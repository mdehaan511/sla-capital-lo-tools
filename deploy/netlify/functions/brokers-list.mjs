/**
 * brokers-list.mjs — GET /api/brokers
 *
 * Deploy 236.224 (Broker Phase A). Now reads from the unified `clients`
 * store filtered by `_isBroker: true`. Legacy `brokers` blob store is
 * still queried as a fallback for un-migrated records — returned in
 * the same shape so brokers.html doesn't need to know either exists.
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

const CONCURRENCY = 10;

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const legacyStore  = getStore({ name: 'brokers', consistency: 'strong' });

  try {
    if (wantAll && canListAllClients(user).ok) {
      const byOwner = {};
      // 1) Broker-flagged clients (new source of truth).
      const { blobs } = await clientsStore.list();
      for (let i = 0; i < blobs.length; i += CONCURRENCY) {
        const chunk = blobs.slice(i, i + CONCURRENCY);
        const results = await Promise.all(chunk.map(async ({ key }) => {
          const slash = key.indexOf('/');
          if (slash < 0) return null;
          const owner = key.slice(0, slash);
          const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
          if (!isBrokerClient(client)) return null;
          return { owner, broker: clientAsBroker(client) };
        }));
        for (const r of results) if (r) {
          (byOwner[r.owner] = byOwner[r.owner] || []).push(r.broker);
        }
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
    // Broker-flagged clients under this owner.
    const brokers = [];
    const seenIds = new Set();
    const { blobs } = await clientsStore.list({ prefix });
    for (let i = 0; i < blobs.length; i += CONCURRENCY) {
      const chunk = blobs.slice(i, i + CONCURRENCY);
      const results = await Promise.all(chunk.map(({ key }) => clientsStore.get(key, { type: 'json' }).catch(() => null)));
      for (const c of results) {
        if (isBrokerClient(c)) {
          const b = clientAsBroker(c);
          brokers.push(b);
          seenIds.add(b.id);
        }
      }
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
