/**
 * loan-review-doc-delete.mjs — POST /api/loan-review-doc-delete
 *
 * Delete one doc blob AND clear the matching current* fields on the
 * review's doc tray. Used when the processor wants to re-upload (or
 * just remove) without immediately replacing.
 *
 * Body: { reviewId, slug, docId }
 *   slug   - which doc tray to clear
 *   docId  - which specific upload to delete (must match
 *            review.docs[slug].currentDocId or live in .history)
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-review-doc-delete error:', e);
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
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (!body.reviewId || !body.slug || !body.docId) {
    return json(400, { error: 'reviewId, slug, docId required' });
  }

  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });

  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  try {
    await docsStore.delete(keySafe(body.reviewId) + '/' + keySafe(body.docId));
  } catch (e) {
    console.warn('loan-review-doc-delete: blob delete failed, continuing to clear refs:', e && e.message);
  }

  const docState = (review.docs || {})[body.slug];
  if (docState) {
    // Clear current* refs if they pointed at the deleted doc.
    if (docState.currentDocId === body.docId) {
      docState.currentDocId = '';
      docState.currentFilename = '';
      docState.currentSize = 0;
      docState.currentMimeType = '';
      docState.currentUploadedAt = '';
      docState.verdict = 'pending';
      docState.processorNotes = '';
      docState.aiVerdict = '';
      docState.aiNotes = '';
      docState.processorOverrideReason = '';
      docState.approvedAt = '';
      docState.approvedBy = '';
    }
    // Also strip from history if it was a prior upload.
    if (Array.isArray(docState.history)) {
      docState.history = docState.history.filter(function (h) { return h && h.docId !== body.docId; });
    }
    review.docs[body.slug] = docState;
  }

  const now = new Date().toISOString();
  review.updatedAt = now;
  review.lastEditedBy = normalizeEmail(user.email);
  review.lastEditedAt = now;
  await reviewStore.setJSON(keySafe(body.reviewId), review);

  return json(200, { ok: true, review });
}
