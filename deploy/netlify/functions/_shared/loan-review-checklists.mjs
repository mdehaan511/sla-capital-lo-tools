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

export const DSCR_DOCS = [
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
  { slug: 'track_record_reo', label: 'Track Record / REO Schedule', section: 'borrower',
    conditions: 'Max of 6 properties needed. Confirm all cells are filled in with reasonable info.' },
  { slug: 'voided_check_ach', label: 'Voided Check / ACH Letter', section: 'borrower',
    conditions: 'Account that borrower wants to make monthly payments from.' },

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
  { slug: 'pfs', label: 'Personal Financial Statement (PFS)', section: 'guarantor',
    conditions: 'Signed by borrower.' },
  { slug: 'voh_corrfirst', label: 'Verification of Housing Cost (CorrFirst Only)', section: 'guarantor',
    conditions: 'Copy of primary home’s mortgage or lease agreement along with proof of payment.',
    investor: 'corrfirst', optional: true },

  // ── Collateral ────────────────────────────────────────────────
  { slug: 'assignment_agreement', label: 'Assignment Agreement', section: 'collateral',
    conditions: 'Buyer matches borrower; seller matches the PSA; all parties signed.', optional: true },
  { slug: 'appraisal', label: 'Appraisal', section: 'collateral',
    conditions: 'Value >= loan amount; does NOT say "subject to".' },
  { slug: 'appraisal_receipt', label: 'Appraisal Receipt', section: 'collateral',
    conditions: 'Paid-in-full receipt for the appraisal.' },
  { slug: 'air', label: 'AIR (Appraisal Independence Report)', section: 'collateral',
    conditions: 'Appraisal Independence Report signed.' },
  { slug: 'cda_report', label: 'CDA Report', section: 'collateral',
    conditions: 'Value >= Appraised value.' },
  { slug: 'evidence_of_insurance', label: 'Evidence of Insurance', section: 'collateral',
    conditions: 'Mortgagee clause; borrower name/LLC; insurance => loan value; $1M liability coverage.' },
  { slug: 'flood_certificate', label: 'Flood Certificate & Insurance', section: 'collateral',
    conditions: 'If property is in a flood zone, request flood insurance EOI.', optional: true },
  { slug: 'proof_of_insurance_pif', label: 'Proof of Insurance Paid in Full (PIF)', section: 'collateral',
    conditions: 'Quote showing policy number and total cost — or — receipt showing $0 owed.' },
  { slug: 'lease_agreements', label: 'Lease Agreements', section: 'collateral',
    conditions: '12 months in length? Non-corporate tenant? Signed by landlord and tenant?' },
  { slug: 'property_mgmt_agreement', label: 'Property Management Agreement', section: 'collateral',
    conditions: 'PMA signed; covers the subject property.' },
  { slug: 'property_mgmt_questionnaire', label: 'Property Management Questionnaire', section: 'collateral',
    conditions: 'PMQ completed in full.' },
  { slug: 'psa', label: 'Purchase and Sale Agreement (PSA)', section: 'collateral',
    conditions: 'Borrower listed as buyer; all parties signed; price matches application.', purchaseOnly: true },
  { slug: 'sow', label: 'Statement of Work (SOW)', section: 'collateral',
    conditions: 'Budget = Requested rehab $$.', optional: true },
  { slug: 'vom', label: 'VOM (Verification of Mortgage)', section: 'collateral',
    conditions: 'Existing mortgage information verified.', optional: true },

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
  { slug: 'tax_certificate', label: 'Tax Certificate', section: 'closing',
    conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed.' },
  { slug: 'title_commitment', label: 'Title Commitment', section: 'closing',
    conditions: 'Mortgagee Clause; loan number; borrower name; property address(es); 125% of loan value; date.' },
  { slug: 'title_eo_insurance', label: 'Title E&O Insurance', section: 'closing',
    conditions: 'Title company name; $1 million in protection; policy dates current.' },
  { slug: 'wire_instructions', label: 'Wire Instructions', section: 'closing',
    conditions: 'Wire instructions for the title company.' },
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
  { slug: 'tax_certificate', label: 'Tax Certificate', section: 'closing',
    conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed.' },
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
