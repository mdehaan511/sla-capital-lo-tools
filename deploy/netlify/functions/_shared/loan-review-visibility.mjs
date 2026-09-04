/**
 * _shared/loan-review-visibility.mjs — Deploy 236.881 (Mike)
 *
 * Which document trays a LOAN OFFICER may see on their own loans.
 *
 * WHAT CHANGED, AND WHY THE LIST EXISTS
 * -------------------------------------
 * Until now the Documents tab was processor/admin only — loan-reviews-list
 * and loan-reviews-get both 403'd, and an LO saw "Document Review is
 * processor / admin only". Mike opened it to LOs, with the condition that
 * they see a NAMED SUBSET rather than the whole file:
 *
 *   Appraisals · BPOs · Tax Certs · Operating Agreements · PSA ·
 *   Lease Agreements · CDA · Term Sheet · Loan Application · Payoffs
 *
 * These are the documents an LO needs to work their own deal and talk to
 * their borrower. Everything else on the checklist — bank statements,
 * background checks, OFAC, personal financial statements, guarantor IDs,
 * credit reports — is processing's file and stays with processing.
 *
 * AN ALLOWLIST, NOT A BLOCKLIST. A category added to the checklist later
 * is invisible to LOs until someone deliberately adds it here. That is the
 * safe direction to fail: a new document type is far more likely to be
 * sensitive than not, and the failure mode of a blocklist is silent
 * exposure.
 *
 * ENFORCED SERVER-SIDE. The UI hides what it shouldn't show, but hiding is
 * not access control — loan-reviews-get filters the record before it
 * leaves, and loan-review-doc-get refuses a document whose tray isn't
 * visible to the caller. An LO with the browser console open gets nothing
 * the API wouldn't hand them anyway.
 */
import { isProcessor } from './auth.mjs';

/**
 * The visible set, by checklist slug.
 *
 * Grouped by the category Mike named so the mapping is auditable — several
 * of his categories cover more than one tray, and those judgement calls
 * should be visible rather than buried in a flat list.
 */
export const LO_VISIBLE_SLUGS = [
  // Appraisals — the report, its paid receipt, and the independence report.
  // An LO fielding "did the appraisal come in?" needs all three.
  'appraisal', 'appraisal_receipt', 'air',

  // BPOs
  'bpo_valuation',

  // Tax Certs
  'tax_certificate',

  // Operating Agreements
  'operating_agreement',

  // PSA (purchase and sale agreement)
  'psa',

  // Lease Agreements
  'lease_agreements',

  // CDA
  'cda_report',

  // Term Sheet
  'term_sheet',

  // Loan Application
  'loan_application',

  // Payoffs — the ordered demand AND the existing mortgage statements the
  // payoff figure comes from. An LO asking "what's the payoff?" wants both.
  'payoff_demand', 'mortgage_statements_payoffs',
];

const _VISIBLE = new Set(LO_VISIBLE_SLUGS);

/**
 * Strip a portfolio tray's per-property suffix.
 *
 * Portfolio reviews split collateral per property as "<slug>__p<i>"
 * (Deploy 236.782). A per-property Lease Agreements tray is still a Lease
 * Agreements tray, so it resolves against the same allowlist rather than
 * silently failing the check and hiding a document the LO is entitled to.
 */
export function baseSlug(slug) {
  return String(slug || '').replace(/__p\d+$/, '');
}

/**
 * Does this user see EVERY tray? Staff do — admin, super_admin, processor
 * and senior_lo all resolve through isProcessor().
 */
export function seesAllTrays(user) {
  return isProcessor(user);
}

/** May this user see this one tray? */
export function canSeeSlug(user, slug) {
  if (seesAllTrays(user)) return true;
  return _VISIBLE.has(baseSlug(slug));
}

/**
 * Return a copy of the review with `docs` narrowed to what this user may
 * see. Staff get the record untouched.
 *
 * Copies rather than mutating: the caller often holds the record it just
 * read from the store, and a filtered copy must never be what gets written
 * back — that would delete the hidden trays for everyone.
 */
export function filterReviewForUser(review, user) {
  if (!review || seesAllTrays(user)) return review;
  const docs = {};
  let hidden = 0;
  for (const slug of Object.keys(review.docs || {})) {
    if (canSeeSlug(user, slug)) docs[slug] = review.docs[slug];
    else hidden++;
  }
  return Object.assign({}, review, {
    docs,
    // Tell the UI it is looking at a subset, so it can say so plainly
    // rather than implying the loan has only ten documents.
    _loFiltered: true,
    _hiddenTrayCount: hidden,
  });
}
