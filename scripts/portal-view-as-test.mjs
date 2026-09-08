/**
 * scripts/portal-view-as-test.mjs — Deploy 236.895
 *
 * Gate for admin "view as a borrower" (_shared/portal-view-as.mjs).
 *
 * This is a permission boundary, so the checks that matter are the negative
 * ones: a non-admin must not be able to read someone else's portal by typing
 * a query parameter, and NOTHING may be written while viewing.
 *
 * Run: node scripts/portal-view-as-test.mjs
 */
import { resolveViewAs, denyWrite } from '../deploy/netlify/functions/_shared/portal-view-as.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

// Roles come off app_metadata the way _shared/auth.mjs getRoles reads them.
const admin    = { email: 'mike@slacapital.com',  app_metadata: { role: 'admin',     roles: ['admin'] } };
const lo       = { email: 'beth@slacapital.com',  app_metadata: { role: 'lo',        roles: ['lo'] } };
const processor= { email: 'proc@slacapital.com',  app_metadata: { role: 'processor', roles: ['processor'] } };
const borrower = { email: 'borrower@example.com', app_metadata: { role: 'borrower',  roles: ['borrower'] } };

const req = (qs) => ({ url: 'https://portal.slacapital.ai/api/borrower-portal-loans' + (qs || '') });
const status = (r) => (r ? r.status : null);

console.log('portal view-as gate\n');

// ── No parameter: everyone just sees themselves ───────────────────────────
{
  const r = resolveViewAs(req(), borrower);
  check('no viewAs → own email', [r.email, r.viewingAs, status(r.error)], ['borrower@example.com', false, null]);
  const a = resolveViewAs(req(), admin);
  check('admin without viewAs is not "viewing"', a.viewingAs, false);
}

// ── The negative cases — the whole point of the file ──────────────────────
{
  // Someone ELSE's portal — the actual threat. (A borrower naming their own
  // address is not a view at all; that case is covered below.)
  const q = '?viewAs=someone.else%40example.com';
  for (const [who, user] of [['borrower', borrower], ['LO', lo], ['processor', processor]]) {
    const r = resolveViewAs(req(q), user);
    check(who + ' cannot view another portal', status(r.error), 403);
    check('  ' + who + ' is not silently granted the view', r.viewingAs, false);
    check('  ' + who + ' email is never swapped', r.email, user.email);
  }

  // A borrower naming their own address is harmless — must not 403 them out
  // of their own portal.
  const ownName = resolveViewAs(req('?viewAs=borrower%40example.com'), borrower);
  check('borrower naming their own address is not blocked',
    [ownName.email, ownName.viewingAs, status(ownName.error)],
    ['borrower@example.com', false, null]);
}

// ── The admin path ────────────────────────────────────────────────────────
{
  const r = resolveViewAs(req('?viewAs=borrower%40example.com'), admin);
  check('admin may view', [r.email, r.viewingAs, status(r.error)], ['borrower@example.com', true, null]);
  check('  actor stays the admin, not the borrower', r.actor, 'mike@slacapital.com');
}

// ── Normalisation and odd input ───────────────────────────────────────────
{
  const r = resolveViewAs(req('?viewAs=BORROWER%40Example.COM'), admin);
  check('address is normalised', r.email, 'borrower@example.com');

  const self = resolveViewAs(req('?viewAs=mike%40slacapital.com'), admin);
  check('viewing yourself is not a view', self.viewingAs, false);

  const junk = resolveViewAs(req('?viewAs=notanemail'), admin);
  check('non-address is rejected', status(junk.error), 400);

  const empty = resolveViewAs(req('?viewAs='), borrower);
  check('empty viewAs is just self, not a 403', [empty.viewingAs, status(empty.error)], [false, null]);
}

// ── Writes: refused while viewing, untouched otherwise ────────────────────
{
  const viewing = resolveViewAs(req('?viewAs=borrower%40example.com'), admin);
  check('write refused while viewing', status(denyWrite(viewing)), 403);

  const own = resolveViewAs(req(), borrower);
  check('borrower writes to their own portal normally', denyWrite(own), null);

  const adminOwn = resolveViewAs(req(), admin);
  check('admin not viewing writes normally', denyWrite(adminOwn), null);

  check('denyWrite tolerates a missing context', denyWrite(null), null);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
