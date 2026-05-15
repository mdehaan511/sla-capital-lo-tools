/**
 * borrower-info-keys.mjs — Per-loan keying + legacy migration helpers
 *
 * Deploy 168 restructured the `borrower_info` blob store from per-client
 * records to per-loan records. Old records (keyed `<owner>/<clientId>`)
 * are still readable; the first time anything touches an existing record
 * it gets lifted forward to the new key `<owner>/<clientId>/<loanId>`.
 *
 * Why per-loan: a borrower can have multiple loans on the same property
 * (DSCR + RTL while comparing options) or multiple loans on different
 * properties. Either way, each loan needs its own borrower-info record:
 *   - Property facts (type, ARV, rent, etc.) can differ between loans
 *   - DSCR vs RTL loan applications need different field subsets
 *   - Credit and other borrower facts can legitimately change over time
 *
 * The legacy key format is preserved for backward compatibility so
 * already-sent borrower links keep working until they get re-saved.
 *
 * Usage:
 *   import { newRecordKey, legacyRecordKey, loadRecord, saveRecord } from './_shared/borrower-info-keys.mjs';
 *
 *   // Reading a record (per-loan):
 *   const rec = await loadRecord(store, ownerKey, clientId, loanId, clientsStore);
 *
 *   // Writing a record (per-loan):
 *   await saveRecord(store, ownerKey, clientId, loanId, record);
 *
 *   // Finding the right loanId for a legacy record (when it doesn't have one):
 *   const inferredLoanId = await inferLoanId(record, client);
 */
import { keySafe } from './auth.mjs';

/**
 * Build the per-loan storage key. clientId + loanId both get keySafe'd to
 * avoid storage-illegal characters; never trust raw user-supplied IDs in
 * a blob path.
 */
export function newRecordKey(ownerKey, clientId, loanId) {
  if (!ownerKey || !clientId || !loanId) {
    throw new Error('newRecordKey requires ownerKey, clientId, and loanId');
  }
  return ownerKey + '/' + keySafe(clientId) + '/' + keySafe(loanId);
}

/**
 * Build the legacy per-client key (used pre-Deploy-168). Still used for
 * the migration fallback path on reads. New writes never go to this key.
 */
export function legacyRecordKey(ownerKey, clientId) {
  return ownerKey + '/' + keySafe(clientId);
}

/**
 * Pick a loan id for a legacy record that doesn't have one set. Used
 * during the read-time migration when an old record needs to be lifted
 * to the new key shape.
 *
 * Priority:
 *   1. record.loanId if set
 *   2. If client has exactly one loan, use it
 *   3. If exactly one loan is in awaiting_app status (most likely
 *      relevant for an in-flight borrower-info record), use it
 *   4. Most recently updated loan
 *   5. First loan
 *
 * Returns null if no client is available or client has no loans.
 */
export function inferLoanId(record, client) {
  if (record && record.loanId) return record.loanId;
  if (!client || !Array.isArray(client.loans) || client.loans.length === 0) return null;
  if (client.loans.length === 1) return client.loans[0].id;
  const awaiting = client.loans.filter((l) => l.status === 'awaiting_app');
  if (awaiting.length === 1) return awaiting[0].id;
  // Most recently updated loan
  const sorted = client.loans.slice().sort((a, b) => {
    const at = a.updatedAt || a.savedAt || a.createdAt || '';
    const bt = b.updatedAt || b.savedAt || b.createdAt || '';
    return bt.localeCompare(at);  // descending
  });
  return sorted[0].id;
}

/**
 * Read a borrower-info record for a specific loan. Tries the new
 * per-loan key first; falls back to the legacy per-client key for
 * existing data; lifts forward to the new key on first read so future
 * reads are faster.
 *
 * Returns null when no record exists at either key.
 *
 * If `client` is provided AND the legacy record is found AND its
 * `loanId` doesn't match the requested loanId AND inferLoanId picks a
 * different loan, the legacy record is NOT returned for this query — it
 * belongs to a different loan. The caller should treat that as "no
 * record yet for this loan."
 */
export async function loadRecord(store, ownerKey, clientId, loanId, client) {
  if (!ownerKey || !clientId) return null;

  // 1. Try the new per-loan key
  if (loanId) {
    const newKey = newRecordKey(ownerKey, clientId, loanId);
    try {
      const rec = await store.get(newKey, { type: 'json' });
      if (rec) return rec;
    } catch (_) {}
  }

  // 2. Fall back to legacy key
  const legacyKey = legacyRecordKey(ownerKey, clientId);
  let legacyRec = null;
  try {
    legacyRec = await store.get(legacyKey, { type: 'json' });
  } catch (_) {}
  if (!legacyRec) return null;

  // 3. Check that the legacy record actually belongs to the requested loan.
  // If the legacy record's loanId is set and doesn't match what we want,
  // it's a DIFFERENT loan's data — don't return it.
  const inferredId = inferLoanId(legacyRec, client);
  if (loanId && inferredId && inferredId !== loanId) {
    // Different loan — caller should treat this as "no record for this loan"
    // The legacy record will be lifted to its correct new key by whatever
    // call eventually asks for it (e.g. asking for the DSCR loan first
    // when the legacy record was for the RTL loan).
    return null;
  }

  // 4. Lift forward: if we have a loanId, copy the legacy record to its
  // new home. Best-effort — don't fail the read if the write fails (the
  // record is still returned). The legacy key is intentionally left
  // intact as a safety backup; the read fallback above will continue to
  // find it.
  const targetLoanId = loanId || inferredId;
  if (targetLoanId && store.setJSON) {
    try {
      // Stamp the loanId onto the lifted record so future reads know
      // which loan it belongs to without re-doing inference.
      const lifted = Object.assign({}, legacyRec, { loanId: targetLoanId });
      await store.setJSON(newRecordKey(ownerKey, clientId, targetLoanId), lifted);
    } catch (_) {}
  }

  return legacyRec;
}

/**
 * Save a borrower-info record to its per-loan key. Always writes to the
 * new key; never to the legacy. If a legacy record exists at the
 * per-client key, it's left intact (safe fallback in case of issues).
 */
export async function saveRecord(store, ownerKey, clientId, loanId, record) {
  if (!ownerKey || !clientId || !loanId) {
    throw new Error('saveRecord requires ownerKey, clientId, and loanId');
  }
  // Ensure record.loanId matches the key — defensive in case the caller
  // didn't sync them.
  const out = Object.assign({}, record, { loanId });
  await store.setJSON(newRecordKey(ownerKey, clientId, loanId), out);
}
