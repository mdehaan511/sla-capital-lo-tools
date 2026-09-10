/**
 * team-roster-rules.mjs — PURE rules for "who is an SLA Capital team member"
 *
 * Deploy 236.958 (Mike: "Users Admin ONLY shows SLA Capital team members we
 * manually invite" … "If someone tries to google sign in with an email that
 * doesnt exist as a user or isnt a borrower that has been invited, simply say
 * 'No User Exists with that Email'.")
 *
 * Background: Google sign-in mints a Supabase auth account for ANY Google
 * user who clicks the button (staff login page, borrower portal, borrower
 * intake). The account gets no role, index.html bounces it to the borrower
 * portal, and it then sits in the Users Admin list as "(no role) · accepted"
 * — which is how a borrower (Byron Posadas, 2026-09-08) ended up looking like
 * a team member. These rules decide, from the facts an account carries, what
 * it is:
 *
 *   staff    — a staff role, from the token-hook role table (public.sla_user_roles,
 *              the authoritative roster since 236.441/236.826) or app_metadata
 *              (legacy / invite-stamped), OR an @slacapital.com address (the
 *              same backstop index.html uses so a legacy LO whose role was
 *              never stamped still lands on the dashboard)
 *   broker   — role 'broker'
 *   borrower — role 'borrower' (borrower-invite-core stamps it) or a live
 *              loan_access grant for the email
 *   unknown  — nobody we invited: Google minted the account on its own
 *
 * Users Admin lists ONLY 'staff'. The sign-in gate (auth-gate.mjs, called from
 * activate.html — the one landing page every Google/magic-link sign-in goes
 * through) turns 'unknown' into "No user exists with that email" and removes
 * the stray account so nothing accumulates.
 *
 * NO imports on purpose: scripts/team-roster-test.mjs loads this bare. The IO
 * (role table, profiles store, Supabase admin API) lives in team-roster.mjs.
 */

export const STAFF_ROLES = ['super_admin', 'admin', 'senior_lo', 'loan_officer', 'processor', 'user'];
export const TEAM_DOMAIN = '@slacapital.com';

export function normEmail(s) {
  return String(s || '').trim().toLowerCase();
}

/** Lower-case, trimmed, de-duplicated role list (drops blanks / non-strings). */
export function normRoles(list) {
  const out = [];
  (Array.isArray(list) ? list : (list ? [list] : [])).forEach((r) => {
    const v = String(r == null ? '' : r).trim().toLowerCase();
    if (v && out.indexOf(v) < 0) out.push(v);
  });
  return out;
}

/** Roles as Supabase stores them on app_metadata ({roles:[…]} or {role:'…'}). */
export function rolesFromMeta(am) {
  const m = am || {};
  if (Array.isArray(m.roles)) return normRoles(m.roles);
  if (typeof m.roles === 'string' && m.roles) return normRoles([m.roles]);
  if (typeof m.role === 'string' && m.role) return normRoles([m.role]);
  return [];
}

/**
 * Role list for display / the role dropdown: the token-hook table is the
 * truth, app_metadata fills in anything the table doesn't say (legacy users
 * invited before the table existed).
 */
export function mergedRoles(tableRoles, appRoles) {
  const out = normRoles(tableRoles);
  normRoles(appRoles).forEach((r) => { if (out.indexOf(r) < 0) out.push(r); });
  return out;
}

export function isTeamDomain(email) {
  return normEmail(email).endsWith(TEAM_DOMAIN);
}

/**
 * classifyAccount({ email, appRoles, tableRoles, grantCount })
 *   → 'staff' | 'broker' | 'borrower' | 'unknown'
 */
export function classifyAccount(a) {
  const acct = a || {};
  const roles = mergedRoles(acct.tableRoles, acct.appRoles);
  if (roles.some((r) => STAFF_ROLES.indexOf(r) >= 0)) return 'staff';
  if (isTeamDomain(acct.email)) return 'staff';
  if (roles.indexOf('broker') >= 0) return 'broker';
  if (roles.indexOf('borrower') >= 0) return 'borrower';
  if (Number(acct.grantCount) > 0) return 'borrower';
  return 'unknown';
}

/** The later of two ISO timestamps; either may be blank. Returns '' if both are. */
export function laterOf(a, b) {
  const ta = Date.parse(a || ''); const tb = Date.parse(b || '');
  const okA = ta > 0; const okB = tb > 0;
  if (okA && okB) return ta >= tb ? a : b;
  if (okA) return a;
  if (okB) return b;
  return '';
}

/**
 * Guard for auto-removing an 'unknown' account from auth-gate: only an account
 * with NO roles anywhere, NOT on the team domain, and NO email/password
 * identity (i.e. every identity is an OAuth provider such as google — an
 * invited user, staff or borrower, always carries an 'email' identity from
 * the admin createUser/invite). `raw` is the Supabase admin-API user object.
 * Grants are checked by the caller before this is consulted.
 */
export function isStrayAccount(raw, tableRoles) {
  const u = raw || {};
  if (isTeamDomain(u.email)) return false;
  if (rolesFromMeta(u.app_metadata).length) return false;
  if (normRoles(tableRoles).length) return false;
  const ids = Array.isArray(u.identities) ? u.identities : [];
  if (!ids.length) return false;
  return ids.every((i) => i && String(i.provider || '').toLowerCase() !== 'email');
}
