/**
 * users-directory.mjs — GET /api/users-directory
 *
 * Deploy 236.107 — minimal user directory for in-app pickers
 * (task assignee, @-mention, contact role assignment, etc.).
 *
 * Returns just { email, name, slug, roles } per user — no phone,
 * no last-login, no IDs. Any authenticated user can call this;
 * the existing users-list endpoint stays admin-only because it
 * exposes management metadata (confirmed_at, last_sign_in_at,
 * the full Identity user.id, etc.) that processors / LOs
 * shouldn't see.
 *
 * Backed by the same Netlify Identity Admin API users-list uses;
 * the admin token is per-request (context.clientContext.identity)
 * so the function can read it regardless of the caller's role.
 *
 * Response: { users: [{ email, name, slug, roles }] }
 */
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const identity = context && context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    return json(500, { error: 'Identity context unavailable' });
  }

  try {
    const out = [];
    let page = 1;
    for (;;) {
      const url = `${identity.url}/admin/users?per_page=50&page=${page}`;
      const resp = await fetch(url, {
        headers: { Authorization: `Bearer ${identity.token}` },
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return json(resp.status, { error: `Identity API ${resp.status}: ${txt.slice(0, 200)}` });
      }
      const data = await resp.json();
      const users = Array.isArray(data.users) ? data.users : [];
      out.push(...users);
      if (users.length < 50) break;
      page += 1;
      if (page > 20) break; // safety cap
    }

    // Minimal payload — no PII beyond what an in-app picker needs.
    // Sorted by name (then email) so dropdown render order is stable.
    const trimmed = out
      .filter((u) => u && u.email && !u.banned) // hide disabled accounts
      .map((u) => ({
        email: String(u.email).toLowerCase(),
        name:  (u.user_metadata && u.user_metadata.full_name) || '',
        slug:  (u.user_metadata && u.user_metadata.slug) || '',
        roles: (u.app_metadata && Array.isArray(u.app_metadata.roles))
          ? u.app_metadata.roles
          : (u.app_metadata && u.app_metadata.roles ? [u.app_metadata.roles] : []),
      }))
      .sort((a, b) => {
        const an = (a.name || a.email).toLowerCase();
        const bn = (b.name || b.email).toLowerCase();
        if (an < bn) return -1;
        if (an > bn) return  1;
        return 0;
      });

    return json(200, { users: trimmed });
  } catch (e) {
    console.error('users-directory error:', e);
    return json(500, { error: 'Failed to list users: ' + ((e && e.message) || 'unknown') });
  }
};
