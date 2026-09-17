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
import { syncReviewCountsToLoan } from './_shared/review-loan-counts.mjs';

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
    // Deploy 237.130 (Dan: removing one of several OFAC docs sent the whole tray
    // back to Pending Docs with a dead Approve button) -- the removed doc leaves
    // documents[] here, and when it was the primary the next live document is
    // promoted WITH its own AI result. The tray keeps its verdict / UW state; it
    // only resets when nothing is left in it. (The page used to promote, but it
    // compared against currentDocId AFTER this endpoint had blanked it.)
    if (Array.isArray(docState.documents)) {
      docState.documents = docState.documents.filter(function (d) { return d && d.docId !== body.docId; });
    }
    if (docState.currentDocId === body.docId) {
      const next = (docState.documents || []).filter(function (d) { return d && !d.hidden && d.docId; })
        .sort(function (x, y) { return String(y.uploadedAt || '').localeCompare(String(x.uploadedAt || '')); })[0]; // most recent upload = primary (matches the upload path)
      if (next) {
        docState.currentDocId = next.docId;
        docState.currentFilename = next.filename || '';
        docState.currentSize = next.size || 0;
        docState.currentMimeType = next.mimeType || 'application/pdf';
        docState.currentUploadedAt = next.uploadedAt || '';
        docState.aiVerdict = next.aiVerdict || '';
        docState.aiNotes = next.aiNotes || '';
        docState.aiFindings = Array.isArray(next.aiFindings) ? next.aiFindings : [];
        docState.aiExtractedEntities = next.aiExtractedEntities || {};
        docState.aiReviewedAt = next.aiReviewedAt || '';
        docState.aiError = next.aiError || '';
      } else {
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
        docState.uwVerdict = '';
        docState.uwApprovedAt = '';
        docState.uwApprovedBy = '';
      }
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
  await syncReviewCountsToLoan(review); // Deploy 237.130 -- a removal changes Docs Collected on the Processing tile

  return json(200, { ok: true, review });
}
