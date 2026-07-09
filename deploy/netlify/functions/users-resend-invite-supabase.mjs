/**
 * users-resend-invite-supabase.mjs — POST /api/users-resend-invite-supabase
 *
 * Admin-only. Sends a fresh magic-link to a user who hasn't signed
 * in yet. Deploy 236.263 rewrite: skip Supabase's /auth/v1/invite
 * (broken on this project's ES256 config), use generate_link +
 * Resend directly — same approach users-invite-supabase now uses.
 *
 * Body: { userId }.
 *
 * If the user has already signed in, we reject with 400 — use the
 * password-reset flow for existing sessions (out of scope here).
 *
 * Response 200: { ok, userId, email, emailedVia: 'resend' }
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin } from './_shared/auth.mjs';

const INVITE_FROM = 'SLA Capital <noreply@leads.slacapital.com>';

function escH(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _humanRole(r) {
  return r === 'admin' ? 'Admin' : r === 'loan_officer' ? 'Loan Officer' : r === 'processor' ? 'Processor' : r;
}
function _buildInviteEmail(email, fullName, role, actionLink) {
  const greeting = fullName ? 'Hi ' + escH(fullName) : 'Hi there';
  const humanRole = escH(_humanRole(role || 'loan_officer'));
  const subject = 'Your SLA Capital Loan Tools invitation (resent)';
  const text =
    greeting + ',\n\n' +
    'Here\'s a fresh invitation link to activate your SLA Capital Loan Tools account (' + (role || 'loan_officer') + ').\n\n' +
    'Click here to sign in:\n' + actionLink + '\n\n' +
    'If you didn\'t expect this, you can ignore this email.\n\n' +
    'SLA Capital';
  const html =
    '<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#f0ece5;padding:40px 20px;margin:0">' +
      '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 28px;color:#1a1520">' +
        '<h1 style="font-family:\'Lora\',serif;color:#261a36;font-size:22px;margin:0 0 8px 0">SLA Capital Loan Tools</h1>' +
        '<p style="margin:0 0 20px;color:#7a7488;font-size:13px">A fresh invitation link — the previous one may have been lost.</p>' +
        '<p style="margin:0 0 12px">' + greeting + ',</p>' +
        '<p style="margin:0 0 16px">Here\'s a fresh link to activate your SLA Capital Loan Tools account as a <strong>' + humanRole + '</strong>.</p>' +
        '<p style="margin:0 0 28px">' +
          '<a href="' + escH(actionLink) + '" style="display:inline-block;padding:12px 28px;background:#C8813A;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-size:14px">Activate account</a>' +
        '</p>' +
        '<p style="font-size:12px;color:#7a7488;margin:0 0 8px">Or copy this link into your browser:</p>' +
        '<p style="font-size:11px;color:#7a7488;word-break:break-all;background:#faf8f3;padding:8px 12px;border-radius:6px;margin:0 0 20px"><a href="' + escH(actionLink) + '" style="color:#7a7488;text-decoration:none">' + escH(actionLink) + '</a></p>' +
        '<p style="font-size:11px;color:#7a7488;font-style:italic;margin:0">This link is single-use. If you didn\'t expect this, ignore this email.</p>' +
      '</div>' +
    '</body></html>';
  return { subject, text, html };
}
async function _sendViaResend(email, subject, text, html) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: INVITE_FROM, to: [email], subject, text, html }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('Resend ' + resp.status + ': ' + t.slice(0, 300));
  }
  return await resp.json().catch(() => ({}));
}

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

  // 1. Look up email + confirmation state + role.
  let email = '';
  let fullName = '';
  let role = '';
  try {
    const lookupResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC },
    });
    if (!lookupResp.ok) {
      const txt = await lookupResp.text().catch(() => '');
      return json(lookupResp.status, { error: 'Supabase lookup ' + lookupResp.status + ': ' + txt.slice(0, 300) });
    }
    const target = await lookupResp.json();
    email = String((target && target.email) || '').toLowerCase();
    fullName = String((target && target.user_metadata && (target.user_metadata.full_name || target.user_metadata.name)) || '').trim();
    const am = (target && target.app_metadata) || {};
    role = (Array.isArray(am.roles) && am.roles[0]) || am.role || '';
    if (!email) return json(400, { error: 'Target user has no email address' });
    if (target && target.last_sign_in_at) {
      return json(400, { error: 'User has already signed in. Use the password-reset flow instead of resending an invite.' });
    }
  } catch (e) {
    console.error('users-resend-invite-supabase lookup error:', e);
    return json(500, { error: 'Failed to look up user: ' + ((e && e.message) || 'unknown') });
  }

  // 2. Generate a fresh magic link.
  let actionLink = '';
  try {
    const linkResp = await fetch(base + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ type: 'magiclink', email: email }),
    });
    if (!linkResp.ok) {
      const txt = await linkResp.text().catch(() => '');
      return json(linkResp.status, { error: 'Supabase generate_link ' + linkResp.status + ': ' + txt.slice(0, 300) });
    }
    const linkData = await linkResp.json().catch(() => ({}));
    actionLink = (linkData && linkData.properties && linkData.properties.action_link) || linkData.action_link || '';
    if (!actionLink) return json(500, { error: 'Supabase generate_link returned no action_link' });
  } catch (e) {
    console.error('users-resend-invite-supabase generate_link error:', e);
    return json(500, { error: 'Failed to generate magic link: ' + ((e && e.message) || 'unknown') });
  }

  // 3. Send via Resend.
  try {
    const mail = _buildInviteEmail(email, fullName, role, actionLink);
    await _sendViaResend(email, mail.subject, mail.text, mail.html);
  } catch (e) {
    console.error('users-resend-invite-supabase resend error:', e);
    return json(500, { error: 'Email send failed: ' + ((e && e.message) || 'unknown') });
  }

  return json(200, { ok: true, userId: userId, email: email, emailedVia: 'resend' });
};
