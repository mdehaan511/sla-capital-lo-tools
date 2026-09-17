/**
 * view-as-start.mjs — POST /api/view-as-start  (Deploy 237.127, Mike)
 *
 * Starts a read-only "View as user" session for an Owner (super admin). Returns the
 * target's roles from public.sla_user_roles (the same source the login token uses) and
 * their display name, and records who looked at whose view and when (blob store
 * `view_as_log`, one entry per start). The session itself is just the
 * `x-sla-view-as` header the browser sends afterwards; _shared/auth.mjs enforces it.
 *
 * Body: { email }   Auth: super admin only.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isSuperAdmin, readJsonBody, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (user._viewAsBy) return json(400, { error: 'Exit the current view before starting another.' });
    if (!isSuperAdmin(user)) return json(403, { error: 'Owner only' });
    const body = (await readJsonBody(req)) || {};
    const email = normalizeEmail(body.email || '');
    if (!email || !email.includes('@')) return json(400, { error: 'email required' });
    if (email === normalizeEmail(user.email)) return json(400, { error: 'That is you.' });

    const rows = await db.select('sla_user_roles', { select: 'email,roles', eq: { email } }).catch(() => []);
    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return json(404, { error: 'That user has no role on the platform, so there is nothing to view as.' });
    const roles = Array.isArray(row.roles) ? row.roles : (row.roles ? [String(row.roles)] : []);

    let name = '';
    try {
      const ps = getStore({ name: 'profiles', consistency: 'eventual' });
      const prof = (await ps.get(email, { type: 'json' }).catch(() => null)) || (await ps.get(keySafe(email), { type: 'json' }).catch(() => null));
      if (prof) name = prof.fullName || prof.full_name || prof.name || '';
    } catch (_) {}
    if (!name) name = String(body.name || '').slice(0, 80);

    const entry = { at: new Date().toISOString(), by: normalizeEmail(user.email), as: email, roles };
    try {
      const store = getStore({ name: 'view_as_log', consistency: 'strong' });
      await store.setJSON(entry.at.slice(0, 10) + '/' + Date.now() + '-' + Math.random().toString(36).slice(2, 7), entry);
    } catch (e) { console.warn('[view-as-start] log write failed (non-fatal):', e && e.message); }
    console.log('[view-as] START', entry.by, '->', email, roles.join(','));
    return json(200, { ok: true, email, name, roles });
  } catch (e) {
    console.error('view-as-start error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
