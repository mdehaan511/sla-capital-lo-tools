// Deploy 236.933 — a TPO premium of 0 is an ANSWER; only a blank is missing.
//
//   node scripts/tpo-blank-vs-zero-test.mjs
//
// This spans two layers and only works if both agree, which is why it is a test
// and not a read-through:
//
//   1. The projections (dashboard-public.mjs adaptRow, sla-dashboard.html
//      adaptLoan) must carry an explicit 0 through as 0. They used to collapse
//      it to '', which threw the distinction away before the page could see it.
//   2. The dashboard predicate (hasTpoPremium) must treat that 0 as present.
//
// Fixing either alone leaves the yellow warning stuck on. The functions are
// pulled out of the real source files so the test cannot drift from them.

import { readFileSync } from 'fs';

let failures = 0;
function check(name, condition, detail) {
  if (condition) { console.log('  PASS  ' + name); return; }
  failures++;
  console.log('  FAIL  ' + name + (detail ? '\n          ' + detail : ''));
}

// ---- lift the real implementations out of the real files -------------------
function lift(file, startMarker, endMarker, returns) {
  const src = readFileSync(file, 'utf8');
  const a = src.indexOf(startMarker);
  if (a < 0) throw new Error('could not find ' + startMarker + ' in ' + file);
  const b = src.indexOf(endMarker, a);
  if (b < 0) throw new Error('could not find end marker in ' + file);
  return new Function(src.slice(a, b) + '; return ' + returns + ';')();
}

const DASH = 'deploy/sla-dashboard.html';
const FN = 'deploy/netlify/functions/dashboard-public.mjs';

const hasTpoPremium = lift(DASH, 'var TPO_PREMIUM_FIELDS', 'function pointsAsPercent', 'hasTpoPremium');
const tpoPremiumPct = lift(DASH, 'var TPO_PREMIUM_FIELDS', 'function pointsAsPercent', 'tpoPremiumPct');
const resolveClient = lift(DASH, 'var TPO_PREMIUM_FIELDS', 'function pointsAsPercent', 'resolveTpoPremium');
const resolveServer = lift(FN, 'function resolveTpoPremium', '// ── Port of', 'resolveTpoPremium');

// ---------------------------------------------------------------------------
console.log('\nThe projections keep a deliberate zero (this is the half that was lost)');
// ---------------------------------------------------------------------------
for (const [label, resolve] of [['client adaptLoan', resolveClient], ['server adaptRow', resolveServer]]) {
  check(label + ': nothing on file stays blank', resolve([undefined, null, '']) === '');
  check(label + ': a stored 0 survives as 0', resolve([0, undefined, undefined]) === 0,
    'got ' + JSON.stringify(resolve([0, undefined, undefined])));
  check(label + ': the string "0" survives as 0', resolve(['0', '', '']) === 0);
  check(label + ': a real premium is unchanged', resolve([1.5, undefined, undefined]) === 1.5);
  check(label + ': a positive later in the chain beats an earlier 0', resolve([0, 2.25, undefined]) === 2.25,
    'got ' + resolve([0, 2.25, undefined]));
  check(label + ': all zeros give 0, not blank', resolve([0, 0, 0]) === 0);
  check(label + ': junk text is not an answer', resolve(['n/a', '', '']) === '');
}
check('client and server agree on every case', [
  [undefined, null, ''], [0, undefined, undefined], ['0', '', ''], [1.5, undefined, undefined],
  [0, 2.25, undefined], [0, 0, 0], ['n/a', '', ''], ['', '', 3],
].every(function (c) { return resolveClient(c) === resolveServer(c); }));

// ---------------------------------------------------------------------------
console.log('\nThe dashboard predicate treats 0 as answered');
// ---------------------------------------------------------------------------
check('a blank TPO_Premium is missing', hasTpoPremium({ TPO_Premium: '' }) === false);
check('an absent field is missing', hasTpoPremium({}) === false);
check('null is missing', hasTpoPremium({ TPO_Premium: null }) === false);
check('a zero is ANSWERED', hasTpoPremium({ TPO_Premium: 0 }) === true);
check('a "0" string is ANSWERED', hasTpoPremium({ TPO_Premium: '0' }) === true);
check('a real premium is answered', hasTpoPremium({ TPO_Premium: 1.75 }) === true);
check('an alternate spelling counts', hasTpoPremium({ tpo_premium: 0 }) === true);
check('junk text is not an answer', hasTpoPremium({ TPO_Premium: 'tbd' }) === false);
check('no loan at all is missing', hasTpoPremium(null) === false);

// ---------------------------------------------------------------------------
console.log('\nRevenue maths is deliberately unchanged');
// ---------------------------------------------------------------------------
check('a zero premium still adds zero revenue', tpoPremiumPct({ TPO_Premium: 0 }) === 0);
check('a blank still reads as zero for revenue', tpoPremiumPct({ TPO_Premium: '' }) === 0);
check('a real premium is still returned', tpoPremiumPct({ TPO_Premium: 2 }) === 2);
check('presence and value stay different questions',
  hasTpoPremium({ TPO_Premium: 0 }) === true && tpoPremiumPct({ TPO_Premium: 0 }) === 0);

// ---------------------------------------------------------------------------
console.log('\nEnd to end: a DSCR loan priced at zero stops being flagged');
// ---------------------------------------------------------------------------
{
  // noTpo is: DSCR, not the Leads modal, and no premium on file.
  const flagged = function (loan) { return !hasTpoPremium(loan); };

  check('never filled in  → still flagged', flagged({ TPO_Premium: resolveServer([undefined, undefined, undefined]) }) === true);
  check('entered as 0     → NOT flagged', flagged({ TPO_Premium: resolveServer([0, undefined, undefined]) }) === false);
  check('entered as 1.25  → NOT flagged', flagged({ TPO_Premium: resolveServer([1.25, undefined, undefined]) }) === false);
  check('zero on tpoSpread only → NOT flagged', flagged({ TPO_Premium: resolveServer([undefined, undefined, 0]) }) === false);
}

console.log('\n' + (failures ? failures + ' FAILURE(S)' : 'All checks passed.') + '\n');
process.exit(failures ? 1 : 0);
