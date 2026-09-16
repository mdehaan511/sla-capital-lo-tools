/**
 * admin-review-counts-backfill.mjs — POST /api/admin-review-counts-backfill (admin)
 *
 * Deploy 237.103 (Mike) — one-off: walk every doc review and mirror its
 * document counts (docsActive / docsCollected / docsApproved / docsConditions +
 * openConditions / totalConditions) onto the loan, so the Processing Pipeline
 * tiles show the new Docs Collected / Conditions pending / Docs Approved items
 * for loans whose review has not been touched since 237.102 shipped.
 *
 * Idempotent (the helper only writes when a count moved). Body: { dryRun? }.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody } from './_shared/auth.mjs';
import { reviewDocCounts, syncReviewCountsToLoan } from './_shared/review-loan-counts.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    const body = (await readJsonBody(req)) || {};
    const dryRun = body.dryRun === true;

    const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await store.list();
    const out = { reviews: blobs.length, linked: 0, updated: 0, unchanged: 0, skipped: 0, errors: 0, dryRun, sample: [] };
    for (const { key } of blobs) {
      const review = await store.get(key, { type: 'json' }).catch(() => null);
      if (!review || !review.source || review.source.kind !== 'existing' || !review.source.loanId) { out.skipped += 1; continue; }
      out.linked += 1;
      if (dryRun) { if (out.sample.length < 15) out.sample.push({ review: review.id, address: review.address, counts: reviewDocCounts(review) }); continue; }
      const r = await syncReviewCountsToLoan(review);
      if (r && r.ok && r.changed) { out.updated += 1; if (out.sample.length < 15) out.sample.push({ review: review.id, address: review.address, counts: r.counts }); }
      else if (r && r.ok) out.unchanged += 1;
      else out.errors += 1;
    }
    return json(200, out);
  } catch (e) {
    console.error('admin-review-counts-backfill error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
