/**
 * users-delete.mjs — POST /api/users-delete
 *
 * Delete a Netlify Identity user. Super-admin only (less reversible action).
 * Body: { userId }
 */
import { handleOptions, json, requireAuth, readJsonBody, isSuperAdmin } from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.userId) return json(400, { error: 'userId required' });

  // Don't let an admin delete themselves
  if (body.userId === user.sub) {
    return json(400, { error: 'Cannot delete your own account' });
  }

  const identity = context && context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    return json(500, { error: 'Identity context unavailable' });
  }

  try {
    const url = `${identity.url}/admin/users/${encodeURIComponent(body.userId)}`;
    const resp = await fetch(url, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${identity.token}` },
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return json(resp.status, { error: `Identity API ${resp.status}: ${txt.slice(0, 200)}` });
    }
    return json(200, { ok: true });
  } catch (e) {
    console.error('users-delete error:', e);
    return json(500, { error: 'Failed to delete user' });
  }
};
