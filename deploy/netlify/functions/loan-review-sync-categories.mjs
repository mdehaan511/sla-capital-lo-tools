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
import { getChecklist, portfolioCollateralEntries } from './_shared/loan-review-checklists.mjs';

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

// The actual backfill, pure + exported so it's unit-testable (Deploy 236.782).
// Mutates review.docs in place; returns the list of slugs it added.
export function syncMissingCategories(review) {
  if (!review.docs) review.docs = {};
  const checklist = getChecklist(review.loanType || '');
  const _isPortfolioReview = Array.isArray(review.properties) && review.properties.length > 1;
  const added = [];

  // Deploy 236.782 — portfolio reviews keep collateral split per property
  // ("<slug>__p<i>", from loan-reviews-save's create-time expansion). Backfill
  // any per-property tray that's missing: this retro-adds the five
  // guaranteed portfolio docs (SOW, Purchase Agreement, Lease Agreements,
  // Evidence of Insurance, Insurance Invoice — see PORTFOLIO_EXTRA_COLLATERAL)
  // to reviews created before this deploy, and it means a collateral category
  // added to the checklist later expands per property instead of landing as a
  // single shared base tray (the pre-236.782 behavior).
  if (_isPortfolioReview) {
    for (const item of portfolioCollateralEntries(review.loanType || '')) {
      if (!item || !item.slug) continue;
      // A shared BASE tray for this slug (legacy sync add — may hold docs)
      // covers the category already; don't double it up per property.
      if (review.docs[item.slug]) continue;
      review.properties.forEach((p, idx) => {
        const i = (p && p.index != null) ? p.index : idx;
        const pslug = item.slug + '__p' + i;
        if (review.docs[pslug]) return;     // already present (incl. hidden) — leave it
        const tray = _blankStandardTray(item);
        tray.slug = pslug;
        // Per-property trays are self-describing (their slug isn't in the
        // frontend DOC_META) — carry label/rubric/property tags like the
        // create-time expansion does.
        tray.section = 'collateral';
        tray.label = item.label;
        tray.conditions = item.conditions || '';
        tray.propertyIndex = i;
        tray.propertyLabel = (p && p.label) || ('Property ' + (i + 1));
        tray.propertyAddress = (p && p.address) || '';
        review.docs[pslug] = tray;
        added.push(pslug);
      });
    }
  }

  for (const item of checklist) {
    if (!item || !item.slug) continue;
    // Deploy 236.690/236.782 — portfolio collateral is handled per property
    // above; never (re-)add a base single collateral tray on a portfolio review.
    if (_isPortfolioReview && item.section === 'collateral') continue;
    if (review.docs[item.slug]) continue;   // already present (incl. hidden) — leave it
    review.docs[item.slug] = _blankStandardTray(item);
    added.push(item.slug);
  }
  return added;
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

  const added = syncMissingCategories(review);

  // Deploy 236.849 — self-heal the two source-doc trays on page open:
  // (1) an EMPTY term_sheet tray backfills from the loan's rate-sheet
  //     envelope (signed/stamped copy preferred — a sheet signed before the
  //     review existed never attached because the unsigned stash was deleted
  //     at completion), (2) an EMPTY loan_application tray backfills from
  //     signed_applications, and (3) an auto-attached doc that never got its
  //     AI review (pre-236.849 attaches left trays ungraded forever) gets it
  //     queued now. Idempotent: only empty trays attach, and the AI queue is
  //     gated on "auto-attached + never graded + not already running".
  const healQueue = [];
  let healed = 0;
  try {
    const src = review.source || {};
    if (src.ownerKey && src.loanId) {
      const { readSignedApp, findLatestRateSheetPdf, attachToSlug, markAiQueued } =
        await import('./_shared/loan-review-auto-attach.mjs');
      const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
      const street = String(review.address || '').split(',')[0].trim() || 'loan';
      const heals = [];
      const la = review.docs.loan_application;
      if (la && !la.currentDocId) {
        const app = await readSignedApp({ ownerKey: keySafe(src.ownerKey), clientId: src.clientId, loanId: src.loanId });
        if (app && app.bytes) heals.push({ slug: 'loan_application', bytes: app.bytes,
          filename: 'Signed Loan Application - ' + street + '.pdf', note: 'auto-attached on page open (signed_applications)' });
      }
      const ts = review.docs.term_sheet;
      if (ts && !ts.currentDocId) {
        const rs = await findLatestRateSheetPdf({ ownerKey: keySafe(src.ownerKey), clientId: src.clientId, loanId: src.loanId });
        if (rs && rs.bytes) heals.push({ slug: 'term_sheet', bytes: rs.bytes,
          filename: (rs.signed ? 'Signed Rate Sheet - ' : 'Rate Sheet - ') + street + '.pdf',
          note: 'auto-attached on page open (envelope ' + (rs.envelopeId || '?') + ')' });
      }
      for (const h of heals) {
        attachToSlug({ review, slug: h.slug, bytes: h.bytes, filename: h.filename,
          mimeType: 'application/pdf', sourceNote: h.note, actorEmail: user.email });
        await docsStore.set(keySafe(review.id) + '/' + review.docs[h.slug].currentDocId, h.bytes, {
          metadata: { reviewId: review.id, slug: h.slug, filename: h.filename, mimeType: 'application/pdf',
            uploadedAt: new Date().toISOString(), uploadedBy: 'auto:sync-heal', source: h.note },
        });
        markAiQueued(review, h.slug);
        healQueue.push(h.slug);
        healed++;
      }
      // (3) auto-attached but never AI-graded → queue now.
      for (const slug of ['loan_application', 'term_sheet']) {
        if (healQueue.includes(slug)) continue;
        const ds = review.docs[slug];
        if (!ds || !ds.currentDocId || ds.aiReviewing) continue;
        if (ds.verdict !== 'pending' || ds.aiVerdict || ds.aiError) continue;
        if (!/^auto-attached/i.test(String(ds.processorNotes || ''))) continue;
        markAiQueued(review, slug);
        healQueue.push(slug);
      }
    }
  } catch (e) {
    console.warn('sync-categories: source-doc heal failed (non-fatal):', e && e.message);
  }

  if (added.length || healed || healQueue.length) {
    review.updatedAt = new Date().toISOString();
    await reviewStore.setJSON(keySafe(review.id), review);
  }
  if (healQueue.length) {
    try {
      const { queueAiReviews } = await import('./_shared/loan-review-auto-attach.mjs');
      await queueAiReviews(review.id, healQueue);
    } catch (e) { console.warn('sync-categories: AI queue failed (non-fatal):', e && e.message); }
  }

  return json(200, { ok: true, review, added, healed, aiQueued: healQueue });
}
