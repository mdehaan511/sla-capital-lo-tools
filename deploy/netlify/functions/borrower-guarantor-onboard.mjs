/**
 * borrower-guarantor-onboard.mjs — POST /api/borrower-guarantor-onboard
 *
 * Deploy 236.591 — first-login onboarding for a portal-invited person who isn't
 * yet tied to their loan(s). They sign in with the invited email, fill a
 * name/phone form, and this attaches them as a Guarantor (a real `clients`
 * record) to every loan they've been granted access to but aren't yet linked to.
 *
 * Auth: the borrower themselves — authorization is their loan_access GRANT, NOT
 * canEditLoan (a borrower is never an editor). The email ALWAYS comes from the
 * verified token, never the body. The guarantor client is created under the
 * LOAN's owner (resolved from the grant), so it's filed under the right LO —
 * unlike borrower-register.mjs which files self-registrations under the house
 * account.
 *
 * Body: { firstName, lastName, phone }
 * Returns: { ok, linked: <n loans newly linked>, loanIds: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';
import { linkGuarantorToLoan } from './_shared/guarantor-link.mjs';
import { writeClient } from './_shared/client-write.mjs';

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
  if (!firstName || !lastName) return json(400, { error: 'First and last name are required.' });

  const grants = await listAccessibleLoans(email);
  if (!grants.length) return json(200, { ok: true, linked: 0, loanIds: [] });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const linkedLoanIds = [];

  for (const g of grants) {
    if (!g.ownerKey || !g.primaryClientId || !g.loanId) continue;
    let primary;
    try { primary = await clientsStore.get(g.ownerKey + '/' + keySafe(g.primaryClientId), { type: 'json' }); }
    catch (_) { continue; }
    if (!primary || !Array.isArray(primary.loans)) continue;
    const loan = primary.loans.find((l) => l && l.id === g.loanId);
    if (!loan) continue;

    // They're the primary borrower on this loan → they don't become their own
    // guarantor; the portal already shows it.
    if (normalizeEmail(primary.email || '') === email) continue;

    try {
      // Dedupes by email under the loan's owner; creates their client if new,
      // links it onto the loan, and writes the guarantor client (PG-first).
      const res = await linkGuarantorToLoan({
        ownerKey: g.ownerKey, primaryClientId: g.primaryClientId, loanId: g.loanId,
        primary, loan, clientsStore,
        createdVia: '_createdViaBorrowerOnboard',
        guarantor: { email, firstName, lastName, phone, ownershipPct: 0 },
      });
      // Persist the primary only when the link actually changed the loan
      // (avoids churn if they were already linked).
      if (!res.alreadyLinked) {
        primary.updatedAt = new Date().toISOString();
        await writeClient(g.ownerKey, primary, { clientsStore });
        linkedLoanIds.push(g.loanId);
      }
    } catch (e) {
      console.warn('borrower-guarantor-onboard: link failed for', g.loanId, e && e.message);
    }
  }

  return json(200, { ok: true, linked: linkedLoanIds.length, loanIds: linkedLoanIds });
}
