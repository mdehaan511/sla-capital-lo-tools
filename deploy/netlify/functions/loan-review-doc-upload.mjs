/**
 * loan-review-doc-upload.mjs — POST /api/loan-review-doc-upload
 *
 * Store a single uploaded document under a review. Phase 1 accepts
 * base64-encoded PDF bytes in the JSON body (no multipart needed).
 *
 * Body:
 *   {
 *     reviewId, slug,
 *     filename, mimeType, sizeBytes,
 *     contentBase64,   // base64-encoded file bytes
 *   }
 *
 * Behavior:
 *   1. Allocates a new docId (`d_<ts>_<rand>`).
 *   2. Writes raw bytes to loan-review-docs/<reviewId>/<docId>.
 *   3. PATCHes the review record:
 *        - Moves any prior current* fields into docs[slug].history.
 *        - Sets new currentDocId / currentFilename / etc.
 *        - Resets verdict to 'pending' (the new upload hasn't been
 *          AI-reviewed yet; processor must approve again).
 *   4. Returns the updated review record so the UI can render the
 *      new tray state without a refetch.
 *
 * Phase 2 will plug Claude vision in here BEFORE the response so the
 * UI gets aiVerdict + aiNotes back in the same round-trip.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

// Hard cap upload size to keep Netlify Functions happy. Most loan docs
// are < 5MB; appraisals can run larger. If this becomes a problem we'll
// switch to signed-URL direct uploads to Netlify Blobs.
const MAX_BYTES = 25 * 1024 * 1024;

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-review-doc-upload error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (!body.reviewId) return json(400, { error: 'reviewId required' });
  if (!body.slug)     return json(400, { error: 'slug required' });
  if (!body.contentBase64) return json(400, { error: 'contentBase64 required' });

  // Validate review exists + slug is part of its checklist.
  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });
  if (!review.docs || !review.docs[body.slug]) {
    return json(400, { error: 'slug not in checklist for this review' });
  }

  // Decode the file bytes.
  let bytes;
  try {
    bytes = Buffer.from(body.contentBase64, 'base64');
  } catch (e) {
    return json(400, { error: 'contentBase64 is not valid base64' });
  }
  if (bytes.length > MAX_BYTES) {
    return json(413, { error: 'File too large; max is ' + (MAX_BYTES / 1024 / 1024) + 'MB' });
  }
  if (bytes.length === 0) {
    return json(400, { error: 'Empty file' });
  }

  const docId = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const docKey = keySafe(body.reviewId) + '/' + docId;
  const now = new Date().toISOString();

  // Store the raw bytes alongside metadata.
  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  await docsStore.set(docKey, bytes, {
    metadata: {
      reviewId: body.reviewId,
      slug: body.slug,
      filename: String(body.filename || ''),
      mimeType: String(body.mimeType || 'application/pdf'),
      uploadedAt: now,
      uploadedBy: normalizeEmail(user.email),
    },
  });

  // Update the review's per-doc state.
  const docState = review.docs[body.slug];

  // If there was a prior upload, push it into history before overwriting.
  if (docState.currentDocId) {
    const histEntry = {
      docId: docState.currentDocId,
      filename: docState.currentFilename || '',
      uploadedAt: docState.currentUploadedAt || '',
      verdict: docState.verdict || 'pending',
      processorNotes: docState.processorNotes || '',
      aiVerdict: docState.aiVerdict || '',
      aiNotes: docState.aiNotes || '',
      approvedAt: docState.approvedAt || '',
      approvedBy: docState.approvedBy || '',
    };
    docState.history = Array.isArray(docState.history) ? docState.history.concat([histEntry]) : [histEntry];
  }

  docState.currentDocId = docId;
  docState.currentFilename = String(body.filename || '');
  docState.currentSize = bytes.length;
  docState.currentMimeType = String(body.mimeType || 'application/pdf');
  docState.currentUploadedAt = now;
  // New upload resets verdict — even if AI re-runs auto-approve, the
  // processor still has to click Approve again on the new doc.
  docState.verdict = 'pending';
  docState.processorNotes = '';
  docState.aiVerdict = '';
  docState.aiNotes = '';
  docState.processorOverrideReason = '';
  docState.approvedAt = '';
  docState.approvedBy = '';

  review.docs[body.slug] = docState;
  review.updatedAt = now;
  review.lastEditedBy = normalizeEmail(user.email);
  review.lastEditedAt = now;

  await reviewStore.setJSON(keySafe(body.reviewId), review);

  return json(200, { ok: true, review, docId });
}
