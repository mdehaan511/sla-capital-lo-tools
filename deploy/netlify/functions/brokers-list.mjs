/**
 * brokers-list.mjs — GET /api/brokers
 *
 * Deploy 236 (Brokers Phase 1). Returns all brokers owned by the
 * authenticated LO. Admins may pass ?all=1 to get every LO's brokers
 * grouped by owner. Matches the shape of clients-list.mjs intentionally
 * so frontend helpers can reuse the response shape.
 *
 * Shapes:
 *   Normal LO:           { brokers: [...] }
 *   Admin w/ ?all=1:     { byOwner: { 'alice@x.com': [...], 'bob@x.com': [...] } }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.170

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const store = getStore({ name: 'brokers', consistency: 'strong' });

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
    const brokers = (await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' })),
    )).filter(Boolean);
    brokers.sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
    );
    return json(200, { brokers });
  } catch (e) {
    console.error('brokers-list error:', e);
    return json(500, { error: 'Failed to load brokers' });
  }
};
