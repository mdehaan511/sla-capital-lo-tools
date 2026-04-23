/**
 * users-update.mjs — POST /api/users-update
 *
 * Update a Netlify Identity user's role. Admin-only.
 *
 * Body: { userId, role }
 *   - role: 'user' | 'admin' | 'super_admin'
 *
 * Uses the per-request admin token Netlify injects into context.identity to
 * call the Identity Admin API safely from server-side. This is the correct
 * pattern — calling /admin/users/:id from a browser JWT does not work.
 *
 * Safety: super_admin role can only be granted by an existing super_admin.
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin, isSuperAdmin } from './_shared/auth.mjs';

const ALLOWED_ROLES = new Set(['user', 'admin', 'super_admin']);

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.userId || !body.role) return json(400, { error: 'userId and role required' });
  if (!ALLOWED_ROLES.has(body.role)) return json(400, { error: 'Invalid role' });

  // Only super_admins can grant super_admin
  if (body.role === 'super_admin' && !isSuperAdmin(user)) {
    return json(403, { error: 'Only super_admin can grant super_admin' });
  }

  const identity = context && context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    return json(500, { error: 'Identity context unavailable' });
  }

  try {
    const url = `${identity.url}/admin/users/${encodeURIComponent(body.userId)}`;
    const resp = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${identity.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ app_metadata: { roles: [body.role] } }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return json(resp.status, { error: `Identity API ${resp.status}: ${txt.slice(0, 200)}` });
    }
    return json(200, { ok: true });
  } catch (e) {
    console.error('users-update error:', e);
    return json(500, { error: 'Failed to update user' });
  }
};
