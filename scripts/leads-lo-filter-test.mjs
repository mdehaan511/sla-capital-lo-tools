#!/usr/bin/env node
/**
 * scripts/leads-lo-filter-test.mjs — Deploy 237.260
 *
 * Mike: "On the leads page make it so the LO search dropdown only has Loan Officers and
 * Admins in it. No processors."
 *
 * What would hurt, so what this guards — the page's own functions are lifted and RUN against
 * a fake profile map + select:
 *   1. A processor, the office assistant or a broker showing up in the Leads LO filter again.
 *   2. A loan officer (plain or senior) or an admin dropping OUT of it — or a profile with no
 *      role at all (users-stats' default) being treated as staff and hidden.
 *   3. The login role no longer carried into the profile map (the filter would then hide
 *      everyone, or nobody).
 *   4. A selected value that is no longer listable sticking around and silently filtering
 *      the board to nothing.
 *
 * Run: node scripts/leads-lo-filter-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)));
  if (!ok) fail++;
};
const assert = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fail++; };
const SRC = readFileSync(new URL('../deploy/pipeline.html', import.meta.url), 'utf8');
const lift = (start, end) => { const a = SRC.indexOf(start); if (a < 0) throw new Error('not found: ' + start.slice(0, 50)); const z = SRC.indexOf(end, a + start.length); if (z < 0) throw new Error('end not found after: ' + start.slice(0, 50)); return SRC.slice(a, z + end.length); };

console.log('\nThe Leads LO filter: loan officers and admins, nobody else');
{
  const code = lift('var LO_FILTER_ROLES = {', '\n}\n') + '\n' + lift('function populateLoFilter() {', '\n}\n') + '\n' + lift('function loDisplay(ownerKey) {', '\n}\n');
  const PROFILES = {
    'carl@slacapital.com':   { email: 'carl@slacapital.com',   fullName: 'Carl Senior',    deleted: false, roles: ['senior_lo'] },
    'mike@slacapital.com':   { email: 'mike@slacapital.com',   fullName: 'Mike DeHaan',    deleted: false, roles: ['super_admin'] },
    'ann@slacapital.com':    { email: 'ann@slacapital.com',    fullName: 'Ann Admin',      deleted: false, roles: ['admin'] },
    'chance@slacapital.com': { email: 'chance@slacapital.com', fullName: 'Chance Officer', deleted: false, roles: ['user'] },
    'norole@slacapital.com': { email: 'norole@slacapital.com', fullName: 'No Role',        deleted: false, roles: [] },
    'raissa@slacapital.com': { email: 'raissa@slacapital.com', fullName: 'Raissa Proc',    deleted: false, roles: ['processor'] },
    'mail@slacapital.com':   { email: 'mail@slacapital.com',   fullName: 'Mail Room',      deleted: false, roles: ['office_assistant'] },
    'bo@broker.com':         { email: 'bo@broker.com',         fullName: 'Bo Broker',      deleted: false, roles: ['broker'] },
    'gone@slacapital.com':   { email: 'gone@slacapital.com',   fullName: 'Gone LO',        deleted: true,  roles: ['user'] },
  };
  const run = (selected, scope) => {
    const sel = { style: {}, innerHTML: '', classes: {}, classList: { toggle(c, on) { this.classes = this.classes || {}; this.classes[c] = !!on; } } };
    sel.classList.classes = sel.classes;
    const c = { document: { getElementById: (id) => (id === 'loFilter' ? sel : null) }, _isStaff: true, _scope: scope || 'all', _loFilterValue: selected || '', _profileMap: JSON.parse(JSON.stringify(PROFILES)), escAttr: (s) => String(s), escH: (s) => String(s), Object, Array, String };
    vm.createContext(c);
    vm.runInContext(code + '\npopulateLoFilter();', c);
    const options = [...sel.innerHTML.matchAll(/<option value="([^"]*)"( selected)?>([^<]*)<\/option>/g)].map((m) => [m[1], m[3], !!m[2]]);
    return { sel, options, value: vm.runInContext('_loFilterValue', c), owns: vm.runInContext('_ownsLeads', c) };
  };
  let r = run('');
  check('the list: every loan officer (plain, senior, no role) and every admin, by name, after "All LOs"; no processor, office assistant, broker or deleted user',
    r.options.map((o) => o[0]),
    ['', 'ann@slacapital.com', 'carl@slacapital.com', 'chance@slacapital.com', 'mike@slacapital.com', 'norole@slacapital.com']);
  check('...shown by full name', r.options.slice(1).map((o) => o[1]), ['Ann Admin', 'Carl Senior', 'Chance Officer', 'Mike DeHaan', 'No Role']);
  check('the rule itself, role by role', ['user', 'senior_lo', 'admin', 'super_admin', 'processor', 'office_assistant', 'broker', 'underwriter'].map((role) => r.owns({ roles: [role] })), [true, true, true, true, false, false, false, false]);
  check('...no role at all = a plain loan officer; a missing roles field too', [r.owns({ roles: [] }), r.owns({})], [true, true]);
  r = run('chance@slacapital.com');
  check('a selected loan officer stays selected', [r.value, r.options.find((o) => o[0] === 'chance@slacapital.com')[2]], ['chance@slacapital.com', true]);
  r = run('raissa@slacapital.com');
  check('a selected processor (from before) is cleared rather than silently filtering the board to nothing', [r.value, r.sel.classes['has-value']], ['', false]);
  r = run('', 'mine');
  check('personal scope: the filter stays hidden', [r.sel.style.display, r.options.length], ['none', 0]);
  assert('the login role is carried into the profile map from users-stats', /roles: Array\.isArray\(p\.roles\) \? p\.roles : \[\] \};/.test(SRC));
  assert('the owner list is filtered by the rule, not only by deleted', /return !_profileMap\[o\]\.deleted && _ownsLeads\(_profileMap\[o\]\);/.test(SRC));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
