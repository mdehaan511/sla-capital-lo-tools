/**
 * team-roster.mjs — the IO half of the team-member rules (Deploy 236.958).
 *
 *   loadRoleTable()         → Map<email, roles[]> from public.sla_user_roles
 *                             (tens of rows; the token hook's own source)
 *   lastSeenFor(emails)     → Map<email, ISO> from the `profiles` blob store,
 *                             READ BY KEY (never listed — a store walk takes
 *                             ~40s on live data, see sla-rep.mjs). profile-ping
 *                             stamps last_seen_at on every signed-in page load
 *                             regardless of which login (Google, magic link,
 *                             Netlify Identity) the person used, which is what
 *                             makes it the accurate "last sign-in" for Users
 *                             Admin — Supabase's own last_sign_in_at only moves
 *                             when SUPABASE signs someone in.
 *   adminGetUser(id) / adminDeleteUser(id) → Supabase Auth admin API
 *
 * Rules themselves are in team-roster-rules.mjs (pure, unit-tested).
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';
import { db, supabaseBaseUrl } from './supabase-db.mjs';
import { normEmail, normRoles } from './team-roster-rules.mjs';

export async function loadRoleTable() {
  const map = new Map();
  try {
    const rows = await db.select('sla_user_roles', { select: 'email,roles', limit: 500 });
    (rows || []).forEach((r) => {
      const e = normEmail(r && r.email);
      if (e) map.set(e, normRoles(r.roles));
    });
  } catch (e) {
    console.warn('[team-roster] sla_user_roles read failed:', e && e.message);
  }
  return map;
}

export async function lastSeenFor(emails) {
  const out = new Map();
  const list = Array.from(new Set((emails || []).map(normEmail).filter(Boolean)));
  if (!list.length) return out;
  const store = getStore({ name: 'profiles', consistency: 'eventual' });
  await Promise.all(list.map((e) =>
    store.get(keySafe(normalizeEmail(e)), { type: 'json' })
      .then((p) => { if (p && p.last_seen_at) out.set(e, String(p.last_seen_at)); })
      .catch(() => {})));
  return out;
}

function _admin() {
  const base = String(supabaseBaseUrl() || '').replace(/\/+$/, '');
  const svc = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!base || !svc) throw new Error('Supabase env vars not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)');
  return { base, headers: { apikey: svc, Authorization: 'Bearer ' + svc } };
}

export async function adminGetUser(userId) {
  const a = _admin();
  const r = await fetch(a.base + '/auth/v1/admin/users/' + encodeURIComponent(userId), { headers: a.headers });
  if (!r.ok) return null;
  return r.json().catch(() => null);
}

export async function adminDeleteUser(userId) {
  const a = _admin();
  const r = await fetch(a.base + '/auth/v1/admin/users/' + encodeURIComponent(userId), { method: 'DELETE', headers: a.headers });
  if (!r.ok) {
    const txt = await r.text().catch(() => '');
    throw new Error('Supabase delete ' + r.status + ': ' + txt.slice(0, 200));
  }
  return true;
}

/** Every auth account, walking the admin list's pages (borrowers make it long). */
export async function adminListAllUsers({ perPage = 200, maxPages = 10 } = {}) {
  const a = _admin();
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const r = await fetch(a.base + '/auth/v1/admin/users?page=' + page + '&per_page=' + perPage, { headers: a.headers });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error('Supabase list ' + r.status + ': ' + txt.slice(0, 300));
    }
    const doc = await r.json().catch(() => ({}));
    const users = Array.isArray(doc && doc.users) ? doc.users : [];
    all.push(...users);
    if (users.length < perPage) break;
  }
  return all;
}
