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
import { analyzeDocIntegrity, classifyDocCategory, mergeIntegrity } from './_shared/doc-integrity.mjs';
// Deploy 236.500 (Phase 3) — AI auto-grab of Underwriting / Lightning Docs
// fields. When a reviewed doc's slug maps to specific UW/Lightning fields,
// we ask the SAME review call to also extract them, then write each one onto
// the loan as an UNVERIFIED proposal for a human to confirm.
import { fieldsForSlug } from './_shared/uw-field-map.mjs';
import { writeClient } from './_shared/client-write.mjs';

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

  const user = await requireAuth(context, req);
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

  // Deploy 236.673 — auto-convert HEIC/HEIF (iPhone photos of IDs, proof of
  // citizenship, etc.) to JPEG so the AI review can read them — Anthropic doesn't
  // accept HEIC. Dynamic import + try/catch so a conversion or bundle failure only
  // affects HEIC uploads: the file still stores and simply falls back to manual
  // review. Mutating body.mimeType/filename makes every downstream step (storage,
  // AI review, integrity check) see the JPEG.
  {
    const _mimeLc = String(body.mimeType || '').toLowerCase();
    const _fnLc = String(body.filename || '').toLowerCase();
    const _isHeic = _mimeLc === 'image/heic' || _mimeLc === 'image/heif' || /\.(heic|heif)$/.test(_fnLc) ||
      (_mimeLc === 'application/octet-stream' && /\.(heic|heif)$/.test(_fnLc));
    if (_isHeic) {
      try {
        const heicConvert = (await import('heic-convert')).default;
        const jpg = await heicConvert({ buffer: bytes, format: 'JPEG', quality: 0.92 });
        bytes = Buffer.from(jpg);
        body.mimeType = 'image/jpeg';
        body.filename = String(body.filename || 'image').replace(/\.(heic|heif)$/i, '') + '.jpg';
      } catch (e) {
        console.warn('loan-review-doc-upload: HEIC→JPEG conversion failed (non-fatal):', e && e.message);
      }
    }
  }

  const docId = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const docKey = keySafe(body.reviewId) + '/' + docId;
  const now = new Date().toISOString();

  // Deploy 236.503 — filename is now finalized AFTER the AI review (once we
  // know the business / individual the doc names), via _finalizeDocName().
  // At storage time we just keep the incoming filename as a provisional; the
  // old " V<N>"-on-every-add behavior (_autoVersionFilename) is retired — a
  // V-suffix is only added on a REPLACE, and the smart name is derived from
  // the doc's OWN extracted entity, not a sibling tray doc's filename.
  const _existingDocState = review.docs[body.slug];
  const _incomingMode     = String(body.mode || '').toLowerCase();
  const _incomingFilename = String(body.filename || '');
  const computedFilename  = _incomingFilename;

  // Store the raw bytes alongside metadata.
  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  await docsStore.set(docKey, bytes, {
    metadata: {
      reviewId:   body.reviewId,
      slug:       body.slug,
      filename:   computedFilename,
      mimeType:   String(body.mimeType || 'application/pdf'),
      uploadedAt: now,
      uploadedBy: normalizeEmail(user.email),
    },
  });

  // Update the review's per-doc state.
  const docState = review.docs[body.slug];

  // Deploy 236.163 — multi-doc per tray. The legacy schema had a
  // single currentDocId per tray and pushed prior uploads into
  // history. Mike: we want multiple LIVE docs per tray with a
  // "replace or add?" modal. The new schema keeps the legacy
  // current* fields populated (= documents[0]) for backward-compat
  // with any unmodified consumer, plus a documents[] array
  // carrying every live (visible) doc on the tray with a per-
  // entry `hidden` flag for replaced ones.
  const incomingMode = _incomingMode;
  const filename = computedFilename;

  // Lift existing currentDocId into documents[] if not already present.
  if (!Array.isArray(docState.documents)) docState.documents = [];
  if (docState.currentDocId && !docState.documents.some((d) => d && d.docId === docState.currentDocId)) {
    docState.documents.unshift({
      docId:      docState.currentDocId,
      filename:   docState.currentFilename || '',
      size:       docState.currentSize || 0,
      mimeType:   docState.currentMimeType || 'application/pdf',
      uploadedAt: docState.currentUploadedAt || '',
      hidden:     false,
    });
  }

  if (incomingMode === 'replace') {
    // Hide the requested doc(s). 'ALL' or empty array means hide
    // everything currently live. Hiding never deletes — the blob
    // stays and the doc record stays in documents[] flagged hidden.
    const targets = Array.isArray(body.replaceDocIds) ? body.replaceDocIds : [];
    const hideAll = targets.length === 0 || targets.indexOf('ALL') >= 0;
    docState.documents.forEach((d) => {
      if (!d) return;
      if (hideAll || targets.indexOf(d.docId) >= 0) d.hidden = true;
    });
  } else if (incomingMode === 'add') {
    // No hiding — the existing docs stay visible alongside the new one.
  } else {
    // Legacy / no-mode upload: push prior into history (original behavior).
    if (docState.currentDocId) {
      const histEntry = {
        docId:          docState.currentDocId,
        filename:       docState.currentFilename || '',
        uploadedAt:     docState.currentUploadedAt || '',
        verdict:        docState.verdict || 'pending',
        processorNotes: docState.processorNotes || '',
        aiVerdict:      docState.aiVerdict || '',
        aiNotes:        docState.aiNotes || '',
        approvedAt:     docState.approvedAt || '',
        approvedBy:     docState.approvedBy || '',
      };
      docState.history = Array.isArray(docState.history) ? docState.history.concat([histEntry]) : [histEntry];
      // Also pop the old entry out of documents[] (we just lifted it
      // there; legacy mode should preserve the original history-only
      // shape for trays that haven't been touched by the new flow).
      docState.documents = docState.documents.filter((d) => d && d.docId !== docState.currentDocId);
    }
  }

  // Prepend the new doc as the "primary" (documents[0]) so it's
  // also the legacy currentDocId.
  docState.documents.unshift({
    docId:      docId,
    filename:   filename,
    size:       bytes.length,
    mimeType:   String(body.mimeType || 'application/pdf'),
    uploadedAt: now,
    hidden:     false,
  });

  docState.currentDocId      = docId;
  docState.currentFilename   = filename;
  docState.currentSize       = bytes.length;
  docState.currentMimeType   = String(body.mimeType || 'application/pdf');
  docState.currentUploadedAt = now;
  // Deploy 236.502 — record when the browser auto-compressed this file to
  // fit the upload limit, so the tray can flag it and a human knows the
  // stored copy is a reduced-resolution version of the original.
  docState.autoCompressed     = body.autoCompressed === true;
  docState.originalSizeBytes  = Number(body.originalSizeBytes) || 0;
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
  let checklistEntry = checklist.find(function (d) { return d.slug === body.slug; });
  // Deploy 236.673 — a doc that landed on a CUSTOM tray (because the category
  // wasn't recognized on the first upload, or predates a newly-added category)
  // used to have "no rubric". Recover a real rubric two ways: (1) match the tray's
  // LABEL to a standard checklist entry (a custom "Appraisal" tray → the standard
  // appraisal rubric); (2) fall back to the tray's own stored conditions.
  if (!checklistEntry && docState && docState.label) {
    const _lbl = String(docState.label).toLowerCase().replace(/\s+/g, ' ').trim();
    checklistEntry = checklist.find(function (d) { return String(d.label || '').toLowerCase().replace(/\s+/g, ' ').trim() === _lbl; }) || null;
  }
  const docMeta = checklistEntry || { label: (docState && docState.label) || body.slug, conditions: (docState && docState.conditions) || '' };
  // Deploy 236.590/236.673 — no rubric (empty conditions) ⇒ flag for manual review
  // (yellow) rather than trusting an unfounded AI "approved".
  const _rubric = String((checklistEntry && checklistEntry.conditions) || (docState && docState.conditions) || '').trim();
  const hasRubric = _rubric.length > 0;
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
  // Deploy 236.78 — also attach the signed Loan Application PDF as
  // a third cached document so the AI has the source-of-truth for
  // cross-references like "LLC name on this AOO must match the loan
  // app". Without this, the AI was only getting borrower / entity /
  // address from a short text context block and would say things
  // like "the loan application does not specify this LLC name" —
  // because it couldn't actually SEE the app.
  // Best-effort: stub-source reviews and loans without a signed app
  // gracefully fall back to per-doc-rubric + guidelines + text ctx.
  let loanAppBytes = null;
  if (review.source && review.source.kind === 'existing' && review.source.clientId && review.source.loanId && review.source.ownerKey) {
    try {
      const appStore = getStore({ name: 'signed_applications', consistency: 'eventual' });
      const appKey = keySafe(review.source.ownerKey) + '/' + keySafe(review.source.clientId) + '/' + keySafe(review.source.loanId);
      const appRec = await appStore.get(appKey, { type: 'json' });
      if (appRec && appRec.pdfBase64) {
        loanAppBytes = Buffer.from(appRec.pdfBase64, 'base64');
      }
    } catch (e) {
      console.warn('loan-review-doc-upload: loan app fetch failed:', e && e.message);
    }
  }
  // Deploy 236.208 — support non-PDF file types in bulk-zip uploads
  // (Word / Excel / CSV / HEIC). Claude's vision endpoint only handles
  // PDF + JPG/PNG/WEBP/GIF natively. For everything else we skip AI
  // review, store the file, and mark the doc as pending manual review.
  // Deploy 236.500 — staged UW/Lightning field proposals from this doc.
  // Filled inside the AI branch; written to the loan AFTER the review is
  // persisted so a proposal-write failure can never block the review.
  let _fieldProposals = null;   // Array<{ dataset, key, value, aiNote }>
  const mime = String(docState.currentMimeType || '').toLowerCase();
  const aiReviewable = (
    mime === 'application/pdf' ||
    mime === 'image/jpeg' || mime === 'image/jpg' ||
    mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif'
  );
  if (!aiReviewable) {
    docState.aiVerdict = 'needs_manual_review';
    docState.aiNotes = 'This file type (' + mime + ') cannot be reviewed automatically. Please review manually and approve/override.';
    docState.aiReviewedAt = new Date().toISOString();
    docState.aiSkippedForMimeType = true;
  } else if (!hasRubric) {
    // Deploy 236.590 — no rubric to verify against (custom / "Other" tray).
    // Skip the AI call entirely and flag for manual review (yellow) rather
    // than letting an unfounded "approved" render as green "looks good".
    docState.aiVerdict = 'needs_manual_review';
    docState.aiNotes = 'No verification rubric is configured for this document type, so it could not be auto-reviewed — manual review required.';
    docState.aiReviewedAt = new Date().toISOString();
    docState.aiSkippedNoRubric = true;
  } else try {
    // Deploy 236.500 — if this doc type carries specific UW/Lightning
    // fields, fold their extraction into the same review call (no extra
    // latency — the review already spends most of the Netlify budget).
    // Only meaningful for reviews tied to a real loan (existing source).
    const _canWriteFields = !!(review.source && review.source.kind === 'existing' &&
      review.source.clientId && review.source.loanId && review.source.ownerKey);
    const _extractSpec = _canWriteFields ? fieldsForSlug(body.slug) : null;
    const _extractFields = (Array.isArray(_extractSpec) && _extractSpec.length)
      ? _extractSpec.map(function (f) { return { key: f.key, label: f.label }; })
      : undefined;

    // Deploy 236.669 — document-integrity / tampering check for financial docs +
    // IDs (Mike). Deterministic forensics on the raw bytes, plus an AI math /
    // consistency pass folded into the same review call. Advisory only — surfaced
    // as a risk badge; never changes the approve/issues verdict or blocks.
    const _docCategory = classifyDocCategory(body.slug, docMeta.label);
    const _runIntegrity = (_docCategory === 'financial' || _docCategory === 'id');
    let _forensics = null;
    if (_runIntegrity) {
      try { _forensics = analyzeDocIntegrity(bytes, docState.currentMimeType, _docCategory); }
      catch (e) { console.warn('doc-integrity forensics failed (non-fatal):', e && e.message); }
    }

    const aiResult = await reviewDocument({
      bytes,
      mimeType: docState.currentMimeType,
      docLabel: docMeta.label,
      docConditions: docMeta.conditions,
      loanContext: ctx,
      investor: review.investor || '',
      guidelinesBytes,
      loanAppBytes,
      extractFields: _extractFields,
      integrityCheck: _runIntegrity,
      docCategory: _docCategory,
    });
    if (_runIntegrity) {
      docState.integrity = mergeIntegrity(_forensics, aiResult.integrity);
      docState.integrity.checkedAt = now;
    }
    docState.aiVerdict = aiResult.verdict;
    docState.aiNotes = aiResult.summary;
    docState.aiFindings = aiResult.findings || [];
    docState.aiExtractedEntities = aiResult.extractedEntities || {};
    docState.aiReviewedAt = now;
    docState.aiError = aiResult.error || '';
    docState.aiCostCents = (Number(docState.aiCostCents || 0) + Number(aiResult.costCents || 0));
    review.aiCostCents = Number(review.aiCostCents || 0) + Number(aiResult.costCents || 0);
    // Deploy 236.165 — promote the AI-extracted date fields onto
    // the top-level docState so the frontend can paint warnings
    // without reaching into aiExtractedEntities every render.
    // Stale-by date is computed from documentDate using per-slug
    // validity windows (see _staleAfterFor). Explicit expirationDate
    // always wins if the doc actually printed one.
    const ee = aiResult.extractedEntities || {};
    if (typeof ee.documentDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.documentDate)) {
      docState.documentDate = ee.documentDate;
    }
    if (typeof ee.expirationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(ee.expirationDate)) {
      docState.expirationDate = ee.expirationDate;
    }
    // Compute a derived "stale by" date the frontend uses for the
    // amber-warning band. Explicit expiration wins; otherwise
    // documentDate + per-slug staleDays. Null when we have no signal.
    const staleAfter = _staleAfterFor(body.slug, docState.documentDate, docState.expirationDate);
    if (staleAfter) docState.staleByDate = staleAfter;
    if (typeof ee.dateNotes === 'string') docState.dateNotes = ee.dateNotes;

    // Deploy 236.500 — collect the AI's per-field extraction so it can be
    // written to the loan as UNVERIFIED proposals. We keep only fields the
    // AI actually FOUND on this doc (found:true + a non-empty value); a
    // "not on this document" answer must never overwrite an existing value.
    const ef = aiResult.extractedFields || {};
    docState.aiExtractedFields = ef; // keep raw for audit/debug
    if (_extractFields && Object.keys(ef).length) {
      const specByKey = {};
      (_extractSpec || []).forEach(function (s) { specByKey[s.key] = s; });
      const props = [];
      Object.keys(ef).forEach(function (k) {
        const spec = specByKey[k];
        const got  = ef[k];
        if (!spec || !got || got.found !== true) return;
        if (got.value === null || got.value === undefined || got.value === '') return;
        props.push({
          dataset: spec.dataset,
          key:     k,
          value:   got.value,
          aiNote:  docMeta.label + (got.where ? ' — ' + got.where : ''),
        });
      });
      if (props.length) _fieldProposals = props;
    }
  } catch (e) {
    console.error('loan-review-doc-upload: AI review threw, continuing:', e && e.message);
    docState.aiVerdict = 'issues';
    docState.aiNotes = 'AI review threw an exception: ' + (e && e.message || 'unknown');
    docState.aiError = 'exception';
    docState.aiReviewedAt = now;
  }

  // Deploy 236.503 — finalize the smart display name now that the AI has
  // (maybe) extracted the business / individual this doc names. Format:
  // "DOC TYPE - Business or Individual on the doc - Category". Applied to
  // BOTH the tray's current* fields and the documents[] entry so the UI,
  // single-doc downloads, and the closer's ZIP all agree. A V-version is
  // added only on a REPLACE (never on an add). Best-effort — never throws.
  try {
    _finalizeDocName(docState, docId, {
      mode:             incomingMode,
      typeLabel:        (docState.isCustom && docState.label) ? docState.label : (docMeta.label || docState.label || body.slug),
      section:          (docMeta.section || docState.section || 'loan'),
      incomingFilename: _incomingFilename,
      entities:         docState.aiExtractedEntities || {},
    });
  } catch (e) {
    console.warn('loan-review-doc-upload: name finalize failed:', e && e.message);
  }

  review.docs[body.slug] = docState;
  review.updatedAt = now;
  review.lastEditedBy = normalizeEmail(user.email);
  review.lastEditedAt = now;

  await reviewStore.setJSON(keySafe(body.reviewId), review);

  // Deploy 236.500 — write the AI's field extractions onto the loan as
  // UNVERIFIED proposals. Done AFTER the review save + wrapped so any
  // failure is logged but never fails the upload (the review is the
  // primary deliverable; the auto-grab is a bonus the human confirms).
  let fieldsWritten = 0;
  if (_fieldProposals && _fieldProposals.length) {
    try {
      fieldsWritten = await writeFieldProposals(review.source, _fieldProposals);
    } catch (e) {
      console.error('loan-review-doc-upload: field-proposal write failed:', e && e.message);
    }
  }

  return json(200, { ok: true, review, docId, fieldsWritten });
}

