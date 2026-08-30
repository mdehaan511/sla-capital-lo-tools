/**
 * store-index.mjs — generic materialized-index factory for any
 * per-owner-namespaced blob store (Deploy 236.343, Tier 2 scaling).
 *
 * Instantiate one per store:
 *
 *   export const quotesIndex = createStoreIndex({
 *     indexStoreName:   'quotes-index',   // where the index blob lives
 *     primaryStoreName: 'quotes',         // the store being indexed
 *     project:          projectQuote,     // (record) => summaryRecord
 *     version:          1,                // bump when project() output changes
 *   });
 *
 * Then use like:
 *   quotesIndex.upsertRecord(ownerKey, quote);
 *   quotesIndex.removeRecord(ownerKey, quoteId);
 *   quotesIndex.readIndex();
 *   quotesIndex.rebuildIndex();
 *
 * Every index blob has the same shape:
 *   { version, updatedAt, byOwner: { [ownerKey]: [ summaryRecord, … ] } }
 *
 * ─── Failure philosophy ───
 * Index writes NEVER throw. Every upsert/remove is `.catch()`'d in
 * the caller so a primary store write can't be blocked by index
 * bookkeeping. Drift self-heals via the 15-minute TTL: readIndex
 * returns { isStale: true } past that, and the read path kicks off
 * a background rebuild.
 */
import { getStore } from '@netlify/blobs';

const INDEX_KEY = 'all';
export const INDEX_TTL_MS = 15 * 60 * 1000;

/**
 * @param {Object} opts
 * @param {string} opts.indexStoreName   e.g. 'quotes-index'
 * @param {string} opts.primaryStoreName e.g. 'quotes'
 * @param {(record:Object) => Object} opts.project
 * @param {number} opts.version          bump to invalidate old
 *                                        index format on read
 * @param {string} [opts.idField='id']   which field on the record
 *                                        identifies it uniquely
 */
