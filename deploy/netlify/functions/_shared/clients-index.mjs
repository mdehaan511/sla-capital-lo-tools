/**
 * clients-index.mjs — single-blob materialized index of every
 * client's summary (Deploy 236.341, Tier 2 of the post-import
 * scaling fix).
 *
 * Before: cross-owner /api/clients?all=1 walked the whole `clients`
 * blob store and did a store.get() per record — ~2 852 blob reads
 * per pipeline load once Mike imported his CRM.
 *
 * After: a single blob at clients-index/all contains a
 * { updatedAt, byOwner: { [ownerKey]: [ summaryClient, … ] } }
 * shape. Cross-owner reads = ONE store.get(). Write endpoints call
 * upsertClient() after their setJSON so the index stays fresh.
 *
 * ─── Concurrency ───
 * Netlify Blobs strong-consistency + last-write-wins. Two mutations
 * racing on the index can lose one increment; this module doesn't
 * attempt CAS. Drift is bounded by:
 *   - readIndex() reports { isStale } when index.updatedAt > TTL.
 *   - Callers with a stale index kick off a background rebuild.
 *   - Admin can force a rebuild via /api/admin-clients-index-rebuild.
 * For a workflow app of this scale (10 LOs, few writes/min), the
 * simpler pattern is fine.
 *
 * ─── Failure philosophy ───
 * Index writes NEVER throw. A failed upsert is logged, the primary
 * client blob write is unaffected. Worst case: index has stale
 * data for one client until the next successful upsert or rebuild.
 */
import { getStore } from '@netlify/blobs';

export const INDEX_STORE = 'clients-index';
export const INDEX_KEY   = 'all';
// Reads older than this trigger a background rebuild. Chosen so a
// missed upsert self-heals within one pipeline visit.
export const INDEX_TTL_MS = 15 * 60 * 1000;

// Fields kept per loan on the summary. Mirrors clients-list.mjs's
// LOAN_SUMMARY_FIELDS + formData.{_finalRate,propType}. Bump the
// index VERSION when you change either.
export const INDEX_VERSION = 1;

const LOAN_SUMMARY_FIELDS = [
  'id', 'address', 'status', 'processingStage', 'loanAmt', 'loanType',
  'toolType', 'rate', 'points', 'purchasePrice', 'propValue', 'propType',
  'fico', 'prepay', 'dscr', 'brokerId', 'brokerName', 'brokerCompany',
  'brokerEmail', 'brokerPhone', 'brokerFee', '_isBrokerLoan',
  'fromApplication', 'prospectId', 'fundingDate', 'maturityDate',
  'servicerName', 'servicerUrl',
  'slaDisplayId', 'guarantorClientIds',
  'createdAt', 'updatedAt', 'savedAt', '_owner',
];

function projectLoan(l) {
  if (!l || typeof l !== 'object') return l;
  const out = {};
  for (const k of LOAN_SUMMARY_FIELDS) {
    if (k in l) out[k] = l[k];
  }
  if (l.formData && typeof l.formData === 'object') {
    out.formData = {
      _finalRate: l.formData._finalRate,
      propType:   l.formData.propType,
    };
  }
  return out;
}

/**
 * Build the compact per-client summary the pipeline / dashboards
 * render. Mirrors clients-list.mjs's projectSummary() — keep in
 * sync or bump INDEX_VERSION.
 */
export function projectClientSummary(client) {
  if (!client || typeof client !== 'object') return client;
  return {
    id:         client.id,
    firstName:  client.firstName || '',
    lastName:   client.lastName  || '',
    name:       client.name      || '',
    email:      client.email     || '',
    phone:      client.phone     || '',
    entityName: client.entityName || '',
    companies:  Array.isArray(client.companies)
      ? client.companies.map((co) => ({ id: co && co.id, name: co && co.name }))
      : [],
    hasSSN:     !!client.ssn_enc,
    _isBroker:  !!client._isBroker,
    _importedAt:    client._importedAt    || undefined,
    _importSource:  client._importSource  || undefined,
    createdAt:  client.createdAt,
    updatedAt:  client.updatedAt,
    loans:      Array.isArray(client.loans) ? client.loans.map(projectLoan) : [],
  };
}

function _indexStore() {
  return getStore({ name: INDEX_STORE, consistency: 'strong' });
}

/**
 * Read the current index blob. Returns { index: null, isStale: false }
 * when the blob doesn't exist yet — caller decides whether to rebuild.
 */
export async function readIndex() {
  try {
    const store = _indexStore();
    const rec = await store.get(INDEX_KEY, { type: 'json' });
    if (!rec) return { index: null, isStale: false, exists: false };
    if (rec.version !== INDEX_VERSION) {
      // Schema drift → treat as missing so callers rebuild.
      return { index: null, isStale: false, exists: false, versionMismatch: true };
    }
    const ageMs = Date.now() - new Date(rec.updatedAt || 0).getTime();
    return { index: rec, isStale: ageMs > INDEX_TTL_MS, exists: true, ageMs };
  } catch (e) {
    console.warn('clients-index readIndex failed:', e && e.message);
    return { index: null, isStale: false, exists: false, error: e && e.message };
  }
}