// Deploy 236.500 — persist AI-extracted UW/Lightning fields onto the loan
// as unverified proposals (verified:false, isAI:true) with a provenance
// note + append-only audit entry, mirroring loan-uw-field-save.mjs's write
// shape so the UW tab renders them identically ("AI — UNVERIFIED"). We do
// NOT overwrite a field a human has already verified — human truth wins.
const _UW_AUDIT_CAP = 2000;
async function writeFieldProposals(source, proposals) {
  const ownerKey  = keySafe(source.ownerKey);
  const clientId  = source.clientId;
  const loanId    = source.loanId;
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  const client = await clientsStore.get(clientKey, { type: 'json' });
  if (!client || !Array.isArray(client.loans)) return 0;
  const idx = client.loans.findIndex(function (l) { return l && l.id === loanId; });
  if (idx < 0) return 0;

  const loan = client.loans[idx];
  const now = new Date().toISOString();
  let wrote = 0;

  proposals.forEach(function (p) {
    const dataField  = p.dataset === 'uw' ? 'uwData'  : 'lightningData';
    const auditField = p.dataset === 'uw' ? 'uwAudit' : 'lightningAudit';
    loan[dataField]  = (loan[dataField] && typeof loan[dataField] === 'object') ? loan[dataField] : {};
    loan[auditField] = Array.isArray(loan[auditField]) ? loan[auditField] : [];

    const prior = loan[dataField][p.key] || null;
    // Human truth wins: never clobber a value a person has verified.
    if (prior && prior.verified === true && prior.isAI !== true) return;
    // Don't churn the audit if the AI would write the exact same value.
    if (prior && prior.isAI === true && String(prior.value) === String(p.value)) return;

    const entry = {
      value:      p.value,
      source:     'doc',
      sourceNote: '',
      isAI:       true,
      aiNote:     p.aiNote || '',
      verified:   false,
      by:         'ai',
      byName:     'AI',
      at:         now,
    };
    loan[dataField][p.key] = entry;
    loan[auditField].push({
      key:    p.key,
      from:   prior ? prior.value : undefined,
      to:     entry.value,
      by:     'ai',
      byName: 'AI',
      isAI:   true,
      aiNote: entry.aiNote,
      at:     now,
    });
    if (loan[auditField].length > _UW_AUDIT_CAP) {
      loan[auditField] = loan[auditField].slice(loan[auditField].length - _UW_AUDIT_CAP);
    }
    wrote++;
  });

  if (!wrote) return 0;

  loan.updatedAt = now;
  client.loans[idx] = loan;
  client.updatedAt = now;
  await writeClient(ownerKey, client, { clientsStore });
  return wrote;
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

// Deploy 236.503 — _autoVersionFilename (which appended " V<N>" to EVERY
// add, deriving the base from a sibling doc's filename) is retired. Naming
// is now finalized post-AI by _finalizeDocName below; V-versions only on a
// replace. _extOf / _stripExt remain — used by the new namer.
function _extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}
function _stripExt(name) {
  return String(name || '').replace(/\.[a-z0-9]{1,8}$/i, '');
}

