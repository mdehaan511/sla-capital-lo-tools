/**
 * borrower-invite-core.mjs — shared Supabase borrower-invite helpers.
 *
 * Deploy 236.533 — used by borrower-intake-invite.mjs (loan-level, borrower/
 * broker) and borrower-portal-invite.mjs (client-level, all loans). Keeps the
 * Supabase admin-API calls, magic-link generation, Resend send, last-sign-in
 * lookup, and the per-loan invite audit record in ONE place.
 *
 * Env: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, RESEND_API_KEY.
 */
import { getStore } from '@netlify/blobs';
import { supabaseBaseUrl } from './supabase-db.mjs';
import { logBorrowerSendFromResponse } from './email.mjs';

const INVITE_FROM = 'SLA Capital <noreply@leads.slacapital.com>';
const INVITE_STORE = 'borrower-invites'; // keyed by loanId

export function getSb() {
  const url = supabaseBaseUrl();
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !svc) return null;
  return {
    base: String(url).replace(/\/+$/, ''),
    headers: { 'apikey': svc, 'Authorization': 'Bearer ' + svc, 'Content-Type': 'application/json' },
  };
}

// Create the Supabase borrower user (role stamped) or note existing. Returns
// { userId, created, alreadyMember }. For an existing user we page to recover
// the id so callers can persist it for O(1) last-sign-in lookups.
export async function ensureBorrowerUser(sb, email, fullName) {
  let created = false, alreadyMember = false, userId = '';
  try {
    const r = await fetch(sb.base + '/auth/v1/admin/users', {
      method: 'POST',
      headers: sb.headers,
      body: JSON.stringify({
        email,
        email_confirm: true,
        app_metadata: { role: 'borrower', roles: ['borrower'] },
        user_metadata: fullName ? { full_name: fullName } : {},
      }),
    });
    if (r.ok) {
      created = true;
      const d = await r.json().catch(() => ({}));
      userId = (d && d.id) || '';
    } else {
      const txt = await r.text().catch(() => '');
      if (r.status === 422 && /already|exists|registered/i.test(txt)) alreadyMember = true;
      else console.warn('[borrower-invite] createUser', r.status, txt.slice(0, 150));
    }
  } catch (e) { console.warn('[borrower-invite] createUser threw:', e && e.message); }
  if (!userId) { userId = await findUserIdByEmail(sb, email); }
  // Deploy 236.592 — refresh the display name on re-invite. Once the account
  // exists the create call above is a no-op (alreadyMember), so without this the
  // account's full_name stays whatever it was first set to — an earlier
  // guarantor's name, or the primary borrower's name from a prior invite — and
  // leaks into the portal greeting ("Welcome, Arthur") and the magic-link email
  // ("Hi <primary borrower>"). PATCH user_metadata.full_name to the person
  // actually being invited now.
  if (userId && fullName && !created) {
    try {
      await fetch(sb.base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
        method: 'PUT',
        headers: sb.headers,
        body: JSON.stringify({ user_metadata: { full_name: fullName } }),
      });
    } catch (e) { console.warn('[borrower-invite] name refresh failed:', e && e.message); }
  }
  return { userId, created, alreadyMember };
}

// Page the admin user list to find a user id by email. Bounded; invites are
// infrequent so this only runs at send time (not on the status hot path).
export async function findUserIdByEmail(sb, email) {
  const want = String(email || '').toLowerCase();
  if (!want) return '';
  for (let page = 1; page <= 25; page++) {
    let r;
    try { r = await fetch(sb.base + '/auth/v1/admin/users?page=' + page + '&per_page=200', { headers: sb.headers }); }
    catch (_) { return ''; }
    if (!r.ok) return '';
    const d = await r.json().catch(() => ({}));
    const users = (d && d.users) || [];
    for (const u of users) {
      if (String(u.email || '').toLowerCase() === want) return u.id || '';
    }
    if (users.length < 200) break;
  }
  return '';
}

export async function lastSignInByUserId(sb, userId) {
  if (!userId) return '';
  try {
    const r = await fetch(sb.base + '/auth/v1/admin/users/' + encodeURIComponent(userId), { headers: sb.headers });
    if (!r.ok) return '';
    const d = await r.json().catch(() => ({}));
    return d && d.last_sign_in_at || '';
  } catch (_) { return ''; }
}

export async function borrowerMagicLink(sb, email, origin) {
  try {
    const r = await fetch(sb.base + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: sb.headers,
      body: JSON.stringify({ type: 'magiclink', email, redirect_to: origin + '/activate.html' }),
    });
    if (!r.ok) return '';
    const d = await r.json().catch(() => ({}));
    return (d && d.properties && d.properties.action_link) || d.action_link || '';
  } catch (_) { return ''; }
}

export async function sendBorrowerEmail(toEmail, subject, text, html, replyTo, logMeta) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const payload = { from: INVITE_FROM, to: [toEmail], subject, text, html };
  if (replyTo) payload.reply_to = replyTo;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  // Deploy 236.685 — when the caller passes logMeta, track delivery so the LO is
  // alerted if this borrower email bounces.
  if (r.ok && logMeta) await logBorrowerSendFromResponse(r, Object.assign({ to: toEmail }, logMeta));
  return r.ok;
}

// ── Per-loan invite audit record (borrower-invites store, keyed by loanId) ──
// Shape: { loanId, borrower?: {email,userId,sentAt,sentBy}, broker?: {...}, updatedAt }

export async function readLoanInvites(loanId) {
  if (!loanId) return null;
  try {
    const store = getStore({ name: INVITE_STORE, consistency: 'strong' });
    return await store.get(String(loanId), { type: 'json' });
  } catch (_) { return null; }
}

export async function writeLoanInvite(loanId, recipient, entry) {
  if (!loanId || !recipient) return;
  const store = getStore({ name: INVITE_STORE, consistency: 'strong' });
  let rec = null;
  try { rec = await store.get(String(loanId), { type: 'json' }); } catch (_) { rec = null; }
  if (!rec) rec = { loanId: String(loanId) };
  rec[recipient] = entry;
  rec.updatedAt = new Date().toISOString();
  await store.setJSON(String(loanId), rec);
  return rec;
}

export function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
