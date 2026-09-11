/**
 * loan-access-revoke.mjs — POST /api/loan-access-revoke
 *
 * Deploy 236.169 — soft-revokes an email's access grant on a
 * loan. Admins can revoke any; LOs can revoke only their loans'.
 *
 * Body: { email, loanId, owner? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canEditLoan, canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.992 — canOverrideOwner
import { revokeLoanAccess } from './_shared/loan-access-store.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-access-revoke error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.email || !body.loanId) {
    return json(400, { error: 'email and loanId required' });
  }
  const email  = normalizeEmail(body.email);
  const loanId = String(body.loanId).trim();
  const primaryClientId = String(body.primaryClientId || '').trim();

  let loan = null;
  let ownerKey = null;
  // Deploy 236.992 (Mike: "give all users access to the Borrower Portal Access
  // box") — the processor tier (admins, processors, senior LOs) may revoke on
  // another LO's loan. It was admins only: a processor's revoke looked the
  // loan up under their OWN key and fell through to 403.
  const override = !!(body.owner && normalizeEmail(body.owner) !== normalizeEmail(user.email) && canOverrideOwner(user).ok);
  if (primaryClientId) {
    try {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const requestedOwner = override ? normalizeEmail(body.owner) : normalizeEmail(user.email);
      ownerKey = keySafe(requestedOwner);
      const client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      if (client && Array.isArray(client.loans)) {
        loan = client.loans.find((l) => l && l.id === loanId) || null;
      }
    } catch (_) {}
  }
  const perm = override ? canOverrideOwner(user) : await canEditLoan(user, loan || { id: loanId }, { ownerKey }); // 236.992
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'not authorized' });

  const access = await revokeLoanAccess({ email, loanId, revokedBy: normalizeEmail(user.email) });
  return json(200, { ok: true, access });
}
