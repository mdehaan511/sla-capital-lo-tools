/**
 * borrower-fix-reminder-cron.mjs — Deploy 236.746
 *
 * Daily sweep (9am Pacific): for every in-progress doc review with
 * processor-flagged trays (verdict 'issues'), email the borrower a
 * "please upload corrected documents" reminder. Skips closed / denied /
 * cancelled loans (the shared sender re-checks the LIVE loan), so the
 * reminders stop automatically once the loan closes or the docs are fixed
 * (a borrower re-upload resets the tray to pending, and an approve clears it).
 *
 * Zero-throw; time-budgeted well under Netlify's ~30s scheduled-fn kill.
 */
import { getStore } from '@netlify/blobs';
import { sendFixEmailForReview, flaggedDocsOf } from './_shared/borrower-fix-email.mjs';

export const config = { schedule: '0 16 * * *' }; // 16:00 UTC ≈ 9am PT (8am PST)

const TIME_BUDGET_MS = 24_000;
const MAX_SENDS = 50;

export default async () => {
  const started = Date.now();
  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  try {
    const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await store.list();
    // Deploy 236.762 — scan NEWEST-first. Keys are r_<timestamp>_… and list
    // oldest-first; once the store outgrows the 24s budget the newest
    // (most active) reviews would silently never be reached.
    const keys = blobs.map((b) => b.key).sort().reverse();
    for (const key of keys) {
      if (Date.now() - started > TIME_BUDGET_MS || sent >= MAX_SENDS) break;
      const review = await store.get(key, { type: 'json' }).catch(() => null);
      if (!review) continue;
      scanned++;
      if (review.status && review.status !== 'in_progress') continue;
      if (!flaggedDocsOf(review).length) continue;
      // Deploy 236.747 — requirePortalLogin: only borrowers who have actually
      // signed in to the portal get automated reminders.
      const r = await sendFixEmailForReview(review, { skipIfClosed: true, requirePortalLogin: true });
      if (r.sent) sent++;
      else if (r.ok) skipped++;
      else failed++;
    }
    console.log(`[fix-reminder-cron] scanned=${scanned} sent=${sent} skipped=${skipped} failed=${failed}`);
  } catch (e) {
    console.error('[fix-reminder-cron] error:', e && e.message);
  }
  return new Response(JSON.stringify({ ok: true, scanned, sent, skipped, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
