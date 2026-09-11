/**
 * servicingpros-portfolio-sync-cron.mjs — nightly Servicing Pros refresh.
 *
 * Deploy 236.983 (Mike). Same code path as POST /api/servicingpros-portfolio-sync
 * (imported directly — no HTTP round trip, no service token). Both lender
 * accounts (SLA + SLA-KAF), full book every night — it is a few dozen loans,
 * so there is no delta window to manage.
 *
 * Writes for real (dryRun:false) but stays conservative: never overwrites a
 * hand-set disposition that disagrees, never promotes their investor over a
 * hand-set one, never guesses a link by address. See the sync header.
 */
import { runSync } from './servicingpros-portfolio-sync.mjs';
import { spConfigured } from './_shared/servicingpros-api.mjs';

// 09:55 UTC ≈ 2:55am PT — right after the FCI run (09:40), before anyone is in.
export const config = { schedule: '55 9 * * *' };

export default async () => {
  if (!spConfigured()) {
    console.warn('[servicingpros-sync-cron] no SERVICINGPROS_API_KEY_* set — skipping');
    return new Response(JSON.stringify({ ok: true, skipped: 'no key' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }
  let out;
  try {
    out = await runSync({ dryRun: false, overwriteManual: false, limit: 200, offset: 0, actor: 'servicingpros-sync-cron', only: null });
  } catch (e) {
    console.error('[servicingpros-sync-cron] failed:', e && e.message);
    return new Response(JSON.stringify({ ok: false, error: (e && e.message) || 'failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }
  console.log('[servicingpros-sync-cron] loans=' + out.servicingPros.totalLoans +
    ' matched=' + out.matching.byId + ' applied=' + out.write.applied + ' unchanged=' + out.write.unchanged +
    ' unmatched=' + out.review.unmatched + ' taggedNotInFeed=' + out.review.taggedNotInFeed + ' errors=' + out.review.errors);
  return new Response(JSON.stringify({
    ok: true, loans: out.servicingPros.totalLoans, applied: out.write.applied, unchanged: out.write.unchanged, review: out.review,
  }), { headers: { 'Content-Type': 'application/json' } });
};
