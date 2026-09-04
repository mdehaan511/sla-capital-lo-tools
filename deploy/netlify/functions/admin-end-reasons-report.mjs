/**
 * admin-end-reasons-report.mjs — GET /api/admin-end-reasons-report
 *
 * Deploy 236.883 (Mike) — "as we cancel loans I want a way to see the sum
 * total for each of these": aggregates every cancelled + declined loan by
 * its structured endReasonCode (stored by loan-cancel / loan-decline since
 * this deploy). One indexed PG query; endReasonCode rides in the loans
 * row's extra JSONB (unpromoted fields land there).
 *
 * Returns { ok, rows: [{ code, label, cancelled, declined, total,
 *   volume }...], totals: { cancelled, declined, total, volume },
 *   unattributed } — rows sorted by total desc; loans ended before this
 * deploy (no code recorded) aggregate under '(no reason recorded)'.
 *
 * Auth: processor/admin (isProcessor — includes senior LOs).
 */
import {
  handleOptions, json, requireAuth, isProcessor,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { END_REASONS, END_REASON_LABEL } from './_shared/end-reasons.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-end-reasons-report error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const loans = await db.select('loans', {
    select: 'id,status,loan_amt,extra',
    in: { status: ['cancelled', 'denied'] },
  }) || [];

  const buckets = {};
  const bucketFor = (code) => {
    if (!buckets[code]) {
      buckets[code] = {
        code,
        label: END_REASON_LABEL[code] || (code === '_none' ? '(no reason recorded)' : code),
        cancelled: 0, declined: 0, total: 0, volume: 0,
      };
    }
    return buckets[code];
  };
  const totals = { cancelled: 0, declined: 0, total: 0, volume: 0 };

  for (const l of loans) {
    const extra = (l.extra && typeof l.extra === 'object') ? l.extra : {};
    const code = String(extra.endReasonCode || '').trim() || '_none';
    const b = bucketFor(code);
    const amt = parseFloat(String(l.loan_amt || '').replace(/[$,]/g, '')) || 0;
    if (l.status === 'cancelled') { b.cancelled++; totals.cancelled++; }
    else { b.declined++; totals.declined++; }
    b.total++; totals.total++;
    b.volume += amt; totals.volume += amt;
  }

  // Every defined reason appears (zeros included) so the table reads as a
  // complete taxonomy; '(no reason recorded)' sorts last.
  for (const r of END_REASONS) bucketFor(r.code);
  const rows = Object.values(buckets).sort((a, b) => {
    if (a.code === '_none') return 1;
    if (b.code === '_none') return -1;
    return b.total - a.total || a.label.localeCompare(b.label);
  });

  return json(200, { ok: true, rows, totals, loansScanned: loans.length });
}
