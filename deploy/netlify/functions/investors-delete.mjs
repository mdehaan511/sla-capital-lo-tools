/**
 * investors-delete.mjs — POST /api/investors-delete
 *
 * Deploy 236.475 — admin-only. Removes an investor from the org-wide book.
 * Loans that referenced this investor keep their stored investorId/name
 * (they just won't resolve to a live record); deletion here does not touch
 * loans.
 *
 * Body: { id }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, keySafe } from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });

    const body = await req.json().catch(() => null);
    const id = String((body && body.id) || '').trim();
    if (!id) return json(400, { error: 'id required' });

    const store = getStore({ name: 'investors', consistency: 'strong' });
    await store.delete(keySafe(id));
    return json(200, { ok: true, deletedId: id });
  } catch (e) {
    console.error('investors-delete error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
