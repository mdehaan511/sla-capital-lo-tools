/**
 * loan-review-auto-attach.mjs — Deploy 236.160
 *
 * Helper that runs when a loan flips to status 'approved' (i.e. the
 * borrower has just submitted the long-form loan application). It
 * looks for an existing Loan Doc Review for the loan and, if found,
 * auto-attaches:
 *
 *   - The signed Loan Application PDF (always present at this point —
 *     borrower-info-sign writes it before borrower-info-sync fires) →
 *     review.docs['loan_application']
 *
 *   - The latest Rate Sheet PDF, when one is stashed in the envelopes
 *     pipeline from a recent "Send Rate Sheet for Signature" event →
 *     review.docs['term_sheet']
 *
 * Both attachments follow the same pattern as a manual upload (see
 * loan-review-doc-upload.mjs): allocate a new docId, write the bytes
 * into the `loan-review-docs` blob with metadata, then patch the
 * review's per-slug doc state (moving any prior currentDocId into
 * history first).
 *
 * Zero-throw contract — every failure is logged and swallowed. This
 * helper is called inside the larger borrower-info-sync flow; an
 * exception here MUST NOT block the loan status flip or any
 * downstream Baseline sync.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';

const LOAN_APP_SLUG   = 'loan_application';
const RATE_SHEET_SLUG = 'term_sheet';

export async function autoAttachOnApproval({ ownerKey, client, loan, actorEmail }) {
  if (!ownerKey || !client || !loan || !loan.id) return { ok: false, reason: 'missing args' };

  try {
    const review = await _findReviewForLoan({ ownerKey, clientId: client.id, loanId: loan.id, address: loan.address });
    if (!review) {
      // No review exists yet — loan-reviews-save now attaches at CREATE time
      // (Deploy 236.744), so nothing is lost. Not an error.
      console.log('[auto-attach] no review for loan ' + loan.id + ' — skipping');
      return { ok: true, attached: 0, reason: 'no-review' };
    }
    return await attachSourceDocs({
      ownerKey, clientId: client.id, loanId: loan.id, address: loan.address,
      review, actorEmail, save: true,
    });
  } catch (e) {
    console.error('[auto-attach] unexpected error:', e && e.message);
    return { ok: false, error: (e && e.message) || 'unknown' };
  }
}

// Deploy 236.744 — the attach core, now shared: called by the sign-time path
// above AND by loan-reviews-save at CREATE time (a review created after the
// app was signed used to get neither doc — Mike's GUC test). `save:false`
// mutates the in-memory review without a store write (the caller saves next).
export async function attachSourceDocs({ ownerKey, clientId, loanId, address, review, actorEmail, save }) {
  try {
    let attached = 0;
    const docsStore   = getStore({ name: 'loan-review-docs', consistency: 'strong' });
    const reviewStore = getStore({ name: 'loan_reviews',     consistency: 'strong' });
    const loan = { id: loanId, address };
    const client = { id: clientId };

    // ── 1. Signed Loan Application ────────────────────────────
    const signedApp = await _readSignedApp({ ownerKey, clientId: client.id, loanId: loan.id });
    if (signedApp && signedApp.bytes && review.docs && review.docs[LOAN_APP_SLUG]) {
      const filename = 'Signed Loan Application - ' + _streetOf(loan.address) + '.pdf';
      _attachToSlug({
        review, slug: LOAN_APP_SLUG, bytes: signedApp.bytes,
        filename, mimeType: 'application/pdf',
        sourceNote: 'auto-attached on approval (signed_applications)',
        actorEmail,
      });
      try {
        await docsStore.set(keySafe(review.id) + '/' + review.docs[LOAN_APP_SLUG].currentDocId, signedApp.bytes, {
          metadata: {
            reviewId:   review.id,
            slug:       LOAN_APP_SLUG,
            filename,
            mimeType:   'application/pdf',
            uploadedAt: new Date().toISOString(),
            uploadedBy: actorEmail || 'auto:approval',
            source:     'signed_applications',
          },
        });
        attached++;
      } catch (e) {
        console.warn('[auto-attach] doc-blob write failed for ' + LOAN_APP_SLUG + ':', e && e.message);
      }
    }

    // ── 2. Most-recent Rate Sheet PDF (from envelopes) ────────
    const rateSheet = await _findLatestRateSheetPdf({ ownerKey, clientId: client.id, loanId: loan.id });
    if (rateSheet && rateSheet.bytes && review.docs && review.docs[RATE_SHEET_SLUG]) {
      const filename = 'Rate Sheet - ' + _streetOf(loan.address) + '.pdf';
      _attachToSlug({
        review, slug: RATE_SHEET_SLUG, bytes: rateSheet.bytes,
        filename, mimeType: 'application/pdf',
        sourceNote: 'auto-attached on approval (envelope ' + (rateSheet.envelopeId || '?') + ')',
        actorEmail,
      });
      try {
        await docsStore.set(keySafe(review.id) + '/' + review.docs[RATE_SHEET_SLUG].currentDocId, rateSheet.bytes, {
          metadata: {
            reviewId:   review.id,
            slug:       RATE_SHEET_SLUG,
            filename,
            mimeType:   'application/pdf',
            uploadedAt: new Date().toISOString(),
            uploadedBy: actorEmail || 'auto:approval',
            source:     'envelopes:' + (rateSheet.envelopeId || ''),
          },
        });
        attached++;
      } catch (e) {
        console.warn('[auto-attach] doc-blob write failed for ' + RATE_SHEET_SLUG + ':', e && e.message);
      }
    }

    if (attached > 0 && save !== false) {
      review.updatedAt = new Date().toISOString();
      review.lastEditedBy = actorEmail || 'auto:approval';
      review.lastEditedAt = review.updatedAt;
      try { await reviewStore.setJSON(keySafe(review.id), review); }
      catch (e) { console.warn('[auto-attach] review save failed:', e && e.message); }
    }
    console.log('[auto-attach] loan ' + loan.id + ' → review ' + review.id + ' attached=' + attached);
    return { ok: true, attached, reviewId: review.id };
  } catch (e) {
    console.error('[auto-attach] unexpected error:', e && e.message);
    return { ok: false, error: (e && e.message) || 'unknown' };
  }
}

// Deploy 236.779 — general-purpose "file this PDF into the loan's review"
// helper for system-generated documents (Xactus credit reports + flood
// certs). Finds the loan's review, attaches into the slug's tray (prior
// current doc moves to documents[]), stamps documentDate + optional
// staleByDate so the doc-review expiry badge enforces validity windows,
// and saves. Returns { ok, attached, reviewId } — zero-throw.
export async function attachPdfToReviewSlug({ ownerKey, clientId, loanId, address, slug, bytes, filename, sourceNote, actorEmail, documentDate, staleByDate }) {
  try {
    if (!bytes || !bytes.length) return { ok: false, reason: 'no-bytes' };
    const review = await _findReviewForLoan({ ownerKey, clientId, loanId, address });
    if (!review) return { ok: true, attached: 0, reason: 'no-review' };
    if (!review.docs || !review.docs[slug]) return { ok: true, attached: 0, reason: 'no-slug' };
    const docsStore   = getStore({ name: 'loan-review-docs', consistency: 'strong' });
    const reviewStore = getStore({ name: 'loan_reviews',     consistency: 'strong' });
    _attachToSlug({ review, slug, bytes, filename, mimeType: 'application/pdf', sourceNote, actorEmail });
    const ds = review.docs[slug];
    if (documentDate) ds.documentDate = documentDate;
    if (staleByDate)  ds.staleByDate  = staleByDate;
    await docsStore.set(keySafe(review.id) + '/' + ds.currentDocId, bytes, {
      metadata: {
        reviewId: review.id, slug, filename, mimeType: 'application/pdf',
        uploadedAt: new Date().toISOString(), uploadedBy: actorEmail || 'auto:xactus',
        source: sourceNote || 'xactus',
      },
    });
    review.updatedAt = new Date().toISOString();
    review.lastEditedBy = actorEmail || 'auto:xactus';
    review.lastEditedAt = review.updatedAt;
    await reviewStore.setJSON(keySafe(review.id), review);
    return { ok: true, attached: 1, reviewId: review.id };
  } catch (e) {
    console.error('[attachPdfToReviewSlug] failed:', e && e.message);
    return { ok: false, error: (e && e.message) || 'unknown' };
  }
}

// ─────────────────────────────────────────────────────────────
// Private helpers

async function _findReviewForLoan({ ownerKey, clientId, loanId, address }) {
  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  // Walk the store; reviews are tiny, this is fine.
  try {
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const r = await store.get(key, { type: 'json' });
      if (!r) continue;
      // Prefer strict loanId match.
      if (r.source && String(r.source.loanId || '') === String(loanId)) return r;
      // Fall back to address match (case-insensitive normalized).
      if (address && r.address &&
          String(r.address).trim().toLowerCase() === String(address).trim().toLowerCase()) {
        return r;
      }
    }
  } catch (e) {
    console.warn('[auto-attach] review walk failed:', e && e.message);
  }
  return null;
}

async function _readSignedApp({ ownerKey, clientId, loanId }) {
  try {
    const store = getStore({ name: 'signed_applications', consistency: 'strong' });
    const key = ownerKey + '/' + keySafe(clientId) + '/' + keySafe(loanId);
    const rec = await store.get(key, { type: 'json' });
    if (rec && rec.pdfBase64) {
      return { bytes: Buffer.from(rec.pdfBase64, 'base64') };
    }
  } catch (e) {
    console.warn('[auto-attach] signed app read failed:', e && e.message);
  }
  return null;
}

async function _findLatestRateSheetPdf({ ownerKey, clientId, loanId }) {
  // The Send-for-Signature flow stashes the rate-sheet PDF bytes in
  // `envelope-pdfs` keyed by `<ownerKey>/<envelopeId>`. We pick the
  // most recently-created envelope on this loan whose first doc is
  // kind='rate_sheet' and pull its stashed PDF.
  try {
    const envelopes = getStore({ name: 'envelopes', consistency: 'strong' });
    const { blobs } = await envelopes.list({ prefix: ownerKey + '/' });
    let latest = null;
    for (const { key } of blobs) {
      const env = await envelopes.get(key, { type: 'json' });
      if (!env) continue;
      if (env.loanId !== loanId) continue;
      const firstDoc = (Array.isArray(env.docs) && env.docs[0]) || null;
      if (!firstDoc || firstDoc.kind !== 'rate_sheet') continue;
      if (!latest || (env.createdAt && env.createdAt > latest.createdAt)) {
        latest = env;
      }
    }
    if (!latest) return null;
    const pdfsStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
    const buf = await pdfsStore.get(ownerKey + '/' + latest.id, { type: 'arrayBuffer' });
    if (!buf) return null;
    return { bytes: Buffer.from(buf), envelopeId: latest.id };
  } catch (e) {
    console.warn('[auto-attach] rate sheet lookup failed:', e && e.message);
  }
  return null;
}

// Mutate the review in place to point a slug at a newly-attached doc.
// Mirrors loan-review-doc-upload's per-doc patch (history push +
// reset to pending verdict). The docId is allocated here so the
// caller can use it for the blob-store write key.
function _attachToSlug({ review, slug, bytes, filename, mimeType, sourceNote, actorEmail }) {
  const docState = review.docs[slug];
  if (!docState) return;

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
  }

  const now = new Date().toISOString();
  docState.currentDocId       = 'd_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  docState.currentFilename    = filename;
  docState.currentSize        = bytes.length;
  docState.currentMimeType    = mimeType;
  docState.currentUploadedAt  = now;
  // Reset verdict + AI state — the new doc needs its own review,
  // even though it was auto-attached. Processor still has to click
  // Approve (or run AI review).
  docState.verdict            = 'pending';
  docState.processorNotes     = sourceNote || '';
  docState.aiVerdict          = '';
  docState.aiNotes            = '';
  docState.aiFindings         = [];
  docState.aiExtractedEntities = {};
  docState.aiReviewedAt       = '';
  docState.aiError            = '';
  docState.processorOverrideReason = '';
  docState.approvedAt         = '';
  docState.approvedBy         = '';
}

function _streetOf(addr) {
  return String(addr || '').split(',')[0].trim() || 'loan';
}