// ── Deploy 236.503 — smart document naming ──────────────────────────
// "DOC TYPE - Business or Individual named on the doc - Category". The
// entity comes from the doc's OWN AI extraction (llcName / borrowerName),
// NOT from a sibling tray doc's filename (the old bug). Docs that don't
// name a business/individual (tax certs, wire instructions, etc.) keep
// their source filename rather than get a misleading label.
// Short category label for the filename (Mike's spec: "Borrower", "Loan
// Docs", …) — distinct from the full section titles ("Borrower Documents").
const _SECTION_SHORT = {
  borrower:   'Borrower',
  guarantor:  'Guarantor',
  collateral: 'Collateral',
  loan:       'Loan Docs',
  closing:    'Closing',
};

function _finalizeDocName(docState, docId, opts) {
  const ext = _extOf(opts.incomingFilename) || _extOf(docState.currentFilename) || 'pdf';
  const entity = _pickEntity(opts.section, opts.entities);
  let base;
  if (entity) {
    base = [_cleanNamePart(opts.typeLabel), entity, _cleanNamePart(_SECTION_SHORT[opts.section] || '')]
      .filter(Boolean).join(' - ');
  } else {
    // No business/individual on the doc → keep the source name (minus any
    // stray trailing " V<N>"); don't invent a misleading label.
    base = _stripExt(opts.incomingFilename).replace(/\s+V\d+\s*$/i, '').trim()
        || _cleanNamePart(opts.typeLabel) || 'Document';
  }
  // Only a REPLACE gets a V-version; an "add" keeps its own distinct name.
  if (opts.mode === 'replace') {
    const hiddenCount = (docState.documents || []).filter((d) => d && d.hidden).length;
    base = base + ' V' + (hiddenCount + 1);
  }
  const finalName = _dedupeTrayFilename(docState, docId, base + '.' + ext);
  docState.currentFilename = finalName;
  const d0 = (docState.documents || []).find((d) => d && d.docId === docId);
  if (d0) d0.filename = finalName;
  return finalName;
}

