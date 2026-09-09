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
 *
 * Deploy 236.849-863 — ALSO the self-heal for APP-GENERATED documents
 * (Mike's rule): anything the platform generates — signed loan application,
 * signed rate sheet, credit report, flood cert, and whatever comes next —
 * files into its tray as the MOST RECENT item, even over an occupied tray
 * (the previous doc moves to tray history). Every heal is guarded by a
 * newer-than-current check so repeat page opens are no-ops. When adding a
 * new generated-document type: attach at generation time via
 * attachPdfToReviewSlug (replace-as-current), and add a guarded backfill
 * here so docs generated before the review existed still land.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe,
} from './_shared/auth.mjs';
import { getChecklist, portfolioCollateralEntries } from './_shared/loan-review-checklists.mjs';
// Deploy 236.921 — the review re-derives its portfolio properties from the
// LOAN on page open; the loan is found by loan id (client ids go stale).
import { locateLoan } from './_shared/loan-locate.mjs';

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
    // Deploy 236.877 — CARRY THE LABEL AND RUBRIC. A tray built here used to
    // hold neither, on the assumption that the frontend's DOC_META would
    // supply them. DOC_META covers 58 of the checklist's 78 slugs, so the
    // other 21 rendered as their raw slug with no description —
    // "foreign_entity_registration", "property_mgmt_summary" — sitting next
    // to properly-named trays like Term Sheet (Mike's screenshot).
    //
    // The per-property branch below has always stamped these, with a comment
    // noting per-property slugs "aren't in the frontend DOC_META". That is
    // true of ANY tray whose slug nobody remembered to add. Every tray is now
    // self-describing, so a new checklist item renders correctly the moment
    // it exists and DOC_META becomes a nicety rather than a second list to
    // keep in sync.
    label: item.label || item.slug,
    conditions: item.conditions || '',
    section: item.section || 'loan',
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

/**
 * Deploy 236.921 (Mike: "This loan is a portfolio but only appears to have
 * document collection for 1 property.")
 *
 * review.properties was written ONCE, when the review was created, from the
 * loan as it was that day. 2524 Hawthorne's review was created on Aug 24 as a
 * single-property RTL; on Sept 9 the loan became a three-property portfolio.
 * syncMissingCategories only expands per property when the REVIEW already
 * says portfolio, and nothing ever re-derived that from the loan — so the
 * other two properties never got a single tray.
 *
 * This adopts the loan's properties into the review when the loan knows more
 * than the review does. Then the existing per-property expansion below does
 * the rest. Two things it is careful about:
 *
 *   - A shared BASE collateral tray (appraisal, sow, psa, …) blocks
 *     per-property expansion of that slug, and may hold documents. Deleting
 *     it would lose them; leaving it shows the same category twice (once
 *     shared, once per property). It becomes PROPERTY 1's tray instead —
 *     the loan's primary address is properties[0], and everything uploaded
 *     while the loan was single-property belonged to that address.
 *   - Custom / "Other" trays are left untagged; the UI shows those under
 *     every property tab as shared, which is what they are.
 *
 * Pure: mutates the review, returns what it did. Exported for the gate.
 */
