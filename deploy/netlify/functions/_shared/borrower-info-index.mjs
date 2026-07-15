/**
 * borrower-info-index.mjs — materialized index for the borrower_info
 * store. Deploy 236.343 (Tier 2 scaling — Option B).
 *
 * The `data` field on a borrower_info record contains the full long-
 * app answers (dozens of fields, plus guarantor arrays, plus company
 * arrays, plus SSN_enc). Projection strips ALL of it — pipeline only
 * needs status + timestamps + token to build status badges and copy
 * the invite link.
 *
 * ID field is a composite key. Real records are per-loan since
 * Deploy 168; some legacy records are per-client. We synthesize an
 * ID by combining clientId + loanId so upsertRecord finds the right
 * row.
 */
import { createStoreIndex } from './store-index.mjs';

function bidId(r) {
  if (!r) return '';
  return String(r.clientId || '') + '|' + String(r.loanId || '');
}

function projectBorrowerInfo(r) {
  if (!r || typeof r !== 'object') return r;
  return {
    // Synthetic id so store-index can find/replace this record.
    id:             bidId(r),
    clientId:       r.clientId,
    loanId:         r.loanId || null,
    ownerKey:       r.ownerKey,
    borrowerEmail:  r.borrowerEmail || '',
    status:         r.status,
    sentAt:         r.sentAt,
    lastSavedAt:    r.lastSavedAt,
    completedAt:    r.completedAt,
    expiresAt:      r.expiresAt,
    token:          r.token,
    // Timestamp for sort. Pipeline reads updatedAt || savedAt || createdAt.
    updatedAt:      r.lastSavedAt || r.sentAt,
    savedAt:        r.lastSavedAt || r.sentAt,
    createdAt:      r.sentAt,
  };
}

export const borrowerInfoIndex = createStoreIndex({
  indexStoreName:   'borrower-info-index',
  primaryStoreName: 'borrower_info',
  project:          projectBorrowerInfo,
  version:          1,
  idField:          'id',
});

// Exposed so upsert callers who don't have `id` on their record
// (most save endpoints work with { clientId, loanId } shape) can
// compute it consistently.
export function borrowerInfoRecordId(clientId, loanId) {
  return String(clientId || '') + '|' + String(loanId || '');
}
