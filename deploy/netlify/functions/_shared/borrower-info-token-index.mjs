/**
 * borrower-info-token-index.mjs — Fast token→recordKey lookup (Deploy 172)
 *
 * Before this index, every borrower-info save and load did:
 *   const { blobs } = await store.list();
 *   for (const { key } of blobs) {
 *     const r = await store.get(key, { type: 'json' });  // sequential
 *     if (r && r.token === incoming) { ... break; }
 *   }
 *
 * That's O(N) sequential blob reads on every keystroke save (the borrower
 * form auto-saves every few seconds). With even 50 records in the store
 * each save fires 50+ blob fetches sequentially. As the LO base grows
 * and old records pile up, latency climbs linearly.
 *
 * This module maintains a parallel index store keyed by the token itself.
 * Lookups become a single get instead of a full scan.
 *
 * Backward compatibility: if a token isn't in the index (e.g. it pre-
 * dates this deploy), the caller falls back to the legacy full-scan
 * and then writes the index entry so subsequent lookups are fast.
 *
 * Index entry: { recordKey, ownerKey, clientId, loanId, createdAt }
 *
 * Storage: `borrower_info_token_idx` blob store. Strong consistency
 * because the index is read seconds after it's written (borrower clicks
 * the email link right after the LO generates it).
 */
import { getStore } from '@netlify/blobs';

const INDEX_STORE = 'borrower_info_token_idx';

function indexStore() {
  return getStore({ name: INDEX_STORE, consistency: 'strong' });
}

/**
 * Write or update an index entry. Call this whenever a record's token
 * is created or rotated (so the index always points to the latest key).
 */
export async function writeTokenIndex(token, recordKey, recordMeta) {
  if (!token || !recordKey) return;
  const entry = {
    recordKey,
    ownerKey: (recordMeta && recordMeta.ownerKey) || '',
    clientId: (recordMeta && recordMeta.clientId) || '',
    loanId:   (recordMeta && recordMeta.loanId)   || '',
    createdAt: new Date().toISOString(),
  };
  try {
    await indexStore().setJSON(token, entry);
  } catch (e) {
    // Non-fatal: index miss falls back to full scan. Log so we notice
    // recurring failures (could indicate a storage outage).
    console.warn('borrower-info-token-index write failed:', e && e.message);
  }
}

/**
 * Look up a record by token via the index. Returns the record key, or
 * null if the token isn't indexed. The caller should fall back to the
 * legacy full-scan if this returns null.
 *
 * The returned key is JUST the key — caller still has to `store.get(key)`
 * to fetch the record itself. That's one blob read total instead of N.
 */
export async function lookupTokenKey(token) {
  if (!token) return null;
  try {
    const entry = await indexStore().get(token, { type: 'json' });
    if (!entry || !entry.recordKey) return null;
    return entry.recordKey;
  } catch (e) {
    return null;
  }
}

/**
 * Remove an index entry. Call when a record is deleted, OR when a token
 * is rotated (the old token's index entry should die so it can't be
 * accidentally used). Best-effort.
 */
export async function deleteTokenIndex(token) {
  if (!token) return;
  try {
    await indexStore().delete(token);
  } catch (e) {
    console.warn('borrower-info-token-index delete failed:', e && e.message);
  }
}
