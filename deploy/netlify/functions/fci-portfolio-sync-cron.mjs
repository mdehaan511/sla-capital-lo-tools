/**
 * fci-portfolio-sync-cron.mjs — nightly FCI servicing refresh.
 *
 * Deploy 236.802 (Mike). Runs the same code path as POST /api/fci-portfolio-sync
 * (imported directly — no HTTP round trip, so no service token to manage).
 *
 * Incremental by design: asks FCI which accounts changed in the last 26 hours
 * and only reconciles those. The window overlaps the 24h gap on purpose so a
 * late or skipped run doesn't leave a hole. If the delta call fails, runSync
 * falls back to the full book rather than syncing nothing.
 *
 * Writes for real (dryRun:false) but stays conservative: it will not map FCI's
 * ambiguous "Assigned"/"CLOSED" statuses, will not overwrite a hand-set
 * disposition, and will not touch investorName/investorId. See the sync header.
 */
import { runSync } from './fci-portfolio-sync.mjs';
import { fciConfigured } from './_shared/fci-api.mjs';

// 09:40 UTC ≈ 2:40am PT — after FCI's overnight posting, before anyone is in.
export const config = { schedule: '40 9 * * *' };

export default async () => {
  if (!fciConfigured()) {
    console.warn('[fci-sync-cron] FCI_API_TOKEN not set — skipping');
    return new Response(JSON.stringify({ ok: true, skipped: 'no token' }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let out;
  try {
    out = await runSync({
      dryRun: false,
      overwriteManual: false,
      // The whole book is 95 loans; a delta window is a handful. 200 is far
      // above either, so one run always finishes rather than leaving a
      // half-applied offset window for nobody to resume.
      limit: 200,
      offset: 0,
      actor: 'fci-sync-cron',
      hoursAgo: 26,
    });
  } catch (e) {
    console.error('[fci-sync-cron] failed:', e && e.message);
    return new Response(JSON.stringify({ ok: false, error: (e && e.message) || 'failed' }), {
      status: 500, headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log('[fci-sync-cron] considered=' + out.fci.considered +
    ' matchedById=' + out.matching.byId + ' matchedByAddress=' + out.matching.byAddress +
    ' applied=' + out.write.applied + ' unchanged=' + out.write.unchanged +
    ' needsReview=' + out.review.needsReview + ' unmatched=' + out.review.unmatched +
    ' errors=' + out.review.errors);

  return new Response(JSON.stringify({
    ok: true,
    considered: out.fci.considered,
    applied: out.write.applied,
    unchanged: out.write.unchanged,
    review: out.review,
  }), { headers: { 'Content-Type': 'application/json' } });
};