// Guarantor / individual docs name the person; everything else names the
// business (LLC), each falling back to the other. Property-only docs with
// no named entity return '' (caller keeps the source filename).
function _pickEntity(section, ee) {
  ee = ee || {};
  const llc = _cleanNamePart(ee.llcName);
  const person = _cleanNamePart(ee.borrowerName);
  if (section === 'guarantor') return person || llc;
  return llc || person;
}

function _cleanNamePart(s) {
  if (!s) return '';
  const t = String(s).replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (!t || /^(null|n\/?a|none|unknown)$/i.test(t)) return '';
  return t;
}

// Avoid two docs on the same tray sharing a filename (they'd collide when
// the closer extracts the ZIP). On an exact clash append " (2)", " (3)"…
function _dedupeTrayFilename(docState, selfId, name) {
  const taken = {};
  (docState.documents || []).forEach((d) => {
    if (d && d.docId !== selfId && d.filename) taken[String(d.filename).toLowerCase()] = true;
  });
  if (!taken[name.toLowerCase()]) return name;
  const dot = name.lastIndexOf('.');
  const nameBase = dot > 0 ? name.slice(0, dot) : name;
  const nameExt  = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (taken[(nameBase + ' (' + i + ')' + nameExt).toLowerCase()]) i++;
  return nameBase + ' (' + i + ')' + nameExt;
}

