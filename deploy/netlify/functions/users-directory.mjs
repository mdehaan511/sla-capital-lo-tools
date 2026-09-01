/**
 * users-directory.mjs — GET /api/users-directory
 *
 * Deploy 236.107 — minimal user directory for in-app pickers
 * (task assignee, @-mention, contact role assignment).
 *
 * Deploy 236.110 — rewritten to source from the `profiles` blob
 * store instead of Netlify Identity's admin API. The previous
 * version failed with "Identity context unavailable" because
 * `context.clientContext.identity` is only populated when the
 * function is invoked via Netlify's Identity middleware path,
 * and our JWT-based calls don't always hit that path. The
 * profiles store has the same data anyway — it's populated by
 * identity-login / identity-signup event handlers and by
 * profile-ping (which the frontend fires on page load). Same
 * approach users-stats.mjs uses.
 *
 * Returns minimal fields { email, name, slug, roles } per user,
 * sorted by name (then email). Any authenticated user can call;
 * users-list.mjs stays admin-only because it exposes management
 * metadata (confirmed_at, last_sign_in_at, Identity user.id).
 *
 * Response: { users: [{ email, name, phone, slug, roles }] }
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';
// Deploy 236.832 — overlay AUTHORITATIVE roles from public.sla_user_roles
// (the token-hook source of truth, kept in sync by every role write since
// 236.826). The profiles-store roles are whatever was stamped at some past
// login and had drifted badly (real LOs showing legacy 'user', promotions
// missing) — which made role-based pickers/filters unreliable.
import { db } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });

  try {
    const profiles = [];
    const { blobs } = await profilesStore.list();
    await Promise.all(blobs.map(async ({ key }) => {
      try {
        const p = await profilesStore.get(key, { type: 'json' });
        if (p && p.email) profiles.push(p);
      } catch (_) { /* skip malformed entries */ }
    }));

    // Deploy 236.832 — authoritative role map by email (best-effort: on a
    // PG blip the stale profile roles below still serve).
    const tableRoles = {};
    try {
      const rows = await db.select('sla_user_roles', { select: 'email,roles' });
      for (const row of (rows || [])) {
        if (row && row.email && Array.isArray(row.roles)) tableRoles[String(row.email).toLowerCase()] = row.roles;
      }
    } catch (e) { console.warn('users-directory: role-table read failed (using profile roles):', e && e.message); }

    // Trim to picker-friendly fields. Roles can live on either the
    // top-level record (some profile-ping versions wrote it there)
    // or under app_metadata, so check both.
    const trimmed = profiles.map((p) => ({
      email: String(p.email || '').toLowerCase(),
      name:  String(p.fullName || p.full_name || (p.user_metadata && p.user_metadata.full_name) || '').trim(),
      // Deploy 236.578 — expose phone so the Proof-of-Funds letter (and Team
      // Members) can show the assigned LO's number. Internal directory only.
      phone: String(p.phone || (p.user_metadata && p.user_metadata.phone) || '').trim(),
      slug:  String(p.slug || (p.user_metadata && p.user_metadata.slug) || '').trim(),
      // Table roles WIN when a row exists; profile roles are the fallback.
      roles: tableRoles[String(p.email || '').toLowerCase()] || (Array.isArray(p.roles)
        ? p.roles
        : (p.app_metadata && Array.isArray(p.app_metadata.roles))
          ? p.app_metadata.roles
          : (p.app_metadata && p.app_metadata.roles ? [p.app_metadata.roles] : [])),
    }))
    .filter((u) => u.email)
    .sort((a, b) => {
      const an = (a.name || a.email).toLowerCase();
      const bn = (b.name || b.email).toLowerCase();
      if (an < bn) return -1;
      if (an > bn) return  1;
      return 0;
    });

    return json(200, { users: trimmed });
  } catch (e) {
    console.error('users-directory error:', e);
    return json(500, { error: 'Failed to list users: ' + ((e && e.message) || 'unknown') });
  }
};