export function createStoreIndex({ indexStoreName, primaryStoreName, project, version, idField = 'id' }) {
  if (!indexStoreName || !primaryStoreName || typeof project !== 'function') {
    throw new Error('createStoreIndex requires indexStoreName + primaryStoreName + project()');
  }
  const INDEX_VERSION = version || 1;

  const _indexStore   = () => getStore({ name: indexStoreName,   consistency: 'strong' });
  const _primaryStore = () => getStore({ name: primaryStoreName, consistency: 'strong' });

  async function readIndex() {
    try {
      const rec = await _indexStore().get(INDEX_KEY, { type: 'json' });
      if (!rec) return { index: null, isStale: false, exists: false };
      if (rec.version !== INDEX_VERSION) {
        return { index: null, isStale: false, exists: false, versionMismatch: true };
      }
      const ageMs = Date.now() - new Date(rec.updatedAt || 0).getTime();
      return { index: rec, isStale: ageMs > INDEX_TTL_MS, exists: true, ageMs };
    } catch (e) {
      console.warn(`${indexStoreName} readIndex failed:`, e && e.message);
      return { index: null, isStale: false, exists: false, error: e && e.message };
    }
  }

  async function _writeIndex(index) {
    index.version   = INDEX_VERSION;
    index.updatedAt = new Date().toISOString();
    await _indexStore().setJSON(INDEX_KEY, index);
  }

  async function upsertRecord(ownerKey, record) {
    if (!ownerKey || !record) return;
    // Project first so stores whose native records don't carry `id`
    // (borrower_info uses composite clientId|loanId) still work —
    // the projection synthesizes the id field.
    const summary = project(record);
    if (!summary || !summary[idField]) return;
    try {
      const { index } = await readIndex();
      const idx = index && index.byOwner ? index : { byOwner: {} };
      const list = idx.byOwner[ownerKey] || [];
      const pos = list.findIndex((r) => r && r[idField] === summary[idField]);
      if (pos >= 0) list[pos] = summary;
      else list.push(summary);
      idx.byOwner[ownerKey] = list;
      await _writeIndex(idx);
    } catch (e) {
      console.warn(`${indexStoreName} upsertRecord failed for ${ownerKey}/${summary[idField]}:`, e && e.message);
    }
  }

  async function removeRecord(ownerKey, id) {
    if (!ownerKey || !id) return;
    try {
      const { index } = await readIndex();
      if (!index || !index.byOwner || !index.byOwner[ownerKey]) return;
      index.byOwner[ownerKey] = index.byOwner[ownerKey].filter((r) => r && r[idField] !== id);
      if (!index.byOwner[ownerKey].length) delete index.byOwner[ownerKey];
      await _writeIndex(index);
    } catch (e) {
      console.warn(`${indexStoreName} removeRecord failed for ${ownerKey}/${id}:`, e && e.message);
    }
  }

  // Deploy 236.796 (Mike) — batch remove. removeRecord() is a full
  // read-modify-write of the index blob, so a bulk delete of N records cost
  // 2N blob ops and crept toward the 26s function cap. This does ONE read and
  // ONE write for the whole set. pairs = [{ ownerKey, id }, ...].
  async function removeRecords(pairs) {
    const list = (pairs || []).filter((p) => p && p.ownerKey && p.id);
    if (!list.length) return { removed: 0 };
    try {
      const { index } = await readIndex();
      if (!index || !index.byOwner) return { removed: 0 };
      const byOwnerIds = new Map();
      for (const { ownerKey, id } of list) {
        if (!byOwnerIds.has(ownerKey)) byOwnerIds.set(ownerKey, new Set());
        byOwnerIds.get(ownerKey).add(id);
      }
      let removed = 0;
      for (const [ownerKey, ids] of byOwnerIds) {
        const cur = index.byOwner[ownerKey];
        if (!cur) continue;
        const next = cur.filter((r) => !(r && ids.has(r[idField])));
        removed += cur.length - next.length;
        if (next.length) index.byOwner[ownerKey] = next;
        else delete index.byOwner[ownerKey];
      }
      if (removed) await _writeIndex(index);
      return { removed };
    } catch (e) {
      console.warn(`${indexStoreName} removeRecords failed:`, e && e.message);
      return { removed: 0, error: (e && e.message) || 'failed' };
    }
  }

  async function rebuildIndex() {
    const start = Date.now();
    const primary = _primaryStore();
    const { blobs } = await primary.list();
    const byOwner = {};
    let recordCount = 0;
    const CHUNK = 25;
    for (let i = 0; i < blobs.length; i += CHUNK) {
      const slice = blobs.slice(i, i + CHUNK);
      const recs = await Promise.all(slice.map(async ({ key }) => {
        const slash = key.indexOf('/');
        if (slash < 0) return null;
        const ownerKey = key.slice(0, slash);
        const rec = await primary.get(key, { type: 'json' }).catch(() => null);
        return { ownerKey, rec };
      }));
      for (const item of recs) {
        if (!item || !item.rec) continue;
        const { ownerKey, rec } = item;
        if (!byOwner[ownerKey]) byOwner[ownerKey] = [];
        byOwner[ownerKey].push(project(rec));
        recordCount++;
      }
    }
    // Sort each owner's list by most-recent, matching the legacy
    // walk behavior so callers don't need to re-sort.
    for (const o of Object.keys(byOwner)) {
      byOwner[o].sort((a, b) =>
        new Date(b.updatedAt || b.savedAt || b.createdAt || 0) -
        new Date(a.updatedAt || a.savedAt || a.createdAt || 0),
      );
    }
    await _writeIndex({ byOwner });
    return {
      ownerCount:  Object.keys(byOwner).length,
      recordCount,
      ms: Date.now() - start,
    };
  }

  return { readIndex, upsertRecord, removeRecord, removeRecords, rebuildIndex, INDEX_VERSION };
}
