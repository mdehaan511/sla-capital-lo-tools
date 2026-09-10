/**
 * scripts/comp-tiers-test.mjs — Deploy 236.951 / 236.952
 *
 * Gate for the shared LO comp model (deploy/lo-comp.js): the close-date tier
 * schedule (new tiers only for closings on/after 2026-09-10), the per-row
 * math per plan, row building with repeat-borrower detection, and the payout
 * state read off the BILL stamps. Both lo-commissions.html and profile.html
 * load this module, so this is the one place the numbers are pinned.
 *
 * Run: node scripts/comp-tiers-test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../deploy/lo-comp.js');
const { tierBps, tierScheduleFor, computeRow, buildRows, payoutState, marginOf } = C;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const r2 = (n) => Math.round(n * 100) / 100;

console.log('comp model gate\n');
const NEW = '2026-09-10', OLD = '2026-09-09';
check('schedule picked by close date', [tierScheduleFor(NEW).effective, tierScheduleFor(OLD).effective, tierScheduleFor('2026-12-01').effective], ['2026-09-10', '0000-00-00', '2026-09-10']);
check('no close date → the original schedule', tierScheduleFor('').effective, '0000-00-00');
check('new: <1.5 → 35', tierBps(1.49, NEW), 35);
check('new: 1.5–2.24 → 50', [tierBps(1.5, NEW), tierBps(2.24, NEW)], [50, 50]);
check('new: 2.25–2.74 → 58.75 (Mike\'s new tier)', [tierBps(2.25, NEW), tierBps(2.5, NEW), tierBps(2.74, NEW)], [58.75, 58.75, 58.75]);
check('new: 65 kicks in AT 2.75, through 3.49', [tierBps(2.75, NEW), tierBps(3.49, NEW)], [65, 65]);
check('new: 3.5–4.49 → 70', [tierBps(3.5, NEW), tierBps(4.49, NEW)], [70, 70]);
check('new: 4.5+ → 85 (the juicy tier)', [tierBps(4.5, NEW), tierBps(6.2, NEW)], [85, 85]);
check('old: <1.5 → 35', tierBps(1.2, OLD), 35);
check('old: 1.5–2.49 → 50 (2.3 stays 50, not 58.75)', [tierBps(1.5, OLD), tierBps(2.3, OLD), tierBps(2.49, OLD)], [50, 50, 50]);
check('old: 2.5–3.49 → 65', [tierBps(2.5, OLD), tierBps(2.74, OLD), tierBps(3.49, OLD)], [65, 65, 65]);
check('old: 3.5+ → 70, even 4.5+ (no 85 for past closings)', [tierBps(3.5, OLD), tierBps(4.5, OLD), tierBps(9, OLD)], [70, 70, 70]);
check('NaN margin → 0', tierBps(NaN, NEW), 0);
check('a datetime close stamp still resolves by its date', tierBps(4.6, '2026-09-10T15:00:00.000Z'), 85);

// ── Margin ─────────────────────────────────────────────────────────────────
check('DSCR margin = points + TPO spread', marginOf({ toolType: 'dscr', points: 1, tpoSpread: 1.5 }).margin, 2.5);
check('RTL margin = points + (sold rate − sizer base)', marginOf({ toolType: 'rtl', points: 2, rate: 11.25, _pricingOverrideOriginal: { rate: 11 } }).margin, 2.25);
check('RTL at the sizer rate → just the points', marginOf({ toolType: 'rtl', points: 2, rate: 10.5 }).margin, 2);

// ── Rows ───────────────────────────────────────────────────────────────────
const byOwner = { 'sara.s@slacapital.com': [
  { id: 'c1', email: 'b@x.com', firstName: 'Bea', lastName: 'Borrower', loans: [
    { id: 'l1', status: 'closed', fundingDate: '2026-06-02', address: '1 First St', toolType: 'dscr', loanAmt: 200000, points: 1, tpoSpread: 1.5, commissionBillId: 'B1', commissionPaymentStatus: 'PAID', commissionPaidAt: '2026-07-01' },
    { id: 'l2', status: 'closed', fundingDate: '2026-09-15', address: '2 Second St', toolType: 'dscr', finalLoanAmount: 300000, points: 1, tpoSpread: 1.5, commissionReferral: 'yes' },
    { id: 'l3', status: 'active', address: 'not closed', toolType: 'dscr', loanAmt: 100000 },
  ] },
] };
const rows = buildRows(byOwner);
check('only closed loans become rows', rows.map((r) => r.loanId), ['l1', 'l2']);
check('the second closing for the same borrower is a repeat', rows.map((r) => r.isRepeat), [false, true]);
check('amount prefers finalLoanAmount', rows.map((r) => r.amount), [200000, 300000]);
check('BILL stamps ride along', [rows[0].billId, rows[0].payStatus, rows[0].paidAt, rows[1].referral], ['B1', 'PAID', '2026-07-01', true]);

// ── Per-row math ───────────────────────────────────────────────────────────
{
  const june = computeRow(rows[0], 'model');
  check('model, June closing: margin 2.5 on the OLD schedule → 65 bps', [june.tier, r2(june.base), june.bonus, r2(june.total)], [65, 1300, 0, 1300]);
  const sept = computeRow(rows[1], 'model');
  check('model, Sept 15 closing: margin 2.5 on the NEW schedule → 58.75 bps + repeat + referral', [sept.tier, r2(sept.base), sept.bonus, r2(sept.total)], [58.75, 1762.5, 500, 2262.5]);
  const company = computeRow(Object.assign({}, rows[1], { source: 'company', isRepeat: false, referral: false }), 'model');
  check('company-sourced halves the tier', [company.applied, r2(company.base)], [29.375, 881.25]);
  check('flat50', r2(computeRow(rows[1], 'flat50').total), 1500);
  check('revenue plan pays nothing here', computeRow(rows[1], 'revenue').total, 0);
  const sal = computeRow({ tool: 'RTL', amount: 200000, ratePct: 12, points: 2.5, tpoSpread: 0 }, 'salary');
  check('salary plan: 25 bps × 1.2 + (2.5−1.5)/100×amount/2 × 1.2', [sal.applied, r2(sal.base), r2(sal.bonus), r2(sal.total)], [30, 600, 1200, 1800]);
}

// ── Payout state ───────────────────────────────────────────────────────────
check('paid via BILL', payoutState({ billId: 'B1', payStatus: 'PAID', paidAt: '2026-07-01' }), { key: 'paid', label: 'Paid', date: '2026-07-01' });
check('hand-marked paid outside BILL', payoutState({ billId: '', payStatus: 'PAID', paidAt: '2026-05-01' }), { key: 'paid', label: 'Paid (outside BILL)', date: '2026-05-01' });
check('billed, nothing back yet', payoutState({ billId: 'B2', payStatus: '', billedAt: '2026-09-01' }), { key: 'billed', label: 'Billed — awaiting payment', date: '2026-09-01' });
check('scheduled', payoutState({ billId: 'B3', payStatus: 'SCHEDULED', paidAt: '2026-09-20' }).key, 'scheduled');
check('not billed', payoutState({ billId: '', payStatus: '' }).key, 'unbilled');

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
