/**
 * loan-review-ai-background.mjs — POST /api/loan-review-ai-background
 *
 * Deploy 236.754 — Netlify BACKGROUND function (name ends in `-background`, so
 * Netlify returns 202 immediately and runs it up to 15 minutes). Reviews a doc
 * that was stored but could NOT be reviewed in the 26s sync upload budget (a
 * long Operating Agreement / appraisal that tripped the 22s Claude timeout).
 *
 * loan-review-doc-upload fires this fire-and-forget when reviewDocument returns
 * error:'timeout'; the tray is left aiReviewing:true and the doc-review page
 * polls until this writes the verdict and clears the flag.
 *
 * Body: { reviewId, slug, docId? }.  Auth: requireAuth + isProcessor (the
 * upload forwards the user's Authorization header). Mirrors loan-review-ai-retry
 * (the "review a stored doc" flow) but with a long reviewDocument timeout and it
 * clears docState.aiReviewing on every outcome so the UI never spins forever.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { getChecklist, staleAfterFor } from './_shared/loan-review-checklists.mjs';
import { reviewDocument } from './_shared/anthropic-doc-review.mjs';
import { analyzeDocIntegrity, classifyDocCategory, mergeIntegrity } from './_shared/doc-integrity.mjs';
// Deploy 236.768 — this path must run the per-field auto-grab too. A large BPO
// is handed here by the upload, and without this the BPO's aivBpo / arvBpo were
// never written — exactly the big BPOs the feature exists for.
import { fieldsForSlug } from './_shared/uw-field-map.mjs';
import { buildProposals, writeFieldProposals, bpoAlertFor, felonyAlertFor } from './_shared/uw-field-write.mjs';

// Background functions get ~15 min; give the Claude call 5 min of headroom.
const BG_TIMEOUT_MS = 5 * 60 * 1000;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-ai-background error:', e);
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

  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });

  const docState = review.docs && review.docs[body.slug];
  if (!docState) return json(400, { error: 'slug not on this review' });
  if (!docState.currentDocId) return json(400, { error: 'No document uploaded for this tray yet' });
  if (docState.noReview) return json(200, { ok: true, skipped: 'noReview' });

  // Resolve the target doc (a specific docId, else the tray's current/primary).
  const _liveEntries = Array.isArray(docState.documents) ? docState.documents.filter((d) => d && !d.hidden) : [];
  let targetDocId = docState.currentDocId;
  let targetEntry = _liveEntries.find((d) => d.docId === docState.currentDocId) || null;
  if (body.docId) {
    const t = _liveEntries.find((d) => d.docId === String(body.docId));
    if (t) { targetEntry = t; targetDocId = t.docId; }
  }
  const isCurrentTarget = (targetDocId === docState.currentDocId);
  const now0 = new Date().toISOString();

  // Deploy 236.762 — RE-READ + surgical merge instead of writing back the
  // stale in-memory copy. This function holds the review across a
  // minutes-long Claude call; writing the whole stale record back was
  // reverting every concurrent change (processor approvals, borrower
  // uploads, doc moves/deletes) made while it ran. Now: fetch fresh, patch
  // ONLY this tray/doc, and stamp tray-level fields only if the reviewed
  // doc is still the tray's current one.
  async function _saveTrayPatch(patch, integrity, costCents) {
    const fresh = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
    if (!fresh || !fresh.docs || !fresh.docs[body.slug]) return null; // review/tray deleted meanwhile — drop result
    const fd = fresh.docs[body.slug];
    const entries = Array.isArray(fd.documents) ? fd.documents : [];
    const entry = entries.find((d) => d && d.docId === targetDocId) || null;
    if (entry) { Object.assign(entry, patch); if (integrity) entry.integrity = integrity; }
    if (fd.currentDocId === targetDocId) {
      Object.assign(fd, patch);
      if (integrity) fd.integrity = integrity;
    } else if (!entry) {
      return null; // doc replaced AND entry gone — nothing to attach the result to
    }
    if (costCents) {
      fd.aiCostCents    = Number(fd.aiCostCents || 0) + Number(costCents);
      fresh.aiCostCents = Number(fresh.aiCostCents || 0) + Number(costCents);
    }
    fresh.updatedAt = new Date().toISOString();
    await reviewStore.setJSON(keySafe(fresh.id), fresh);
    return fresh;
  }

  // Helper: clear the "reviewing" flag on the tray + the doc entry, then save.
  async function _clearReviewingAndSave(extra) {
    await _saveTrayPatch(Object.assign({ aiReviewing: false }, extra || {}));
  }

  // Fetch the stored bytes.
  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  const r = await docsStore.getWithMetadata(keySafe(body.reviewId) + '/' + keySafe(targetDocId), { type: 'arrayBuffer' });
  if (!r || !r.data) {
    await _clearReviewingAndSave({ aiVerdict: 'issues', aiNotes: 'Document bytes not found in storage for background review.', aiError: 'bytes_missing', aiReviewedAt: now0 });
    return json(404, { error: 'Document bytes not found' });
  }
  const bytes = Buffer.from(r.data);
  const mimeType = (r.metadata && r.metadata.mimeType) || (targetEntry && targetEntry.mimeType) || docState.currentMimeType || 'application/pdf';

  // Resolve rubric (checklist entry, or the tray's own stored conditions).
  const checklist = getChecklist(review.loanType || '');
  let checklistEntry = checklist.find((d) => d.slug === body.slug);
  if (!checklistEntry && docState.label) {
    const _lbl = String(docState.label).toLowerCase().replace(/\s+/g, ' ').trim();
    checklistEntry = checklist.find((d) => String(d.label || '').toLowerCase().replace(/\s+/g, ' ').trim() === _lbl) || null;
  }
  const docLabel      = (checklistEntry && checklistEntry.label) || docState.label || body.slug;
  const docConditions = (checklistEntry && checklistEntry.conditions) || docState.conditions || '';
  const _rubric = String(docConditions).trim();
  if (!_rubric) {
    await _clearReviewingAndSave({ aiVerdict: 'needs_manual_review', aiNotes: 'No verification rubric is configured for this document type, so it could not be auto-reviewed — manual review required.', aiFindings: [], aiExtractedEntities: {}, aiReviewedAt: now0, aiError: '', aiSkippedNoRubric: true });
    return json(200, { ok: true, review });
  }

  // Optional context PDFs (program guidelines, then investor; + signed loan app).
  let guidelinesBytes = null;
  {
    const gStore = getStore({ name: 'loan-review-guidelines', consistency: 'eventual' });
    const gKeys = [];
    if (review.loanType) gKeys.push(String(review.loanType).toLowerCase().trim());
    if (review.investor) gKeys.push(String(review.investor).toLowerCase().trim());
    for (const k of gKeys) {
      if (!k) continue;
      try { const g = await gStore.get(k, { type: 'arrayBuffer' }); if (g) { guidelinesBytes = Buffer.from(g); break; } }
      catch (e) { console.warn('loan-review-ai-background: guidelines fetch failed for ' + k + ':', e && e.message); }
    }
  }
  let loanAppBytes = null;
  if (review.source && review.source.loanId && review.source.clientId && review.source.ownerKey) {
    try {
      const appStore = getStore({ name: 'signed_applications', consistency: 'eventual' });
      const appKey = review.source.ownerKey + '/' + keySafe(review.source.clientId) + '/' + keySafe(review.source.loanId);
      const rec = await appStore.get(appKey, { type: 'json' });
      if (rec && rec.pdfBase64) loanAppBytes = Buffer.from(rec.pdfBase64, 'base64');
    } catch (e) { console.warn('loan-review-ai-background: signed-app fetch failed:', e && e.message); }
  }

  const ctx = _buildLoanContext(review);
  const now = new Date().toISOString();
  const _docCategory = classifyDocCategory(body.slug, docLabel);
  const _runIntegrity = (_docCategory === 'financial' || _docCategory === 'id');
  let _forensics = null;
  if (_runIntegrity) {
    try { _forensics = analyzeDocIntegrity(bytes, mimeType, _docCategory); }
    catch (e) { console.warn('loan-review-ai-background: integrity forensics failed (non-fatal):', e && e.message); }
  }

  // Deploy 236.768 — same auto-grab spec the sync upload uses, folded into this
  // review call (no extra latency). Only for reviews tied to a real loan.
  const _canWriteFields = !!(review.source && review.source.kind === 'existing' &&
    review.source.clientId && review.source.loanId && review.source.ownerKey);
  const _extractSpec = _canWriteFields ? fieldsForSlug(body.slug) : null;
  const _extractFields = (Array.isArray(_extractSpec) && _extractSpec.length)
    ? _extractSpec.map(function (f) { return { key: f.key, label: f.label }; })
    : undefined;

  let aiResult;
  try {
    aiResult = await reviewDocument({
      bytes, mimeType, docLabel, docConditions,
      loanContext: ctx, investor: review.investor || '',
      guidelinesBytes, loanAppBytes,
      extractFields: _extractFields,
      integrityCheck: _runIntegrity, docCategory: _docCategory,
      timeoutMs: BG_TIMEOUT_MS,
    });
  } catch (e) {
    console.error('loan-review-ai-background: reviewDocument threw:', e && e.message);
    await _clearReviewingAndSave({ aiVerdict: 'issues', aiNotes: 'Background AI review threw an exception: ' + ((e && e.message) || 'unknown'), aiFindings: [], aiExtractedEntities: {}, aiReviewedAt: now, aiError: (e && e.message) || 'exception' });
    return json(500, { error: 'AI review failed' });
  }

  const _integrity = _runIntegrity ? Object.assign(mergeIntegrity(_forensics, aiResult.integrity), { checkedAt: now }) : null;
  const ee = aiResult.extractedEntities || {};
  const _ok = {
    aiReviewing: false,
    aiVerdict: aiResult.verdict,
    aiNotes: aiResult.summary,
    aiFindings: aiResult.findings || [],
    aiExtractedEntities: ee,
    aiReviewedAt: now,
    aiError: aiResult.error || '',
  };
  // Promote the 236.165 date fields + recompute the stale-by date (parity with
  // the upload/retry paths) so the tray's expiry badge is correct.
  if (typeof ee.documentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.documentDate)) _ok.documentDate = ee.documentDate;
  if (typeof ee.expirationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.expirationDate)) _ok.expirationDate = ee.expirationDate;
  const _stale = staleAfterFor(body.slug, _ok.documentDate || docState.documentDate, _ok.expirationDate || docState.expirationDate);
  if (_stale) _ok.staleByDate = _stale;
  if (typeof ee.dateNotes === 'string') _ok.dateNotes = ee.dateNotes;

  // Deploy 236.768 — persist the per-field auto-grab (incl. the BPO's aivBpo /
  // arvBpo) and the BPO reprice alert, exactly like the sync upload path.
  const _props = buildProposals(_extractSpec, aiResult.extractedFields, docLabel);
  _ok.aiExtractedFields = aiResult.extractedFields || {};
  const _bpoAlert = bpoAlertFor(body.slug, _props, review.snapshotLoan);
  if (_bpoAlert !== null) _ok.bpoAlert = _bpoAlert;
  // Deploy 236.777 — felony hard stop on a background check (RTL + DSCR).
  const _felAlert = felonyAlertFor(body.slug, _props);
  if (_felAlert !== null) _ok.felonyAlert = _felAlert;

  // Deploy 236.762 — fresh-read merge (see _saveTrayPatch); the stale
  // whole-record write here was the concurrency clobber.
  const saved = await _saveTrayPatch(_ok, _integrity, aiResult.costCents || 0);

  // Write the loan fields AFTER the review is saved, so a proposal-write failure
  // can never lose the review itself (same ordering as the upload path).
  if (_props && _canWriteFields) {
    try { await writeFieldProposals(review.source, _props, normalizeEmail(user.email)); }
    catch (e) { console.error('loan-review-ai-background: field-proposal write failed:', e && e.message); }
  }
  return json(200, { ok: true, review: saved || review, dropped: !saved });
}

// Mirror of the helper in loan-review-ai-retry (kept inline per the codebase
// pattern for these small review helpers). MUST match its shape exactly — the
// object keys feed reviewDocument's prompt.
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
