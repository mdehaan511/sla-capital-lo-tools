/**
 * users-list-supabase.mjs — GET /api/users-list-supabase
 *
 * Path A Phase 1: the Users Admin roster. Admin-only.
 *
 * Deploy 236.958 (Mike: "Users Admin ONLY shows SLA Capital team members we
 * manually invite. Also the Last Sign In column needs to become accurate to
 * when they last signed in.")
 *
 *   TEAM MEMBERS ONLY — every auth account is classified with the shared
 *   team-roster rules (token-hook role table first, app_metadata as legacy,
 *   @slacapital.com backstop). Borrowers, brokers and Google-minted unknowns
 *   never appear in `users`; they are counted in `hidden`, and the unknowns
 *   are listed separately in `unknown` so an admin can remove them (they are
 *   otherwise invisible now).
 *
 *   ACCURATE LAST SIGN-IN — Supabase's last_sign_in_at only moves when
 *   Supabase itself signs the person in (Google / magic link / password).
 *   Someone still using the Netlify Identity login never touches it, so it
 *   froze for several LOs. profile-ping stamps profiles.last_seen_at on every
 *   signed-in page load whatever the login was, so lastSignInAt is now the
 *   LATER of the two (lastSignInSource says which won).
 *
 *   ROLE FROM THE ROLE TABLE — the page used to read roles off app_metadata
 *   only, so a Google-created staff account (roles live on the token, from
 *   public.sla_user_roles) showed "(no role)". Table wins, app_metadata fills.
 *
 *   ALL PAGES — the admin list is paged; borrowers pushed it past one page,
 *   so this walks every page (cap 2,000 accounts).
 *
 * Response 200:
 *   { ok: true,
 *     users: [{ id, email, role, roles, roleSource, invitedAt, confirmedAt,
 *               lastSignInAt, lastSignInSource, supabaseLastSignInAt, lastSeenAt,
 *               fullName, phone, provider, appMetadata, userMetadata }, …],
 *     total, authTotal,
 *     hidden: { borrowers, brokers, unknown },
 *     unknown: [{ id, email, fullName, provider, createdAt, lastSignInAt }, …] }
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { classifyAccount, rolesFromMeta, mergedRoles, laterOf, normEmail } from './_shared/team-roster-rules.mjs';
import { loadRoleTable, lastSeenFor, adminListAllUsers } from './_shared/team-roster.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  // Pass req so requireAuth can fall back to Authorization-header
  // decode when context.clientContext.user is empty.
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  try {
    const [rawUsers, table] = await Promise.all([adminListAllUsers(), loadRoleTable()]);

    // Classify. Grants are only consulted for accounts nothing else explains
    // (a few keyed blob reads, not one per account).
    const classified = await Promise.all(rawUsers.map(async (u) => {
      const email = normEmail(u && u.email);
      const appRoles = rolesFromMeta(u && u.app_metadata);
      const tableRoles = table.get(email) || [];
      let kind = classifyAccount({ email, appRoles, tableRoles, grantCount: 0 });
      if (kind === 'unknown' && email) {
        const grants = await listAccessibleLoans(email).catch(() => []);
        kind = classifyAccount({ email, appRoles, tableRoles, grantCount: grants.length });
      }
      return { u, email, appRoles, tableRoles, kind };
    }));

    const staff = classified.filter((c) => c.kind === 'staff');
    const seen = await lastSeenFor(staff.map((c) => c.email));

    const users = staff.map(({ u, email, appRoles, tableRoles }) => {
      const am = (u && u.app_metadata) || {};
      const um = (u && u.user_metadata) || {};
      const roles = mergedRoles(tableRoles, appRoles);
      const supabaseLast = u.last_sign_in_at || '';
      const lastSeen = seen.get(email) || '';
      const last = laterOf(supabaseLast, lastSeen);
      return {
        id:                   u.id || '',
        email,
        role:                 roles[0] || '',
        roles,
        roleSource:           tableRoles.length ? 'table' : (appRoles.length ? 'app' : ''),
        invitedAt:            u.invited_at || '',
        confirmedAt:          u.email_confirmed_at || u.confirmed_at || '',
        lastSignInAt:         last,
        lastSignInSource:     !last ? '' : (last === lastSeen && lastSeen !== supabaseLast ? 'portal' : 'supabase'),
        supabaseLastSignInAt: supabaseLast,
        lastSeenAt:           lastSeen,
        fullName:             um.full_name || um.name || '',
        phone:                um.phone || '', // Deploy 236.579 — for the admin profile editor
        provider:             am.provider || (Array.isArray(am.providers) ? am.providers.join(',') : ''),
        appMetadata:          am,
        userMetadata:         um,
      };
    });

    // Sort: most-recently-signed-in first, then newest-invited, then email.
    users.sort((a, b) => {
      const aT = a.lastSignInAt || a.invitedAt || '';
      const bT = b.lastSignInAt || b.invitedAt || '';
      if (aT !== bT) return aT < bT ? 1 : -1;
      return a.email < b.email ? -1 : 1;
    });

    const count = (k) => classified.filter((c) => c.kind === k).length;
    const unknown = classified.filter((c) => c.kind === 'unknown').map(({ u, email }) => {
      const am = (u && u.app_metadata) || {};
      const um = (u && u.user_metadata) || {};
      return {
        id: u.id || '', email,
        fullName: um.full_name || um.name || '',
        provider: am.provider || (Array.isArray(am.providers) ? am.providers.join(',') : ''),
        createdAt: u.created_at || '',
        lastSignInAt: u.last_sign_in_at || '',
      };
    }).sort((a, b) => (a.lastSignInAt || a.createdAt) < (b.lastSignInAt || b.createdAt) ? 1 : -1);

    return json(200, {
      ok: true, users, total: users.length, authTotal: rawUsers.length,
      hidden: { borrowers: count('borrower'), brokers: count('broker'), unknown: unknown.length },
      unknown,
    });
  } catch (e) {
    console.error('users-list-supabase error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
