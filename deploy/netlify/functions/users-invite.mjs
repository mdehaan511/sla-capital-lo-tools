/**
 * users-invite.mjs — POST /api/users-invite
 *
 * Send a Netlify Identity invitation email to a new user. Admin-only.
 * Body: { email, role? }
 *
 * Identity sends the invitation; the user clicks the link in their email
 * and sets their own password. Their role is then updated via users-update.
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin, isSuperAdmin, normalizeEmail } from './_shared/auth.mjs';

const ALLOWED_ROLES = new Set(['user', 'admin', 'super_admin']);

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const email = normalizeEmail(body && body.email);
  if (!email || !email.includes('@')) return json(400, { error: 'Valid email required' });

  const role = body.role || 'user';
  if (!ALLOWED_ROLES.has(role)) return json(400, { error: 'Invalid role' });
  if (role === 'super_admin' && !isSuperAdmin(user)) {
    return json(403, { error: 'Only super_admin can grant super_admin' });
  }

  const identity = context && context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    return json(500, { error: 'Identity context unavailable' });
  }

  try {
    // The /invite endpoint sends an email with a confirmation link.
    // /admin/users creates the user but does NOT send an email — that's why
    // earlier attempts succeeded silently with no email arriving.
    const inviteResp = await fetch(`${identity.url}/invite`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${identity.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: email,
        // Note: app_metadata isn't accepted on /invite, so we update the
        // role in a follow-up PUT to /admin/users/:id once the user exists.
      }),
    });

    if (!inviteResp.ok) {
      const txt = await inviteResp.text().catch(() => '');
      if (inviteResp.status === 422) {
        return json(409, { error: 'User with this email already exists' });
      }
      return json(inviteResp.status, { error: `Identity API ${inviteResp.status}: ${txt.slice(0, 200)}` });
    }

    const created = await inviteResp.json().catch(() => ({}));

    // Set the role if non-default. Best-effort; don't fail the invite if this fails.
    if (role && role !== 'user' && created.id) {
      try {
        await fetch(`${identity.url}/admin/users/${encodeURIComponent(created.id)}`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${identity.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ app_metadata: { roles: [role] } }),
        });
      } catch (e) {
        console.warn('users-invite: invite sent but role update failed:', e);
      }
    }

    return json(200, { ok: true, user: { id: created.id, email: created.email } });
  } catch (e) {
    console.error('users-invite error:', e);
    return json(500, { error: 'Failed to invite user' });
  }
};
