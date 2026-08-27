/**
 * loan-review-doc-upload-chunk.mjs — POST /api/loan-review-doc-upload-chunk
 *
 * Deploy 236.766 — CHUNKED upload for files too big for the normal path.
 *
 * Why: loan-review-doc-upload takes the whole file as base64 in the JSON body,
 * and Netlify caps a function request at ~6MB — base64 inflates ~33%, so the
 * real ceiling is ~4.2MB raw. An **executed closing package** is routinely
 * 10–50MB, so LOs got "too large" and nothing stored (the Executed Closing
 * Documents tray then looked filed but was empty). This endpoint takes the file
 * in ~3MB slices and assembles them server-side.
 *
 * Two actions on one endpoint:
 *   1. CHUNK    { reviewId, slug, uploadId, chunkIndex, totalChunks, contentBase64 }
 *               → stores loan-review-chunks/<uploadId>/<index>
 *   2. FINALIZE { reviewId, slug, uploadId, totalChunks, filename, mimeType,
 *                 sizeBytes, mode?, replaceDocIds?, finalize:true }
 *               → concatenates every chunk into loan-review-docs/<reviewId>/<docId>,
 *                 patches the review's tray exactly like the normal upload, then
 *                 deletes the chunk blobs.
 *
 * AI: a noReview tray (Executed Closing Documents) is stored only. Any other
 * tray hands off to loan-review-ai-background (15-min budget) — a chunked file
 * is by definition too big to review inside the sync budget.
 *
 * Auth: requireAuth + isProcessor (same gate as the normal upload).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { getChecklist } from './_shared/loan-review-checklists.mjs';

// Assembled-file ceiling. Generous for a signed closing package while keeping
// the finalize call's memory + runtime inside the function budget.
const MAX_TOTAL_BYTES = 80 * 1024 * 1024;
const MAX_CHUNKS = 40;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-doc-upload-chunk error:', e);
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
  if (!body.reviewId) return json(400, { error: 'reviewId required' });
  if (!body.slug)     return json(400, { error: 'slug required' });
  if (!body.uploadId) return json(400, { error: 'uploadId required' });

  const uploadId = keySafe(String(body.uploadId));
  const chunkStore = getStore({ name: 'loan-review-chunks', consistency: 'strong' });

  // ── 1. Store one chunk ──────────────────────────────────────────
  if (body.finalize !== true) {
    const idx = Number(body.chunkIndex);
    const total = Number(body.totalChunks);
    if (!Number.isInteger(idx) || idx < 0) return json(400, { error: 'chunkIndex must be a non-negative integer' });
    if (!Number.isInteger(total) || total <= 0 || total > MAX_CHUNKS) {
      return json(400, { error: 'totalChunks must be 1–' + MAX_CHUNKS + ' (file too large to upload in slices)' });
    }
    if (!body.contentBase64) return json(400, { error: 'contentBase64 required' });
    let bytes;
    try { bytes = Buffer.from(body.contentBase64, 'base64'); }
    catch (e) { return json(400, { error: 'contentBase64 is not valid base64' }); }
    if (!bytes.length) return json(400, { error: 'Empty chunk' });
    await chunkStore.set(uploadId + '/' + String(idx).padStart(3, '0'), bytes);
    return json(200, { ok: true, chunkIndex: idx, bytes: bytes.length });
  }

  // ── 2. Finalize: assemble + patch the review ────────────────────
  const total = Number(body.totalChunks);
  if (!Number.isInteger(total) || total <= 0 || total > MAX_CHUNKS) return json(400, { error: 'totalChunks invalid' });

  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });
  if (!review.docs || !review.docs[body.slug]) return json(400, { error: 'slug not in checklist for this review' });

  // Pull every chunk back and concatenate in order.
  const parts = [];
  let totalBytes = 0;
  for (let i = 0; i < total; i++) {
    const key = uploadId + '/' + String(i).padStart(3, '0');
    const buf = await chunkStore.get(key, { type: 'arrayBuffer' }).catch(() => null);
    if (!buf) return json(400, { error: 'Missing chunk ' + i + ' of ' + total + ' — please re-upload the file.' });
    const b = Buffer.from(buf);
    totalBytes += b.length;
    if (totalBytes > MAX_TOTAL_BYTES) return json(413, { error: 'Assembled file exceeds ' + (MAX_TOTAL_BYTES / 1024 / 1024) + 'MB' });
    parts.push(b);
  }
  const bytes = Buffer.concat(parts, totalBytes);

  const docId = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const now = new Date().toISOString();
  const filename = String(body.filename || 'upload.pdf');
  const mimeType = String(body.mimeType || 'application/pdf');

  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  await docsStore.set(keySafe(body.reviewId) + '/' + docId, bytes, {
    metadata: {
      reviewId: body.reviewId, slug: body.slug, filename, mimeType,
      uploadedAt: now, uploadedBy: normalizeEmail(user.email),
    },
  });

  // Patch the tray — mirrors loan-review-doc-upload's documents[]/current* logic.
  const docState = review.docs[body.slug];
  if (!Array.isArray(docState.documents)) docState.documents = [];
  if (docState.currentDocId && !docState.documents.some((d) => d && d.docId === docState.currentDocId)) {
    docState.documents.unshift({
      docId: docState.currentDocId, filename: docState.currentFilename || '',
      size: docState.currentSize || 0, mimeType: docState.currentMimeType || 'application/pdf',
      uploadedAt: docState.currentUploadedAt || '', hidden: false,
    });
  }
  const incomingMode = String(body.mode || '').toLowerCase();
  if (incomingMode === 'replace') {
    const targets = Array.isArray(body.replaceDocIds) ? body.replaceDocIds : [];
    const hideAll = targets.length === 0 || targets.indexOf('ALL') >= 0;
    docState.documents.forEach((d) => { if (d && (hideAll || targets.indexOf(d.docId) >= 0)) d.hidden = true; });
  }
  docState.documents.unshift({ docId, filename, size: bytes.length, mimeType, uploadedAt: now, hidden: false });
  docState.currentDocId      = docId;
  docState.currentFilename   = filename;
  docState.currentSize       = bytes.length;
  docState.currentMimeType   = mimeType;
  docState.currentUploadedAt = now;
  docState.verdict = 'pending';
  docState.processorNotes = '';
  docState.aiFindings = [];
  docState.aiExtractedEntities = {};
  docState.aiError = '';
  docState.processorOverrideReason = '';
  docState.approvedAt = '';
  docState.approvedBy = '';

  // Storage-only tray → filed, never reviewed. Anything else → background review.
  const checklistEntry = getChecklist(review.loanType || '').find((d) => d.slug === body.slug);
  const isNoReview = !!(checklistEntry && checklistEntry.noReview) || docState.noReview === true;
  let queuedBackground = false;
  if (isNoReview) {
    docState.noReview = true;
    docState.aiVerdict = 'stored';
    docState.aiNotes = 'Filed for record-keeping. This tray is not AI-reviewed.';
    docState.aiReviewedAt = now;
    docState.aiReviewing = false;
  } else {
    docState.aiVerdict = '';
    docState.aiNotes = '';
    docState.aiReviewedAt = '';
    docState.aiReviewing = true;   // the page polls until the background fn writes a verdict
    queuedBackground = true;
  }

  const _uploaded = docState.documents.find((x) => x && x.docId === docId);
  if (_uploaded) {
    _uploaded.aiVerdict = docState.aiVerdict || '';
    _uploaded.aiNotes = docState.aiNotes || '';
    _uploaded.aiReviewedAt = docState.aiReviewedAt || '';
  }

  review.docs[body.slug] = docState;
  review.updatedAt = now;
  review.lastEditedBy = normalizeEmail(user.email);
  review.lastEditedAt = now;
  await reviewStore.setJSON(keySafe(body.reviewId), review);

  // Best-effort chunk cleanup (the doc is already safely stored).
  for (let i = 0; i < total; i++) {
    chunkStore.delete(uploadId + '/' + String(i).padStart(3, '0')).catch(() => {});
  }

  if (queuedBackground) {
    try {
      const base = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
      const auth = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('authorization') || '') : '';
      await fetch(base + '/.netlify/functions/loan-review-ai-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': auth },
        body: JSON.stringify({ reviewId: body.reviewId, slug: body.slug, docId }),
      });
    } catch (e) {
      console.error('loan-review-doc-upload-chunk: background review kickoff failed:', e && e.message);
    }
  }

  return json(200, { ok: true, review, docId, bytes: bytes.length, aiReviewing: queuedBackground });
}
