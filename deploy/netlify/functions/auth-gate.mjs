/**
 * auth-gate.mjs — GET /api/auth-gate
 *
 * Deploy 236.958 (Mike: "If someone tries to google sign in with an email that
 * doesnt exist as a user or isnt a borrower that has been invited, simply say
 * 'No User Exists with that Email'.")
 *
 * Called by activate.html the moment a Supabase session lands there (every
 * Google sign-in and every magic link — staff page, borrower portal, borrower
 * intake — redirects to activate.html). Google mints an auth account for
 * anyone, so the check has to happen AFTER the sign-in; this endpoint says
 * what the freshly signed-in account actually is:
 *
 *   { ok, kind: 'staff' | 'broker' | 'borrower' | 'unknown', teamDomain, removed }
 *
 * 'unknown' = nobody we invited (no staff/borrower/broker role in the token-
 * hook role table or app_metadata, not an @slacapital.com address, no live
 * loan_access grant). For those the stray auth account is deleted again —
 * guarded by isStrayAccount(): never an account with any role, never a team-
 * domain address, never one that carries an email/password identity (every
 * invited user does) — so the next attempt starts clean and nothing piles up
 * in Supabase. activate.html then signs the browser out and shows the
 * message; a non-team address is sent on to portal-select.html (Borrower or
 * Broker?).
 *
 * Any authenticated caller (it is about the caller's own account). Fails
 * OPEN on infrastructure errors — activate.html proceeds as before — because
 * locking real staff out on a transient PG/blobs hiccup is the worse failure.
 */
import { handleOptions, json, requireAuth, getRoles, normalizeEmail } from './_shared/auth.mjs';
import { classifyAccount, isStrayAccount, isTeamDomain, normRoles } from './_shared/team-roster-rules.mjs';
import { loadRoleTable, adminGetUser, adminDeleteUser } from './_shared/team-roster.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('auth-gate error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const email = normalizeEmail(user.email || '');
  const userId = String(user.sub || user.id || '');
  const tokenRoles = normRoles([].concat(getRoles(user) || [], Array.isArray(user.sla_roles) ? user.sla_roles : []));

  const table = await loadRoleTable();
  const tableRoles = table.get(email) || [];

  let kind = classifyAccount({ email, appRoles: tokenRoles, tableRoles, grantCount: 0 });
  let grants = 0;
  if (kind === 'unknown') {
    grants = (await listAccessibleLoans(email)).length;
    kind = classifyAccount({ email, appRoles: tokenRoles, tableRoles, grantCount: grants });
  }

  let removed = false;
  if (kind === 'unknown' && userId) {
    // Re-read the account from the admin API — the token only carries what
    // the hook stamped; the guard wants app_metadata + identities as stored.
    try {
      const raw = await adminGetUser(userId);
      if (raw && normalizeEmail(raw.email || '') === email && isStrayAccount(raw, tableRoles)) {
        await adminDeleteUser(userId);
        removed = true;
        console.log('[auth-gate] removed stray account', email.replace(/^(.{2}).*@/, '$1…@'));
      }
    } catch (e) {
      console.warn('[auth-gate] stray cleanup skipped:', e && e.message);
    }
  }

  return json(200, { ok: true, kind, teamDomain: isTeamDomain(email), removed });
}
