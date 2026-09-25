#!/usr/bin/env node
/**
 * scripts/lo-filter-roles-test.mjs — Deploy 237.278
 *
 * Mike: "Any idea why the All LOs drop down in the LEADS Pipeline isn't showing
 * all the LOs?" … "But it is showing Diana for some reason and she's an
 * underwriter."
 *
 * 237.260 added a role filter to that dropdown with the LEGACY role name 'user'
 * but not 'loan_officer' — the name a loan officer's role has actually carried
 * since the role table became authoritative. So the list dropped every LO who had
 * been migrated and kept the ones who hadn't, which is why it looked arbitrary
 * rather than broken. The roster below is the REAL one, read off sla_user_roles
 * on 2026-09-25, with the roles each profile really carries.
 *
 * Run: node scripts/lo-filter-roles-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};

const P = readFileSync(new URL('../deploy/pipeline.html', import.meta.url), 'utf8');
const a = P.indexOf('var LO_FILTER_ROLES =');
const b = P.indexOf('function populateLoFilter()', a);
assert('the filter is where the gate expects it', a > 0 && b > a);
const ctx = { console, String, Array, Object, Boolean };
vm.createContext(ctx);
vm.runInContext(P.slice(a, b), ctx);
const owns = (email, roles, hasLeads) => {
  ctx._ownersWithLeads = hasLeads ? { [email]: true } : {};
  return vm.runInContext('_ownsLeads(' + JSON.stringify({ email, roles }) + ', ' + JSON.stringify(email) + ')', ctx);
};

// sla_user_roles, 2026-09-25, plus how many leads each owns on the board today.
const ROSTER = [
  ['jeff@slacapital.com',            ['loan_officer'], 0],
  ['kayla.blouin@slacapital.com',    ['loan_officer'], 0],
  ['miguel@slacapital.com',          ['loan_officer'], 0],
  ['nabil@slacapital.com',           ['loan_officer'], 0],
  ['sierra@slacapital.com',          ['loan_officer'], 0],
  ['milk.delcorio@slacapital.com',   ['loan_officer'], 0],
  ['eric.clunn@slacapital.com',      ['loan_officer'], 0],
  ['mason.bridges@slacapital.com',   ['loan_officer'], 0],
  ['marianne.wentzel@slacapital.com',['user'],         0],   // legacy label
  ['jojo.scherer@slacapital.com',    ['user'],         0],
  ['randy.dargan@slacapital.com',    ['user'],         0],
  ['carl.davis@slacapital.com',      ['senior_lo'],    0],
  ['sara.s@slacapital.com',          ['senior_lo'],    0],
];

console.log('\nevery loan officer is listed, whatever their role is called\n');
{
  const missing = ROSTER.filter(([e, r, n]) => !owns(e, r, n > 0)).map(([e]) => e);
  check('none of them is filtered out', missing, []);
  assert('the allowlist carries the CURRENT role name, which is what was missing',
    /loan_officer: true/.test(P.slice(a, b)), 'LO_FILTER_ROLES has no loan_officer');
  assert('…and still carries the legacy one, so an unmigrated LO is not dropped instead',
    /user: true/.test(P.slice(a, b)));
  check('an LO with an empty pipeline is still selectable — that is the point of the filter',
    owns('nabil@slacapital.com', ['loan_officer'], false), true);
  check('a profile with no roles at all is treated as a plain LO', owns('nobody@slacapital.com', [], false), true);
}

console.log('\nand nobody else is, unless they actually own a lead');
{
  // Diana is an underwriter whose LOGIN role is admin (underwriter is a team role
  // on a loan, not a login role — 237.216), so the role alone cannot place her.
  check('Diana, admin by login, underwriter by job, with no leads: not listed',
    owns('diana@slacapital.com', ['admin'], false), false);
  check('Mike, Chance and Jeremy are admins who DO own leads: listed',
    ['mike@slacapital.com', 'chance@slacapital.com', 'jeremy@slacapital.com'].map((e) => owns(e, ['admin'], true)),
    [true, true, true]);
  check('a super_admin with leads is listed, one without is not',
    [owns('dan@slacapital.com', ['super_admin'], true), owns('dan@slacapital.com', ['super_admin'], false)],
    [true, false]);
  check('processors are not loan officers',
    ['keith', 'raissa', 'jessy', 'elle', 'beth'].map((n) => owns(n + '@slacapital.com', ['processor'], false)),
    [false, false, false, false, false]);
  check('…but a processor who somehow owns a lead is selectable, so it is findable',
    owns('keith@slacapital.com', ['processor'], true), true);
  check('the office assistant and a broker never own leads',
    [owns('mail@slacapital.com', ['office_assistant'], false), owns('b@broker.com', ['broker'], false)],
    [false, false]);
}

console.log('\nthe list is rebuilt once the board knows who owns what');
{
  assert('the owner set is built from the board, not guessed',
    /_ownersWithLeads = \{\};[\s\S]{0,400}it\.ownerKey/.test(P));
  assert('…and the dropdown is re-populated after it exists',
    /_ownersWithLeads\[o\] = true;[\s\S]{0,200}populateLoFilter\(\);/.test(P));
  const first = P.indexOf('populateLoFilter();');
  assert('the earlier call is still there for the first paint', first > 0 && first < P.indexOf('_ownersWithLeads = {};'));
  assert('a deleted profile is still filtered out', /!_profileMap\[o\]\.deleted && _ownsLeads\(_profileMap\[o\], o\)/.test(P));
}

console.log(fail ? `\n${fail} check(s) FAILED` : '\nall checks pass');
process.exit(fail ? 1 : 0);