// Deploy 236.165 — per-doc-type validity windows. Each rule is the
// max age a doc can have (in days) before it goes stale for closing
// purposes. Mike's spec: "bank statements expire the beginning of
// next month, Certificate of good standings are only good for 30
// days from print." Generalized here as days-from-documentDate;
// the precise EOM rule for bank statements is approximated as 60
// days (current month + next), which is conservative on the side
// of warning early. Refine later as needed.
const STALE_DAYS = {
  bank_stmt_current:           60,
  bank_stmt_previous:          60,
  certificate_of_good_standing: 30,
  entity_background_check:     90,
  guarantor_background_check:  90,
  ofac_entity:                 90,
  ofac_personal:               90,
  credit_report:              120,
  appraisal:                  120,
  appraisal_receipt:          120,
};

function _staleAfterFor(slug, documentDate, expirationDate) {
  // Explicit expiration on the doc itself always wins.
  if (typeof expirationDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(expirationDate)) {
    return expirationDate;
  }
  if (typeof documentDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(documentDate)) return '';
  const days = STALE_DAYS[String(slug || '').toLowerCase()];
  if (!days) return '';
  // Compute documentDate + days as YYYY-MM-DD. Plain Date math
  // works fine here — DST shifts are at most an hour and we're
  // doing day-granularity comparisons downstream.
  const parts = documentDate.split('-');
  const dt = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
  if (isNaN(dt.getTime())) return '';
  dt.setUTCDate(dt.getUTCDate() + days);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return y + '-' + m + '-' + d;
}
