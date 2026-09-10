/**
 * scripts/team-roster-test.mjs — Deploy 236.958
 *
 * Gate for the pure team-member rules (deploy/netlify/functions/_shared/
 * team-roster-rules.mjs): what Users Admin lists, what the sign-in gate lets
 * through, and which stray accounts it may remove.
 *
 * Run: node scripts/team-roster-test.mjs
 */
import {
  STAFF_ROLES, classifyAccount, mergedRoles, rolesFromMeta, laterOf, isStrayAccount, isTeamDomain,
} from '../deploy/netlify/functions/_shared/team-roster-rules.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

console.log('team roster gate\n');

// ── classification ─────────────────────────────────────────────────────────
check('every invite-able role is staff', ['admin', 'senior_lo', 'loan_officer', 'processor'].every((r) => STAFF_ROLES.includes(r)), true);
check('role from the token-hook table → staff', classifyAccount({ email: 'sara@gmail.com', tableRoles: ['loan_officer'] }), 'staff');
check('role only on app_metadata (legacy invite) → staff', classifyAccount({ email: 'x@y.com', appRoles: ['processor'] }), 'staff');
check('super_admin via app_metadata {role:"…"} shape', classifyAccount({ email: 'm@y.com', appRoles: rolesFromMeta({ role: 'super_admin' }) }), 'staff');
check('@slacapital.com with NO role anywhere → still staff (index.html backstop)', classifyAccount({ email: 'new.hire@SLAcapital.com' }), 'staff');
check('role borrower → borrower', classifyAccount({ email: 'b@gmail.com', appRoles: ['borrower'] }), 'borrower');
check('no role but a live grant → borrower', classifyAccount({ email: 'b@gmail.com', grantCount: 1 }), 'borrower');
check('role broker → broker', classifyAccount({ email: 'k@brokerage.com', tableRoles: ['broker'] }), 'broker');
check('Google-minted, no role, no grant, not team domain → unknown (Byron)', classifyAccount({ email: 'posadas71@gmail.com', appRoles: [], tableRoles: [], grantCount: 0 }), 'unknown');
check('staff beats borrower when both are stamped', classifyAccount({ email: 'x@y.com', appRoles: ['borrower'], tableRoles: ['admin'] }), 'staff');
check('blank input is unknown, not a crash', classifyAccount(null), 'unknown');

// ── role merge (table wins, app fills) ─────────────────────────────────────
check('table first, app_metadata extras appended, de-duped, lower-cased', mergedRoles(['Loan_Officer'], ['loan_officer', 'processor']), ['loan_officer', 'processor']);
check('no table row → app_metadata roles', mergedRoles([], ['admin']), ['admin']);
check('rolesFromMeta handles roles array / roles string / role string / nothing',
  [rolesFromMeta({ roles: ['a', 'b'] }), rolesFromMeta({ roles: 'x' }), rolesFromMeta({ role: 'y' }), rolesFromMeta({})],
  [['a', 'b'], ['x'], ['y'], []]);

// ── last sign-in = the later stamp ─────────────────────────────────────────
check('portal ping newer than Supabase sign-in → the ping wins', laterOf('2026-08-01T10:00:00Z', '2026-09-10T08:00:00Z'), '2026-09-10T08:00:00Z');
check('Supabase newer → Supabase wins', laterOf('2026-09-10T08:00:00Z', '2026-08-01T10:00:00Z'), '2026-09-10T08:00:00Z');
check('one side blank → the other', [laterOf('', '2026-01-01T00:00:00Z'), laterOf('2026-01-01T00:00:00Z', '')], ['2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z']);
check('both blank → blank', laterOf('', ''), '');

// ── stray-account removal guard ────────────────────────────────────────────
const google = { email: 'posadas71@gmail.com', app_metadata: { provider: 'google', providers: ['google'] }, identities: [{ provider: 'google' }] };
check('Google-only, role-less, non-team → removable', isStrayAccount(google, []), true);
check('same account but the role table knows them → keep', isStrayAccount(google, ['loan_officer']), false);
check('app_metadata role (invited borrower) → keep', isStrayAccount(Object.assign({}, google, { app_metadata: { roles: ['borrower'] } }), []), false);
check('an email/password identity (admin-invited user) → keep', isStrayAccount(Object.assign({}, google, { identities: [{ provider: 'email' }, { provider: 'google' }] }), []), false);
check('team-domain address → never removed', isStrayAccount(Object.assign({}, google, { email: 'someone@slacapital.com' }), []), false);
check('no identities at all → keep (nothing to reason from)', isStrayAccount(Object.assign({}, google, { identities: [] }), []), false);
check('isTeamDomain is case-insensitive and needs the @', [isTeamDomain('A@SLACapital.com'), isTeamDomain('a@notslacapital.com'), isTeamDomain('')], [true, false, false]);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
