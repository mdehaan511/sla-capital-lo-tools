/**
 * application-resign-reset.mjs — reset a loan's application to "awaiting
 * signatures" after the guarantor set changed, so the remaining parties must
 * RE-SIGN the modified document.
 *
 * Deploy 236.703 — Mike: removing a guarantor should modify the application and
 * require it to be re-signed (the honest/secure route) rather than carrying the
 * old signature seals forward over changed content.
 *
 * This does NOT render a PDF. The `signed_applications` record is DELETED; when
 * Borrower 1 re-signs via the fresh link, `borrower-info-sign.mjs` rebuilds the
 * PDF and re-mints every secondary (Guarantor 2/3/4) token from
 * `record.data.guarantors[]` — so we never hand-mint secondary tokens here, and
 * there is exactly one code path that stamps a signed application.
 *
 * Behavior, given { ownerKey, clientId (primary), loanId }:
 *   1. Load the borrower_info record. No record → nothing signed → no-op.
 *   2. Run the caller's `transformData(record.data)` (e.g. splice a guarantor
 *      out of data.guarantors[], or reorder). It returns truthy if it changed
 *      the guarantor set.
 *   3. If the app was already signed/in-flight AND the data changed (or the
 *      caller passed `force`), do the full reset: delete signed_applications +
 *      its secondary token-index entries, clear all sign markers on
 *      borrower_info, re-mint the Borrower-1 token, set status 'pending'.
 *      Otherwise just persist the data change and leave the live link alone.
 *
 * Returns { reset, hadRecord, newToken?, dataUpdated }.
 */
import { getStore } from '@netlify/blobs';
import { loadRecord, saveRecord, newRecordKey } from './borrower-info-keys.mjs';
import { writeTokenIndex, deleteTokenIndex } from './borrower-info-token-index.mjs';
import { generateToken } from './crypto.mjs';

const TOKEN_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days, matches borrower-info-request

// Every marker borrower-info-sign / borrower2-auth-sign stamps to record a
// signature. Clearing all of them (plus a fresh token) returns the record to a
// clean pre-signature state so Borrower 1 can sign again.
const SIGN_MARKER_FIELDS = [
  'signedAt', 'signedBy', 'completedAt',
  'b1SignedAt', 'b1SignedBy',
  'b2SignedAt', 'b3SignedAt', 'b4SignedAt',
  'b2InvitedAt', 'b3InvitedAt', 'b4InvitedAt',
  'b2Token', 'b3Token', 'b4Token',
  'signedAuditKey',
];

// signed_applications key format — mirrors borrower-info-sign.mjs exactly.
function signedAppKey(ownerKey, clientId, loanId) {
  const safe = (s) => String(s == null ? '' : s).replace(/[^a-zA-Z0-9_-]/g, '_');
  return `${ownerKey}/${safe(clientId)}/${safe(loanId || '_no_loan')}`;
}

export async function resetApplicationForResign({ ownerKey, clientId, loanId, transformData, force }) {
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await loadRecord(biStore, ownerKey, clientId, loanId, null);
  if (!record) return { reset: false, hadRecord: false, dataUpdated: false };

  // Was anything actually signed / in-flight? If not, there is nothing to force
  // a re-sign of — we just keep the (pending) app data in sync.
  const wasSignedish = !!(
    record.signedAt || record.b1SignedAt || record.completedAt || record.signedAuditKey ||
    record.b2Token || record.b3Token || record.b4Token
  );

  let changed = false;
  if (typeof transformData === 'function') {
    record.data = record.data || {};
    try { changed = !!transformData(record.data); }
    catch (e) { console.warn('resetApplicationForResign: transformData threw:', e && e.message); }
  }

  const needReset = !!force || (wasSignedish && changed);

  if (!needReset) {
    // No signatures to invalidate (or nothing changed). Persist any data edit.
    if (changed) {
      record.updatedAt = new Date().toISOString();
      await saveRecord(biStore, ownerKey, clientId, loanId, record);
    }
    return { reset: false, hadRecord: true, dataUpdated: changed };
  }

  // ── Delete the signed application + its secondary token-index entries ──
  try {
    const signedStore = getStore({ name: 'signed_applications', consistency: 'strong' });
    const b2idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
    const sKey = signedAppKey(ownerKey, clientId, loanId);
    const signed = await signedStore.get(sKey, { type: 'json' }).catch(() => null);
    if (signed) {
      for (const pos of [2, 3, 4]) {
        const b = signed['borrower' + pos];
        if (b && b.token) { try { await b2idx.delete(b.token); } catch (_) {} }
      }
      try { await signedStore.delete(sKey); } catch (_) {}
    }
  } catch (e) {
    console.warn('resetApplicationForResign: signed_applications reset failed:', e && e.message);
  }

  // ── Reset borrower_info to a clean pre-signature state + re-mint B1 token ──
  const oldToken = record.token;
  for (const f of SIGN_MARKER_FIELDS) { delete record[f]; }
  record.status = 'pending';
  record.token = generateToken();
  record.expiresAt = new Date(Date.now() + TOKEN_TTL_MS).toISOString();
  record.resetForResignAt = new Date().toISOString();
  record.updatedAt = record.resetForResignAt;
  await saveRecord(biStore, ownerKey, clientId, loanId, record);

  const recordKey = newRecordKey(ownerKey, clientId, loanId);
  try { await writeTokenIndex(record.token, recordKey, { ownerKey, clientId, loanId }); } catch (_) {}
  if (oldToken && oldToken !== record.token) { try { await deleteTokenIndex(oldToken); } catch (_) {} }

  return { reset: true, hadRecord: true, newToken: record.token, dataUpdated: changed };
}
