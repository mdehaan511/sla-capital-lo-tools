/**
 * admin-users-prune-ghosts.mjs — POST /api/admin-users-prune-ghosts
 *
 * Deploy 236.833 — remove GHOST users: accounts deleted from Supabase (via
 * Users Admin) whose `profiles` blob and/or `sla_user_roles` row survived.
 * users-directory serves from the profiles store, so ghosts kept appearing
 * in every picker (Mike: Dru showed in the LO dropdown after removal).
 * The delete endpoint cleans both up going forward (236.826 + 236.833);
 * this sweeps the backlog. Rerunnable.
 *
 * Flow: page the Supabase auth admin user list → the set of LIVE emails;
 * delete any profiles blob or role-table row whose email isn't in it.
 *
 * Body: { apply?: bool (default FALSE = dry run) }
 * Auth: admin only.
 * Response: { ok, liveUsers, ghostProfiles: [emails], ghostRoleRows: [emails],
 *             applied }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe } from './_shared/auth.mjs';
import { supabaseBaseUrl, db } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-users-prune-ghosts error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const apply = body.apply === true;

  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const base = String(supabaseBaseUrl() || '').replace(/\/+$/, '');
  if (!base || !SVC) return json(500, { error: 'Supabase env vars not configured' });

  // ── Live email set from Supabase auth ─────────────────────────────
  const live = new Set();
  for (let page = 1; page <= 50; page++) {
    const r = await fetch(base + '/auth/v1/admin/users?page=' + page + '&per_page=200', {
      headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC },
    });
    if (!r.ok) return json(502, { error: 'Supabase user list failed: HTTP ' + r.status });
    const d = await r.json().catch(() => ({}));
    const users = (d && d.users) || [];
    for (const u of users) if (u && u.email) live.add(String(u.email).toLowerCase());
    if (users.length < 200) break;
  }
  if (!live.size) return json(500, { error: 'Supabase returned zero users — refusing to prune everything' });

  // ── Ghost profiles ────────────────────────────────────────────────
  const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
  const ghostProfiles = [];
  const { blobs } = await profilesStore.list();
  for (const { key } of blobs) {
    const p = await profilesStore.get(key, { type: 'json' }).catch(() => null);
    const email = String((p && p.email) || '').toLowerCase();
    if (!email) continue;
    if (!live.has(email)) {
      ghostProfiles.push(email);
      if (apply) {
        try { await profilesStore.delete(key); }
        catch (e) { console.warn('[prune-ghosts] profile delete failed:', email, e && e.message); }
      }
    }
  }

  // ── Ghost role-table rows ─────────────────────────────────────────
  const ghostRoleRows = [];
  try {
    const rows = await db.select('sla_user_roles', { select: 'email' });
    for (const row of (rows || [])) {
      const email = String((row && row.email) || '').toLowerCase();
      if (email && !live.has(email)) {
        ghostRoleRows.push(email);
        if (apply) {
          try { await db.del('sla_user_roles', { email }); }
          catch (e) { console.warn('[prune-ghosts] role row delete failed:', email, e && e.message); }
        }
      }
    }
  } catch (e) {
    console.warn('[prune-ghosts] role-table read failed:', e && e.message);
  }

  console.log('[prune-ghosts] live=' + live.size + ' ghostProfiles=' + ghostProfiles.length +
    ' ghostRoleRows=' + ghostRoleRows.length + ' applied=' + apply);
  return json(200, { ok: true, liveUsers: live.size, ghostProfiles, ghostRoleRows, applied: apply });
}