async function _writeIndex(index) {
  const store = _indexStore();
  index.version   = INDEX_VERSION;
  index.updatedAt = new Date().toISOString();
  await store.setJSON(INDEX_KEY, index);
}

/**
 * Upsert a single client into the index. Never throws — logs and
 * continues on failure so the primary write path isn't blocked by
 * index bookkeeping.
 */
export async function upsertClient(ownerKey, client) {
  if (!ownerKey || !client || !client.id) return;
  try {
    const { index } = await readIndex();
    const idx = index && index.byOwner ? index : { byOwner: {} };
    const list = idx.byOwner[ownerKey] || [];
    const pos = list.findIndex((c) => c && c.id === client.id);
    const summary = projectClientSummary(client);
    if (pos >= 0) list[pos] = summary;
    else list.push(summary);
    idx.byOwner[ownerKey] = list;
    await _writeIndex(idx);
  } catch (e) {
    console.warn(`clients-index upsertClient failed for ${ownerKey}/${client.id}:`, e && e.message);
  }
}

/**
 * Remove a client from the index. Silent on failure.
 */
export async function removeClient(ownerKey, clientId) {
  if (!ownerKey || !clientId) return;
  try {
    const { index } = await readIndex();
    if (!index || !index.byOwner || !index.byOwner[ownerKey]) return;
    index.byOwner[ownerKey] = index.byOwner[ownerKey].filter((c) => c && c.id !== clientId);
    if (!index.byOwner[ownerKey].length) delete index.byOwner[ownerKey];
    await _writeIndex(index);
  } catch (e) {
    console.warn(`clients-index removeClient failed for ${ownerKey}/${clientId}:`, e && e.message);
  }
}

/**
 * Move a client between owner buckets (used by cross-LO reassign
 * flows). Silent on failure.
 */
export async function moveClient(fromOwnerKey, toOwnerKey, clientId, updatedClient) {
  if (!fromOwnerKey || !toOwnerKey || !clientId) return;
  try {
    const { index } = await readIndex();
    const idx = index && index.byOwner ? index : { byOwner: {} };
    // Remove from old.
    if (idx.byOwner[fromOwnerKey]) {
      idx.byOwner[fromOwnerKey] = idx.byOwner[fromOwnerKey].filter((c) => c && c.id !== clientId);
      if (!idx.byOwner[fromOwnerKey].length) delete idx.byOwner[fromOwnerKey];
    }
    // Add to new. Prefer updatedClient's summary; fall back to the
    // client's own entry from the old bucket (if it happens to still
    // exist somewhere in the index).
    const summary = updatedClient
      ? projectClientSummary(updatedClient)
      : (idx.byOwner[toOwnerKey] || []).find((c) => c && c.id === clientId) || null;
    if (summary) {
      const list = idx.byOwner[toOwnerKey] || [];
      const pos = list.findIndex((c) => c && c.id === clientId);
      if (pos >= 0) list[pos] = summary;
      else list.push(summary);
      idx.byOwner[toOwnerKey] = list;
    }
    await _writeIndex(idx);
  } catch (e) {
    console.warn(`clients-index moveClient failed for ${clientId}:`, e && e.message);
  }
}

/**
 * Full rebuild — walks every blob in the clients store, projects,
 * and writes a fresh index. Used by:
 *   - /api/admin-clients-index-rebuild (manual repair)
 *   - clients-list.mjs when it discovers a missing index
 *   - background trigger when readIndex() returns isStale
 * Returns { ownerCount, clientCount, ms }.
 */
export async function rebuildIndex() {
  const start = Date.now();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await clientsStore.list();
  const byOwner = {};
  // Parallel-fetch in chunks of 25 to keep memory reasonable.
  const CHUNK = 25;
  let clientCount = 0;
  for (let i = 0; i < blobs.length; i += CHUNK) {
    const slice = blobs.slice(i, i + CHUNK);
    const recs = await Promise.all(slice.map(async ({ key }) => {
      const slash = key.indexOf('/');
      if (slash < 0) return null;
      const ownerKey = key.slice(0, slash);
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      return { ownerKey, rec };
    }));
    // Deploy 236.342 — filter out null items BEFORE destructuring.
    // The prior loop `for (const { ownerKey, rec } of recs)` blew up
    // on the first null (which happens whenever a blob's key has no
    // `/` — settings blobs, malformed keys, etc.) with the message
    // "Cannot destructure property 'ownerKey' of '.for' as it is
    // null." That silently killed every rebuild attempt, so the
    // index never populated and every read fell through to the
    // 30-second walk fallback.
    for (const item of recs) {
      if (!item || !item.rec) continue;
      const { ownerKey, rec } = item;
      if (!byOwner[ownerKey]) byOwner[ownerKey] = [];
      byOwner[ownerKey].push(projectClientSummary(rec));
      clientCount++;
    }
  }
  // Sort each owner's list by most-recent.
  for (const o of Object.keys(byOwner)) {
    byOwner[o].sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
    );
  }
  await _writeIndex({ byOwner });
  return {
    ownerCount: Object.keys(byOwner).length,
    clientCount,
    ms: Date.now() - start,
  };
}
