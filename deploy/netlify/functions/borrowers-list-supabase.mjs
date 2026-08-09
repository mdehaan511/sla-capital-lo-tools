/**
 * borrowers-list-supabase.mjs — /api/borrowers-list-supabase
 *
 * Deploy 236.532 — Borrower admin view (Phase 3). Admin-gated. Lists the
 * Supabase borrower accounts (role 'borrower') with their loan_access grants
 * and last sign-in, and offers two per-borrower actions. Mirrors the staff
 * users-*-supabase.mjs pattern.
 *
 *   GET  → { borrowers: [{ id, email, fullName, lastSignInAt, createdAt,
 *                          loans: [{ loanId, address, ownerKey, primaryClientId, grantedAt }] }] }
 *   POST { action:'revoke', email, loanId } → revoke a borrower's access to one loan
 *   POST { action:'resend', email }         → email a fresh one-click magic-link sign-in
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs';
import { listAccessibleLoans, revokeLoanAccess } from './_shared/loan-access-store.mjs';

const INVITE_FROM = 'SLA Capital <noreply@leads.slacapital.com>';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrowers-list-supabase error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const SUPABASE_URL = supabaseBaseUrl();
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) return json(500, { error: 'Supabase env not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
  const sbBase = String(SUPABASE_URL).replace(/\/+$/, '');
  const sbHeaders = { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC, 'Content-Type': 'application/json' };

  // ── Actions ──────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = await readJsonBody(req) || {};
    const action = String(body.action || '');
    const email = normalizeEmail(body.email || '');
    if (!email) return json(400, { error: 'email required' });

    if (action === 'revoke') {
      const loanId = String(body.loanId || '').trim();
      if (!loanId) return json(400, { error: 'loanId required' });
      try { await revokeLoanAccess({ email, loanId, revokedBy: normalizeEmail(user.email) }); }
      catch (e) { return json(500, { error: 'Revoke failed: ' + (e.message || 'unknown') }); }
      return json(200, { ok: true });
    }

    if (action === 'resend') {
      const origin = new URL(req.url).origin;
      const link = await _magicLink(sbBase, sbHeaders, email, origin);
      if (!link) return json(500, { error: 'Could not generate a login link for that borrower.' });
      let emailed = false;
      try { emailed = await _sendLink(email, link); } catch (e) { console.warn('resend send failed:', e && e.message); }
      return json(200, { ok: true, emailed });
    }

    return json(400, { error: 'Unknown action' });
  }

  // ── GET: list borrowers ──────────────────────────────────────
  const borrowers = [];
  let page = 1;
  for (;;) {
    let resp;
    try { resp = await fetch(sbBase + '/auth/v1/admin/users?page=' + page + '&per_page=200', { headers: sbHeaders }); }
    catch (e) { return json(502, { error: 'Supabase user list failed: ' + (e.message || 'unknown') }); }
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      return json(resp.status, { error: 'Supabase user list ' + resp.status + ': ' + t.slice(0, 200) });
    }
    const d = await resp.json().catch(() => ({}));
    const users = (d && d.users) || [];
    for (const u of users) {
      const am = (u && u.app_metadata) || {};
      const roles = Array.isArray(am.roles) ? am.roles : (am.role ? [am.role] : []);
      if (roles.indexOf('borrower') < 0) continue;
      const meta = (u && u.user_metadata) || {};
      borrowers.push({
        id: u.id,
        email: normalizeEmail(u.email || ''),
        fullName: meta.full_name || meta.name || '',
        lastSignInAt: u.last_sign_in_at || '',
        createdAt: u.created_at || '',
      });
    }
    if (users.length < 200) break;
    page += 1;
    if (page > 50) break; // safety
  }

  // Join loan_access grants + resolve loan addresses (cached per client record).
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientCache = new Map();
  async function _loanAddr(ownerKey, clientId, loanId) {
    if (!ownerKey || !clientId) return '';
    const ck = ownerKey + '/' + keySafe(clientId);
    if (!clientCache.has(ck)) {
      let c = null;
      try { c = await clientsStore.get(ck, { type: 'json' }); } catch (_) { c = null; }
      clientCache.set(ck, c);
    }
    const client = clientCache.get(ck);
    const loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) : null;
    return (loan && loan.address) || '';
  }
  for (const b of borrowers) {
    const grants = await listAccessibleLoans(b.email);
    b.loans = [];
    for (const g of grants) {
      b.loans.push({
        loanId: g.loanId,
        ownerKey: g.ownerKey || '',
        primaryClientId: g.primaryClientId || '',
        grantedAt: g.grantedAt || '',
        address: await _loanAddr(g.ownerKey, g.primaryClientId, g.loanId),
      });
    }
  }

  borrowers.sort((a, b) =>
    String(b.lastSignInAt || b.createdAt || '').localeCompare(String(a.lastSignInAt || a.createdAt || '')));
  return json(200, { borrowers });
}

async function _magicLink(sbBase, sbHeaders, email, origin) {
  try {
    const r = await fetch(sbBase + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ type: 'magiclink', email, redirect_to: origin + '/activate.html' }),
    });
    if (!r.ok) return '';
    const d = await r.json().catch(() => ({}));
    return (d && d.properties && d.properties.action_link) || d.action_link || '';
  } catch (_) { return ''; }
}

async function _sendLink(email, link) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const text = 'Sign in to your SLA Capital borrower portal — no password needed:\n' + link +
    '\n\nYou can also sign in with Google using this same email address.\n\n— SLA Capital';
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">Here's your one-click sign-in to the SLA Capital borrower portal — no password needed.</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${esc(link)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">Sign in &rarr;</a>
      </p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">You can also sign in any time with <strong>Google</strong> using this same email address.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this into your browser:<br>${esc(link)}</p>
    </div></body></html>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: INVITE_FROM, to: [email], subject: 'Your SLA Capital sign-in link', text, html }),
  });
  return r.ok;
}
