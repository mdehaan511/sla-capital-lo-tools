/**
 * quotes-list.mjs — GET /api/quotes
 *
 * Returns all saved quotes for the authenticated user.
 * Admins may pass ?all=1 to get every user's quotes (grouped by owner).
 *
 * Quote shape (preserved from current saved-quotes.html code):
 *   { id, toolType, savedAt, updatedAt, status, loanAmt, loanType, fico,
 *     rate, points, propValue, rent, taxes, insurance, hoa, address, ... }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.266
import { quotesIndex } from './_shared/quotes-index.mjs'; // Deploy 236.343

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const store = getStore({ name: 'quotes', consistency: 'strong' });

  try {
    if (wantAll && canListAllClients(user).ok) {
      // Deploy 236.343 — index fast path. One blob get instead of
      // walking every quote (~500+ at Mike's scale, growing).
      const { index, isStale, exists } = await quotesIndex.readIndex();
      if (exists && index && index.byOwner) {
        if (isStale) {
          quotesIndex.rebuildIndex().catch((e) => console.warn('quotes rebuild bg failed:', e && e.message));
        }
        return json(200, { byOwner: index.byOwner, _fromIndex: true });
      }
      // Missing index → rebuild inline + return.
      try {
        const stats = await quotesIndex.rebuildIndex();
        const fresh = await quotesIndex.readIndex();
        if (fresh && fresh.index && fresh.index.byOwner) {
          return json(200, { byOwner: fresh.index.byOwner, _fromIndex: true, _rebuilt: stats });
        }
      } catch (e) {
        console.warn('quotes-list inline rebuild failed, falling through:', e && e.message);
      }
      // Fallback: legacy walk.
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
          new Date(b.updatedAt || b.savedAt || 0) - new Date(a.updatedAt || a.savedAt || 0));
      });
      return json(200, { byOwner });
    }

    const ownerKey = keySafe(normalizeEmail(user.email));
    const prefix = ownerKey + '/';
    const { blobs } = await store.list({ prefix });
    const quotes = await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' })),
    );
    const filtered = quotes.filter(Boolean);
    filtered.sort((a, b) =>
      new Date(b.updatedAt || b.savedAt || 0) - new Date(a.updatedAt || a.savedAt || 0));
    return json(200, { quotes: filtered });
  } catch (e) {
    console.error('quotes-list error:', e);
    return json(500, { error: 'Failed to load quotes' });
  }
};
