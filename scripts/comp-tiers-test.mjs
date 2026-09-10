/**
 * scripts/comp-tiers-test.mjs — Deploy 236.951
 *
 * Gate for the LO comp model's tier schedule in deploy/lo-commissions.html:
 * the new tiers apply to closings on/after 2026-09-10; anything that closed
 * earlier keeps the original four tiers. Pulls the functions out of the page
 * by name so the page and the gate can't drift.
 *
 * Run: node scripts/comp-tiers-test.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../deploy/lo-commissions.html', import.meta.url), 'utf8');
function extract(name, kw) {
  const start = src.indexOf((kw || 'function') + ' ' + name + (kw ? ' ' : '('));
  if (start < 0) throw new Error(name + ' not found');
  const open = kw ? src.indexOf('[', start) : src.indexOf('{', start);
  const [o, c] = kw ? ['[', ']'] : ['{', '}'];
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === o) depth++;
    else if (src[i] === c) { depth--; if (depth === 0) return src.slice(start, i + 1) + (kw ? ';' : ''); }
  }
  throw new Error('unbalanced ' + name);
}
const code = [extract('TIER_SCHEDULES', 'var'), extract('tierScheduleFor'), extract('tierBps')].join('\n');
const { tierBps, tierScheduleFor } = new Function(code + '\nreturn { tierBps, tierScheduleFor };')();

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

console.log('comp tiers gate\n');
const NEW = '2026-09-10', OLD = '2026-09-09';
check('schedule picked by close date', [tierScheduleFor(NEW).effective, tierScheduleFor(OLD).effective, tierScheduleFor('2026-12-01').effective], ['2026-09-10', '0000-00-00', '2026-09-10']);
check('no close date → the original schedule', tierScheduleFor('').effective, '0000-00-00');

// New schedule (closings from 9/10/26)
check('new: <1.5 → 35', tierBps(1.49, NEW), 35);
check('new: 1.5–2.24 → 50', [tierBps(1.5, NEW), tierBps(2.24, NEW)], [50, 50]);
check('new: 2.25–2.74 → 58.75 (Mike\'s new tier)', [tierBps(2.25, NEW), tierBps(2.5, NEW), tierBps(2.74, NEW)], [58.75, 58.75, 58.75]);
check('new: 65 kicks in AT 2.75, through 3.49', [tierBps(2.75, NEW), tierBps(3.49, NEW)], [65, 65]);
check('new: 3.5–4.49 → 70', [tierBps(3.5, NEW), tierBps(4.49, NEW)], [70, 70]);
check('new: 4.5+ → 85 (the juicy tier)', [tierBps(4.5, NEW), tierBps(6.2, NEW)], [85, 85]);

// Original schedule (already-closed loans never move)
check('old: <1.5 → 35', tierBps(1.2, OLD), 35);
check('old: 1.5–2.49 → 50 (2.3 stays 50, not 58.75)', [tierBps(1.5, OLD), tierBps(2.3, OLD), tierBps(2.49, OLD)], [50, 50, 50]);
check('old: 2.5–3.49 → 65', [tierBps(2.5, OLD), tierBps(2.74, OLD), tierBps(3.49, OLD)], [65, 65, 65]);
check('old: 3.5+ → 70, even 4.5+ (no 85 for past closings)', [tierBps(3.5, OLD), tierBps(4.5, OLD), tierBps(9, OLD)], [70, 70, 70]);

check('NaN margin → 0', tierBps(NaN, NEW), 0);
check('a datetime close stamp still resolves by its date', tierBps(4.6, '2026-09-10T15:00:00.000Z'), 85);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
