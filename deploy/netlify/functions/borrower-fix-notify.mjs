/**
 * borrower-fix-notify.mjs — POST /api/borrower-fix-notify
 *
 * Deploy 236.746 — processor's on-demand "email the borrower about flagged
 * documents" button on the Doc Review page. Sends the same email the daily
 * reminder cron sends (all currently-flagged trays + their reasons + the
 * upload link), immediately, regardless of the loan's status.
 *
 * Body: { reviewId }
 * Auth: processor or admin.
 * Response: { ok, sent, to?, flaggedCount?, reason? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe,
} from './_shared/auth.mjs';
import { sendFixEmailForReview, flaggedDocsOf } from './_shared/borrower-fix-email.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-fix-notify error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  const reviewId = String((body && body.reviewId) || '').trim();
  if (!reviewId) return json(400, { error: 'reviewId required' });

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await store.get(keySafe(reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });

  const flagged = flaggedDocsOf(review);
  if (!flagged.length) return json(400, { error: 'No flagged documents on this review — flag an issue first.' });

  const r = await sendFixEmailForReview(review, { skipIfClosed: false });
  if (!r.sent) {
    return json(r.ok ? 400 : 500, { error: 'Email not sent: ' + (r.reason || 'unknown') });
  }
  return json(200, { ok: true, sent: true, to: r.to, flaggedCount: flagged.length });
}