export function adoptPortfolioFromLoan(review, loan) {
  const out = { adopted: false, from: 0, to: 0, migrated: [] };
  if (!review || !loan) return out;
  const props = Array.isArray(loan.properties) ? loan.properties : [];
  if (!loan.isPortfolio || props.length < 2) return out;
  const have = Array.isArray(review.properties) ? review.properties : [];
  out.from = have.length;
  if (have.length >= props.length) return out;

  review.properties = props.map((p, i) => ({
    index: i,
    label: (have[i] && have[i].label) || 'Property ' + (i + 1),
    address: (p && p.address) || (have[i] && have[i].address) || '',
  }));
  review.isPortfolio = true;
  out.to = review.properties.length;
  out.adopted = true;

  // Base collateral trays → Property 1.
  review.docs = review.docs || {};
  const p0 = review.properties[0] || {};
  for (const slug of Object.keys(review.docs)) {
    const tray = review.docs[slug];
    if (!tray || typeof tray !== 'object') continue;
    if (tray.isCustom) continue;                          // shared by design
    if (/__p\d+$/.test(slug)) continue;                   // already per-property
    if (String(tray.section || '') !== 'collateral') continue;
    if (tray.propertyIndex != null) continue;
    const pslug = slug + '__p0';
    if (review.docs[pslug]) continue;                     // would clobber — leave it
    const moved = { ...tray, slug: pslug, propertyIndex: 0, propertyLabel: p0.label || 'Property 1', propertyAddress: p0.address || '' };
    moved.history = Array.isArray(tray.history) ? tray.history.slice() : [];
    moved.history.push({ ts: new Date().toISOString(), action: 'portfolio_adopt',
      note: 'Loan became a ' + props.length + '-property portfolio; this tray now belongs to ' + (p0.label || 'Property 1') + '.' });
    review.docs[pslug] = moved;
    delete review.docs[slug];
    out.migrated.push(slug);
  }
  return out;
}

