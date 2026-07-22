/**
 * brokers-list.mjs — GET /api/brokers
 *
 * Deploy 236.224 (Broker Phase A). Now reads from the unified `clients`
 * store filtered by `_isBroker: true`. Legacy `brokers` blob store is
 * still queried as a fallback for un-migrated records — returned in
 * the same shape so brokers.html doesn't need to know either exists.
 *
 * Deploy 236.387 — broker-flagged clients now come from Postgres
 * (clients WHERE is_broker = true) instead of walking every client
 * blob and GETting each one to check the flag. At 2,800+ client
 * blobs the ?all=1 walk ran long enough to time out the function.
 * Blob-shape is rebuilt from the PG row (camelCase + `extra` spread,
 * same pattern as client-get-pg.mjs) so the existing clientAsBroker()
 * projection keeps working unchanged. The legacy `brokers` store
 * merge is kept as-is — that store is small and read-only.
 *
 * Shapes (unchanged from Phase 1):
 *   Normal LO:           { brokers: [...] }
 *   Admin w/ ?all=1:     { byOwner: { 'alice@x.com': [...], 'bob@x.com': [...] } }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs';
import { isBrokerClient, clientAsBroker } from './_shared/broker-client.mjs';
import { db } from './_shared/supabase-db.mjs';

// Deploy 236.387 — everything isBrokerClient() + clientAsBroker() read,
// plus `extra` so un-promoted fields (_brokerCompany especially — it
// lives in extra, not a column) still round-trip onto the blob shape.
const BROKER_SELECT = 'id,owner_email,first_name,last_name,email,phone,' +
  'entity_name,display_name,is_broker,notes,created_at,updated_at,created_by,extra';

// Rebuild a blob-shaped client from a PG row — trimmed copy of
// client-get-pg.mjs's _clientRowToBlobShape (no loans needed here).
function _brokerRowToBlobShape(c) {
  if (!c) return null;
  const out = {
    id:          c.id,
    firstName:   c.first_name   || '',
    lastName:    c.last_name    || '',
    email:       c.email        || '',
    phone:       c.phone        || '',
    entityName:  c.entity_name  || '',
    displayName: c.display_name || '',
    _isBroker:   !!c.is_broker,
    notes:       c.notes        || '',
    createdAt:   c.created_at,
    updatedAt:   c.updated_at,
    createdBy:   c.created_by   || '',
  };
  // extra JSONB merged onto the top level so anything un-promoted
  // (e.g. _brokerCompany, _legacyBrokerId) still shows up.
  Object.assign(out, c.extra || {});
  // _isBroker is a promoted key (never in extra), but re-set it so a
  // malformed extra can't flip the flag out from under isBrokerClient.
  out._isBroker = !!c.is_broker;
  return out;
}

// Deploy 236.387 — paginated fetch of broker-flagged clients from PG.
// PostgREST caps responses at ~1000 rows regardless of limit, so loop
// with offset until a short page. The broker subset is small today,
// but pagination keeps this correct if the broker book ever grows.
async function _fetchBrokerClientRows(extraEq) {
  const PAGE = 1000;
  const rows = [];
  let offset = 0;
  while (true) {
    const page = await db.select('clients', {
      select: BROKER_SELECT,
      eq: Object.assign({ is_broker: true }, extraEq || {}),
      limit: PAGE,
      offset,
    });
    rows.push(...(page || []));
    if ((page || []).length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break; // runaway guard
  }
  return rows;
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const legacyStore = getStore({ name: 'brokers', consistency: 'strong' });

  try {
    if (wantAll && canListAllClients(user).ok) {
      const byOwner = {};
      // 1) Broker-flagged clients (new source of truth) — one paginated
      //    PG query instead of walking + GETting every client blob.
      //    byOwner keys stay keySafe(ownerEmail) to match the legacy
      //    blob-prefix keys the merge below (and brokers.html) expect.
      const rows = await _fetchBrokerClientRows();
      for (const r of rows) {
        const client = _brokerRowToBlobShape(r);
        if (!isBrokerClient(client)) continue; // exact legacy semantics
        const owner = keySafe(normalizeEmail(r.owner_email || ''));
        if (!owner) continue;
        (byOwner[owner] = byOwner[owner] || []).push(clientAsBroker(client));
      }
      // 2) Legacy brokers store — anything the Phase A migration
      //    hasn't picked up yet. Skip if already present in byOwner
      //    (matched by id) so we don't double-list post-migration.
      await _mergeLegacyBrokersByOwner(legacyStore, byOwner);
      Object.keys(byOwner).forEach((o) => {
        byOwner[o].sort((a, b) =>
          new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
        );
      });
      return json(200, { byOwner });
    }

    const loKey = keySafe(normalizeEmail(user.email));
    const prefix = loKey + '/';
    // Broker-flagged clients under this owner — PG query scoped by
    // owner_email (stored normalized lowercase by pg-mirror, which is
    // exactly normalizeEmail(user.email)).
    const brokers = [];
    const seenIds = new Set();
    const rows = await _fetchBrokerClientRows({ owner_email: normalizeEmail(user.email) });
    for (const r of rows) {
      const client = _brokerRowToBlobShape(r);
      if (!isBrokerClient(client)) continue;
      const b = clientAsBroker(client);
      brokers.push(b);
      seenIds.add(b.id);
    }
    // Legacy broker records not yet migrated.
    try {
      const { blobs: lb } = await legacyStore.list({ prefix });
      for (const { key } of lb) {
        const rec = await legacyStore.get(key, { type: 'json' }).catch(() => null);
        if (!rec || seenIds.has(rec.id)) continue;
        brokers.push(rec);
      }
    } catch (_) { /* non-fatal */ }
    brokers.sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
    );
    return json(200, { brokers });
  } catch (e) {
    console.error('brokers-list error:', e);
    return json(500, { error: 'Failed to load brokers' });
  }
};

// Read every legacy broker record; skip anything already in byOwner
// under the matching (owner, id) tuple.
async function _mergeLegacyBrokersByOwner(store, byOwner) {
  try {
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const owner = key.slice(0, slash);
      const rec = await store.get(key, { type: 'json' }).catch(() => null);
      if (!rec) continue;
      const existing = byOwner[owner] || [];
      if (existing.some((b) => b.id === rec.id)) continue;
      (byOwner[owner] = existing).push(rec);
    }
  } catch (_) { /* non-fatal */ }
}
