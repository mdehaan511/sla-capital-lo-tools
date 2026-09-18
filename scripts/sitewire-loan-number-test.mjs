/**
 * scripts/sitewire-loan-number-test.mjs — Deploy 237.158 (Mike)
 *
 * The SLA loan number is written out THREE times: the shared browser helper in
 * sla-api.js, the fallback still inlined in loan-details.js, and the server
 * copy in _shared/loan-number.mjs. The Sitewire join only works while all three
 * produce the same string for the same loan — a drift of one character and the
 * Draws tab silently shows dashes, which is the bug this deploy fixes.
 *
 * So: pull each implementation out of the real source file and make them agree.
 *
 *   node scripts/sitewire-loan-number-test.mjs
 */
import { readFileSync } from 'node:fs';
import { slaLoanNumber as serverNumber, deriveSlaLoanNumber as serverDerive } from '../deploy/netlify/functions/_shared/loan-number.mjs';

const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8');

// ── Pull the browser implementations out of the shipped files ──
function extract(src, startMarker, file) {
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('could not find ' + startMarker + ' in ' + file);
  // Walk braces from the first { after the marker.
  let j = src.indexOf('{', i), depth = 0, k = j;
  for (; k < src.length; k++) {
    if (src[k] === '{') depth++;
    else if (src[k] === '}') { depth--; if (!depth) break; }
  }
  return src.slice(i, k + 1);
}

const apiSrc = read('deploy/sla-api.js');
const ldSrc  = read('deploy/loan-details.js');
const sandbox = { window: {} }; // no SLA on it: loan-details must use its own fallback
const make = (code, name) => {
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', code + '\nreturn ' + name + ';');
  return fn(sandbox.window);
};
const apiDerive = make(extract(apiSrc, 'function deriveSlaLoanNumber(loan)', 'sla-api.js'), 'deriveSlaLoanNumber');
const apiNumber = make(
  extract(apiSrc, 'function deriveSlaLoanNumber(loan)', 'sla-api.js') + '\n' +
  extract(apiSrc, 'function slaLoanNumber(loan)', 'sla-api.js'), 'slaLoanNumber');
const ldDerive  = make(extract(ldSrc, 'function _deriveSlaLoanIdClient(loan)', 'loan-details.js'), '_deriveSlaLoanIdClient');

const today = (() => { const d = new Date(); return '' + d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0'); })();

const CASES = [
  { name: 'funding date wins',        loan: { id: 'l_1787948453094_1sxv', fundingDate: '2026-08-31', createdAt: '2026-08-28T20:20:53.094Z' }, expectStamp: '20260831' },
  { name: 'ISO funding timestamp',    loan: { id: 'l_1787948453094_1sxv', fundingDate: '2026-08-31T00:00:00.000Z' },                          expectStamp: '20260831' },
  { name: 'createdAt fallback',       loan: { id: 'l_1787948453094_1sxv', createdAt: '2026-08-28T20:20:53.094Z' },                            expectStamp: '20260828' },
  { name: 'no dates at all',          loan: { id: 'l_1787948453094_1sxv' },                                                                   expectStamp: today },
  { name: 'unparseable date',         loan: { id: 'l_1787948453094_1sxv', fundingDate: 'not a date' },                                        expectStamp: today },
  { name: 'empty id',                 loan: { id: '', createdAt: '2026-01-02' },                                                              expectStamp: '20260102' },
  { name: 'Mike’s reported loan', loan: { id: 'l_1787948453094_1sxv', createdAt: '2026-08-28T20:20:53.094Z' },                           expectStamp: '20260828' },
];

let failed = 0;
const fail = (msg) => { failed++; console.log('  ✗ ' + msg); };

console.log('SLA loan number — three implementations, one string\n');
for (const c of CASES) {
  const a = apiDerive(c.loan), b = ldDerive(c.loan), s = serverDerive(c.loan);
  const agree = a === b && b === s;
  const shaped = /^SLA-\d{8}-\d{4}$/.test(a) && a.slice(4, 12) === c.expectStamp;
  if (agree && shaped) console.log('  ✓ ' + c.name.padEnd(24) + a);
  else {
    if (!agree) fail(c.name + ' — disagree: sla-api ' + a + ' / loan-details ' + b + ' / server ' + s);
    if (!shaped) fail(c.name + ' — expected stamp ' + c.expectStamp + ', got ' + a);
  }
}

// ── A stored number always wins, and is normalized the way the join expects ──
console.log('\nStored slaDisplayId');
const stored = [
  { loan: { id: 'l_1', slaDisplayId: 'SLA-20260101-0042', createdAt: '2026-08-28' }, want: 'SLA-20260101-0042' },
  { loan: { id: 'l_1', slaDisplayId: '  sla-20260101-0042  ' },                      want: 'SLA-20260101-0042' },
  { loan: { id: 'l_1', slaDisplayId: '' , createdAt: '2026-08-28' },                 want: serverDerive({ id: 'l_1', createdAt: '2026-08-28' }) },
];
for (const c of stored) {
  const a = apiNumber(c.loan), s = serverNumber(c.loan);
  if (a === c.want && s === c.want) console.log('  ✓ ' + JSON.stringify(c.loan.slaDisplayId) + ' → ' + a);
  else fail('stored ' + JSON.stringify(c.loan.slaDisplayId) + ' — sla-api ' + a + ' / server ' + s + ' / want ' + c.want);
}

// ── The derived number must be STABLE: it is what is typed into Sitewire ──
console.log('\nStability');
const pinned = { id: 'l_1787948453094_1sxv', fundingDate: '2026-08-31' };
const PINNED_EXPECT = serverDerive(pinned);
if (/^SLA-20260831-\d{4}$/.test(PINNED_EXPECT) && apiDerive(pinned) === PINNED_EXPECT && ldDerive(pinned) === PINNED_EXPECT) {
  console.log('  ✓ ' + pinned.id + ' → ' + PINNED_EXPECT + ' (all three)');
} else fail('pinned loan drifted: ' + PINNED_EXPECT);

console.log('');
if (failed) { console.log(failed + ' check(s) FAILED'); process.exit(1); }
console.log('✓ all three implementations agree');
