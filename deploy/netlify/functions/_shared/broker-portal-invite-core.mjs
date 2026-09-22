/**
 * _shared/broker-portal-invite-core.mjs -- invite a broker to the Preferred Partner portal.
 *
 * Deploy 237.241 (Mike: "when brokers fill out an application they automatically get
 * invited to the broker portal"). Lifted out of broker-portal-invite.mjs (237.236) so the
 * LO's "Invite Broker" button and the application form run the SAME invite: the same
 * guards, the same partner record, the same link, the same email.
 *
 * inviteBrokerToPortal({ ownerKey, loan, client, brokerClient, actorEmail, origin,
 *                        clientsStore, via, onlyIfNeverInvited })
 *   loan + client       the loan and its PARENT client (a borrower, or on a broker-submitted
 *                       application the broker's own record); or
 *   brokerClient        a Broker Book record (no loan)
 *   actorEmail          who is inviting (the LO on the button; the owning LO for the form)
 *   via                 'lo' | 'apply' -- remembered on the partner record and the loan
 *   onlyIfNeverInvited  the form's rule: a partner who was already invited or already has a
 *                       login is left alone (their portal simply lists the new loan)
 *
 * Returns { ok: true, ...result } (result = what the endpoint responds with),
 *         { ok: true, skipped: '<why>' } when onlyIfNeverInvited applied, or
 *         { ok: false, status, error } for a refusal. Never throws for a refusal; a store
 *         write that fails does throw, so the caller can decide (the endpoint reports it,
 *         the form logs it and moves on).
 *
 * What a run does, in order (each step idempotent, so "Resend" is the same call):
 *   1. resolves the broker and refuses the two mix-ups this exists to end: the broker email
 *      being the borrower's own email (the linked guarantor's / the typed borrower's on a
 *      broker-parent loan, the parent's otherwise), and a team member's address;
 *   2. links the loan to a broker CLIENT record when it has none (the portal lists by
 *      loan.brokerId), writing the loan;
 *   3. creates-or-updates the partner ACCESS record as APPROVED under the loan's LO (an
 *      existing partner keeps their rep and details; suspended stays suspended) and stamps
 *      role `broker` in sla_user_roles as a union;
 *   4. picks the link: no login -> a one-time claim (broker-signup); a login -> a 72h durable
 *      sign-in link (kind 'broker');
 *   5. emails it (reply-to the owning LO), records the invite on the loan and the partner,
 *      and grants the loan (role broker) when it is in processing.
 */
import { normalizeEmail, keySafe } from './auth.mjs';
import { isLoanInProcessing } from './access.mjs';
import { getPartner, savePartner, mintInvite, markPortalInvite } from './broker-partners.mjs';
import { syncRoleTable } from './sla-roles.mjs';
import { db } from './supabase-db.mjs';
import {
  getSb, findUserIdByEmail, mintDurablePortalLink, linkExpiryCopy, writeLoanInvite,
} from './borrower-invite-core.mjs';
import { grantLoanAccess } from './loan-access-store.mjs';
import { linkOrCreateBroker } from './broker-link.mjs';
import { writeClient } from './client-write.mjs';
import { clientAsBroker, splitBrokerName } from './broker-client.mjs';
import { sendPartnerInviteEmail } from './broker-invite-email.mjs';
import { getOwnerReplyTo } from './email.mjs';

// Roles that make an address a TEAM MEMBER's. A broker record carrying one of these is a
// mix-up (an LO's own email typed as the broker), never an invite.
export const STAFF_ROLES = ['super_admin', 'admin', 'senior_lo', 'loan_officer', 'processor', 'office_assistant', 'underwriter'];

/** The broker as the record describes them: a Broker Book record, or the loan's broker fields. */
export function brokerFieldsOf(loan, brokerClient) {
  if (brokerClient) return clientAsBroker(brokerClient);
  const fd = (loan && loan.formData) || {};
  return {
    id:      String((loan && loan.brokerId) || '').trim(),
    name:    String((loan && loan.brokerName) || fd.brokerName || '').trim(),
    company: String((loan && loan.brokerCompany) || fd.brokerCompany || '').trim(),
    email:   String((loan && loan.brokerEmail) || fd.brokerEmail || '').trim(),
    phone:   String((loan && loan.brokerPhone) || fd.brokerPhone || '').trim(),
  };
}

