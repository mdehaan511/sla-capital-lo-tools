/**
 * broker-portal-invite.mjs -- /api/broker-portal-invite
 *
 * Deploy 237.236 (Mike: "For brokers instead of invite to borrower portal it should be
 * invite to broker portal. In fact we need to completely diverge the borrowers and brokers.")
 *
 * Until now "Invite Broker" on a loan sent the broker to the BORROWER portal: a borrower-role
 * Supabase user and a borrower-role loan grant (borrower-intake-invite.mjs). A broker now
 * gets the Preferred Partner portal (/broker-portal): their own login, every loan they are
 * the broker on, and the borrower's document page for each one in processing.
 *
 *   POST { loanId, primaryClientId, owner? }      invite the broker ON a loan
 *   POST { brokerClientId, owner? }               invite a broker from their Broker Book page
 *   GET  ?brokerClientId=&owner=                  portal status for a broker record
 *
 * What a POST does, in order (each step is idempotent, so "Resend" is the same call):
 *   1. resolves the broker (the loan's broker fields, or the broker client record) and
 *      refuses the two mix-ups this exists to end: the broker email being the borrower's
 *      own email, and a team member's address;
 *   2. links the loan to a broker CLIENT record when it has none (linkOrCreateBroker --
 *      the portal finds loans by loan.brokerId), writing the loan;
 *   3. creates-or-updates the partner ACCESS record (broker_partners) as APPROVED, owned
 *      by the loan's LO -- the inviting loan officer vouches; the desk keeps its suspend
 *      switch -- and stamps role `broker` in sla_user_roles (union: a person who is also a
 *      borrower somewhere keeps that);
 *   4. picks the link: no login yet -> a one-time claim (broker-signup.html, choose a
 *      password); a login exists (they were a borrower-portal user before, or signed in
 *      with Google) -> a 72h durable sign-in link (kind 'broker');
 *   5. emails it (reply-to the owning LO), records the invite on the loan (the existing
 *      "Broker: ... invited ... last login" line reads that record) and on the partner
 *      record, and grants the loan (role broker) when it is in processing so the document
 *      page opens on their first visit.
 *
 * Auth: staff (never a borrower or broker login). A plain LO acts in their own book; a
 * processor or admin may pass `owner` (canOverrideOwner). Never sends to an address the
 * caller typed: the recipient is always what the record says.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { isBrokerRole, canOverrideOwner, isLoanInProcessing } from './_shared/access.mjs';
import { getPartner, savePartner, mintInvite, markPortalInvite } from './_shared/broker-partners.mjs';
import { syncRoleTable } from './_shared/sla-roles.mjs';
import { db } from './_shared/supabase-db.mjs';
import {
  getSb, findUserIdByEmail, lastSignInByUserId, mintDurablePortalLink, linkExpiryCopy, writeLoanInvite,
} from './_shared/borrower-invite-core.mjs';
import { grantLoanAccess } from './_shared/loan-access-store.mjs';
import { linkOrCreateBroker } from './_shared/broker-link.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { clientAsBroker, splitBrokerName } from './_shared/broker-client.mjs';
import { sendPartnerInviteEmail } from './_shared/broker-invite-email.mjs';
import { getOwnerReplyTo } from './_shared/email.mjs';

// Roles that make an address a TEAM MEMBER's. A broker record carrying one of these is a
// mix-up (an LO's own email typed as the broker), never an invite.
const STAFF_ROLES = ['super_admin', 'admin', 'senior_lo', 'loan_officer', 'processor', 'office_assistant', 'underwriter'];

function _rolesOf(user) {
  const am = (user && user.app_metadata) || {};
  const r = Array.isArray(am.roles) ? am.roles : (am.role ? [am.role] : []);
  return r.map((x) => String(x).toLowerCase());
}
// Staff = anyone whose login is not a borrower's or a broker's.
function _isStaff(user) {
  if (!user || isBrokerRole(user)) return false;
  const roles = _rolesOf(user);
  return !(roles.length > 0 && roles.every((r) => r === 'borrower' || r === 'viewer'));
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-portal-invite error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST' && req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!_isStaff(user)) return json(403, { error: 'Staff only' });

  const selfEmail = normalizeEmail(user.email);
  const isGet = req.method === 'GET';
  const q = isGet ? new URL(req.url).searchParams : null;
  const body = isGet ? {} : ((await readJsonBody(req)) || {});
  const ownerParam = isGet ? (q.get('owner') || '') : (body.owner || '');

  // Owner: a plain LO always works in their own book; processors + admins may name one.
  let ownerEmail = selfEmail;
  if (ownerParam && normalizeEmail(ownerParam) !== selfEmail) {
    if (!canOverrideOwner(user).ok) {
      return json(403, { error: 'Only the loan officer who owns this loan, a processor, or an admin can invite its broker.' });
    }
    ownerEmail = normalizeEmail(ownerParam);
  }
  const ownerKey = keySafe(ownerEmail);
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // ── resolve the broker ────────────────────────────────────────────────────
  let loan = null, client = null, brokerClient = null;
  const brokerClientId = String((isGet ? q.get('brokerClientId') : body.brokerClientId) || '').trim();
  const loanId = String((isGet ? q.get('loanId') : body.loanId) || '').trim();
  const primaryClientId = String((isGet ? q.get('primaryClientId') : body.primaryClientId) || '').trim();

  if (brokerClientId) {
    brokerClient = await clientsStore.get(ownerKey + '/' + keySafe(brokerClientId), { type: 'json' }).catch(() => null);
    if (!brokerClient) return json(404, { error: 'Broker not found in this book' });
    if (!brokerClient._isBroker) {
      return json(400, { error: 'This is a borrower record, not a broker. Brokers are invited from the Broker Book, or from a loan they are the broker on.' });
    }
  } else if (loanId && primaryClientId) {
    client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' }).catch(() => null);
    loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) || null : null;
    if (!loan) return json(404, { error: 'Loan not found' });
  } else {
    return json(400, { error: 'brokerClientId, or loanId + primaryClientId, required' });
  }

  let b;
  if (brokerClient) {
    b = clientAsBroker(brokerClient);
  } else {
    const fd = loan.formData || {};
    b = {
      id:      String(loan.brokerId || '').trim(),
      name:    String(loan.brokerName || fd.brokerName || '').trim(),
      company: String(loan.brokerCompany || fd.brokerCompany || '').trim(),
      email:   String(loan.brokerEmail || fd.brokerEmail || '').trim(),
      phone:   String(loan.brokerPhone || fd.brokerPhone || '').trim(),
    };
  }
  const email = normalizeEmail(b.email || '');
  if (!email || email.indexOf('@') < 0) {
    return json(400, { error: loan ? 'No broker email on this loan. Add it in Broker Info first.' : 'This broker has no email on file. Add one first.' });
  }

  // ── GET: status ───────────────────────────────────────────────────────────
  if (isGet) {
    const partner = await getPartner(email);
    if (!partner) return json(200, { invited: false, email, hasPartner: false });
    const pi = partner.portalInvite || null;
    const sb = getSb();
    let userId = (pi && pi.userId) || '';
    // A claimed login has no stored user id (broker-claim minted it); look it up once and
    // keep it, so the "last login" line never pages the user list again.
    if (!userId && partner.inviteAcceptedAt && sb) {
      userId = await findUserIdByEmail(sb, email).catch(() => '');
      if (userId) { try { await markPortalInvite(email, { userId }); } catch (_) {} }
    }
    let lastSignInAt = '';
    if (userId && sb) { try { lastSignInAt = await lastSignInByUserId(sb, userId); } catch (_) {} }
    return json(200, {
      invited: !!pi, email, hasPartner: true, status: partner.status,
      mode: (pi && pi.mode) || '', sentAt: (pi && pi.at) || '', sentBy: (pi && pi.by) || '',
      emailed: pi ? pi.emailed !== false : false,
      claimedAt: partner.inviteAcceptedAt || '',
      hasLogin: !!userId || !!partner.inviteAcceptedAt,
      lastSignInAt: lastSignInAt || '',
    });
  }

  // ── the two mix-ups this endpoint exists to end ───────────────────────────
  if (client && client.email && normalizeEmail(client.email) === email) {
    return json(409, { error: 'The broker email on this loan is the borrower\'s own email (' + email + '). A broker is a separate person with their own address -- fix Broker Info first.' });
  }
  if (/@slacapital\.com$/.test(email)) {
    return json(409, { error: email + ' is a team address, not a broker.' });
  }
  let tableRoles = [];
  try {
    const row = await db.first('sla_user_roles', { select: 'email,roles', eq: { email } });
    tableRoles = row && Array.isArray(row.roles) ? row.roles.map((r) => String(r).toLowerCase()) : [];
  } catch (_) { tableRoles = []; }
  if (tableRoles.some((r) => STAFF_ROLES.indexOf(r) >= 0)) {
    return json(409, { error: email + ' belongs to a team member, not a broker.' });
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

  // ── the partner ACCESS record: approved, owned by the loan's LO ───────────
  const existing = await getPartner(email);
  if (existing && existing.status === 'suspended') {
    return json(409, { error: 'This partner\'s portal access is suspended. An admin can reinstate it on the Preferred Partners desk.' });
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
  catch (e) { return json(500, { error: 'Partner record write failed: ' + ((e && e.message) || 'unknown') }); }

  // Role follows the record (the token hook stamps roles FROM the table; Deploy 236.826).
  // Union, not replace: a person who is also a borrower somewhere keeps that.
  const roles = tableRoles.slice();
  if (roles.indexOf('broker') < 0) roles.push('broker');
  const roleSync = await syncRoleTable(email, roles);

  // ── the link: claim a login, or sign in to the one they have ──────────────
  const sb = getSb();
  const userId = sb ? await findUserIdByEmail(sb, email).catch(() => '') : '';
  const origin = new URL(req.url).origin;
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
    catch (e) { return json(500, { error: 'Could not mint the invite: ' + ((e && e.message) || 'unknown') }); }
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
    try { await writeLoanInvite(loan.id, 'broker', { email, userId, sentAt: now, sentBy: selfEmail, portal: 'broker', mode }); }
    catch (e) { console.warn('broker-portal-invite: loan record write failed:', e && e.message); }
    if (isLoanInProcessing(loan)) {
      try { await grantLoanAccess({ email, loanId: loan.id, primaryClientId: client.id, ownerKey, role: 'broker', grantedBy: selfEmail }); }
      catch (e) { console.warn('broker-portal-invite: grant failed:', e && e.message); }
    }
  }
  try { await markPortalInvite(email, { at: now, by: selfEmail, mode, loanId: loan ? loan.id : '', userId, emailed: !!sent.ok }); }
  catch (e) { console.warn('broker-portal-invite: partner stamp failed:', e && e.message); }

  return json(200, {
    ok: true, email, mode, emailed: !!sent.ok, emailError: sent.error || '', inviteUrl: url, sentAt: now,
    partner: { status: partner.status, clientId: partner.clientId || '', ownerKey: partner.ownerKey || '' },
    roleSync, linked, linkNote,
    loanId: loan ? loan.id : '',
  });
}
