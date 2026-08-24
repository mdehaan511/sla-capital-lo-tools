/**
 * loan-review-sync-categories.mjs — POST /api/loan-review-sync-categories
 *
 * Deploy 236.677 — self-healing backfill: add any STANDARD checklist
 * categories that are missing from an existing review as empty pending
 * trays. Reviews snapshot the checklist at CREATION, so a review made
 * before a category was added (e.g. Insurance Invoice / Payoff Demand /
 * Proof of Security Deposit, added 236.670) never got that tray — and a
 * zip upload then fell back to a one-off "Other" custom tray per file
 * (the duplicates Mike saw). Adding the real trays lets those docs be
 * moved into the correct bucket (loan-review-doc-move) and lets future
 * uploads land there directly.
 *
 * Body: { reviewId }
 * Auth: requireAuth + isProcessor.
 *
 * Idempotent — only ADDS slugs not already on the review (never touches
 * existing trays, hidden flags, docs, or verdicts). Writes only when it
 * actually added something. Called on doc-review page open.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe,
} from './_shared/auth.mjs';
import { getChecklist } from './_shared/loan-review-checklists.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-sync-categories error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _blankStandardTray(item) {
  return {
    slug: item.slug,
    verdict: 'pending',
    required: !(item.optional || item.investor),
    processorNotes: '',
    naReason: '',
    currentDocId: '',
    currentFilename: '',
    currentSize: 0,
    currentUploadedAt: '',
    currentMimeType: '',
    aiVerdict: '',
    aiNotes: '',
    aiFindings: [],
    aiExtractedEntities: {},
    aiReviewedAt: '',
    aiError: '',
    aiCostCents: 0,
    processorOverrideReason: '',
    approvedAt: '',
    approvedBy: '',
    history: [],
    documents: [],
  };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body || !body.reviewId) return json(400, { error: 'reviewId required' });

  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });
  if (!review.docs) review.docs = {};

  const checklist = getChecklist(review.loanType || '');
  // Deploy 236.690 — on a portfolio review, collateral is split into per-property
  // trays ("<slug>__p<i>"); don't re-add the base single collateral tray.
  const _isPortfolioReview = Array.isArray(review.properties) && review.properties.length > 1;
  const added = [];
  for (const item of checklist) {
    if (!item || !item.slug) continue;
    if (review.docs[item.slug]) continue;   // already present (incl. hidden) — leave it
    if (_isPortfolioReview && item.section === 'collateral' && review.docs[item.slug + '__p0']) continue;
    review.docs[item.slug] = _blankStandardTray(item);
    added.push(item.slug);
  }

  if (added.length) {
    review.updatedAt = new Date().toISOString();
    await reviewStore.setJSON(keySafe(review.id), review);
  }

  return json(200, { ok: true, review, added });
}
