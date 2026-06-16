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
import { getChecklist } from './_shared/loan-review-checklists.mjs';
import { reviewDocument } from './_shared/anthropic-doc-review.mjs';

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
  docState.aiFindings = [];
  docState.aiExtractedEntities = {};
  docState.aiReviewedAt = '';
  docState.aiError = '';
  docState.processorOverrideReason = '';
  docState.approvedAt = '';
  docState.approvedBy = '';

  // Deploy 236.76 (Phase 2a) — auto-run Claude vision against the new
  // upload before responding. Per Mike's spec the default behavior is
  // auto-review on every upload (no manual trigger button). The
  // verdict comes back as advisory — the processor still has to
  // click Approve / Override / Flag Issues to finalize.
  //
  // Looks up the doc's conditions from the checklist by slug so the
  // rubric is server-side source of truth (not whatever the client
  // happened to send). Loan context comes from the review's
  // snapshotted client + loan record.
  const checklist = getChecklist(review.loanType || '');
  const docMeta = checklist.find(function (d) { return d.slug === body.slug; }) || { label: body.slug, conditions: '' };
  const ctx = buildLoanContext(review);
  // Deploy 236.77 — attach the investor's underwriting guidelines PDF
  // (if uploaded by an admin via the guidelines-admin page). The
  // Anthropic helper marks it cache_control: ephemeral so subsequent
  // calls in the same 5-min window only pay ~10% of the guidelines
  // input cost. Failure to fetch is non-fatal — review still runs
  // against the per-doc rubric alone.
  let guidelinesBytes = null;
  if (review.investor) {
    try {
      const guidelinesStore = getStore({ name: 'loan-review-guidelines', consistency: 'eventual' });
      const g = await guidelinesStore.get(String(review.investor).toLowerCase().trim(), { type: 'arrayBuffer' });
      if (g) guidelinesBytes = Buffer.from(g);
    } catch (e) {
      console.warn('loan-review-doc-upload: guidelines fetch failed:', e && e.message);
    }
  }
  try {
    const aiResult = await reviewDocument({
      bytes,
      mimeType: docState.currentMimeType,
      docLabel: docMeta.label,
      docConditions: docMeta.conditions,
      loanContext: ctx,
      investor: review.investor || '',
      guidelinesBytes,
    });
    docState.aiVerdict = aiResult.verdict;
    docState.aiNotes = aiResult.summary;
    docState.aiFindings = aiResult.findings || [];
    docState.aiExtractedEntities = aiResult.extractedEntities || {};
    docState.aiReviewedAt = now;
    docState.aiError = aiResult.error || '';
    docState.aiCostCents = (Number(docState.aiCostCents || 0) + Number(aiResult.costCents || 0));
    review.aiCostCents = Number(review.aiCostCents || 0) + Number(aiResult.costCents || 0);
  } catch (e) {
    console.error('loan-review-doc-upload: AI review threw, continuing:', e && e.message);
    docState.aiVerdict = 'issues';
    docState.aiNotes = 'AI review threw an exception: ' + (e && e.message || 'unknown');
    docState.aiError = 'exception';
    docState.aiReviewedAt = now;
  }

  review.docs[body.slug] = docState;
  review.updatedAt = now;
  review.lastEditedBy = normalizeEmail(user.email);
  review.lastEditedAt = now;

  await reviewStore.setJSON(keySafe(body.reviewId), review);

  return json(200, { ok: true, review, docId });
}

// Build the loan-context object sent to Claude. Pulls from the
// review's snapshot (set at create time by loan-reviews-save.mjs)
// so the AI is judging against the underwritten loan, not whatever
// the LO has since changed on the underlying record.
function buildLoanContext(review) {
  const loan = review.sourceLoanSnapshot || {};
  const fd   = loan.formData || {};
  const client = review.sourceClientSnapshot || {};
  function pick(k) {
    if (loan[k] != null && loan[k] !== '') return loan[k];
    if (fd[k]   != null && fd[k]   !== '') return fd[k];
    return '';
  }
  const borrowerName = ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || review.borrowerName || '';
  return {
    loanAmount:    pick('loanAmt') || review.loanAmount || '',
    address:       pick('address') || review.address || '',
    borrowerName:  borrowerName,
    borrowerEmail: client.email || '',
    entityName:    client.entityName || '',
    loanType:      review.loanType || '',
    fundingDate:   pick('fundingDate') || review.expectedCloseDate || '',
  };
}
