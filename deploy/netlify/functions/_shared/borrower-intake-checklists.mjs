/**
 * _shared/borrower-intake-checklists.mjs — Deploy 236.518
 *
 * Borrower-facing document-intake lists (Mike's spec). Each item maps to the
 * SAME review slug the processor's Document Review uses, so a borrower upload
 * lands directly in the processor's loan_review — real-time AI feedback for the
 * borrower, one accept/reject surface for the processor.
 *
 * Slugs differ by program (DSCR uses voided_check_ach / ein_letter; RTL uses
 * voided_check / ein_or_w9), so the two lists are defined explicitly against
 * the real loan-review-checklists slugs. `assignment_agreement` isn't in the
 * DSCR processor checklist, so the borrower-upload endpoint seeds it on demand
 * (using the `conditions` fallback here) when the item is uploaded.
 *
 * Item shape:
 *   { slug, label, hint?, optional?, multi?, templateUrl?, conditions? }
 *     optional   — "if applicable"; never blocks completion
 *     multi      — expects more than one file (e.g. DL front + back)
 *     templateUrl— a downloadable template link (SOW)
 *     conditions — AI-review rubric fallback when the slug isn't in getChecklist
 */

export const SOW_TEMPLATE_URL = '/templates/SOW-Template.xlsx';

// Shared borrower-facing items that exist in BOTH programs (same concept,
// program-specific slug filled per list below).
const RTL_ITEMS = [
  { slug: 'guarantor_id',               label: "Driver's License (Front & Back)", hint: 'Upload both the front and the back of the ID for each guarantor.', multi: true },
  { slug: 'bank_stmt_current',          label: "Bank Statement — this month",  hint: 'Your most recent monthly statement.' },
  { slug: 'bank_stmt_previous',         label: "Bank Statement — last month",   hint: 'The statement for the month before.' },
  { slug: 'psa',                        label: 'Purchase & Sale Agreement',     hint: 'The signed PSA for the subject property.' },
  { slug: 'assignment_agreement',       label: 'Assignment Contract',           hint: 'Only if this is an assignment / wholesale deal.', optional: true },
  { slug: 'sow',                        label: 'Statement of Work',             hint: 'Your rehab budget + line-item scope. Use our template below.', templateUrl: SOW_TEMPLATE_URL },
  { slug: 'voided_check',               label: 'Voided Check',                  hint: 'A voided check for the account your payments will come from.' },
  { slug: 'articles_of_organization',   label: 'Articles of Organization',      hint: 'The recorded Articles for your LLC.' },
  { slug: 'certificate_of_good_standing', label: 'Certificate of Good Standing', hint: 'Dated within the last 90 days.' },
  { slug: 'operating_agreement',        label: 'Operating Agreement',           hint: 'Signed operating agreement for the entity.' },
  { slug: 'ein_or_w9',                  label: 'EIN Letter',                    hint: 'The IRS EIN assignment letter (or a W-9).' },
];

const DSCR_ITEMS = [
  { slug: 'guarantor_id',               label: "Driver's License (Front & Back)", hint: 'Upload both the front and the back of the ID for each guarantor.', multi: true },
  { slug: 'bank_stmt_current',          label: "Bank Statement — this month",  hint: 'Your most recent monthly statement.' },
  { slug: 'bank_stmt_previous',         label: "Bank Statement — last month",   hint: 'The statement for the month before.' },
  { slug: 'psa',                        label: 'Purchase & Sale Agreement',     hint: 'The signed PSA for the subject property.' },
  // Not in the DSCR processor checklist — seeded on demand by the upload endpoint.
  { slug: 'assignment_agreement',       label: 'Assignment Contract',           hint: 'Only if this is an assignment / wholesale deal.', optional: true,
    conditions: 'Buyer matches borrower; seller matches the PSA; all parties signed.' },
  { slug: 'voided_check_ach',           label: 'Voided Check',                  hint: 'A voided check for the account your payments will come from.' },
  { slug: 'articles_of_organization',   label: 'Articles of Organization',      hint: 'The recorded Articles for your LLC.' },
  { slug: 'certificate_of_good_standing', label: 'Certificate of Good Standing', hint: 'Dated within the last 90 days.' },
  { slug: 'operating_agreement',        label: 'Operating Agreement',           hint: 'Signed operating agreement for the entity.' },
  { slug: 'ein_letter',                 label: 'EIN Letter',                    hint: 'The IRS EIN assignment letter.' },
  { slug: 'lease_agreements',           label: 'Lease Agreements',              hint: 'Current signed lease(s) for the property.' },
  { slug: 'evidence_of_insurance',      label: 'Evidence of Insurance',         hint: 'The insurance binder or declarations page.' },
];

export function borrowerChecklist(loanType) {
  const t = String(loanType || '').toLowerCase();
  return t === 'dscr' ? DSCR_ITEMS : RTL_ITEMS; // GUC/other → RTL default
}

// The set of slugs a borrower is allowed to upload to for a loan type.
export function borrowerSlugSet(loanType) {
  return new Set(borrowerChecklist(loanType).map((i) => i.slug));
}

// Look up a single borrower item by slug (for its label/conditions fallback).
export function borrowerItem(loanType, slug) {
  return borrowerChecklist(loanType).find((i) => i.slug === slug) || null;
}
