/**
 * clients-list.js — GET /api/clients
 *
 * Returns all clients owned by the authenticated LO.
 * Admins may pass ?all=1 to get every LO's clients (grouped by owner).
 *
 * Response shapes:
 *   Normal LO: { clients: [...] }
 *   Admin w/ ?all=1: { byOwner: { "alice@x.com": [...], "bob@x.com": [...] } }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
// Deploy 236.169 — Access Refactor PR #1: cross-LO listing is now
// gated by canListAllClients() instead of hand-rolled isAdmin. Same
// behavior for callers; centralizes the decision so PR #2+ can
// evolve the rule without editing every endpoint.
import { canListAllClients } from './_shared/access.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const store = getStore({ name: 'clients', consistency: 'strong' });

  try {
    if (wantAll && canListAllClients(user).ok) {
      const { blobs } = await store.list();
      const byOwner = {};
      await Promise.all(blobs.map(async ({ key }) => {
        const idx = key.indexOf('/');
        if (idx < 0) return;
        const owner = key.slice(0, idx);
        const record = await store.get(key, { type: 'json' });
        if (!record) return;
        if (!byOwner[owner]) byOwner[owner] = [];
        byOwner[owner].push(record);
      }));
      // Sort each owner's list by most-recent
      Object.keys(byOwner).forEach((o) => {
        byOwner[o].sort((a, b) =>
          new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
        );
        byOwner[o] = byOwner[o].map(sanitize);
      });
      return json(200, { byOwner });
    }

    const loKey = keySafe(normalizeEmail(user.email));
    const prefix = loKey + '/';
    const { blobs } = await store.list({ prefix });
    const clients = await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' })),
    );
    const filtered = clients.filter(Boolean);
    filtered.sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
    );
    return json(200, { clients: filtered.map(sanitize) });
  } catch (e) {
    console.error('clients-list error:', e);
    return json(500, { error: 'Failed to load clients' });
  }
};

// Strip the encrypted SSN from list responses; expose only a boolean flag.
// Plaintext SSN is fetched via /api/client-ssn-reveal on demand.
function sanitize(client) {
  const out = Object.assign({}, client);
  if (out.ssn_enc) {
    out.hasSSN = true;
    delete out.ssn_enc;
  } else {
    out.hasSSN = false;
  }
  return out;
}
