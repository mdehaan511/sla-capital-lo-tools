/**
 * loan-review-doc-move.mjs — POST /api/loan-review-doc-move
 *
 * Deploy 236.675 — re-home an uploaded document from one tray to another
 * on the same review. The motivating case (Mike): a document that landed
 * on an "Other" / custom tray (because its category wasn't recognized on
 * upload) has no rubric, so it can't be reviewed — and there was no way to
 * move it into the correct standard bucket (e.g. Appraisal) to be reviewed.
 *
 * Body: { reviewId, fromSlug, toSlug }
 *   - fromSlug: the tray the doc is currently on.
 *   - toSlug:   the destination tray. Either an EXISTING tray on the review,
 *               or a standard checklist slug for the loan type (we create the
 *               tray from the checklist so it carries the right rubric).
 * Auth: requireAuth + isProcessor (same gate as upload / retry).
 *
 * Behavior (pure re-home — NO AI here):
 *   1. Move every LIVE (non-hidden) document off fromSlug onto toSlug,
 *      preserving each doc's blob (bytes stay under the same docId; only the
 *      review's pointers move — no byte copy).
 *   2. Set toSlug.currentDocId to the first moved doc + reset its AI/verdict
 *      to a fresh "pending" so the caller re-reviews it against toSlug's rubric.
 *   3. Clean fromSlug: drop the moved docs; if it's a custom/"Other" tray with
 *      nothing left, delete the tray entirely; a standard source tray is left
 *      empty (pending) so it still shows as an outstanding requirement.
 *
 * The client immediately calls loan-review-ai-retry on toSlug so the doc is
 * reviewed with the destination's rubric (which, for a standard category,
 * always exists). Keeping the AI out of this endpoint means the move itself is
 * fast + can never fail on an AI hiccup, and reuses the battle-tested retry
 * review path (label-match rubric recovery, integrity check, etc.).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe,
} from './_shared/auth.mjs';
import { getChecklist } from './_shared/loan-review-checklists.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-doc-move error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _isCustomTray(slug, docState) {
  return (docState && docState.isCustom === true) || /^(custom_|other_)/.test(String(slug || ''));
}

// Reconstruct the live-docs array for a tray from its documents[] (new schema)
// falling back to the legacy current* fields (single-doc trays).
function _liveDocs(docState) {
  const out = [];
  const seen = {};
  if (Array.isArray(docState.documents)) {
    for (const d of docState.documents) {
      if (d && d.docId && !d.hidden && !seen[d.docId]) { seen[d.docId] = 1; out.push(d); }
    }
  }
  if (docState.currentDocId && !seen[docState.currentDocId]) {
    out.unshift({
      docId:      docState.currentDocId,
      filename:   docState.currentFilename || '',
      size:       docState.currentSize || 0,
      mimeType:   docState.currentMimeType || 'application/pdf',
      uploadedAt: docState.currentUploadedAt || '',
      hidden:     false,
    });
  }
  return out;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body || !body.reviewId || !body.fromSlug || !body.toSlug) {
    return json(400, { error: 'reviewId, fromSlug and toSlug required' });
  }
  if (body.fromSlug === body.toSlug) {
    return json(400, { error: 'Source and destination are the same tray' });
  }

  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });
  if (!review.docs) return json(400, { error: 'Review has no document trays' });

  const from = review.docs[body.fromSlug];
  if (!from) return json(400, { error: 'Source tray not on this review' });

  const moving = _liveDocs(from);
  if (!moving.length) return json(400, { error: 'No document to move on the source tray' });

  // Resolve (or create) the destination tray.
  let to = review.docs[body.toSlug];
  if (!to) {
    const entry = getChecklist(review.loanType || '').find((d) => d.slug === body.toSlug);
    if (!entry) return json(400, { error: 'Destination category not found for this loan type' });
    to = review.docs[body.toSlug] = {
      slug:       body.toSlug,
      section:    entry.section || 'loan',
      label:      entry.label || body.toSlug,
      conditions: entry.conditions || '',
      verdict:    'pending',
      documents:  [],
    };
  }
  if (!Array.isArray(to.documents)) to.documents = [];

  // Lift the destination's existing legacy currentDocId into its documents[]
  // so we don't lose it when we prepend the moved docs.
  if (to.currentDocId && !to.documents.some((d) => d && d.docId === to.currentDocId)) {
    to.documents.unshift({
      docId:      to.currentDocId,
      filename:   to.currentFilename || '',
      size:       to.currentSize || 0,
      mimeType:   to.currentMimeType || 'application/pdf',
      uploadedAt: to.currentUploadedAt || '',
      hidden:     false,
    });
  }

  // Prepend the moved docs (dedupe by docId) — most-recent-moved becomes primary.
  const movedIds = {};
  for (let i = moving.length - 1; i >= 0; i--) {
    const md = moving[i];
    movedIds[md.docId] = 1;
    to.documents = to.documents.filter((d) => !(d && d.docId === md.docId));
    to.documents.unshift({
      docId:      md.docId,
      filename:   md.filename || '',
      size:       md.size || 0,
      mimeType:   md.mimeType || 'application/pdf',
      uploadedAt: md.uploadedAt || '',
      hidden:     false,
    });
  }
  const primary = to.documents[0];
  to.currentDocId      = primary.docId;
  to.currentFilename   = primary.filename;
  to.currentSize       = primary.size;
  to.currentMimeType   = primary.mimeType;
  to.currentUploadedAt = primary.uploadedAt;
  // Fresh doc on the destination ⇒ reset AI + verdict so the caller re-reviews
  // it against THIS tray's rubric and the processor must approve again.
  to.verdict = 'pending';
  to.processorNotes = '';
  to.aiVerdict = '';
  to.aiNotes = '';
  to.aiFindings = [];
  to.aiExtractedEntities = {};
  to.aiReviewedAt = '';
  to.aiError = '';
  to.aiSkippedNoRubric = false;
  to.processorOverrideReason = '';
  to.approvedAt = '';
  to.approvedBy = '';
  if (to.hidden) to.hidden = false;  // moving a doc into a hidden tray un-hides it

  // ── Clean the source ────────────────────────────────────────────────
  from.documents = (Array.isArray(from.documents) ? from.documents : []).filter((d) => d && !movedIds[d.docId]);
  const fromLiveRemaining = from.documents.filter((d) => d && !d.hidden);

  if (_isCustomTray(body.fromSlug, from) && !fromLiveRemaining.length && !from.documents.length) {
    // Custom/"Other" tray emptied by the move — remove it entirely so it
    // doesn't linger as a rubric-less husk.
    delete review.docs[body.fromSlug];
  } else if (!fromLiveRemaining.length) {
    // Standard (or custom-with-hidden-history) tray: clear the current
    // pointer + AI/verdict so it reads as an outstanding requirement again.
    from.currentDocId = '';
    from.currentFilename = '';
    from.currentSize = 0;
    from.currentMimeType = '';
    from.currentUploadedAt = '';
    from.verdict = 'pending';
    from.aiVerdict = '';
    from.aiNotes = '';
    from.aiFindings = [];
    from.aiExtractedEntities = {};
    from.aiReviewedAt = '';
    from.aiError = '';
    from.approvedAt = '';
    from.approvedBy = '';
  } else {
    // Other live docs remain — just repoint current* to the first survivor.
    const surv = fromLiveRemaining[0];
    from.currentDocId      = surv.docId;
    from.currentFilename   = surv.filename || '';
    from.currentSize       = surv.size || 0;
    from.currentMimeType   = surv.mimeType || 'application/pdf';
    from.currentUploadedAt = surv.uploadedAt || '';
  }

  const now = new Date().toISOString();
  review.updatedAt = now;
  await reviewStore.setJSON(keySafe(review.id), review);

  return json(200, { ok: true, review, movedTo: body.toSlug, movedCount: moving.length });
}
