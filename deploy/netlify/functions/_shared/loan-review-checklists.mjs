/**
 * _shared/loan-review-checklists.mjs — Phase 1 source of truth for which
 * documents need to be reviewed per loan type, and what the human +
 * AI processors should check on each. Encoded from the user-supplied
 * "DSCR - UW Sheet - DSCR Review Template" and "RTL - UW Sheet - RTL
 * Checklist" PDFs.
 *
 * Slug conventions (stable IDs — DO NOT RENAME once a review uses them):
 *   - lowercase, snake_case, no spaces
 *   - section prefix avoided (the `section` field already groups them)
 *
 * `optional: true` means the doc is "(if applicable)" — the processor
 * must explicitly mark it N/A with a reason if it doesn't apply to
 * this loan; otherwise an upload is required.
 *
 * `purchaseOnly: true` means the doc is only required for purchase
 * transactions (vs refi). For Phase 1 the processor decides this; we
 * don't yet infer purpose from the linked loan record.
 *
 * `investor: 'corrfirst'` (etc.) flags docs that only apply to a
 * specific investor. Phase 1 defaults: Diya = DSCR, Colchis = RTL.
 * If the loan ships to a different investor, the processor can
 * override which docs are required from the loan settings.
 */

export const SECTIONS = [
  { key: 'borrower',  label: 'Borrower Documents'  },
  { key: 'guarantor', label: 'Guarantor Documents' },
  { key: 'collateral',label: 'Collateral Documents'},
  { key: 'loan',      label: 'Loan Documents'      },
  { key: 'closing',   label: 'Closing Documents'   },
];

