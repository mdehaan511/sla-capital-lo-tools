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
    const attachedSlugs = [];
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
        attachedSlugs.push(LOAN_APP_SLUG);
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
        attachedSlugs.push(RATE_SHEET_SLUG);
      } catch (e) {
        console.warn('[auto-attach] doc-blob write failed for ' + RATE_SHEET_SLUG + ':', e && e.message);
      }
    }

    // Deploy 236.849 — auto-attached docs get their AI review queued instead
    // of sitting ungraded until a human clicks. Mark first (spinner shows on
    // page load), fire after the review is persisted. With save:false the
    // CALLER persists then must call queueAiReviews(reviewId, attachedSlugs).
    attachedSlugs.forEach((s) => markAiQueued(review, s));

    if (attached > 0 && save !== false) {
      review.updatedAt = new Date().toISOString();
      review.lastEditedBy = actorEmail || 'auto:approval';
      review.lastEditedAt = review.updatedAt;
      try { await reviewStore.setJSON(keySafe(review.id), review); }
      catch (e) { console.warn('[auto-attach] review save failed:', e && e.message); }
      await queueAiReviews(review.id, attachedSlugs);
    }
    console.log('[auto-attach] loan ' + loan.id + ' → review ' + review.id + ' attached=' + attached);
    return { ok: true, attached, attachedSlugs, reviewId: review.id };
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

// Deploy 236.818 — exported for the point-of-truth refresh flow
// (loan-review-refresh-background.mjs) so it can reuse the same review
// lookup / signed-app read / attach mechanics.
export { _findReviewForLoan as findReviewForLoan, _readSignedApp as readSignedApp, _attachToSlug as attachToSlug };
// Deploy 236.849 — exported for the sync-categories self-heal (backfills the
// signed rate sheet onto reviews whose term_sheet tray is still empty).
export { _findLatestRateSheetPdf as findLatestRateSheetPdf };

