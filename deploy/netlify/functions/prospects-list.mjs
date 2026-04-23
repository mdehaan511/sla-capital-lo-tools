/**
 * prospects-list.js — GET /api/prospects
 *
 * Returns prospects routed to the authenticated LO's slug.
 *   - The LO's slug is pulled from user.user_metadata.slug, falling back to
 *     the email localpart.
 *   - Admins may pass ?all=1 to see every prospect, grouped by loSlug.
 *   - Admins/LOs may pass ?slug=<slug> to view a specific slug.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe,
} from './_shared/auth.mjs';

function slugForUser(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  if (meta.slug) return keySafe(String(meta.slug).toLowerCase());
  if (user.email) return keySafe(user.email.split('@')[0].toLowerCase());
  return '';
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const explicitSlug = url.searchParams.get('slug');

  const store = getStore({ name: 'prospects', consistency: 'strong' });

  try {
    if (wantAll && isAdmin(user)) {
      const { blobs } = await store.list();
      const bySlug = {};
      await Promise.all(blobs.map(async ({ key }) => {
        const idx = key.indexOf('/');
        if (idx < 0) return;
        const slug = key.slice(0, idx);
        const record = await store.get(key, { type: 'json' });
        if (!record) return;
        if (!bySlug[slug]) bySlug[slug] = [];
        bySlug[slug].push(record);
      }));
      Object.keys(bySlug).forEach((s) => {
        bySlug[s].sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
      });
      return json(200, { bySlug });
    }

    // Non-admin: only their own slug. Admin asking for a specific slug is also fine.
    let slug = explicitSlug ? keySafe(explicitSlug.toLowerCase()) : slugForUser(user);
    if (!isAdmin(user) && explicitSlug && keySafe(explicitSlug.toLowerCase()) !== slugForUser(user)) {
      return json(403, { error: 'Not authorized for that slug' });
    }
    if (!slug) return json(200, { prospects: [] });

    const prefix = slug + '/';
    const { blobs } = await store.list({ prefix });
    const prospects = await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' })),
    );
    const filtered = prospects.filter(Boolean);
    filtered.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    return json(200, { prospects: filtered, slug });
  } catch (e) {
    console.error('prospects-list error:', e);
    return json(500, { error: 'Failed to load prospects' });
  }
};
