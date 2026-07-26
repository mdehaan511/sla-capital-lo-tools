/**
 * users-invite-supabase.mjs — POST /api/users-invite-supabase
 *
 * Path A Phase 1 (Deploy 236.263 rework): invite a new Supabase user
 * WITHOUT going through Supabase's own invite-email path, which trips
 * an ES256 mismatch on this project's JWT signing keys.
 *
 * Approach:
 *   1. Create the user directly via /auth/v1/admin/users. Role is
 *      stamped into app_metadata at creation time, `email_confirm:
 *      true` so no separate confirmation step is required.
 *   2. Generate a magic-link URL via /auth/v1/admin/generate_link
 *      with type='magiclink'. Same code path signInWithOtp uses,
 *      which is proven working (spike test 236.20-something).
 *   3. Send the invite email OURSELVES via Resend (already used
 *      by borrower2-auth-resend / envelopes-send / quotes-decide
 *      throughout the codebase). Bypasses Supabase's built-in
 *      email delivery entirely.
 *
 * Body: { email, role?, fullName? }
 *
 * Roles: 'admin' | 'loan_officer' | 'processor'
 * super_admin required to grant admin.
 *
 * Response 200: { ok, user: { id, email, role }, emailedVia: 'resend' }
 * Response 409: user with this email already exists in Supabase
 */
import { handleOptions, json, requireAuth, readJsonBody, isAdmin, isSuperAdmin, normalizeEmail } from './_shared/auth.mjs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs'; // Deploy 236.398