// Deploy 236.838 — backfill EXISTING Xactus verifications (credit reports +
// flood certs) into a review's trays. The live orders auto-attach at pull
// time (236.779), but a pull made BEFORE the loan had a Doc Review only
// landed in the verifications store — a review created afterwards started
// with empty credit/flood trays and nobody noticed the report was already
// on file. Called at review-create time (loan-reviews-save, save:false —
// the caller persists). Mutates the in-memory review; zero-throw.
export async function attachExistingVerifications({ ownerKey, loanId, review, actorEmail }) {
  let attached = 0;
  try {
    if (!ownerKey || !loanId || !review || !review.docs) return { ok: true, attached: 0 };
    // Deploy 236.863 (Mike) — app-generated docs always file as the MOST
    // RECENT tray item, even over an occupied tray. The guard is a frozen
    // per-slug cutoff (the tray's currentUploadedAt at run start): only
    // verifications ORDERED after that attach, so repeat page opens are
    // no-ops (an attached report's orderedAt predates its own attach time),
    // while a newer pull supersedes whatever sits in the tray — the old doc
    // moves to tray history, never lost. Empty tray = no cutoff = everything
    // attaches oldest-first (the original create-time behavior).
    const _cutoffFor = (slug) => {
      const ds = review.docs[slug];
      return (ds && ds.currentDocId) ? String(ds.currentUploadedAt || '') : '';
    };
    const _cutoff = {
      credit_report:     _cutoffFor('credit_report'),
      flood_certificate: _cutoffFor('flood_certificate'),
    };
    const vStore = getStore({ name: 'verifications', consistency: 'strong' });
    const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
    const vDocs = getStore({ name: 'verification-docs', consistency: 'strong' });
    const { blobs } = await vStore.list({ prefix: ownerKey + '/' });
    const hits = [];
    for (const { key } of blobs) {
      const v = await vStore.get(key, { type: 'json' }).catch(() => null);
      if (!v || v.loanId !== loanId || !v.hasPdf) continue;
      if (v.kind !== 'credit' && v.kind !== 'flood') continue;
      hits.push(v);
    }
    // Oldest first so the NEWEST report ends up as the tray's current doc
    // (earlier ones land in the tray history).
    hits.sort((a, b) => String(a.orderedAt || '').localeCompare(String(b.orderedAt || '')));
    for (const v of hits) {
      const slug = v.kind === 'credit' ? 'credit_report' : 'flood_certificate';
      if (_cutoff[slug] && String(v.orderedAt || '') <= _cutoff[slug]) continue;
      const ds = review.docs[slug];
      if (!ds) continue; // checklist without this tray
      const buf = await vDocs.get(ownerKey + '/' + v.id, { type: 'arrayBuffer' }).catch(() => null);
      if (!buf) continue;
      const bytes = Buffer.from(buf);
      const subjectName = (v.subject && v.subject.name) || '';
      // 236.862 — "[Name] - Credit Report - Soft|Hard - [date]" (Mike's
      // convention; flood mirrors it with the street).
      const _vDate = String(v.orderedAt || '').slice(0, 10);
      const filename = v.kind === 'credit'
        ? (subjectName || 'Borrower') + ' - Credit Report - ' + (v.reportType === 'SoftCheck' ? 'Soft' : 'Hard') + ' - ' + _vDate + '.pdf'
        : (_streetOf(v.address)) + ' - Flood Cert - ' + _vDate + '.pdf';
      _attachToSlug({
        review, slug, bytes, filename, mimeType: 'application/pdf',
        sourceNote: 'backfilled from verifications (' + (v.xactusReportId || v.certId || v.id) + ')',
        actorEmail: actorEmail || 'auto:verification-backfill',
      });
      if (v.orderedAt) ds.documentDate = String(v.orderedAt).slice(0, 10);
      if (v.expiresAt) ds.staleByDate = String(v.expiresAt).slice(0, 10);
      try {
        await docsStore.set(keySafe(review.id) + '/' + ds.currentDocId, bytes, {
          metadata: {
            reviewId: review.id, slug, filename, mimeType: 'application/pdf',
            uploadedAt: new Date().toISOString(),
            uploadedBy: actorEmail || 'auto:verification-backfill',
            source: 'verifications:' + v.id,
          },
        });
        attached++;
      } catch (e) {
        console.warn('[verification-backfill] doc-blob write failed for ' + slug + ':', e && e.message);
      }
    }
  } catch (e) {
    console.warn('[verification-backfill] failed (non-fatal):', e && e.message);
  }
  return { ok: true, attached };
}

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
  // Pick the most recently-created rate-sheet envelope on this loan and pull
  // its PDF. Deploy 236.849 — a COMPLETED envelope's original is DELETED from
  // `envelope-pdfs` (envelope-sign keeps only the stamped copy in
  // `envelope-final-pdfs`), so a rate sheet that was signed before the review
  // existed always came back empty here (Chance's Jimmy St loan). Read the
  // stamped final first — it's also the better document (signatures on it) —
  // then fall back to the unsigned stash (both key shapes: with and without
  // the /<docIdx> suffix; older stashes used the bare envelope id).
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
    const finalStore = getStore({ name: 'envelope-final-pdfs', consistency: 'strong' });
    const pdfsStore  = getStore({ name: 'envelope-pdfs',       consistency: 'strong' });
    const tries = [
      { store: finalStore, key: ownerKey + '/' + latest.id + '/0', signed: true },
      { store: pdfsStore,  key: ownerKey + '/' + latest.id + '/0', signed: false },
      { store: pdfsStore,  key: ownerKey + '/' + latest.id,        signed: false },
    ];
    for (const t of tries) {
      // 236.849c — these stores hold BASE64 TEXT (envelope-sign writes the
      // stamped b64 string; the send flows stash pdfBase64). Reading as
      // arrayBuffer returned the base64 characters as "PDF bytes" — the
      // attached doc was corrupt and the AI reviewer 400'd on it. Decode,
      // and verify the result actually is a PDF before attaching.
      const raw = await t.store.get(t.key).catch(() => null);
      if (!raw) continue;
      let bytes = null;
      if (typeof raw === 'string') {
        bytes = raw.slice(0, 5) === '%PDF-' ? Buffer.from(raw, 'latin1') : Buffer.from(raw, 'base64');
      } else {
        bytes = Buffer.from(raw);
      }
      if (bytes && bytes.length && bytes.slice(0, 5).toString('latin1') === '%PDF-') {
        // 236.854 — status + completion time let the sync-categories heal
        // decide "a NEWER signed sheet exists, replace the tray's copy".
        return {
          bytes, envelopeId: latest.id, signed: t.signed,
          status: latest.status || '',
          completedAt: (latest.status === 'completed' && latest.statusUpdatedAt) || '',
        };
      }
    }
    return null;
  } catch (e) {
    console.warn('[auto-attach] rate sheet lookup failed:', e && e.message);
  }
  return null;
}

// Deploy 236.849 — queue background AI reviews for freshly auto-attached docs.
// Auto-attached trays used to sit "Awaiting Review" with NO AI grade until a
// human clicked (Mike: Jimmy St loan application "couldn't be reviewed by AI"
// — it was never run). Fired with the internal HMAC so borrower-triggered
// flows (signing) can queue reviews without a staff JWT. Call AFTER the
// review has been persisted — each background reviewer re-reads it fresh.
export async function queueAiReviews(reviewId, slugs) {
  if (!reviewId || !slugs || !slugs.length) return 0;
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
  let fired = 0;
  for (const slug of slugs) {
    try {
      const { internalBgSig } = await import('./review-truth.mjs');
      const r = await fetch(base + '/.netlify/functions/loan-review-ai-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sla-internal': internalBgSig(reviewId, slug) },
        body: JSON.stringify({ reviewId, slug }),
      });
      if (r.status === 202 || r.ok) fired++;
      else console.warn('[auto-attach] AI queue for ' + slug + ' got ' + r.status);
    } catch (e) {
      console.warn('[auto-attach] AI queue failed for ' + slug + ':', e && e.message);
    }
  }
  return fired;
}

// Mark a tray as queued-for-AI so the page shows the spinner immediately
// (loan-review-ai-background clears aiReviewing on every outcome).
export function markAiQueued(review, slug) {
  const ds = review && review.docs && review.docs[slug];
  if (!ds || !ds.currentDocId) return false;
  ds.aiReviewing = true;
  ds.aiNotes = 'AI review queued (auto-attached document).';
  ds.aiError = '';
  return true;
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
