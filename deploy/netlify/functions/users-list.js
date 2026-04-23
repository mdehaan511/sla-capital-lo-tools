/**
 * users-list.js — GET /api/users-list
 *
 * Lists all Netlify Identity users. Admin-only.
 * Calls the Netlify Identity Admin API using the per-request admin token
 * Netlify injects into context.clientContext.identity.
 *
 * This replaces the localStorage-based "user registry" in admin.html, which
 * only reflected users who had logged in on the admin's own browser.
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.js';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const identity = context && context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    return json(500, { error: 'Identity context unavailable' });
  }

  try {
    // Paginate through users. Identity default page size is 50.
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
      if (page > 20) break; // safety — 1000 users cap
    }

    // Trim to what the UI needs
    const trimmed = out.map((u) => ({
      id: u.id,
      email: u.email,
      confirmed_at: u.confirmed_at || null,
      created_at: u.created_at || null,
      last_sign_in_at: u.last_sign_in_at || null,
      full_name: (u.user_metadata && u.user_metadata.full_name) || '',
      phone: (u.user_metadata && u.user_metadata.phone) || '',
      slug: (u.user_metadata && u.user_metadata.slug) || '',
      roles: (u.app_metadata && Array.isArray(u.app_metadata.roles))
        ? u.app_metadata.roles
        : (u.app_metadata && u.app_metadata.roles ? [u.app_metadata.roles] : ['user']),
    }));

    return json(200, { users: trimmed });
  } catch (e) {
    console.error('users-list error:', e);
    return json(500, { error: 'Failed to list users' });
  }
};
