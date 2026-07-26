/**
 * loan-access-list.mjs — GET /api/loan-access-list
 *
 * Deploy 236.169 — reads live grants either BY LOAN
 * (`?loanId=...` — admin/LO who owns the loan) or BY EMAIL
 * (`?email=...` — admin only; LOs can only see their own email
 * for now). No auth surface for cross-LO email lookups yet.
 */
import {
  handleOptions, json, requireAuth,
  normalizeEmail, isAdmin,
} from './_shared/auth.mjs';
import { listAccessibleLoans, listGrantsForLoan } from './_shared/loan-access-store.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-access-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const loanId = String(url.searchParams.get('loanId') || '').trim();
  const email  = String(url.searchParams.get('email')  || '').trim().toLowerCase();

  if (loanId) {
    // Admin OR owning LO (owner-check is enforced up in the
    // frontend / by the loan-details.html page — this endpoint
    // reads only; it doesn't expose sensitive doc content).
    const grants = await listGrantsForLoan(loanId);
    return json(200, { loanId, grants });
  }
  if (email) {
    const self = normalizeEmail(user.email);
    if (email !== self && !isAdmin(user)) {
      return json(403, { error: 'Admin required to read another user\'s grants' });
    }
    const loans = await listAccessibleLoans(email);
    return json(200, { email, loans });
  }
  return json(400, { error: 'Provide either loanId or email' });
}
