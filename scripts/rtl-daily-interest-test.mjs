/**
 * scripts/rtl-daily-interest-test.mjs — Deploy 236.932
 *
 * Gate for the 30/360 daily + prepaid interest math on the Loan Terms card.
 * The functions live in deploy/loan-details.js (browser ES5); this pulls
 * their source out by name and evaluates it, so the page and the gate can
 * never drift.
 *
 * Run: node scripts/rtl-daily-interest-test.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../deploy/loan-details.js', import.meta.url), 'utf8');

function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found in loan-details.js');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
  }
  throw new Error('unbalanced braces in ' + name);
}
const names = ['_ldParseYmd', '_ldDrawsNum', '_ldRatePctOf', '_days30360ToNextFirst', '_ldInterestMath'];
const fns = new Function(names.map(extract).join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
const { _ldRatePctOf: ratePct, _days30360ToNextFirst: days, _ldInterestMath: math } = fns;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const r2 = (n) => Math.round(n * 100) / 100;

console.log('RTL daily interest gate\n');

check('rate "10.500" → 10.5%', ratePct('10.500'), 10.5);
check('rate 0.105 (Baseline decimal) → 10.5%', r2(ratePct(0.105)), 10.5);
check('rate blank → 0', ratePct(''), 0);

check('close 9/15 → 16 days to 10/1', days('2026-09-15'), 16);
check('close on the 1st → the whole month (30)', days('2026-09-01'), 30);
check('close on the 30th → 1 day', days('2026-09-30'), 1);
check('close on a 31st counts as the 30th → 1 day', days('2026-08-31'), 1);
check('Feb 28 → 3 days (30/360 ignores the short month)', days('2026-02-28'), 3);
check('no closing date → 0', days(''), 0);

{
  const m = math(144200, 10.5, '2026-09-15', true, 69300);
  check('Dutch: base is the full note', m.base, 144200);
  check('  daily = 144,200 × 10.5% ÷ 360', r2(m.daily), 42.06);
  check('  16 days prepaid', [m.days, r2(m.prepaid)], [16, 672.93]);
}
{
  const m = math('$144,200', '10.500', '2026-09-01', true, 0);
  check('formatted inputs parse; close on the 1st → 30 days', [m.base, m.days, r2(m.prepaid)], [144200, 30, 1261.75]);
}
{
  const m = math(144200, 10.5, '2026-09-15', false, 69300);
  check('Non-Dutch: base is the initial advance (note − holdback)', m.base, 74900);
  check('  daily on the advance', r2(m.daily), 21.85);
}
check('Non-Dutch never goes below zero', math(50000, 10, '2026-09-15', false, 80000).base, 0);
check('no rate → no interest', [math(144200, 0, '2026-09-15', true, 0).daily, math(144200, 0, '2026-09-15', true, 0).prepaid], [0, 0]);
check('no closing date → daily shown, prepaid 0', [r2(math(144200, 10.5, '', true, 0).daily), math(144200, 10.5, '', true, 0).prepaid], [42.06, 0]);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
