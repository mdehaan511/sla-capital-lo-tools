#!/usr/bin/env node
/**
 * scripts/sizer-routing-test.mjs — Deploy 237.245 (Mike)
 *
 * Mike: "he needs to reprice with the 5+ sizer ... the loan is going to the 1-4 sizer when
 * clicking on the go to sizer button."
 *
 * Every "open in sizer" router used to send a DSCR loan to the Multifamily sizer ONLY when
 * the MF sizer itself had marked it (mfProgram). A 5+ unit DSCR loan that came in another
 * way (Baseline import: propType 'multi', no marker) opened the 1-4 sizer, which cannot
 * price it. The rule is now: multifamily when the MF marker is set, OR the property is
 * "5+ Unit Multifamily" (propType 'multi' -- the application's and the MF sizer's value; the
 * 1-4 sizer has no such option), OR it carries 5+ units. RTL and GUC route first, as before.
 *
 * Each router line is lifted from its page and RUN against the same fixtures.
 *
 * Run: node scripts/sizer-routing-test.mjs
 */
import { readFileSync } from 'node:fs';

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
const DEPLOY = new URL('../deploy/', import.meta.url);
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');

// Lift the router: from the `var _mfRec = ...` line through the assignment that follows it
// (the page variable), which may span several lines and ends with a quoted page name + ';'.
function liftRouter(src, pageVar) {
  const lines = src.split('\n');
  const i = lines.findIndex((l) => /^\s*var _mfRec = /.test(l));
  if (i < 0) throw new Error('no _mfRec line');
  const out = [lines[i]];
  for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
    out.push(lines[j]);
    if (/';\s*$/.test(lines[j]) || /'\);\s*$/.test(lines[j])) break;
  }
  const code = out.join('\n');
  if (code.indexOf('var ' + pageVar) < 0 && code.indexOf('var ' + pageVar + '=') < 0) throw new Error('router does not assign ' + pageVar + ':\n' + code);
  return code;
}
// Run the lifted router with every free name it might use supplied.
function route(code, pageVar, env) {
  const names = ['l', 'fd', 'q', 'o', 'p', 'loanRec', 'tool', 'isDscr', '_tt', 'String', 'parseInt'];
  const fn = new Function(...names, code + '\nreturn ' + pageVar + ';');
  const e = Object.assign({ String, parseInt }, env);
  return fn(...names.map((n) => e[n]));
}
const strip = (s) => String(s || '').replace(/^\//, '');

const FIX = [
  ['a Baseline-imported 5+ DSCR loan (propType multi, no marker, empty toolType) -- Mike\'s loan', { toolType: '', loanType: 'dscr', propType: 'multi' }, 'mf-dscr-sizer.html'],
  ['a loan the MF sizer saved (mfProgram marker)', { toolType: 'dscr', mfProgram: 'mf_lobal', propType: 'multi' }, 'mf-dscr-sizer.html'],
  ['a DSCR loan carrying 6 units', { toolType: 'dscr', numUnits: '6' }, 'mf-dscr-sizer.html'],
  ['a DSCR loan carrying 4 units', { toolType: 'dscr', numUnits: '4', propType: '2-4' }, 'dscr-sizer.html'],
  ['a 1-4 DSCR loan (sfr)', { toolType: 'dscr', propType: 'sfr' }, 'dscr-sizer.html'],
  ['a DSCR loan with nothing on it', { toolType: 'dscr' }, 'dscr-sizer.html'],
  ['the marker only in formData (older MF quotes)', { toolType: 'dscr', formData: { mfProgram: 'mf_lobal' } }, 'mf-dscr-sizer.html'],
  ['propType multi only in formData', { toolType: 'dscr', formData: { propType: 'multi' } }, 'mf-dscr-sizer.html'],
  ['an RTL loan on a 5+ building still opens the RTL sizer', { toolType: 'rtl', propType: 'multi', numUnits: '12' }, 'rtl-sizer.html'],
  ['a GUC loan still opens the GUC sizer', { toolType: 'guc', propType: 'multi' }, 'guc-sizer.html'],
];

function envFor(file, rec) {
  const fd = rec.formData || {};
  const tt = String(rec.toolType || '').toLowerCase();
  const tool = tt === 'rtl' ? 'rtl' : tt === 'guc' ? 'guc' : 'dscr';
  const isDscr = tt !== 'rtl' && tt !== 'guc';
  return { l: rec, fd, q: rec, o: rec, p: rec, loanRec: null, tool, isDscr, _tt: tt };
}

const PAGES = [
  ['loan-details.js', 'sizerPage', 'Loan Details "Edit in Sizer"'],
  ['clients.html', 'tool', 'Clients list "open in sizer"'],
  ['pipeline.html', 'sizerPage', 'Pipeline quote cards'],
  ['saved-quotes.html', '_page', 'Saved Quotes'],
  ['orphaned-sizers.html', 'page', 'Orphaned sizers'],
];
for (const [file, pageVar, label] of PAGES) {
  console.log('\n' + label + ' (' + file + ')');
  let code;
  try { code = liftRouter(read(file), pageVar); } catch (e) { fail++; console.log('  FAIL could not lift the router: ' + e.message); continue; }
  for (const [name, rec, want] of FIX) {
    let got;
    try { got = strip(route(code, pageVar, envFor(file, rec))); } catch (e) { got = 'threw ' + e.message; }
    check(name, got, want);
  }
}
// pipeline: the loan record wins over the quote row, and a quote row alone still routes
{
  const code = liftRouter(read('pipeline.html'), 'sizerPage');
  const q = { toolType: 'dscr', propType: 'sfr' };
  check('Pipeline: the loan record (5+ units) wins over a quote row that says sfr', route(code, 'sizerPage', Object.assign(envFor('pipeline.html', q), { loanRec: { toolType: 'dscr', propType: 'multi' } })), 'mf-dscr-sizer.html');
  check('Pipeline: no loan record -> the quote row decides', route(code, 'sizerPage', Object.assign(envFor('pipeline.html', { toolType: 'dscr', mfProgram: 'mf_lobal' }), { loanRec: null })), 'mf-dscr-sizer.html');
}
// prospects.html (legacy list): a 5+ unit application opens the MF sizer
{
  const code = liftRouter(read('prospects.html'), 'dest');
  check('Prospects page: a 5+ Unit Multifamily application -> MF sizer; fix & flip -> RTL; a house -> 1-4', [
    route(code, 'dest', { p: { propType: 'multi' } }), route(code, 'dest', { p: { loanProduct: 'fix_flip', propType: 'multi' } }), route(code, 'dest', { p: { propType: 'sfr' } }),
  ], ['mf-dscr-sizer.html', 'rtl-sizer.html', 'dscr-sizer.html']);
}
// every router says the same thing (one rule, five copies)
{
  const rule = /\(_mfRec\.mfProgram \|\| _mfFd\.mfProgram \|\| String\(_mfRec\.propType \|\| _mfFd\.propType \|\| ''\)\.toLowerCase\(\) === 'multi' \|\| parseInt\(_mfRec\.numUnits \|\| _mfFd\.numUnits \|\| 0, 10\) >= 5\)/;
  const missing = PAGES.map((p) => p[0]).concat(['prospects.html']).filter((f) => !rule.test(read(f)));
  check('the same rule text sits in every router', missing, []);
  const m = /loan-details\.js\?v=(\d+|237245)/.exec(read('loan-details.html'));
  assert('loan-details.html loads a loan-details.js pinned to this deploy or newer', !!m && (m[1] === '237245' || parseInt(m[1], 10) >= 237245));
  const MF = read('mf-dscr-sizer.html');
  assert('the MF sizer can load an existing loan by clientId + loanId (what the routed link passes)', /urlParams\.get\('clientId'\)/.test(MF) && /urlParams\.get\('loanId'\)/.test(MF) && /function loadFromClientLoan\(\)/.test(MF));
  assert('...and offers the way back for a property that is really 1-4', /switchTo14\(\)/.test(MF));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
