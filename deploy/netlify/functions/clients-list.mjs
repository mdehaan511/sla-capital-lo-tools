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
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const store = getStore({ name: 'clients', consistency: 'strong' });

  try {
    if (wantAll && isAdmin(user)) {
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
    return json(200, { clients: filtered });
  } catch (e) {
    console.error('clients-list error:', e);
    return json(500, { error: 'Failed to load clients' });
  }
};
