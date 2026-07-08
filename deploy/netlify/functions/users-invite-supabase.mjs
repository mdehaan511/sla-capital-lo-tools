/**
 * users-invite-supabase.mjs — POST /api/users-invite-supabase
 *
 * Path A Phase 1: Send a Supabase invitation email to a new user
 * with a role stamped into app_metadata. Admin-only.
 *
 * Body: { email, role?, fullName? }
 *   - email    (required): the invitee's email
 *   - role     (optional, default 'loan_officer'): one of
 *                'admin' | 'loan_officer' | 'processor'
 *   - fullName (optional): stashed in user_metadata for display
 *
 * Flow:
 *   1. Gate on admin via existing Netlify Identity requireAuth.
 *      (Phase 2 will teach requireAuth to also accept Supabase
 *      JWTs so an admin whose own account has moved to Supabase
 *      can still invite.)
 *   2. Call Supabase Auth Admin API:
 *      POST {SUPABASE_URL}/auth/v1/invite
 *      Headers:
 *        apikey: <service role key>
 *        Authorization: Bearer <service role key>
 *      Body: {
 *        email,
 *        data: { full_name },        // → user_metadata
 *      }
 *      This sends the invite email AND creates the user. It does
 *      NOT accept app_metadata directly, so we follow up with a
 *      PUT to /auth/v1/admin/users/:id to stamp the role.
 *   3. Return the invited user's id + email.
 *
 * Response 200: { ok, user: { id, email, role } }
 * Response 4xx: { error }
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin, isSuperAdmin, normalizeEmail } from './_shared/auth.mjs';

const ALLOWED_ROLES = new Set(['admin', 'loan_officer', 'processor']);

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  // Phase 1 gate: existing Netlify Identity admin check. Phase 2
  // will extend requireAuth to also accept Supabase JWTs so
  // Supabase-migrated admins can still invite.
  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });

  const email = normalizeEmail(body && body.email);
  if (!email || !email.includes('@')) return json(400, { error: 'Valid email required' });

  const role = String((body && body.role) || 'loan_officer').toLowerCase();
  if (!ALLOWED_ROLES.has(role)) {
    return json(400, { error: 'Invalid role. Allowed: ' + Array.from(ALLOWED_ROLES).join(', ') });
  }
  if (role === 'admin' && !isSuperAdmin(user)) {
    return json(403, { error: 'Only super_admin can grant admin role' });
  }

  const fullName = String((body && body.fullName) || '').trim();

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) {
    return json(500, { error: 'Supabase env vars not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
  }
  const base = String(SUPABASE_URL).replace(/\/+$/, '');

  try {
    // 1. Invite — sends email + creates the user record.
    const inviteResp = await fetch(base + '/auth/v1/invite', {
      method: 'POST',
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        email: email,
        data:  fullName ? { full_name: fullName } : {},
      }),
    });

    if (!inviteResp.ok) {
      const txt = await inviteResp.text().catch(() => '');
      // Supabase returns 422 for "already exists" too; normalize to 409
      // to match the Netlify Identity invite behavior.
      if (inviteResp.status === 422 && /already|exists|registered/i.test(txt)) {
        return json(409, { error: 'User with this email already exists in Supabase' });
      }
      return json(inviteResp.status, { error: 'Supabase invite ' + inviteResp.status + ': ' + txt.slice(0, 300) });
    }

    const created = await inviteResp.json().catch(() => ({}));
    const supabaseUserId = created && created.id;

    // 2. Stamp the role into app_metadata. Best-effort — if this
    // fails, the user was still invited; we surface a warning
    // rather than swallowing it or double-charging the email.
    let roleStamped = false;
    let roleError = null;
    if (supabaseUserId) {
      try {
        const putResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(supabaseUserId), {
          method: 'PUT',
          headers: {
            'apikey':        SVC,
            'Authorization': 'Bearer ' + SVC,
            'Content-Type':  'application/json',
          },
          body: JSON.stringify({ app_metadata: { role: role, roles: [role] } }),
        });
        if (putResp.ok) roleStamped = true;
        else roleError = 'HTTP ' + putResp.status + ': ' + (await putResp.text().catch(() => '')).slice(0, 200);
      } catch (e) {
        roleError = (e && e.message) || 'unknown error';
      }
    } else {
      roleError = 'Invite succeeded but no user id returned — cannot stamp role.';
    }

    return json(200, {
      ok: true,
      user: {
        id:    supabaseUserId || '',
        email: email,
        role:  role,
      },
      roleStamped,
      roleError,
    });
  } catch (e) {
    console.error('users-invite-supabase error:', e);
    return json(500, { error: 'Failed to invite user: ' + ((e && e.message) || 'unknown') });
  }
};
