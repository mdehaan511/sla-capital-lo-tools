/**
 * borrower-guarantor-onboard.mjs — POST /api/borrower-guarantor-onboard
 *
 * Deploy 236.591 — first-login onboarding for a portal-invited person.
 * Deploy 236.592 — expanded into a "verify your information" step: the borrower
 * confirms name / phone / SSN (optional) / mailing address on first login. It
 * updates their client record under each loan's owner and stamps
 * `borrowerVerifiedAt` so the form only appears once. If they aren't yet linked
 * to a granted loan (edge case — the UI now only invites existing guarantors),
 * it also attaches them as a guarantor.
 *
 * Auth: the borrower themselves — authorization is their loan_access GRANT, NOT
 * canEditLoan. The email ALWAYS comes from the verified token. The client is
 * created/updated under the LOAN's owner (from the grant), never the house
 * account.
 *
 * Body: { firstName, lastName, phone, ssn?, homeAddress?: {street,city,state,zip} }
 * Returns: { ok, verified: <n clients stamped>, loanIds: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';
import { linkGuarantorToLoan } from './_shared/guarantor-link.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { encryptField } from './_shared/crypto.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-guarantor-onboard error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const email = normalizeEmail(user.email);
  if (!email || email.indexOf('@') < 0) return json(400, { error: 'No email on your account.' });

  const body = await readJsonBody(req) || {};
  const firstName = String(body.firstName || '').trim();
  const lastName  = String(body.lastName  || '').trim();
  const phone     = String(body.phone     || '').trim();
  const h = (body.homeAddress && typeof body.homeAddress === 'object') ? body.homeAddress : {};
  const homeAddress = {
    street: String(h.street || '').trim(),
    city:   String(h.city   || '').trim(),
    state:  String(h.state  || '').trim(),
    zip:    String(h.zip    || '').trim(),
  };
  // Name + phone + mailing address are required; SSN is optional (per Mike).
  if (!firstName || !lastName) return json(400, { error: 'First and last name are required.' });
  if (!phone) return json(400, { error: 'A phone number is required.' });
  if (!homeAddress.street || !homeAddress.city || !homeAddress.state || !homeAddress.zip) {
    return json(400, { error: 'A complete mailing address (street, city, state, zip) is required.' });
  }
  // SSN optional; only persist a full 9-digit value (encrypted).
  const ssnDigits = String(body.ssn || '').replace(/\D/g, '');
  const ssnEnc = ssnDigits.length === 9 ? encryptField(ssnDigits) : '';

  const grants = await listAccessibleLoans(email);
  if (!grants.length) return json(200, { ok: true, verified: 0, loanIds: [] });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const now = new Date().toISOString();
  const doneLoanIds = [];
  let verified = 0;

  // Apply the verified fields to the borrower's OWN client under each granted
  // loan — the primary client if they're the primary borrower, else their
  // guarantor client (creating + linking it if somehow missing).
  const seenClientKeys = {};
  for (const g of grants) {
    if (!g.ownerKey || !g.primaryClientId || !g.loanId) continue;
    let primary;
    try { primary = await clientsStore.get(g.ownerKey + '/' + keySafe(g.primaryClientId), { type: 'json' }); }
    catch (_) { continue; }
    if (!primary || !Array.isArray(primary.loans)) continue;
    const loan = primary.loans.find((l) => l && l.id === g.loanId);
    if (!loan) continue;

    let target = null;
    let wroteViaLink = false;
    if (normalizeEmail(primary.email || '') === email) {
      target = primary;                       // they ARE the primary borrower
    } else {
      // Find their guarantor client under this owner; create+link if missing.
      const ids = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
      for (const gid of ids) {
        try {
          const gc = await clientsStore.get(g.ownerKey + '/' + keySafe(gid), { type: 'json' });
          if (gc && normalizeEmail(gc.email || '') === email) { target = gc; break; }
        } catch (_) { /* skip */ }
      }
      if (!target) {
        try {
          const res = await linkGuarantorToLoan({
            ownerKey: g.ownerKey, primaryClientId: g.primaryClientId, loanId: g.loanId,
            primary, loan, clientsStore, createdVia: '_createdViaBorrowerOnboard',
            guarantor: { email, firstName, lastName, phone, ownershipPct: 0 },
          });
          target = res.guarantor;
          wroteViaLink = true;
          if (!res.alreadyLinked) { primary.updatedAt = now; await writeClient(g.ownerKey, primary, { clientsStore }); }
        } catch (e) { console.warn('borrower-guarantor-onboard: link failed for', g.loanId, e && e.message); continue; }
      }
    }
    if (!target) continue;

    // Apply the verified fields (fill/refresh) + stamp verifiedAt. SSN + address
    // overwrite (the borrower is the source of truth for their own info).
    if (firstName) target.firstName = firstName;
    if (lastName)  target.lastName  = lastName;
    if (phone)     target.phone     = phone;
    target.homeAddress = homeAddress;
    if (ssnEnc) { target.ssn_enc = ssnEnc; target.ssnLast4 = ssnDigits.slice(-4); }
    target.borrowerVerifiedAt = now;
    target._lastBorrowerEdit = now;
    target.updatedAt = now;

    // Persist (dedupe writes per client key across multiple grants to one client).
    const tKey = g.ownerKey + '/' + keySafe(target.id);
    if (!seenClientKeys[tKey]) {
      seenClientKeys[tKey] = true;
      try {
        await writeClient(g.ownerKey, target, { clientsStore });
        verified += 1;
      } catch (e) { console.warn('borrower-guarantor-onboard: write failed for', target.id, e && e.message); }
    }
    doneLoanIds.push(g.loanId);
  }

  return json(200, { ok: true, verified, loanIds: doneLoanIds });
}
