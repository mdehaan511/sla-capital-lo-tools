/**
 * loan-review-request-borrower.mjs — POST /api/loan-review-request-borrower
 *
 * Deploy 236.920 (Mike: "We also need to be able to add an additional tray
 * and request it from the borrower.")
 *
 * Staff add a category in Doc Review ("+ Add Category") and then ask the
 * borrower for it. This flags the tray `borrowerRequested`, which is what puts
 * it on the borrower's document page with its own Upload button (see
 * _shared/borrower-intake-custom.mjs isBorrowerVisibleTray), and optionally
 * emails the borrower a "your loan team needs one more document" note with a
 * link to their portal.
 *
 * Body: { reviewId, slug, requested: true|false, hint?, notify? }
 *   hint    — optional note the borrower sees under the item
 *   notify  — send the email now (only meaningful when requested = true)
 * Auth: processor tier (same as loan-reviews-save).
 * Returns: { ok, review, emailed, emailReason? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { sendRequestEmailForReview } from './_shared/borrower-fix-email.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-request-borrower error:', e);
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
  if (!body || !body.reviewId || !body.slug) return json(400, { error: 'reviewId and slug required' });
  const slug = String(body.slug);
  const requested = body.requested !== false;
  const hint = String(body.hint || '').replace(/\s+/g, ' ').trim().slice(0, 300);

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await store.get(keySafe(body.reviewId), { type: 'json' }).catch(() => null);
  if (!review) return json(404, { error: 'Review not found' });
  const doc = review.docs && review.docs[slug];
  if (!doc || typeof doc !== 'object') return json(404, { error: 'No such document category on this review' });

  const self = normalizeEmail(user.email);
  const now = new Date().toISOString();
  // Same per-doc merge discipline as loan-reviews-save: touch only this tray.
  const patch = requested
    ? { borrowerRequested: true, borrowerRequestedAt: now, borrowerRequestedBy: self, borrowerHint: hint }
    : { borrowerRequested: false, borrowerUnrequestedAt: now, borrowerUnrequestedBy: self };
  review.docs[slug] = { ...doc, ...patch };
  review.docs[slug].history = Array.isArray(doc.history) ? doc.history.slice() : [];
  review.docs[slug].history.push({
    ts: now, action: requested ? 'borrower_requested' : 'borrower_unrequested', by: self,
    note: requested
      ? ('Requested from the borrower' + (hint ? ' — "' + hint + '"' : '') + '.')
      : 'No longer requested from the borrower.',
  });
  review.updatedAt = now;
  review.lastEditedBy = self;
  review.lastEditedAt = now;
  await store.setJSON(keySafe(review.id), review);

  let emailed = false, emailReason = '';
  if (requested && body.notify) {
    const r = await sendRequestEmailForReview(review, [slug], { by: self });
    emailed = !!(r && r.sent);
    emailReason = (r && r.reason) || '';
  }

  return json(200, { ok: true, review, emailed, emailReason: emailReason || undefined });
}
