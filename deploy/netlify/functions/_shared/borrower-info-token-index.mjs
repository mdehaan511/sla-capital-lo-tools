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
 * Deploy 236.414 — resolveByToken: the ONE way to turn a borrower
 * token into its record. Fast path via the index; on miss, a
 * chunked-parallel walk of the store BOUNDED by a time budget, with
 * index self-heal on find. The unbounded sequential walk this
 * replaces (copied into sign/load/save individually) could exceed
 * the 10s function limit and surface to borrowers as a naked 504 —
 * which is exactly what a borrower stuck in the resend-rotation
 * cycle hit for weeks.
 *
 * Returns { record, recordKey, timedOut }:
 *   record null + timedOut false → token genuinely unknown (stale/rotated)
 *   record null + timedOut true  → walk ran out of budget (treat as unknown,
 *                                  message-wise; logged for diagnosis)
 */
export async function resolveByToken(store, token, opts) {
  const budgetMs = (opts && opts.budgetMs) || 6500;
  const t0 = Date.now();
  if (!token) return { record: null, recordKey: null, timedOut: false };

  const fastKey = await lookupTokenKey(token);
  if (fastKey) {
    try {
      const r = await store.get(fastKey, { type: 'json' });
      if (r && r.token === token) return { record: r, recordKey: fastKey, timedOut: false };
    } catch (_) { /* fall through to walk */ }
  }

  const { blobs } = await store.list();
  console.log('[token-resolve] index miss — walking ' + blobs.length + ' records (budget ' + budgetMs + 'ms)');
  const CHUNK = 25;
  for (let i = 0; i < blobs.length; i += CHUNK) {
    if (Date.now() - t0 > budgetMs) {
      console.warn('[token-resolve] budget exhausted at ' + i + '/' + blobs.length);
      return { record: null, recordKey: null, timedOut: true };
    }
    const slice = blobs.slice(i, i + CHUNK);
    const loaded = await Promise.all(slice.map((b) =>
      store.get(b.key, { type: 'json' })
        .then((r) => ({ key: b.key, r }))
        .catch(() => ({ key: b.key, r: null }))
    ));
    for (const it of loaded) {
      if (it.r && it.r.token === token) {
        await writeTokenIndex(token, it.key, it.r); // self-heal, never throws
        return { record: it.r, recordKey: it.key, timedOut: false };
      }
    }
  }
  return { record: null, recordKey: null, timedOut: false };
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