// Deploy 236.212 — DSCR checklist rewritten to match Mike's list
// derived from the Diya Underwriting Guidelines (Term - 2026.01.29).
// Slug identifiers preserved for docs that carry over (Operating
// Agreement, Articles, EIN, Bank Stmts, PFS, PSA, etc.) so existing
// reviews continue to render; renamed / new slugs are minted fresh.
// Any prior slug not on this list is removed from the checklist —
// old reviews retain their docs but won't require them going forward.
export const DSCR_DOCS = [
  // ── Borrower ──────────────────────────────────────────────────
  { slug: 'operating_agreement', label: 'Operating Agreement', section: 'borrower',
    conditions: 'Verify LLC name; identify all owners with 20%+ ownership; all signatures + initials present.' },
  { slug: 'articles_of_organization', label: 'Recorded Articles of Organization', section: 'borrower',
    conditions: 'Verify LLC name matches loan application; must be the recorded copy stamped by the Secretary of State.' },
  { slug: 'certificate_of_good_standing', label: 'Certificate of Good Standing', section: 'borrower',
    conditions: 'Within last 90 days; correct LLC listed; state seal; Secretary of State signature.' },
  { slug: 'entity_background_check', label: 'Entity Background Check', section: 'borrower',
    conditions: 'No bankruptcies, liens, or judgements within 90 days of close date.' },
  { slug: 'ofac_entity', label: 'OFAC Check (Entity)', section: 'borrower',
    conditions: 'Entity name on OFAC report matches Articles of Organization exactly.' },
  { slug: 'ein_letter', label: 'EIN Letter (Entity & Guarantors)', section: 'borrower',
    conditions: 'SS-4 form or filed tax return showing the entity\'s EIN.' },
  { slug: 'foreign_entity_registration', label: 'Registration as a Foreign Entity', section: 'borrower',
    conditions: 'Required when the borrowing LLC is formed in a different state than the subject property.', optional: true },
  { slug: 'track_record_reo', label: 'Real Estate Schedule & Track Record', section: 'borrower',
    conditions: 'Confirm all cells filled with reasonable info; addresses, values, mortgages, cash flow.' },
  { slug: 'bank_stmt_current', label: 'This Month\'s Bank Statements', section: 'borrower',
    conditions: 'Liquidity requirements met? Borrower\'s ownership of accounts verified?' },
  { slug: 'bank_stmt_previous', label: 'Last Month\'s Bank Statements', section: 'borrower',
    conditions: 'Liquidity requirements met? Borrower\'s ownership of accounts verified?' },
  { slug: 'voided_check_ach', label: 'Voided Check', section: 'borrower',
    conditions: 'Scan of a voided check for the account the loan payments will come from. Account holder should match borrower or a third-party payee form is required.' },

  // ── Guarantor ─────────────────────────────────────────────────
  { slug: 'pfs', label: 'Personal Financial Statement (PFS)', section: 'guarantor',
    conditions: 'Signed by all guarantors. Assets, liabilities, income, contingent liabilities.' },
  { slug: 'guarantor_id', label: 'ID for each Guarantor', section: 'guarantor',
    conditions: 'Driver\'s License or Passport for each guarantor; matches name on application; not expired.' },
  // Deploy 236.670 — added per Mike.
  { slug: 'proof_of_citizenship', label: 'Proof of Citizenship', section: 'guarantor',
    conditions: 'Citizenship / permanent-residency evidence for each guarantor (passport, birth certificate, naturalization certificate, or green card). Name matches the application.', optional: true },
  { slug: 'credit_authorization', label: 'Credit Authorization', section: 'guarantor',
    conditions: 'Signed by all guarantors.' },
  { slug: 'credit_report', label: 'Credit Report', section: 'guarantor',
    conditions: 'Middle score above 690? Any lates or past-due accounts? Report is < 90 days old?' },
  { slug: 'guarantor_background_check', label: 'Guarantor Background Check', section: 'guarantor',
    conditions: 'No bankruptcies, liens, or judgements; criminal report < 90 days old.' },
  { slug: 'ofac_personal', label: 'OFAC Check (Personal)', section: 'guarantor',
    conditions: 'Personal name of all guarantors must match exactly.' },

  // ── Collateral ────────────────────────────────────────────────
  { slug: 'psa', label: 'Purchase Agreement', section: 'collateral',
    conditions: 'Borrower listed as buyer; all parties signed; price matches application.', purchaseOnly: true },
  { slug: 'cost_basis', label: 'Cost Basis', section: 'collateral',
    conditions: 'Documentation of borrower\'s total invested basis (purchase price + rehab + closing costs).', optional: true },
  { slug: 'lease_agreements', label: 'Lease Agreements', section: 'collateral',
    conditions: 'Signed by landlord and tenant; term length; non-corporate tenant; rent verifies to the underwriting.' },
  // Deploy 236.670 — added per Mike (DSCR docs from the S7 Holdings package).
  { slug: 'proof_of_security_deposit', label: 'Proof of Security Deposit', section: 'collateral',
    conditions: 'Evidence the tenant security deposit(s) are held (bank record, ledger, or receipt). Amount is consistent with the lease(s).', optional: true },
  { slug: 'insurance_invoice', label: 'Insurance Invoice', section: 'collateral',
    conditions: 'Invoice for the property insurance premium. Annual premium, policy number, carrier, and named insured (borrower / LLC) shown; premium reasonable for the coverage.', optional: true },
  { slug: 'property_mgmt_summary', label: 'Property Management Summary', section: 'collateral',
    conditions: 'Summary of PM company\'s scope; fees; contact info.', optional: true },
  { slug: 'property_mgmt_agreement', label: 'Property Management Agreement', section: 'collateral',
    conditions: 'PMA signed; covers the subject property.', optional: true },
  { slug: 'property_mgmt_questionnaire', label: 'Property Management Questionnaire', section: 'collateral',
    conditions: 'PMQ completed in full.', optional: true },
  { slug: 'mortgage_statements_payoffs', label: 'Mortgage Statements / Payoffs', section: 'collateral',
    conditions: 'Existing mortgage information verified; unpaid balances confirmed; payoff figures current for refi.', optional: true },
  { slug: 'vom', label: 'VOM (Verification of Mortgage)', section: 'collateral',
    conditions: 'Existing mortgage information verified.', optional: true },
  { slug: 'property_insurance_binder', label: 'Property Insurance — Binder', section: 'collateral',
    conditions: 'Provided if the Dec Page is not yet available. Mortgagee clause; loan number; borrower name; coverage >= loan value; $1M liability.', optional: true },
  { slug: 'evidence_of_insurance', label: 'Property Insurance — Dec Page', section: 'collateral',
    conditions: 'Mortgagee clause; loan number; borrower/LLC name; coverage >= loan value; $1M liability; effective dates through closing.' },
  { slug: 'flood_insurance_policy', label: 'Flood Insurance Policy', section: 'collateral',
    conditions: 'Required if property is in a FEMA flood zone. Mortgagee clause; coverage meets guidelines.', optional: true },
  { slug: 'proof_of_insurance_pif', label: 'Proof of Property Insurance Paid-Through Date', section: 'collateral',
    conditions: 'Receipt or endorsement showing policy paid through closing.' },
  { slug: 'property_profile', label: 'Property Profile', section: 'collateral',
    conditions: 'Ownership history, parcel details, tax history, comparable properties.' },
  { slug: 'appraisal', label: 'Appraisal', section: 'collateral',
    conditions: 'Value >= loan amount; does NOT say "subject to"; appraiser certified; comps recent + within 1 mile.' },
  { slug: 'appraisal_receipt', label: 'Appraisal Receipt', section: 'collateral',
    conditions: 'Paid-in-full receipt for the appraisal.' },
  { slug: 'air', label: 'AIR (Appraisal Independence Report)', section: 'collateral',
    conditions: 'Appraisal Independence Report signed.' },
  { slug: 'cda_report', label: 'CDA Report', section: 'collateral',
    conditions: 'Value >= Appraised value.' },
  { slug: 'property_condition_assessment', label: 'Property Condition Assessment (PCA)', section: 'collateral',
    conditions: 'PCA report on subject property; deferred maintenance itemized; capital reserves recommended.', optional: true },
  { slug: 'flood_certificate', label: 'Flood Certificates', section: 'collateral',
    conditions: 'Life-of-loan flood cert; zone determination.' },
  { slug: 'condo_documents', label: 'Condo Documents', section: 'collateral',
    conditions: 'HOA docs, master insurance, budget, reserve study — for condo units only.', optional: true },
  { slug: 'environmental_survey', label: 'Environmental Survey (5+ MF)', section: 'collateral',
    conditions: 'Required for 5+ unit multifamily properties. Phase I ESA or transaction screen.', optional: true },

  // ── Loan ──────────────────────────────────────────────────────
  { slug: 'letter_of_intent', label: 'Letter of Intent', section: 'loan',
    conditions: 'LOI signed and dated; terms consistent with final loan.' },
  { slug: 'revised_loan_terms', label: 'New / Revised Loan Terms', section: 'loan',
    conditions: 'Reflects any changes since the original LOI; both parties agreed.', optional: true },
  { slug: 'loan_application', label: 'Loan Application / Credit Authorization', section: 'loan',
    conditions: 'All information filled out and accurate; signatures present; credit auth signed by every guarantor.' },
  { slug: 'term_sheet', label: 'Term Sheet', section: 'loan',
    conditions: 'Ensure it is the most up-to-date terms.' },
  { slug: 'outstanding_conditions', label: 'Outstanding Conditions & Documents', section: 'loan',
    conditions: 'Log of any remaining conditions that need resolution before funding.', optional: true },
  { slug: 'exception_request', label: 'Exception Request Form (TPO / Borrower)', section: 'loan',
    conditions: 'Signed exception form when a guideline exception is being requested.', optional: true },

  // ── Closing ───────────────────────────────────────────────────
  { slug: 'title_escrow_contact', label: 'Title / Escrow Contact Information', section: 'closing',
    conditions: 'Title company name; address; primary contact name; phone; email.' },
  { slug: 'title_commitment', label: 'Title Commitment / Preliminary Title Report', section: 'closing',
    conditions: 'Mortgagee Clause; loan number; borrower name; property address(es); 125% of loan value; date; exceptions reviewed.' },
  { slug: 'cpl', label: 'Title — Closing Protection Letter (CPL)', section: 'closing',
    conditions: 'Mortgagee Clause; loan number; property address; date.' },
  { slug: 'title_eo_insurance', label: 'Title — E&O Insurance', section: 'closing',
    conditions: 'Title company name; $1 million in protection; policy dates current.' },
  { slug: 'wire_instructions', label: 'Settlement Agent Wire Instructions', section: 'closing',
    conditions: 'Wire instructions for the title company. Verified via callback to a known number.' },
  { slug: 'prelim_settlement', label: 'Escrow — Estimated Closing Statement', section: 'closing',
    conditions: 'Loan amount correct; fees correct; prepaid interest; property address; borrower named.' },
  { slug: 'final_hud', label: 'Final HUD / Settlement Statement', section: 'closing',
    conditions: 'Final signed settlement statement (HUD / Closing Disclosure) collected AFTER closing. Loan amount, fees, prepaid interest, payoffs, and net wire all reconcile to the approved terms.' },
  { slug: 'tax_certificate', label: 'Tax Certificates', section: 'closing',
    conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed.' },
  // Deploy 236.670 — added per Mike (payoff of the existing lien on a refi).
  { slug: 'payoff_demand', label: 'Payoff Demand', section: 'closing',
    conditions: 'Payoff statement from the existing lender (refinance). Payoff amount, per-diem interest, and good-through date are current; lender + loan match the subject property.', optional: true },
  { slug: 'borrower_closing_funds_receipt', label: 'Borrower Closing Funds Receipt', section: 'closing',
    conditions: 'Requested day of closing.', purchaseOnly: true },
  { slug: 'emd_receipt', label: 'EMD Receipt', section: 'closing',
    conditions: 'Receipt showing borrower provided EMD to the title company.', purchaseOnly: true },
  { slug: 'invoice', label: 'Invoice', section: 'closing',
    conditions: 'Third-party fees invoiced (appraisal, PCA, environmental, etc.).', optional: true },
];

export const RTL_DOCS = [
  // ── Borrower ──────────────────────────────────────────────────
  { slug: 'articles_of_organization', label: 'Articles of Organization', section: 'borrower',
    conditions: 'Verify LLC name matches loan application.' },
  { slug: 'entity_background_check', label: 'Entity Background Check', section: 'borrower',
    conditions: 'No bankruptcies, liens, or judgements within 90 days of close date.' },
  { slug: 'bank_stmt_current', label: 'Current-Month Bank Statements', section: 'borrower',
    conditions: 'Liquidity requirements met? Borrower’s ownership of accounts verified?' },
  { slug: 'bank_stmt_previous', label: 'Previous-Month Bank Statements', section: 'borrower',
    conditions: 'Liquidity requirements met? Borrower’s ownership of accounts verified?' },
  { slug: 'certificate_of_good_standing', label: 'Certificate of Good Standing', section: 'borrower',
    conditions: 'Within last 90 days; correct LLC listed; state seal; Secretary of State signature.' },
  { slug: 'ein_or_w9', label: 'EIN Letter or W9', section: 'borrower',
    conditions: 'If no EIN letter, request a W9 instead.' },
  { slug: 'ofac_entity', label: 'OFAC Check (Entity)', section: 'borrower',
    conditions: 'Entity name on OFAC report matches AOO exactly.' },
  { slug: 'operating_agreement', label: 'Operating Agreement', section: 'borrower',
    conditions: 'Verify LLC name; identify all owners with 20%+ ownership; all signatures + initials present.' },
  { slug: 'track_record', label: 'Track Record', section: 'borrower',
    conditions: 'Max of 8 properties needed for top pricing. Confirm all cells filled in with reasonable info.' },
  { slug: 'voided_check', label: 'Voided Check', section: 'borrower',
    conditions: 'Account borrower wants payment from. If different than borrower name get 3rd-party payee form.' },
  { slug: 'borrower_loe', label: 'Borrower Letter of Explanation', section: 'borrower',
    conditions: 'As required.', optional: true },

  // ── Guarantor ─────────────────────────────────────────────────
  { slug: 'guarantor_background_check', label: 'Guarantor Background Check', section: 'guarantor',
    conditions: 'No bankruptcies, liens, or judgements; criminal report < 90 days old.' },
  { slug: 'credit_authorization', label: 'Credit Authorization', section: 'guarantor',
    conditions: 'Signed by all guarantors.' },
  { slug: 'credit_report', label: 'Credit Report', section: 'guarantor',
    conditions: 'Middle score above 690? Any lates or past-due accounts? Report is < 90 days old?' },
  { slug: 'guarantor_id', label: 'Guarantor ID (Driver’s License or Passport)', section: 'guarantor',
    conditions: 'Matches name on application; not expired; birth date matches.' },
  { slug: 'ofac_personal', label: 'OFAC Check (Personal)', section: 'guarantor',
    conditions: 'Personal name of all guarantors must match exactly.' },
  { slug: 'guarantor_loe', label: 'Guarantor Letter of Explanation', section: 'guarantor',
    conditions: 'As required.', optional: true },

  // ── Collateral ────────────────────────────────────────────────
  { slug: 'assignment_agreement', label: 'Assignment Agreement', section: 'collateral',
    conditions: 'Buyer matches borrower; seller matches the PSA; all parties signed.', optional: true },
  { slug: 'bpo_valuation', label: 'BPO / Valuation', section: 'collateral',
    conditions: 'Value >= loan amount.' },
  { slug: 'evidence_of_insurance', label: 'Evidence of Insurance', section: 'collateral',
    conditions: 'Mortgagee clause; loan #; borrower name/LLC; insurance => loan value; $1M liability coverage.' },
  { slug: 'flood_certificate', label: 'Flood Certificate & Insurance', section: 'collateral',
    conditions: 'If property is in a flood zone, request flood insurance EOI.', optional: true },
  { slug: 'proof_of_insurance_pif', label: 'Proof of Insurance Paid in Full (PIF)', section: 'collateral',
    conditions: 'Quote showing policy number and total cost — or — receipt showing $0 owed.' },
  { slug: 'psa', label: 'Purchase and Sale Agreement (PSA)', section: 'collateral',
    conditions: 'Borrower listed as buyer; all parties signed; price matches application.', purchaseOnly: true },
  { slug: 'sow', label: 'Statement of Work (SOW)', section: 'collateral',
    conditions: 'Budget = Requested rehab $$.' },
  // Deploy 236.670 — added to RTL per Mike (Appraisal + Insurance Invoice).
  { slug: 'appraisal', label: 'Appraisal', section: 'collateral',
    conditions: 'Value >= loan amount; does NOT say "subject to"; appraiser certified; comps recent + within 1 mile.', optional: true },
  { slug: 'insurance_invoice', label: 'Insurance Invoice', section: 'collateral',
    conditions: 'Invoice for the property insurance premium. Annual premium, policy number, carrier, and named insured (borrower / LLC) shown; premium reasonable for the coverage.', optional: true },

  // ── Loan ──────────────────────────────────────────────────────
  { slug: 'loan_application', label: 'Loan Application', section: 'loan',
    conditions: 'Verify all information filled out and is accurate; signatures present.' },
  { slug: 'term_sheet', label: 'Term Sheet', section: 'loan',
    conditions: 'Ensure it is the most up-to-date terms.' },

  // ── Closing ───────────────────────────────────────────────────
  { slug: 'borrower_closing_funds_receipt', label: 'Borrower Closing Funds Receipt', section: 'closing',
    conditions: 'Requested day of closing.', purchaseOnly: true },
  { slug: 'cpl', label: 'Closing Protection Letter (CPL)', section: 'closing',
    conditions: 'Mortgagee Clause; loan number; property address; date.' },
  { slug: 'emd_receipt', label: 'EMD Receipt', section: 'closing',
    conditions: 'Receipt showing borrower provided EMD to the title company.', purchaseOnly: true },
  { slug: 'prelim_settlement', label: 'Pre-Lim Settlement Statement', section: 'closing',
    conditions: 'Loan amount correct; fees correct; prepaid interest; property address; borrower.' },
  { slug: 'final_hud', label: 'Final HUD / Settlement Statement', section: 'closing',
    conditions: 'Final signed settlement statement (HUD / Closing Disclosure) collected AFTER closing. Loan amount, fees, prepaid interest, payoffs, and net wire all reconcile to the approved terms.' },
  { slug: 'tax_certificate', label: 'Tax Certificate', section: 'closing',
    conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed.' },
  // Deploy 236.670 — added to RTL per Mike (payoff of the existing lien on a refi).
  { slug: 'payoff_demand', label: 'Payoff Demand', section: 'closing',
    conditions: 'Payoff statement from the existing lender (refinance). Payoff amount, per-diem interest, and good-through date are current; lender + loan match the subject property.', optional: true },
  { slug: 'title_commitment', label: 'Title Commitment', section: 'closing',
    conditions: 'Mortgagee Clause; loan number; borrower name; property address(es); 125% of loan value; date; 24-month chain of title.' },
  { slug: 'title_eo_insurance', label: 'Title E&O Insurance', section: 'closing',
    conditions: 'Title company name; $1 million in protection; policy dates current.' },
  { slug: 'wire_instructions', label: 'Wire Instructions', section: 'closing',
    conditions: 'Wire instructions for the title company.' },
];

export function getChecklist(loanType) {
  const t = String(loanType || '').toLowerCase();
  if (t === 'dscr') return DSCR_DOCS;
  if (t === 'rtl')  return RTL_DOCS;
  return [];
}

export function getDefaultInvestor(loanType) {
  const t = String(loanType || '').toLowerCase();
  if (t === 'dscr') return 'diya';
  if (t === 'rtl')  return 'colchis';
  return '';
}

// Deploy 236.678 — resolve a STANDARD category definition by slug across ALL
// loan types (union of DSCR + RTL). Used by the doc-move endpoint so a processor
// can file a mis-bucketed doc into any standard category (with its real rubric)
// even when that category isn't part of the loan's own checklist — e.g. moving a
// lease agreement into "Lease Agreements" on an RTL loan. DSCR wins on slug
// collisions (its rubric text is the fuller of the two).
export function findCategory(slug) {
  const s = String(slug || '');
  if (!s) return null;
  return DSCR_DOCS.find((d) => d.slug === s) || RTL_DOCS.find((d) => d.slug === s) || null;
}
