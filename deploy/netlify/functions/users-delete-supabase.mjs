/**
 * users-delete-supabase.mjs — POST /api/users-delete-supabase
 *
 * Path A Phase 1 extension: hard-delete a Supabase user via the
 * Auth Admin API. Admin-only. Body: { userId }.
 *
 * "Delete" removes the user record entirely from Supabase. If you
 * want a reversible option, use the disable flag instead (see
 * users-update-role for the pattern — passing user_metadata.disabled
 * would let you keep the audit trail).
 *
 * Response 200: { ok, deleted: userId }
 * Response 4xx: { error }
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin, isSuperAdmin } from './_shared/auth.mjs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs'; // Deploy 236.398

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const caller = await requireAuth(context, req);
  if (!caller) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(caller)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const userId = String((body && body.userId) || '').trim();
  if (!userId) return json(400, { error: 'userId required' });

  const SUPABASE_URL = supabaseBaseUrl(); // Deploy 236.398: strips /rest/v1 suffix
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) {
    return json(500, { error: 'Supabase env vars not configured' });
  }
  const base = String(SUPABASE_URL).replace(/\/+$/, '');

  // Guard: only super_admin can delete another admin. Prevents an
  // ordinary admin from removing a peer or the super_admin's own
  // account.
  try {
    const lookupResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC },
    });
    if (lookupResp.ok) {
      const u = await lookupResp.json().catch(() => null);
      const am = (u && u.app_metadata) || {};
      const targetRoles = Array.isArray(am.roles) ? am.roles : (typeof am.role === 'string' && am.role ? [am.role] : []);
      if (targetRoles.includes('admin') && !isSuperAdmin(caller)) {
        return json(403, { error: 'Only super_admin can delete another admin' });
      }
    }
  } catch (_) { /* non-fatal — Supabase 404 during lookup will bubble on delete */ }

  try {
    const delResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      method: 'DELETE',
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
      },
    });
    if (!delResp.ok) {
      const txt = await delResp.text().catch(() => '');
      return json(delResp.status, { error: 'Supabase delete ' + delResp.status + ': ' + txt.slice(0, 300) });
    }
    return json(200, { ok: true, deleted: userId });
  } catch (e) {
    console.error('users-delete-supabase error:', e);
    return json(500, { error: 'Failed to delete user: ' + ((e && e.message) || 'unknown') });
  }
};
