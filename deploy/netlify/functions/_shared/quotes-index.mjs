/**
 * quotes-index.mjs — materialized index for the quotes store.
 * Deploy 236.343 (Tier 2 scaling — Option B).
 */
import { createStoreIndex } from './store-index.mjs';

// The pipeline tile builder reads: id, loanId, clientId, address,
// status, updatedAt/savedAt, toolType, formData.{propType,_finalRate,
// _points,loanAmt,purchasePrice}, loanAmt, borrower, borrowerEmail.
// Include what the tile renderers need + status/close-check helpers.
function projectQuote(q) {
  if (!q || typeof q !== 'object') return q;
  return {
    id:         q.id,
    loanId:     q.loanId    || '',
    clientId:   q.clientId  || '',
    address:    q.address   || '',
    status:     q.status    || '',
    toolType:   q.toolType  || '',
    // Deploy 236.761 — MF-program marker (routes the pipeline card's Open
    // Sizer to mf-dscr-sizer.html). Older quotes only carry it inside
    // formData, so fall through to there during the rebuild.
    mfProgram:  q.mfProgram || (q.formData && q.formData.mfProgram) || '',
    loanAmt:    q.loanAmt   || '',
    borrower:   q.borrower      || '',
    borrowerEmail: q.borrowerEmail || '',
    savedAt:    q.savedAt,
    updatedAt:  q.updatedAt,
    borrowerInfoCompletedAt: q.borrowerInfoCompletedAt || '',
    // Deploy 236.380 — close + decision fields. The original 236.343
    // projection dropped these, so closed.html and decisions.html in
    // admin All-LOs scope (which reads this index) rendered EVERY
    // closed loan with blank final amount / commission / close date.
    // LO self-scope reads raw blobs and was unaffected — which is why
    // the regression hid for so long.
    finalLoanAmount:  q.finalLoanAmount  ?? null,
    originalLoanAmt:  q.originalLoanAmt  || '',
    commissionRate:   q.commissionRate   ?? null,
    commissionAmount: q.commissionAmount ?? null,
    closedAt:         q.closedAt         || '',
    closedBy:         q.closedBy         || '',
    closeNotes:       q.closeNotes       || '',
    decidedAt:        q.decidedAt        || '',
    decidedBy:        q.decidedBy        || '',
    decisionNotes:    q.decisionNotes    || '',
    submittedAt:      q.submittedAt      || '',
    // Pipeline reads a handful of formData fields for tile display
    // + the propType dedupe key. Drop everything else (sizer state
    // snapshots + pricing overrides can add many KB per record).
    formData: q.formData ? {
      propType:     q.formData.propType,
      _finalRate:   q.formData._finalRate,
      _points:      q.formData._points,
      loanAmt:      q.formData.loanAmt,
      purchasePrice:q.formData.purchasePrice,
      brokerName:   q.formData.brokerName,
      brokerCompany:q.formData.brokerCompany,
      brokerEmail:  q.formData.brokerEmail,
      _isBrokerLoan:q.formData._isBrokerLoan,
    } : undefined,
  };
}

export const quotesIndex = createStoreIndex({
  indexStoreName:   'quotes-index',
  primaryStoreName: 'quotes',
  project:          projectQuote,
  // Deploy 236.380 — bumped so the stored v1 index (missing the close
  // fields) is discarded and rebuilt with the new projection on the
  // next read.
  // Deploy 236.761 — v3: + mfProgram (MF sizer routing).
  version:          3,
});
