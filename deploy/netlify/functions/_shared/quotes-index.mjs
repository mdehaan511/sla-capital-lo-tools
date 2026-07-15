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
    loanAmt:    q.loanAmt   || '',
    borrower:   q.borrower      || '',
    borrowerEmail: q.borrowerEmail || '',
    savedAt:    q.savedAt,
    updatedAt:  q.updatedAt,
    borrowerInfoCompletedAt: q.borrowerInfoCompletedAt || '',
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
  version:          1,
});
