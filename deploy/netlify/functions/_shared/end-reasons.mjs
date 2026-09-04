/**
 * _shared/end-reasons.mjs — Deploy 236.883 (Mike)
 *
 * Structured "why did this loan end" reasons, shared by loan-cancel,
 * loan-decline, and the admin-end-reasons-report aggregation. The dropdown
 * options in loan-details.html mirror this list — keep the two in sync
 * (labels are Mike's exact wording, including "Canceled" on the investor row).
 * The chosen code is stored on the loan as `endReasonCode` for BOTH cancels
 * and declines so one report can aggregate across them.
 */
export const END_REASONS = [
  { code: 'other_lender',       label: 'Borrower Went With Other Lender' },
  { code: 'credit_below',       label: 'Borrower Credit Below Expected' },
  { code: 'background',         label: 'Background Check Issues' },
  { code: 'liquidity',          label: 'Liquidity Issues' },
  { code: 'appraisal',          label: 'Appraisal Issues' },
  { code: 'property_use',       label: 'Property Use Issues' },
  { code: 'fraud',              label: 'Fraud Discovered' },
  { code: 'borrower_cancelled', label: 'Borrower Cancelled Deal' },
  { code: 'investor_cancelled', label: 'Investor Canceled Deal' },
  { code: 'seller_cancelled',   label: 'Seller Cancelled Deal' },
  { code: 'deal_fell_through',  label: 'Deal Fell Through' },
  { code: 'other',              label: 'Other' },
];

export const END_REASON_LABEL = {};
for (const r of END_REASONS) END_REASON_LABEL[r.code] = r.label;

export function isEndReasonCode(code) {
  return Object.prototype.hasOwnProperty.call(END_REASON_LABEL, String(code || ''));
}
