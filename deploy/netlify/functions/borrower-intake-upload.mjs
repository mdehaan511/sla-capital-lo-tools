/**
 * borrower-intake-upload.mjs — POST /api/borrower-intake-upload
 *
 * Deploy 236.518 — Borrower Document Intake. A borrower (or, for broker
 * loans, the broker) uploads a document against a SPECIFIC checklist slug and
 * gets a REAL-TIME AI verdict so obvious problems are caught before the
 * processor ever looks. The upload lands in the loan's SAME loan_review record
 * the processor works from — so there's one accept/reject surface. Per Mike:
 * an AI-clean doc still shows "submitted — pending review"; it only leaves the
 * borrower's list when a PROCESSOR accepts it (verdict → approved).
 *
 * Body: { loanId, primaryClientId, ownerKey, slug, filename, mimeType,
 *         contentBase64, autoCompressed? }
 * Auth: canReadLoan (borrower's loan_access grant; LO/admin short-circuit).
 * Returns: { ok, reviewId, slug, docId, verdict, borrowerStatus, borrowerMessage, findings }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canReadLoan } from './_shared/access.mjs';
import { getChecklist } from './_shared/loan-review-checklists.mjs';
import { borrowerSlugSet, borrowerItem } from './_shared/borrower-intake-checklists.mjs';
import { reviewDocument } from './_shared/anthropic-doc-review.mjs';

const MAX_BYTES = 25 * 1024 * 1024;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-intake-upload error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const { loanId, primaryClientId, ownerKey, contentBase64 } = body;
  const slug = String(body.slug || '').trim();
  if (!loanId || !contentBase64) return json(400, { error: 'loanId and contentBase64 required' });
  if (!slug) return json(400, { error: 'slug required' });

  // Load the loan for the access check + loan type / context.
  let loan = null, client = null;
  try {
    if (primaryClientId && ownerKey) {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      loan = client && Array.isArray(client.loans)
        ? client.loans.find((l) => l && l.id === loanId) || null
        : null;
    }
  } catch (_) {}
  const perm = await canReadLoan(user, loan || { id: loanId, ownerKey }, { ownerKey, loanId });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  let bytes;
  try { bytes = Buffer.from(contentBase64, 'base64'); }
  catch (e) { return json(400, { error: 'contentBase64 not valid base64' }); }
  if (bytes.length === 0)       return json(400, { error: 'Empty file' });
  if (bytes.length > MAX_BYTES) return json(413, { error: 'Too large (max 25MB)' });

  // Find or create the review for this loan (same discovery as borrower-doc-upload).
  const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  let review = null;
  try {
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r) continue;
      if (r.source && r.source.loanId === loanId) { review = r; break; }
      if (r.address && loan && loan.address &&
          String(r.address).toLowerCase().trim() === String(loan.address).toLowerCase().trim()) { review = r; break; }
    }
  } catch (e) { console.warn('[borrower-intake-upload] review lookup failed:', e && e.message); }

  const loanType = String((review && review.loanType) || (loan && loan.loanType) || '').toLowerCase();
  // Only allow uploads to slugs on the borrower's own checklist.
  if (!borrowerSlugSet(loanType).has(slug)) {
    return json(400, { error: 'That document is not on your submission list.' });
  }

  if (!review) {
    review = {
      id:        'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      address:   loan ? (loan.address || '') : '',
      investor:  '', loanType, docs: {},
      sourceLoanSnapshot:   loan   || {},
      sourceClientSnapshot: client || {},
      source:    { kind: 'existing', loanId, clientId: primaryClientId || '', ownerKey: ownerKey || '' },
      borrowerName: (client ? ((client.firstName || '') + ' ' + (client.lastName || '')).trim() : ''),
      loanAmount:   loan ? (loan.loanAmt || '') : '',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      createdBy: 'auto:borrower-intake',
    };
  }
  review.docs = review.docs || {};

  const now   = new Date().toISOString();
  const docId = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const mimeType  = String(body.mimeType || 'application/pdf');
  const item      = borrowerItem(loanType, slug) || { label: slug };
  const finalName = String(body.filename || (item.label + '.pdf')).slice(0, 160);

  // Resolve the AI rubric: prefer the processor checklist's conditions, else
  // the borrower item's fallback (covers slugs not in getChecklist, e.g. DSCR
  // assignment_agreement).
  const checklist = getChecklist(loanType) || [];
  const meta = checklist.find((d) => d.slug === slug) || { label: item.label, conditions: item.conditions || '' };

  // Write the bytes.
  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  try {
    await docsStore.set(keySafe(review.id) + '/' + docId, bytes, {
      metadata: { reviewId: review.id, slug, filename: finalName, mimeType, uploadedAt: now, uploadedBy: normalizeEmail(user.email), source: 'borrower-intake' },
    });
  } catch (e) { return json(500, { error: 'Failed to write file: ' + (e && e.message || 'unknown') }); }

  // Seed / update the docState. Multi-doc trays (DL front+back) keep siblings.
  const prior = review.docs[slug] && typeof review.docs[slug] === 'object' ? review.docs[slug] : null;
  const documents = (prior && Array.isArray(prior.documents)) ? prior.documents.slice() : [];
  documents.unshift({ docId, filename: finalName, size: bytes.length, mimeType, uploadedAt: now, hidden: false });

  const docState = Object.assign({}, prior || {}, {
    slug,
    label:           (prior && prior.label) || meta.label || item.label || slug,
    section:         (prior && prior.section) || meta.section || 'borrower',
    conditions:      meta.conditions || (prior && prior.conditions) || '',
    required:        prior ? prior.required : !item.optional,
    // Processor still owns the accept — a borrower upload never sets verdict.
    verdict:         (prior && prior.verdict === 'approved') ? 'approved' : 'pending',
    processorNotes:  (prior && prior.processorNotes) || '',
    naReason:        '',
    currentDocId:    docId,
    currentFilename: finalName,
    currentSize:     bytes.length,
    currentMimeType: mimeType,
    currentUploadedAt: now,
    documents,
    history:         (prior && Array.isArray(prior.history)) ? prior.history : [],
    uploadedByBorrower: normalizeEmail(user.email),
    borrowerUploadedAt: now,
    borrowerStatus:  'submitted',      // submitted → pending processor accept
    manualReviewRequested: false,      // fresh upload clears any prior request
    manualReviewNote: '',
    // reset AI fields for the fresh upload
    aiVerdict: '', aiNotes: '', aiFindings: [], aiExtractedEntities: {},
    aiReviewedAt: '', aiError: '', processorOverrideReason: '',
    approvedAt: (prior && prior.approvedAt) || '', approvedBy: (prior && prior.approvedBy) || '',
  });

  // ── Real-time AI review (the whole point of borrower intake) ─────────
  const mime = mimeType.toLowerCase();
  const aiReviewable = (mime === 'application/pdf' || mime === 'image/jpeg' || mime === 'image/jpg'
    || mime === 'image/png' || mime === 'image/webp' || mime === 'image/gif');
  let borrowerStatus = 'submitted';
  let borrowerMessage = 'Received — submitted for review.';
  let verdict = 'received';
  let findings = [];
  if (!aiReviewable) {
    docState.aiVerdict = 'needs_manual_review';
    docState.aiNotes = 'This file type can’t be auto-checked. A processor will review it.';
    docState.aiReviewedAt = now;
    borrowerMessage = 'Received. This file type can’t be auto-checked, so a processor will review it.';
  } else {
    try {
      const ai = await reviewDocument({
        bytes, mimeType, docLabel: docState.label, docConditions: docState.conditions,
        loanContext: _loanContext(review), investor: review.investor || '',
      });
      docState.aiVerdict = ai.verdict;
      docState.aiNotes = ai.summary || '';
      docState.aiFindings = ai.findings || [];
      docState.aiExtractedEntities = ai.extractedEntities || {};
      docState.aiReviewedAt = now;
      docState.aiError = ai.error || '';
      docState.aiCostCents = Number(docState.aiCostCents || 0) + Number(ai.costCents || 0);
      review.aiCostCents = Number(review.aiCostCents || 0) + Number(ai.costCents || 0);
      verdict = ai.verdict;
      findings = (ai.findings || []).filter((f) => f && f.status === 'not_met')
        .map((f) => ({ condition: f.condition, detail: f.detail }));
      if (ai.verdict === 'approved') {
        borrowerMessage = 'Looks good! ✓ Submitted for review.';
      } else {
        // Surface the specific problem(s) in borrower-friendly language.
        const probs = findings.map((f) => f.detail || f.condition).filter(Boolean);
        borrowerMessage = (ai.summary || 'We spotted a possible issue with this document.')
          + (probs.length ? ' Specifically: ' + probs.slice(0, 3).join('; ') + '.' : '')
          + ' You can upload a corrected version, or request a manual review.';
        borrowerStatus = 'needs_fix';
      }
    } catch (e) {
      console.warn('[borrower-intake-upload] AI review threw:', e && e.message);
      docState.aiVerdict = 'needs_manual_review';
      docState.aiNotes = 'Auto-check was unavailable; a processor will review it.';
      docState.aiReviewedAt = now;
      borrowerMessage = 'Received. Our auto-check was busy, so a processor will review it.';
    }
  }
  docState.borrowerStatus = borrowerStatus;

  review.docs[slug] = docState;
  review.updatedAt = now;
  review.lastEditedBy = normalizeEmail(user.email);
  review.lastEditedAt = now;

  try { await reviewsStore.setJSON(keySafe(review.id), review); }
  catch (e) { return json(500, { error: 'Failed to save review: ' + (e && e.message || 'unknown') }); }

  return json(200, {
    ok: true, reviewId: review.id, slug, docId, filename: finalName,
    verdict, borrowerStatus, borrowerMessage, findings,
  });
}

// Minimal loan context for the AI cross-checks (borrower/entity/address/amount).
function _loanContext(review) {
  const loan = review.sourceLoanSnapshot || {};
  const client = review.sourceClientSnapshot || {};
  const fd = loan.formData || {};
  const pick = (k) => (loan[k] != null && loan[k] !== '') ? loan[k] : (fd[k] != null ? fd[k] : '');
  return {
    loanAmount:   pick('loanAmt') || review.loanAmount || '',
    address:      pick('address') || review.address || '',
    borrowerName: ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || review.borrowerName || '',
    borrowerEmail: client.email || '',
    entityName:   client.entityName || '',
    loanType:     review.loanType || '',
    fundingDate:  pick('fundingDate') || review.expectedCloseDate || '',
  };
}
