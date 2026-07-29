/**
 * investors-list.mjs — GET /api/investors-list
 *
 * Deploy 236.475 — returns the org-wide investor book. Readable by ANY
 * authenticated user (loan officers select an investor on a loan's Funding
 * Plan); only admins can add/edit/delete (investors-save / investors-delete).
 *
 * Response: { investors: [{ id, name, company, pocName, pocEmail, pocPhone,
 *                           criteria, notes, createdAt, updatedAt }, ...] }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    const store = getStore({ name: 'investors', consistency: 'strong' });
    const { blobs } = await store.list();
    const investors = [];
    await Promise.all(blobs.map(async ({ key }) => {
      const inv = await store.get(key, { type: 'json' }).catch(() => null);
      if (inv && inv.id) investors.push(inv);
    }));
    investors.sort((a, b) =>
      String(a.name || a.company || '').toLowerCase()
        .localeCompare(String(b.name || b.company || '').toLowerCase()));

    return json(200, { investors });
  } catch (e) {
    console.error('investors-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