const ALLOWED_ROLES = new Set(['admin', 'loan_officer', 'processor']);
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
  const humanRole = escH(_humanRole(role));
  const subject = 'You\'re invited to SLA Capital Loan Tools';
  const text =
    greeting + ',\n\n' +
    'You\'ve been invited to SLA Capital\'s Loan Tools portal with the role of ' + role + '.\n\n' +
    'Click here to activate your account and sign in:\n' + actionLink + '\n\n' +
    'This link is single-use and will sign you in the first time you click it. ' +
    'If you didn\'t expect this invitation, you can ignore this email — the invitation will expire.\n\n' +
    'SLA Capital';
  const html =
    '<!doctype html><html><body style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#f0ece5;padding:40px 20px;margin:0">' +
      '<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:32px 28px;color:#1a1520">' +
        '<h1 style="font-family:\'Lora\',serif;color:#261a36;font-size:22px;margin:0 0 8px 0">SLA Capital Loan Tools</h1>' +
        '<p style="margin:0 0 20px;color:#7a7488;font-size:13px">You\'ve been invited to the internal loan-officer portal.</p>' +
        '<p style="margin:0 0 12px">' + greeting + ',</p>' +
        '<p style="margin:0 0 16px">You\'ve been invited to SLA Capital\'s Loan Tools as a <strong>' + humanRole + '</strong>. Click the button below to activate your account and sign in.</p>' +
        '<p style="margin:0 0 28px">' +
          '<a href="' + escH(actionLink) + '" style="display:inline-block;padding:12px 28px;background:#C8813A;color:#fff;border-radius:6px;font-weight:600;text-decoration:none;font-size:14px">Activate account</a>' +
        '</p>' +
        '<p style="font-size:12px;color:#7a7488;margin:0 0 8px">Or copy this link into your browser:</p>' +
        '<p style="font-size:11px;color:#7a7488;word-break:break-all;background:#faf8f3;padding:8px 12px;border-radius:6px;margin:0 0 20px"><a href="' + escH(actionLink) + '" style="color:#7a7488;text-decoration:none">' + escH(actionLink) + '</a></p>' +
        '<p style="font-size:11px;color:#7a7488;font-style:italic;margin:0">This link is single-use. If you didn\'t expect this invitation, ignore this email.</p>' +
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

  const user = await requireAuth(context, req);
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

  const SUPABASE_URL = supabaseBaseUrl(); // Deploy 236.398: strips /rest/v1 suffix
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) {
    return json(500, { error: 'Supabase env vars not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
  }
  const base = String(SUPABASE_URL).replace(/\/+$/, '');

  // 1. Create the Supabase user with role stamped + email confirmed.
  //    email_confirm=true prevents Supabase from firing its own
  //    confirmation-email path (which would trip the ES256 bug).
  let supabaseUserId = '';
  try {
    const createResp = await fetch(base + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        email: email,
        email_confirm: true,
        app_metadata: { role: role, roles: [role] },
        user_metadata: fullName ? { full_name: fullName } : {},
      }),
    });
    if (!createResp.ok) {
      const txt = await createResp.text().catch(() => '');
      if (createResp.status === 422 && /already|exists|registered/i.test(txt)) {
        return json(409, { error: 'User with this email already exists in Supabase. Delete or resend-invite the existing record instead.' });
      }
      return json(createResp.status, { error: 'Supabase createUser ' + createResp.status + ': ' + txt.slice(0, 300) });
    }
    const created = await createResp.json().catch(() => ({}));
    supabaseUserId = created && created.id || '';
    if (!supabaseUserId) {
      return json(500, { error: 'Supabase createUser succeeded but returned no user id' });
    }
  } catch (e) {
    console.error('users-invite-supabase createUser error:', e);
    return json(500, { error: 'Failed to create user: ' + ((e && e.message) || 'unknown') });
  }

  // 2. Generate a magic-link URL. type='magiclink' goes through the
  //    same code path signInWithOtp uses — proven working on this
  //    project's ES256 configuration.
  let actionLink = '';
  try {
    // Deploy 236.264 — point the magic-link redirect at our own
    // activation page. Without redirect_to, Supabase falls back to
    // the project's Site URL (=/), which loads Netlify Identity and
    // shows a login modal instead of receiving the Supabase session
    // token. The activation page has the Supabase SDK loaded and
    // auto-detects the session from the URL fragment.
    // origin resolves to whichever domain the admin invited from
    // (portal.slacapital.ai vs slaloantools.netlify.app) so the
    // invitee lands on a matching subdomain.
    const inviteOrigin = new URL(req.url).origin;
    const linkResp = await fetch(base + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: {
        'apikey':        SVC,
        'Authorization': 'Bearer ' + SVC,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        type: 'magiclink',
        email: email,
        redirect_to: inviteOrigin + '/activate.html',
      }),
    });
    if (!linkResp.ok) {
      const txt = await linkResp.text().catch(() => '');
      // User was created but we can't email them. Return partial
      // success so the admin knows to delete + retry OR use the
      // resend-invite action once they're in the list.
      return json(500, {
        error: 'User created but magiclink generation failed: ' + linkResp.status + ' ' + txt.slice(0, 200),
        userId: supabaseUserId,
      });
    }
    const linkData = await linkResp.json().catch(() => ({}));
    actionLink = (linkData && linkData.properties && linkData.properties.action_link) || linkData.action_link || '';
    if (!actionLink) {
      return json(500, { error: 'Supabase generate_link returned no action_link', userId: supabaseUserId });
    }
  } catch (e) {
    console.error('users-invite-supabase generate_link error:', e);
    return json(500, { error: 'Failed to generate magic link: ' + ((e && e.message) || 'unknown'), userId: supabaseUserId });
  }

  // 3. Send the invite email via Resend directly.
  try {
    const mail = _buildInviteEmail(email, fullName, role, actionLink);
    await _sendViaResend(email, mail.subject, mail.text, mail.html);
  } catch (e) {
    console.error('users-invite-supabase resend error:', e);
    return json(500, {
      error: 'User created but email send failed: ' + ((e && e.message) || 'unknown'),
      userId: supabaseUserId,
      hint: 'The user exists in Supabase — use Resend invite from the users list to try emailing again.',
    });
  }

  return json(200, {
    ok: true,
    user: { id: supabaseUserId, email: email, role: role },
    emailedVia: 'resend',
    roleStamped: true,
  });
};