// The actual backfill, pure + exported so it's unit-testable (Deploy 236.782).
// Mutates review.docs in place; returns { added, relabeled } — Deploy
// 236.877 widened it from a bare array because a label-only heal changes
// nothing the caller could otherwise detect.
export function syncMissingCategories(review) {
  if (!review.docs) review.docs = {};
  const checklist = getChecklist(review.loanType || '');
  const _isPortfolioReview = Array.isArray(review.properties) && review.properties.length > 1;
  const added = [];
  let relabeled = 0;

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

  // Deploy 236.877 — heal trays that predate the label fix above. Every
  // review created before this deploy has label-less trays, and they render
  // as raw slugs; adding the field only to NEW trays would leave every
  // existing loan looking wrong forever. Fills BLANKS ONLY, so a custom
  // tray's own label and any processor edit are untouched.
  const byId = {};
  for (const item of checklist) if (item && item.slug) byId[item.slug] = item;
  for (const slug of Object.keys(review.docs)) {
    const tray = review.docs[slug];
    if (!tray || tray.isCustom) continue;
    // Per-property trays carry "<slug>__p<i>"; their metadata comes from the
    // base checklist entry.
    const base = byId[slug] || byId[String(slug).replace(/__p\d+$/, '')];
    if (!base) continue;
    if (!tray.label)      { tray.label = base.label || slug; relabeled++; }
    if (!tray.conditions) { tray.conditions = base.conditions || ''; }
    if (!tray.section)    { tray.section = base.section || 'loan'; }
  }

  // The caller only persists when something changed, so a label-only pass has
  // to report itself — otherwise every review would heal in memory, render
  // correctly once, and come back wrong on the next load.
  return { added, relabeled };
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

  // Deploy 236.921 — let the review catch up with a loan that became a
  // portfolio after the review existed. Best-effort: a loan we can't find
  // simply means no adoption this time.
  let portfolio = { adopted: false, from: 0, to: 0, migrated: [] };
  let loanTypeMismatch = '';
  try {
    const src = review.source || {};
    if (src.loanId) {
      const found = await locateLoan({
        ownerKey: src.ownerKey ? keySafe(src.ownerKey) : '', clientId: src.clientId || '', loanId: src.loanId,
      });
      if (found && found.loan) {
        portfolio = adoptPortfolioFromLoan(review, found.loan);
        const lt = String(found.loan.toolType || '').toLowerCase();
        if (lt && review.loanType && lt !== String(review.loanType).toLowerCase()) loanTypeMismatch = review.loanType + ' → loan is ' + lt;
      }
    }
  } catch (e) { console.warn('loan-review-sync-categories: portfolio adopt skipped:', e && e.message); }

  const { added, relabeled } = syncMissingCategories(review);

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
      if (la) {
        const app = await readSignedApp({ ownerKey: keySafe(src.ownerKey), clientId: src.clientId, loanId: src.loanId });
        // 236.863 (Mike) — the CURRENT signed application always files as the
        // tray's most recent item, even over an occupied tray (a re-signed
        // app supersedes whatever sits there; the old copy goes to history).
        // Byte-length equality is the attach fingerprint (same convention as
        // the truth-refresh reattach), so repeat page opens are no-ops.
        if (app && app.bytes &&
            (!la.currentDocId || Number(la.currentSize || 0) !== app.bytes.length)) {
          heals.push({ slug: 'loan_application', bytes: app.bytes,
            filename: 'Signed Loan Application - ' + street + '.pdf', note: 'auto-attached on page open (signed_applications)' });
        }
      }
      const ts = review.docs.term_sheet;
      if (ts) {
        const rs = await findLatestRateSheetPdf({ ownerKey: keySafe(src.ownerKey), clientId: src.clientId, loanId: src.loanId });
        if (rs && rs.bytes) {
          // 236.854 — also REPLACE the tray's copy when a NEWER completed
          // (signed) envelope exists: the envelope-sign attach hook can be
          // missed (a warm pre-deploy instance served the signature on
          // Locust Ave), and a re-signed sheet after a guarantor change must
          // supersede the flagged old one. Old doc goes to tray history.
          const _curEnvM = /envelope (env_[A-Za-z0-9_]+)/.exec(String(ts.processorNotes || ''));
          const _curEnv = _curEnvM ? _curEnvM[1] : '';
          const _newerSigned = !!(ts.currentDocId && rs.completedAt &&
            rs.envelopeId && rs.envelopeId !== _curEnv &&
            rs.completedAt > String(ts.currentUploadedAt || ''));
          if (!ts.currentDocId || _newerSigned) {
            heals.push({ slug: 'term_sheet', bytes: rs.bytes,
              filename: (rs.signed ? 'Signed Rate Sheet - ' : 'Rate Sheet - ') + street + '.pdf',
              note: 'auto-attached on page open (envelope ' + (rs.envelopeId || '?') + ')' });
          }
        }
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
      // (2b) Deploy 236.862 (Mike) — credit reports / flood certs that only
      // reached the verifications store (pull before the review existed, or
      // a missed pull-time attach) backfill into their trays on page open.
      // attachExistingVerifications is empty-tray-guarded, so an occupied
      // tray is never touched and repeat opens are no-ops.
      try {
        const { attachExistingVerifications } = await import('./_shared/loan-review-auto-attach.mjs');
        const vr = await attachExistingVerifications({
          ownerKey: keySafe(src.ownerKey), loanId: src.loanId, review,
          actorEmail: user.email,
        });
        if (vr && vr.attached) healed += vr.attached;
      } catch (e) {
        console.warn('sync-categories: verification backfill failed (non-fatal):', e && e.message);
      }

      // (3) auto-attached but never AI-graded → queue now.
      for (const slug of ['loan_application', 'term_sheet']) {
        if (healQueue.includes(slug)) continue;
        const ds = review.docs[slug];
        if (!ds || !ds.currentDocId || ds.aiReviewing) continue;
        if (ds.verdict !== 'pending' || ds.aiVerdict || ds.aiError) continue;
        // 236.854 — the truth-refresh reattach writes 'point of truth
        // refreshed (...)' notes; those trays were auto-attached too.
        if (!/^(auto-attached|point of truth refreshed)/i.test(String(ds.processorNotes || ''))) continue;
        markAiQueued(review, slug);
        healQueue.push(slug);
      }
    }
  } catch (e) {
    console.warn('sync-categories: source-doc heal failed (non-fatal):', e && e.message);
  }

  if (added.length || relabeled || healed || healQueue.length || portfolio.adopted) {
    review.updatedAt = new Date().toISOString();
    await reviewStore.setJSON(keySafe(review.id), review);
  }
  if (healQueue.length) {
    try {
      const { queueAiReviews } = await import('./_shared/loan-review-auto-attach.mjs');
      await queueAiReviews(review.id, healQueue);
    } catch (e) { console.warn('sync-categories: AI queue failed (non-fatal):', e && e.message); }
  }

  return json(200, {
    portfolio, loanTypeMismatch: loanTypeMismatch || undefined, ok: true, review, added, relabeled, healed, aiQueued: healQueue });
}
