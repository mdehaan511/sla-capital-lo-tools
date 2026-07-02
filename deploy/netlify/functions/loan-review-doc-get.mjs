/**
 * loan-review-doc-get.mjs — GET /api/loan-review-doc-get?reviewId=...&docId=...
 *
 * Streams the raw document bytes back to the browser so the processor
 * can re-view what they uploaded earlier (e.g. when continuing a
 * review after a few days). The browser will render the PDF inline
 * via the native viewer when Content-Disposition is inline.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, corsHeaders,
} from './_shared/auth.mjs';
// Deploy 236.169 — Access Refactor PR #1. canReadReviewDoc handles
// the processor+ fast path today; the borrower path (view your own
// signed docs) unlocks automatically when borrowers land in PR #3.
import { canReadReviewDoc } from './_shared/access.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-review-doc-get error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const reviewId = url.searchParams.get('reviewId');
  const docId = url.searchParams.get('docId');
  if (!reviewId || !docId) return json(400, { error: 'reviewId and docId required' });

  // Deploy 236.169 — permission check runs BEFORE the blob fetch.
  // canReadReviewDoc needs the review record to consult the
  // borrower path; grab it once and reuse. Processors + admins
  // short-circuit before the review lookup.
  let review = null;
  try {
    const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    review = await reviewsStore.get(keySafe(reviewId), { type: 'json' });
  } catch (_) {}
  const perm = await canReadReviewDoc(user, review, docId);
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  const key = keySafe(reviewId) + '/' + keySafe(docId);
  const result = await docsStore.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!result || !result.data) return json(404, { error: 'Doc not found' });

  const meta = result.metadata || {};
  const mimeType = meta.mimeType || 'application/pdf';
  const filename = meta.filename || (docId + '.pdf');

  return new Response(result.data, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': mimeType,
      'Content-Disposition': 'inline; filename="' + filename.replace(/"/g, "'") + '"',
      'Cache-Control': 'private, no-cache',
    },
  });
}
