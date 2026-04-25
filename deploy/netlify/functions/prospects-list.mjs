/**
 * prospects-list.mjs — GET /api/prospects
 *
 * Returns prospects belonging to the authenticated LO.
 *
 * New shape: prospects are stored under keySafe(loEmail)/{prospectId}.
 * Older entries may still be under a slug; we read both prefixes for the
 * current LO so nothing's dropped during the transition.
 *
 * Admins may pass ?all=1 to see every prospect grouped by ownerKey.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

function ownerKeyForUser(user) {
  if (!user) return '';
  return keySafe(normalizeEmail(user.email));
}

function legacySlugForUser(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  if (meta.slug) return keySafe(String(meta.slug).toLowerCase());
  if (user.email) return keySafe(user.email.split('@')[0].toLowerCase());
  return '';
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const store = getStore({ name: 'prospects', consistency: 'strong' });

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
      Object.keys(byOwner).forEach((s) => {
        byOwner[s].sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
      });
      return json(200, { bySlug: byOwner });
    }

    // Pull from BOTH the new email-keyed prefix AND the legacy slug prefix
    const ownerKey  = ownerKeyForUser(user);
    const legacyKey = legacySlugForUser(user);

    const collected = {};
    async function pull(prefix) {
      if (!prefix) return;
      const { blobs } = await store.list({ prefix: prefix + '/' });
      await Promise.all(blobs.map(async ({ key }) => {
        const p = await store.get(key, { type: 'json' });
        if (p && p.id) collected[p.id] = p;
      }));
    }
    await pull(ownerKey);
    if (legacyKey && legacyKey !== ownerKey) await pull(legacyKey);

    const prospects = Object.values(collected);
    prospects.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    return json(200, { prospects, slug: ownerKey });
  } catch (e) {
    console.error('prospects-list error:', e);
    return json(500, { error: 'Failed to load prospects' });
  }
};
