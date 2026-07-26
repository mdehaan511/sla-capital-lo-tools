/**
 * users-list-supabase.mjs — GET /api/users-list-supabase
 *
 * Path A Phase 1: Return every user in the Supabase project.
 * Admin-only.
 *
 * Uses the Auth Admin API:
 *   GET {SUPABASE_URL}/auth/v1/admin/users?page=1&per_page=200
 *
 * Response 200:
 *   {
 *     ok: true,
 *     users: [
 *       {
 *         id, email, role, roles,
 *         invitedAt, confirmedAt, lastSignInAt,
 *         fullName,
 *         provider,
 *         appMetadata, userMetadata      // raw for advanced inspection
 *       }, ...
 *     ],
 *     total,
 *   }
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs'; // Deploy 236.398

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  // Pass req so requireAuth can fall back to Authorization-header
  // decode when context.clientContext.user is empty.
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const SUPABASE_URL = supabaseBaseUrl(); // Deploy 236.398: strips /rest/v1 suffix
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) {
    return json(500, { error: 'Supabase env vars not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
  }
  const base = String(SUPABASE_URL).replace(/\/+$/, '');

  // Support pagination via ?page=N&perPage=N; defaults are sensible for
  // an admin UI showing the whole list.
  const url = new URL(req.url);
  const page    = Math.max(1, parseInt(url.searchParams.get('page')    || '1', 10));
  const perPage = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('perPage') || '200', 10)));

  try {
    const listResp = await fetch(base + '/auth/v1/admin/users?page=' + page + '&per_page=' + perPage, {
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
      },
    });
    if (!listResp.ok) {
      const txt = await listResp.text().catch(() => '');
      return json(listResp.status, { error: 'Supabase list ' + listResp.status + ': ' + txt.slice(0, 300) });
    }
    const doc = await listResp.json().catch(() => ({}));
    const rawUsers = Array.isArray(doc && doc.users) ? doc.users : [];

    const users = rawUsers.map((u) => {
      const am = (u && u.app_metadata) || {};
      const um = (u && u.user_metadata) || {};
      const roles = Array.isArray(am.roles) ? am.roles : (typeof am.role === 'string' && am.role ? [am.role] : []);
      return {
        id:           u.id || '',
        email:        (u.email || '').toLowerCase(),
        role:         roles[0] || '',
        roles:        roles,
        invitedAt:    u.invited_at    || '',
        confirmedAt:  u.email_confirmed_at || u.confirmed_at || '',
        lastSignInAt: u.last_sign_in_at || '',
        fullName:     um.full_name || um.name || '',
        provider:     am.provider  || (Array.isArray(am.providers) ? am.providers.join(',') : ''),
        appMetadata:  am,
        userMetadata: um,
      };
    });

    // Sort: most-recently-signed-in first, then newest-invited, then email.
    users.sort((a, b) => {
      const aT = a.lastSignInAt || a.invitedAt || '';
      const bT = b.lastSignInAt || b.invitedAt || '';
      if (aT !== bT) return bT.localeCompare(aT);
      return (a.email || '').localeCompare(b.email || '');
    });

    return json(200, {
      ok:    true,
      users: users,
      total: (doc && (doc.total || doc.total_count)) || users.length,
      page:  page,
      perPage: perPage,
    });
  } catch (e) {
    console.error('users-list-supabase error:', e);
    return json(500, { error: 'Failed to list users: ' + ((e && e.message) || 'unknown') });
  }
};
