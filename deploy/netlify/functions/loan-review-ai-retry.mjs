/**
 * loan-review-ai-retry.mjs — POST /api/loan-review-ai-retry
 *
 * Deploy 236.166 — re-runs the Anthropic doc-review against an
 * already-uploaded document. Used by the per-tray "Retry AI Review"
 * button that appears when the AI failed (aiError set) OR the LO
 * just wants a fresh take after tweaking processor notes.
 *
 * Body: { reviewId, slug }
 * Auth: requireAuth + isProcessor (same gate as the upload endpoint).
 *
 * Behavior:
 *   1. Loads the review + the tray's current doc.
 *   2. Fetches the doc bytes from loan-review-docs/<reviewId>/<docId>.
 *   3. Loads checklist meta for the slug (or falls back to docState
 *      .label / .conditions for custom trays).
 *   4. Optionally pulls the investor guidelines PDF + signed loan-
 *      app PDF (same context the upload flow uses).
 *   5. Calls reviewDocument(...) and overwrites the AI fields
 *      (aiVerdict, aiNotes, aiFindings, aiExtractedEntities,
 *      aiReviewedAt, aiError, aiCostCents) on the docState.
 *   6. Promotes documentDate / expirationDate / staleByDate per
 *      236.165 so the badge updates after a successful retry.
 *
 * Does NOT touch the verdict, processorNotes, or any other
 * processor-driven field. Idempotent — every call replaces the
 * AI block with a fresh one; the cost is added to the running
 * total.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe,
} from './_shared/auth.mjs';
import { getChecklist } from './_shared/loan-review-checklists.mjs';
import { reviewDocument } from './_shared/anthropic-doc-review.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-ai-retry error:', e);
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
  if (!body || !body.reviewId || !body.slug) {
    return json(400, { error: 'reviewId and slug required' });
  }

  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });

  const docState = review.docs && review.docs[body.slug];
  if (!docState) return json(400, { error: 'slug not on this review' });
  if (!docState.currentDocId) return json(400, { error: 'No document uploaded for this tray yet' });

  // Fetch the doc bytes + mime from the blob store.
  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  const blobKey = keySafe(body.reviewId) + '/' + keySafe(docState.currentDocId);
  const r = await docsStore.getWithMetadata(blobKey, { type: 'arrayBuffer' });
  if (!r || !r.data) return json(404, { error: 'Document bytes not found in storage' });
  const bytes = Buffer.from(r.data);
  const mimeType = (r.metadata && r.metadata.mimeType) || docState.currentMimeType || 'application/pdf';

  // Resolve label + conditions. Standard checklist trays look up
  // via getChecklist(); custom trays carry their own label /
  // conditions on the doc record.
  const checklist = getChecklist(review.loanType || '');
  const checklistEntry = checklist.find((d) => d.slug === body.slug);
  const docLabel      = (checklistEntry && checklistEntry.label) || docState.label || body.slug;
  const docConditions = (checklistEntry && checklistEntry.conditions) || docState.conditions || '';

  // Optional context PDFs (same lookups the upload flow does).
  let guidelinesBytes = null;
  if (review.investor) {
    try {
      const guidelinesStore = getStore({ name: 'loan-review-guidelines', consistency: 'eventual' });
      const g = await guidelinesStore.get(String(review.investor).toLowerCase().trim(), { type: 'arrayBuffer' });
      if (g) guidelinesBytes = Buffer.from(g);
    } catch (e) {
      console.warn('loan-review-ai-retry: guidelines fetch failed:', e && e.message);
    }
  }
  let loanAppBytes = null;
  if (review.source && review.source.loanId && review.source.clientId && review.source.ownerKey) {
    try {
      const signedAppStore = getStore({ name: 'signed_applications', consistency: 'eventual' });
      const key = review.source.ownerKey + '/' + keySafe(review.source.clientId) + '/' + keySafe(review.source.loanId);
      const rec = await signedAppStore.get(key, { type: 'json' });
      if (rec && rec.pdfBase64) loanAppBytes = Buffer.from(rec.pdfBase64, 'base64');
    } catch (e) {
      console.warn('loan-review-ai-retry: signed-app fetch failed:', e && e.message);
    }
  }

  const ctx = _buildLoanContext(review);
  const now = new Date().toISOString();

  let aiResult;
  try {
    aiResult = await reviewDocument({
      bytes,
      mimeType,
      docLabel,
      docConditions,
      loanContext: ctx,
      investor: review.investor || '',
      guidelinesBytes,
      loanAppBytes,
    });
  } catch (e) {
    console.error('loan-review-ai-retry: AI review threw:', e && e.message);
    docState.aiVerdict      = 'issues';
    docState.aiNotes        = 'AI review threw an exception: ' + (e && e.message || 'unknown');
    docState.aiFindings     = [];
    docState.aiExtractedEntities = {};
    docState.aiReviewedAt   = now;
    docState.aiError        = (e && e.message) || 'unknown';
    await _saveReview(reviewStore, review, now);
    return json(500, { error: 'AI review failed: ' + (e && e.message || 'unknown'), review });
  }

  docState.aiVerdict           = aiResult.verdict;
  docState.aiNotes             = aiResult.summary;
  docState.aiFindings          = aiResult.findings || [];
  docState.aiExtractedEntities = aiResult.extractedEntities || {};
  docState.aiReviewedAt        = now;
  docState.aiError             = aiResult.error || '';
  docState.aiCostCents         = Number(docState.aiCostCents || 0) + Number(aiResult.costCents || 0);
  review.aiCostCents           = Number(review.aiCostCents || 0) + Number(aiResult.costCents || 0);

  // Promote 236.165 date fields when the retry returned them.
  const ee = aiResult.extractedEntities || {};
  if (typeof ee.documentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.documentDate)) {
    docState.documentDate = ee.documentDate;
  }
  if (typeof ee.expirationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.expirationDate)) {
    docState.expirationDate = ee.expirationDate;
  }
  if (typeof ee.dateNotes === 'string') docState.dateNotes = ee.dateNotes;

  await _saveReview(reviewStore, review, now);
  return json(200, { ok: true, review });
}

async function _saveReview(store, review, now) {
  review.updatedAt = now;
  await store.setJSON(keySafe(review.id), review);
}

// Mirror of the helper in loan-review-doc-upload.mjs — small enough
// to inline rather than pull into a shared file.
function _buildLoanContext(review) {
  const client = review.snapshotClient || {};
  const loan   = review.snapshotLoan   || {};
  const pick = (k) => loan[k] || review[k] || '';
  return {
    propertyAddress: review.address || loan.address || '',
    loanAmount:      pick('loanAmt'),
    purchasePrice:   pick('purchasePrice'),
    arv:             pick('arv'),
    rehabBudget:     pick('rehabBudget'),
    borrowerName:    ((client.firstName || '') + ' ' + (client.lastName || '')).trim(),
    entityName:      client.entityName || '',
    loanType:        review.loanType || '',
    fundingDate:     pick('fundingDate') || review.expectedCloseDate || '',
  };
}
