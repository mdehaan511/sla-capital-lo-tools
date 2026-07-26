/**
 * users-update-role-supabase.mjs — POST /api/users-update-role-supabase
 *
 * Admin-only. Updates a user's role via Supabase Auth Admin API.
 * Body: { userId, role }
 *
 * Stamps role into BOTH app_metadata.role (singular) and
 * app_metadata.roles (array) so downstream code that reads either
 * shape works. Preserves any other app_metadata fields the user
 * had (provider, providers, etc.) — only the role keys are replaced.
 *
 * Guardrails:
 *   - Only super_admin can grant or revoke 'admin' role.
 *   - Users can't demote themselves — protects against locking
 *     yourself out of admin capabilities.
 *
 * Response 200: { ok, user: { id, email, role, roles } }
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin, isSuperAdmin } from './_shared/auth.mjs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs'; // Deploy 236.398

const ALLOWED_ROLES = new Set(['admin', 'loan_officer', 'processor']);

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const caller = await requireAuth(context, req);
  if (!caller) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(caller)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const userId = String((body && body.userId) || '').trim();
  const role = String((body && body.role) || '').toLowerCase().trim();
  if (!userId) return json(400, { error: 'userId required' });
  if (!ALLOWED_ROLES.has(role)) {
    return json(400, { error: 'Invalid role. Allowed: ' + Array.from(ALLOWED_ROLES).join(', ') });
  }

  const SUPABASE_URL = supabaseBaseUrl(); // Deploy 236.398: strips /rest/v1 suffix
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) {
    return json(500, { error: 'Supabase env vars not configured' });
  }
  const base = String(SUPABASE_URL).replace(/\/+$/, '');

  try {
    // Fetch existing so we can preserve provider info + know the
    // target's current role for guardrails.
    const lookupResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC },
    });
    if (!lookupResp.ok) {
      const txt = await lookupResp.text().catch(() => '');
      return json(lookupResp.status, { error: 'Supabase lookup ' + lookupResp.status + ': ' + txt.slice(0, 300) });
    }
    const target = await lookupResp.json();
    const existingAm = (target && target.app_metadata) || {};
    const existingRoles = Array.isArray(existingAm.roles) ? existingAm.roles : (typeof existingAm.role === 'string' && existingAm.role ? [existingAm.role] : []);

    // Guard: only super_admin can grant admin, or demote an existing admin.
    if (role === 'admin' && !isSuperAdmin(caller)) {
      return json(403, { error: 'Only super_admin can grant the admin role' });
    }
    if (existingRoles.includes('admin') && role !== 'admin' && !isSuperAdmin(caller)) {
      return json(403, { error: 'Only super_admin can revoke admin from another user' });
    }
    // Guard: can't demote yourself. Prevents accidental lockout.
    if (target && target.email && caller.email &&
        String(target.email).toLowerCase() === String(caller.email).toLowerCase() &&
        role !== 'admin' && existingRoles.includes('admin')) {
      return json(400, { error: 'You cannot revoke your own admin role. Ask another super_admin.' });
    }

    // Build the merged app_metadata. Keep everything Supabase set
    // (provider, providers, etc.); replace the role keys.
    const mergedAm = Object.assign({}, existingAm, { role: role, roles: [role] });

    const putResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      method: 'PUT',
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ app_metadata: mergedAm }),
    });
    if (!putResp.ok) {
      const txt = await putResp.text().catch(() => '');
      return json(putResp.status, { error: 'Supabase update ' + putResp.status + ': ' + txt.slice(0, 300) });
    }
    const updated = await putResp.json().catch(() => ({}));
    return json(200, {
      ok: true,
      user: {
        id:    userId,
        email: (updated.email || target.email || '').toLowerCase(),
        role:  role,
        roles: [role],
      },
    });
  } catch (e) {
    console.error('users-update-role-supabase error:', e);
    return json(500, { error: 'Failed to update role: ' + ((e && e.message) || 'unknown') });
  }
};
