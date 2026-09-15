/**
 * loan-payment-history.mjs — GET /api/loan-payment-history?servicer=&account=[&force=1]
 *
 * Deploy 237.053 (Mike) — borrower payment history for the Closed Loans
 * Servicing tab (a row expands to show it).
 * Deploy 237.054 — reads the per-account cache first (filled nightly by
 * payment-history-warm-background right after the servicer syncs, TTL 26h) so
 * a row opens instantly; a miss or ?force=1 pulls live from FCI / Servicing
 * Pros through _shared/payment-history.mjs.
 *
 * Response: { ok, cached, servicer, account, asOf, rows: [{ dateDue,
 *   dateReceived, daysLate, amount, toInterest, toPrincipal, lateCharges,
 *   type, reference, balance }] }
 * Auth: processor or admin (staff pages only).
 */
import { handleOptions, json, requireAuth, isAdmin, isProcessor } from './_shared/auth.mjs';
import { servicerKind, readCached, fetchAndCache } from './_shared/payment-history.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user) && !isProcessor(user)) return json(403, { error: 'Processor or admin only' });

    const url = new URL(req.url);
    const servicer = String(url.searchParams.get('servicer') || '').trim();
    const account = String(url.searchParams.get('account') || '').trim();
    const force = url.searchParams.get('force') === '1';
    if (!account) return json(400, { error: 'This loan has no servicer loan number yet — add it on the loan\'s Servicing tab.' });
    const kind = servicerKind(servicer, account);
    if (!kind) return json(400, { error: 'Servicer "' + (servicer || 'unknown') + '" has no payment-history integration (FCI and Servicing Pros do).' });

    if (!force) {
      const hit = await readCached(kind, account);
      if (hit) return json(200, Object.assign({ ok: true, cached: true }, hit));
    }
    const out = await fetchAndCache(kind, account);
    return json(200, Object.assign({ ok: true, cached: false }, out));
  } catch (e) {
    console.error('loan-payment-history error:', e);
    return json(500, { error: 'Payment history failed: ' + ((e && e.message) || 'unknown') });
  }
};
