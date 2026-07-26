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
import { canEditLoan } from './_shared/access.mjs';
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
  if (primaryClientId) {
    try {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const requestedOwner = (body.owner && isAdmin(user)) ? normalizeEmail(body.owner) : normalizeEmail(user.email);
      ownerKey = keySafe(requestedOwner);
      const client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      if (client && Array.isArray(client.loans)) {
        loan = client.loans.find((l) => l && l.id === loanId) || null;
      }
    } catch (_) {}
  }
  const perm = await canEditLoan(user, loan || { id: loanId }, { ownerKey });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'not authorized' });

  const access = await revokeLoanAccess({ email, loanId, revokedBy: normalizeEmail(user.email) });
  return json(200, { ok: true, access });
}
