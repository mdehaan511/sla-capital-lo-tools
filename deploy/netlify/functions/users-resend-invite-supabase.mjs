/**
 * users-resend-invite-supabase.mjs — POST /api/users-resend-invite-supabase
 *
 * Admin-only. Sends a fresh invite email to a user who hasn't
 * confirmed yet. Handles the "email got lost" case Mike hit.
 *
 * Body: { userId }.
 *
 * Two Supabase paths depending on user state:
 *   - User exists but hasn't confirmed → generateLink 'invite' type
 *     produces a fresh action-link URL; Supabase emails it via
 *     the configured SMTP.
 *   - User already confirmed → 400 with a clear message; use
 *     "reset password" flow instead (out of scope here).
 *
 * Response 200: { ok, userId, email }
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin } from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const caller = requireAuth(context, req);
  if (!caller) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(caller)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const userId = String((body && body.userId) || '').trim();
  if (!userId) return json(400, { error: 'userId required' });

  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) {
    return json(500, { error: 'Supabase env vars not configured' });
  }
  const base = String(SUPABASE_URL).replace(/\/+$/, '');

  try {
    // Look up the target's email + current confirmation state.
    const lookupResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC },
    });
    if (!lookupResp.ok) {
      const txt = await lookupResp.text().catch(() => '');
      return json(lookupResp.status, { error: 'Supabase lookup ' + lookupResp.status + ': ' + txt.slice(0, 300) });
    }
    const target = await lookupResp.json();
    const email = String((target && target.email) || '').toLowerCase();
    const confirmedAt = target && (target.email_confirmed_at || target.confirmed_at);
    if (!email) return json(400, { error: 'Target user has no email address' });
    if (confirmedAt) {
      return json(400, { error: 'User has already confirmed their account. Use the password-reset flow instead of resending an invite.' });
    }

    // /auth/v1/invite re-sends the invite email. If the user already
    // exists (which is exactly our case), Supabase still generates a
    // fresh magic link and delivers it via SMTP.
    const inviteResp = await fetch(base + '/auth/v1/invite', {
      method: 'POST',
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ email: email }),
    });
    if (!inviteResp.ok) {
      const txt = await inviteResp.text().catch(() => '');
      return json(inviteResp.status, { error: 'Supabase resend ' + inviteResp.status + ': ' + txt.slice(0, 300) });
    }

    return json(200, { ok: true, userId: userId, email: email });
  } catch (e) {
    console.error('users-resend-invite-supabase error:', e);
    return json(500, { error: 'Failed to resend invite: ' + ((e && e.message) || 'unknown') });
  }
};
