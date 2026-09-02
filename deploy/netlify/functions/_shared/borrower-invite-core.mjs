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
import crypto from 'node:crypto';
import { supabaseBaseUrl } from './supabase-db.mjs';
import { logBorrowerSendFromResponse } from './email.mjs';

const INVITE_FROM = 'SLA Capital <noreply@leads.slacapital.com>';
const INVITE_STORE = 'borrower-invites'; // keyed by loanId

// ── Deploy 236.818 — durable 72-hour portal links ─────────────────────────
// Supabase magic links expire fast (project OTP window), so emailed links
// were dying before borrowers clicked them. Emails now carry OUR link
// (/api/borrower-link?t=<signed token>) which stays valid for 72 hours; at
// click time the borrower-link endpoint mints a FRESH Supabase magic link
// and redirects — so the underlying Supabase link is always seconds old.
// An expired token lands on a page with a one-click "email me a new link".
// Token = base64url({e:email, x:expiresMs, v:1}) + '.' + HMAC-SHA256
// signed with ESIGN_SEAL_SECRET (same secret family as the eSign tokens).
export const PORTAL_LINK_TTL_HOURS = 72;

function _linkSecret() { return process.env.ESIGN_SEAL_SECRET || ''; }
function _b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function _b64urlDecode(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64').toString('utf8');
}
function _signPayload(payloadB64) {
  return _b64url(crypto.createHmac('sha256', _linkSecret()).update(payloadB64).digest());
}

// Returns { url, token, expiresAt (ISO), expiresText } or null when the
// secret isn't configured (callers fall back to the raw magic link).
export function mintDurablePortalLink(email, origin) {
  if (!_linkSecret() || !email) return null;
  const expiresMs = Date.now() + PORTAL_LINK_TTL_HOURS * 3600 * 1000;
  const payloadB64 = _b64url(JSON.stringify({ e: String(email).toLowerCase(), x: expiresMs, v: 1 }));
  const token = payloadB64 + '.' + _signPayload(payloadB64);
  const base = String(origin || 'https://portal.slacapital.ai').replace(/\/+$/, '');
  return {
    url: base + '/api/borrower-link?t=' + token,
    token,
    expiresAt: new Date(expiresMs).toISOString(),
    expiresText: portalLinkExpiryText(expiresMs),
  };
}

// Verify a durable-link token. Returns { email, expiresMs, expired } or null
// when the signature is invalid/garbled (expired tokens still verify — the
// redeem endpoint uses them to offer a resend to the same address).
export function verifyDurablePortalToken(token) {
  try {
    if (!_linkSecret()) return null;
    const parts = String(token || '').split('.');
    if (parts.length !== 2) return null;
    const want = _signPayload(parts[0]);
    const a = Buffer.from(parts[1]); const b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const p = JSON.parse(_b64urlDecode(parts[0]));
    if (!p || !p.e || !p.x) return null;
    return { email: String(p.e).toLowerCase(), expiresMs: Number(p.x), expired: Date.now() > Number(p.x) };
  } catch (_) { return null; }
}

// Shared email copy for the expiry disclosure — every invite email that
// carries a durable link appends this (Mike: tell them it lasts 72 hours,
// tell them WHEN it expires, and that they can get a new one).
export function linkExpiryCopy(durable) {
  if (!durable) return { text: '', html: '' };
  const t = 'For your security this sign-in link expires in ' + PORTAL_LINK_TTL_HOURS + ' hours — on ' +
    durable.expiresText + '. If it has expired, just open it anyway and you can request a fresh link with one click.';
  const h = '<p style="font-size:13px;line-height:1.55;color:#7a7488">For your security this sign-in link expires in <strong>' +
    PORTAL_LINK_TTL_HOURS + ' hours</strong> — on <strong>' + escHtml(durable.expiresText) +
    '</strong>. If it has expired, just open it anyway and you can request a fresh link with one click.</p>';
  return { text: t, html: h };
}

// "September 3 at 2:15 PM PT" — SLA is Spokane, so Pacific time.
export function portalLinkExpiryText(expiresMs) {
  try {
    const d = new Date(expiresMs);
    return d.toLocaleString('en-US', {
      month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
      timeZone: 'America/Los_Angeles',
    }) + ' PT';
  } catch (_) { return ''; }
}

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
