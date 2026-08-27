/**
 * loan-change-log-get.mjs — GET /api/loan-change-log-get
 *
 * Deploy 236.771 — reads the detailed field-level audit log for one loan
 * (see _shared/loan-change-log.mjs). Powers the Audit Log modal on Loan
 * Details. Read-only.
 *
 * Query: ?clientId=&loanId=&owner=   (owner optional; cross-owner needs staff)
 * Returns: { ok, entries: [ { at, by, byName, source, changes:[...] } ] }
 *          newest entry first.
 */
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { readLoanChangeLog } from './_shared/loan-change-log.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    const url = new URL(req.url);
    const clientId = url.searchParams.get('clientId') || '';
    const loanId   = url.searchParams.get('loanId')   || '';
    const owner    = url.searchParams.get('owner')    || '';
    if (!clientId || !loanId) return json(400, { error: 'clientId and loanId required' });

    // Same owner rule as the rest of the loan surface: your own by default,
    // someone else's only with processor/admin override.
    const selfEmail = normalizeEmail(user.email);
    let ownerKey = keySafe(selfEmail);
    if (owner && normalizeEmail(owner) !== selfEmail && owner !== ownerKey) {
      if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires processor or admin' });
      ownerKey = keySafe(normalizeEmail(owner));
    }

    const entries = await readLoanChangeLog(ownerKey, clientId, loanId);
    return json(200, { ok: true, entries });
  } catch (e) {
    console.error('loan-change-log-get error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