export async function inviteBrokerToPortal(a) {
  const ownerKey = a.ownerKey;
  const loan = a.loan || null, client = a.client || null, brokerClient = a.brokerClient || null;
  const selfEmail = normalizeEmail(a.actorEmail || '');
  const via = a.via === 'apply' ? 'apply' : 'lo';
  const clientsStore = a.clientsStore;
  const origin = String(a.origin || 'https://portal.slacapital.ai').replace(/\/+$/, '');
  const refuse = (status, error) => ({ ok: false, status, error });

  const b = brokerFieldsOf(loan, brokerClient);
  const email = normalizeEmail(b.email || '');
  if (!email || email.indexOf('@') < 0) {
    return refuse(400, loan ? 'No broker email on this loan. Add it in Broker Info first.' : 'This broker has no email on file. Add one first.');
  }

  // ── the two mix-ups this exists to end ───────────────────────────────────
  // Deploy 237.240 -- on a broker-submitted application the PARENT client IS the broker, so
  // "the borrower's own email" is the linked guarantor's / the name the broker typed, never
  // the parent's.
  const parentIsBroker = !!(client && loan && client._isBroker &&
    (loan.brokerId === client.id || loan._isBrokerLoan || (client.email && normalizeEmail(client.email) === email)));
  const borrowerEmails = [];
  if (client && !parentIsBroker && client.email) borrowerEmails.push(normalizeEmail(client.email));
  if (loan && loan.borrowerEmail) borrowerEmails.push(normalizeEmail(loan.borrowerEmail));
  (loan && Array.isArray(loan.guarantors) ? loan.guarantors : []).forEach((g) => { if (g && g.email) borrowerEmails.push(normalizeEmail(g.email)); });
  if (borrowerEmails.indexOf(email) >= 0) {
    return refuse(409, 'The broker email on this loan is the borrower\'s own email (' + email + '). A broker is a separate person with their own address -- fix Broker Info first.');
  }
  if (/@slacapital\.com$/.test(email)) return refuse(409, email + ' is a team address, not a broker.');
  let tableRoles = [];
  try {
    const row = await db.first('sla_user_roles', { select: 'email,roles', eq: { email } });
    tableRoles = row && Array.isArray(row.roles) ? row.roles.map((r) => String(r).toLowerCase()) : [];
  } catch (_) { tableRoles = []; }
  if (tableRoles.some((r) => STAFF_ROLES.indexOf(r) >= 0)) return refuse(409, email + ' belongs to a team member, not a broker.');

  // ── the partner ACCESS record ─────────────────────────────────────────────
  const existing = await getPartner(email);
  if (existing && existing.status === 'suspended') {
    return refuse(409, 'This partner\'s portal access is suspended. An admin can reinstate it on the Preferred Partners desk.');
  }
  if (a.onlyIfNeverInvited && existing) {
    // The form's rule: never nag. Invited before, or already holding a login -> nothing to do;
    // the new loan simply appears in their portal.
    if (existing.inviteAcceptedAt) return { ok: true, skipped: 'has-login', email };
    if (existing.portalInvite && existing.portalInvite.at) return { ok: true, skipped: 'already-invited', email };
    if (existing.inviteToken) return { ok: true, skipped: 'desk-invite-pending', email };
  }

  const now = new Date().toISOString();

  // ── link the loan to a broker record (the portal lists loans by brokerId) ─
  let linked = !!(loan && loan.brokerId), linkNote = '';
  if (loan && !loan.brokerId) {
    let r = null;
    try { r = await linkOrCreateBroker(ownerKey, { brokerId: '', brokerName: b.name, brokerCompany: b.company, brokerEmail: email, brokerPhone: b.phone }); }
    catch (_) { r = null; }
    if (r && r.id) {
      loan.brokerId = r.id;
      const bb = r.broker || {};
      if (!loan.brokerName && bb.name) loan.brokerName = bb.name;
      if (!loan.brokerCompany && bb.company) loan.brokerCompany = bb.company;
      if (!loan.brokerPhone && bb.phone) loan.brokerPhone = bb.phone;
      loan.updatedAt = now;
      try { await writeClient(ownerKey, client, { clientsStore }); linked = true; }
      catch (e) { linkNote = 'The loan could not be linked to the broker record (' + ((e && e.message) || 'write failed') + '); it will not show in their portal until it is.'; }
    } else {
      linkNote = 'No broker record could be made for this loan (a broker name is needed); it will not show in their portal until Broker Info has a name.';
    }
    if (!b.id && loan.brokerId) b.id = loan.brokerId;
  }

  const patch = { status: 'approved' };
  const fill = (k, v) => { if (v && !(existing && existing[k])) patch[k] = v; };
  const nm = splitBrokerName(b.name || '');
  fill('firstName', nm.firstName); fill('lastName', nm.lastName);
  fill('company', b.company); fill('phone', b.phone);
  fill('clientId', brokerClient ? brokerClient.id : (b.id || ''));
  fill('ownerKey', ownerKey);
  let partner;
  try { partner = await savePartner(email, patch, selfEmail); }
  catch (e) { return refuse(500, 'Partner record write failed: ' + ((e && e.message) || 'unknown')); }

  // Role follows the record (the token hook stamps roles FROM the table; Deploy 236.826).
  // Union, not replace: a person who is also a borrower somewhere keeps that.
  const roles = tableRoles.slice();
  if (roles.indexOf('broker') < 0) roles.push('broker');
  const roleSync = await syncRoleTable(email, roles);

  // ── the link: claim a login, or sign in to the one they have ──────────────
  const sb = getSb();
  const userId = sb ? await findUserIdByEmail(sb, email).catch(() => '') : '';
  let mode, url, expiry = null;
  if (userId) {
    mode = 'signin';
    const d = mintDurablePortalLink(email, origin, { kind: 'broker' });
    url = d ? d.url : origin + '/';
    expiry = linkExpiryCopy(d);
  } else {
    mode = 'claim';
    let rec;
    try { rec = await mintInvite(email, selfEmail); }
    catch (e) { return refuse(500, 'Could not mint the invite: ' + ((e && e.message) || 'unknown')); }
    url = origin + '/broker-signup.html?t=' + encodeURIComponent(rec.inviteToken);
  }

  // ── email it, reply-to the LO who owns the relationship ───────────────────
  let replyTo = '';
  try { replyTo = await getOwnerReplyTo(ownerKey); } catch (_) { replyTo = ''; }
  const sent = await sendPartnerInviteEmail({
    toEmail: email, url, rec: partner, actor: replyTo || selfEmail, mode, expiry,
    forAddress: loan ? String(loan.address || '') : '',
  });

  // ── records ───────────────────────────────────────────────────────────────
  if (loan) {
    try { await writeLoanInvite(loan.id, 'broker', { email, userId, sentAt: now, sentBy: selfEmail, portal: 'broker', mode, via }); }
    catch (e) { console.warn('broker-portal-invite: loan record write failed:', e && e.message); }
    if (client && isLoanInProcessing(loan)) {
      try { await grantLoanAccess({ email, loanId: loan.id, primaryClientId: client.id, ownerKey, role: 'broker', grantedBy: selfEmail }); }
      catch (e) { console.warn('broker-portal-invite: grant failed:', e && e.message); }
    }
  }
  try { await markPortalInvite(email, { at: now, by: selfEmail, mode, via, loanId: loan ? loan.id : '', userId, emailed: !!sent.ok }); }
  catch (e) { console.warn('broker-portal-invite: partner stamp failed:', e && e.message); }

  return {
    ok: true, email, mode, via, emailed: !!sent.ok, emailError: sent.error || '', inviteUrl: url, sentAt: now,
    partner: { status: partner.status, clientId: partner.clientId || '', ownerKey: partner.ownerKey || '' },
    roleSync, linked, linkNote,
    loanId: loan ? loan.id : '',
  };
}
