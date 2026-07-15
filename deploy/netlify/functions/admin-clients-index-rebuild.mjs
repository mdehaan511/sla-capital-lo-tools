/**
 * admin-clients-index-rebuild.mjs — POST /api/admin-clients-index-rebuild
 *
 * Deploy 236.341 (Tier 2 scaling) — force a full rebuild of the
 * clients-index blob. Used after a bulk import, after any endpoint
 * that mutates a client without instrumenting the index write-through,
 * or as a routine repair when the index looks stale.
 *
 * Auth: admin only.
 * Response: { ok, ownerCount, clientCount, ms }
 */
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { rebuildIndex } from './_shared/clients-index.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-clients-index-rebuild error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const stats = await rebuildIndex();
  return json(200, { ok: true, ...stats });
}
