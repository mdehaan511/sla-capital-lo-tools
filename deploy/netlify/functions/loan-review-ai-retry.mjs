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
import { getChecklist, staleAfterFor } from './_shared/loan-review-checklists.mjs';
import { fieldsForSlug } from './_shared/uw-field-map.mjs';
import { buildProposals, writeFieldProposals, bpoAlertFor } from './_shared/uw-field-write.mjs';
import { reviewDocument } from './_shared/anthropic-doc-review.mjs';
import { analyzeDocIntegrity, classifyDocCategory, mergeIntegrity } from './_shared/doc-integrity.mjs';

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
  // Deploy 236.752 — storage-only trays (Executed Closing Documents) are never AI-reviewed.
  if (docState.noReview) return json(200, { ok: true, review, skipped: 'noReview' });

  // Deploy 236.689 — review a SPECIFIC document when body.docId is given, so a
  // tray holding multiple docs (e.g. two people's IDs) can be reviewed one at a
  // time. Without docId, review the tray's current (primary) doc as before.
  const _liveEntries = Array.isArray(docState.documents) ? docState.documents.filter((d) => d && !d.hidden) : [];
  let targetDocId = docState.currentDocId;
  let targetEntry = _liveEntries.find((d) => d.docId === docState.currentDocId) || null;
  if (body.docId) {
    const t = _liveEntries.find((d) => d.docId === String(body.docId));
    if (!t) return json(400, { error: 'docId is not a live document on this tray' });
    targetEntry = t;
    targetDocId = t.docId;
  }
  const isCurrentTarget = (targetDocId === docState.currentDocId);

  // Fetch the doc bytes + mime from the blob store.
  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  const blobKey = keySafe(body.reviewId) + '/' + keySafe(targetDocId);
  const r = await docsStore.getWithMetadata(blobKey, { type: 'arrayBuffer' });
  if (!r || !r.data) return json(404, { error: 'Document bytes not found in storage' });
  const bytes = Buffer.from(r.data);
  const mimeType = (r.metadata && r.metadata.mimeType) || (targetEntry && targetEntry.mimeType) || docState.currentMimeType || 'application/pdf';

  // Resolve label + conditions. Standard checklist trays look up
  // via getChecklist(); custom trays carry their own label /
  // conditions on the doc record.
  const checklist = getChecklist(review.loanType || '');
  let checklistEntry = checklist.find((d) => d.slug === body.slug);
  // Deploy 236.673 — recover a real rubric for a custom tray by matching its label
  // to a standard checklist entry (parity with loan-review-doc-upload).
  if (!checklistEntry && docState.label) {
    const _lbl = String(docState.label).toLowerCase().replace(/\s+/g, ' ').trim();
    checklistEntry = checklist.find((d) => String(d.label || '').toLowerCase().replace(/\s+/g, ' ').trim() === _lbl) || null;
  }
  const docLabel      = (checklistEntry && checklistEntry.label) || docState.label || body.slug;
  const docConditions = (checklistEntry && checklistEntry.conditions) || docState.conditions || '';

  // Deploy 236.590 — mirror the upload path: a document with no static-checklist
  // rubric (custom / "Other" tray) has nothing to verify against, so flag it for
  // manual review (yellow) instead of running the AI against empty criteria and
  // trusting an "approved". Short-circuits before the expensive context fetches.
  // Deploy 236.680 — fall back to the tray's OWN stored conditions, not just the
  // loan-type checklist entry. A doc moved into a category that isn't on this
  // loan's checklist (e.g. Lease Agreements filed onto an RTL loan via
  // loan-review-doc-move → findCategory) carries its rubric on docState.conditions;
  // without this fallback the retry wrongly short-circuited to "no rubric". Parity
  // with the upload path's _rubric resolution.
  const _retryRubric = String((checklistEntry && checklistEntry.conditions) || (docState && docState.conditions) || '').trim();
  if (!_retryRubric) {
    const nrNow = new Date().toISOString();
    const _nr = { aiVerdict: 'needs_manual_review', aiNotes: 'No verification rubric is configured for this document type, so it could not be auto-reviewed — manual review required.', aiFindings: [], aiExtractedEntities: {}, aiReviewedAt: nrNow, aiError: '', aiSkippedNoRubric: true };
    Object.assign(docState, _nr);
    if (targetEntry && targetEntry !== docState) Object.assign(targetEntry, _nr);
    await _saveReview(reviewStore, review, nrNow);
    return json(200, { ok: true, review });
  }

  // Optional context PDFs (same lookups the upload flow does).
  // Deploy 236.683 — attach guidelines by loan PROGRAM first (loanType), then
  // investor, so RTL guidelines review ALL RTLs regardless of investor (parity
  // with loan-review-doc-upload).
  let guidelinesBytes = null;
  {
    const guidelinesStore = getStore({ name: 'loan-review-guidelines', consistency: 'eventual' });
    const gKeys = [];
    if (review.loanType) gKeys.push(String(review.loanType).toLowerCase().trim());
    if (review.investor) gKeys.push(String(review.investor).toLowerCase().trim());
    for (const k of gKeys) {
      if (!k) continue;
      try {
        const g = await guidelinesStore.get(k, { type: 'arrayBuffer' });
        if (g) { guidelinesBytes = Buffer.from(g); break; }
      } catch (e) {
        console.warn('loan-review-ai-retry: guidelines fetch failed for ' + k + ':', e && e.message);
      }
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

  // Deploy 236.669 — mirror the upload path's integrity check on retry.
  const _docCategory = classifyDocCategory(body.slug, docLabel);
  const _runIntegrity = (_docCategory === 'financial' || _docCategory === 'id');
  let _forensics = null;
  if (_runIntegrity) {
    try { _forensics = analyzeDocIntegrity(bytes, mimeType, _docCategory); }
    catch (e) { console.warn('doc-integrity forensics failed (non-fatal):', e && e.message); }
  }

  // Deploy 236.768 — auto-grab spec (parity with the upload + background paths).
  const _canWriteFields = !!(review.source && review.source.kind === 'existing' &&
    review.source.clientId && review.source.loanId && review.source.ownerKey);
  const _extractSpec = _canWriteFields ? fieldsForSlug(body.slug) : null;
  const _extractFields = (Array.isArray(_extractSpec) && _extractSpec.length)
    ? _extractSpec.map(function (f) { return { key: f.key, label: f.label }; })
    : undefined;

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
      // Deploy 236.768 — Retry now runs the per-field auto-grab too, so hitting
      // ↻ Retry on an already-uploaded BPO re-pulls aivBpo / arvBpo instead of
      // needing a re-upload.
      extractFields: _extractFields,
      integrityCheck: _runIntegrity,
      docCategory: _docCategory,
    });
  } catch (e) {
    console.error('loan-review-ai-retry: AI review threw:', e && e.message);
    const _err = { aiVerdict: 'issues', aiNotes: 'AI review threw an exception: ' + (e && e.message || 'unknown'), aiFindings: [], aiExtractedEntities: {}, aiReviewedAt: now, aiError: (e && e.message) || 'unknown' };
    if (targetEntry) Object.assign(targetEntry, _err);
    if (isCurrentTarget) Object.assign(docState, _err);
    await _saveReview(reviewStore, review, now);
    return json(500, { error: 'AI review failed: ' + (e && e.message || 'unknown'), review });
  }

  // Deploy 236.689 — write the result to the reviewed doc's OWN entry (always)
  // and mirror to the tray level only when it's the current/primary doc.
  const _integrity = _runIntegrity ? Object.assign(mergeIntegrity(_forensics, aiResult.integrity), { checkedAt: now }) : null;
  const _ok = {
    aiVerdict: aiResult.verdict,
    aiNotes: aiResult.summary,
    aiFindings: aiResult.findings || [],
    aiExtractedEntities: aiResult.extractedEntities || {},
    aiReviewedAt: now,
    aiError: aiResult.error || '',
  };
  if (targetEntry) { Object.assign(targetEntry, _ok); if (_integrity) targetEntry.integrity = _integrity; }
  if (isCurrentTarget) { Object.assign(docState, _ok); if (_integrity) docState.integrity = _integrity; }
  docState.aiCostCents         = Number(docState.aiCostCents || 0) + Number(aiResult.costCents || 0);
  review.aiCostCents           = Number(review.aiCostCents || 0) + Number(aiResult.costCents || 0);

  // Promote 236.165 date fields when the retry returned them — only for the
  // current/primary doc (the tray's stale-date badge reflects it).
  if (isCurrentTarget) {
    const ee = aiResult.extractedEntities || {};
    if (typeof ee.documentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.documentDate)) {
      docState.documentDate = ee.documentDate;
    }
    if (typeof ee.expirationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.expirationDate)) {
      docState.expirationDate = ee.expirationDate;
    }
    if (typeof ee.dateNotes === 'string') docState.dateNotes = ee.dateNotes;
    // Deploy 236.738 — recompute the stale-by date here too (upload did it, the
    // retry never did), so re-running the AI review corrects an existing doc's
    // stale badge instead of leaving a stale value from an old window.
    const staleAfter = staleAfterFor(body.slug, docState.documentDate, docState.expirationDate);
    if (staleAfter) docState.staleByDate = staleAfter;
  }

  // Deploy 236.768 — persist the auto-grab (incl. the BPO's aivBpo / arvBpo) and
  // the BPO reprice alert, then write the loan fields AFTER the review is saved.
  const _props = buildProposals(_extractSpec, aiResult.extractedFields, docLabel);
  if (isCurrentTarget) {
    docState.aiExtractedFields = aiResult.extractedFields || {};
    const _bpoAlert = bpoAlertFor(body.slug, _props, review.snapshotLoan);
    if (_bpoAlert !== null) docState.bpoAlert = _bpoAlert;
  }

  await _saveReview(reviewStore, review, now);

  if (_props && _canWriteFields) {
    try { await writeFieldProposals(review.source, _props); }
    catch (e) { console.error('loan-review-ai-retry: field-proposal write failed:', e && e.message); }
  }
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
