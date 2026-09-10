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
const { tierBps, tierScheduleFor, computeRow, buildRows, payoutState, marginOf, clientIsBrokerFor, repeatKeyOf, buildPendingRows, isPendingApproved, todayISO } = C;

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
// Deploy 236.963 — Mike: "10.5 and 1.5 base ... change it to 10% 1.5 points then its 1 point for the comp multiplier"
check('RTL sold UNDER the sizer base: 10.0 vs 10.5 at 1.5 pts → margin 1.0 (35 bps), not floored', (() => { const m = marginOf({ toolType: 'rtl', points: 1.5, rate: 0.10, _pricingOverrideOriginal: { rate: 0.105 } }); return [Math.round(m.margin * 100) / 100, m.parts, tierBps(m.margin, '2026-09-15')]; })(), [1, '1.50 pts − 0.50 under sizer base', 35]);
check('RTL sold OVER the sizer base still adds', marginOf({ toolType: 'rtl', points: 1.5, rate: 0.11, _pricingOverrideOriginal: { rate: 0.105 } }).parts, '1.50 pts + 0.50 over sizer base');

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

// ── Repeat detection vs brokers (236.953) ──────────────────────────────────
{
  const broker = { id: 'b1', email: 'tanner@brokerage.com', firstName: 'Tanner', lastName: 'Broker', _isBroker: true, loans: [
    { id: 'k1', status: 'closed', fundingDate: '2026-03-01', address: 'A', toolType: 'rtl', loanAmt: 100000, points: 2, borrowerName: 'Ann One', borrowerEmail: 'ann@one.com' },
    { id: 'k2', status: 'closed', fundingDate: '2026-05-01', address: 'B', toolType: 'rtl', loanAmt: 100000, points: 2, borrowerName: 'Bob Two', borrowerEmail: 'bob@two.com' },
    { id: 'k3', status: 'closed', fundingDate: '2026-08-01', address: 'C', toolType: 'rtl', loanAmt: 100000, points: 2, borrowerName: 'Ann One', borrowerEmail: 'ANN@one.com' },
    { id: 'k4', status: 'closed', fundingDate: '2026-08-15', address: 'D', toolType: 'rtl', loanAmt: 100000, points: 2 },   // no borrower on file
  ] };
  const direct = { id: 'c9', email: 'ann@one.com', firstName: 'Ann', lastName: 'One', loans: [
    { id: 'k5', status: 'closed', fundingDate: '2026-09-01', address: 'E', toolType: 'rtl', loanAmt: 100000, points: 2 },
  ] };
  const rs = buildRows({ 'carl.davis@slacapital.com': [broker, direct] });
  const byId = {}; rs.forEach((r) => { byId[r.loanId] = r; });
  check('broker record is recognised as a broker', [clientIsBrokerFor(broker, broker.loans[0]), clientIsBrokerFor(direct, direct.loans[0])], [true, false]);
  check('a client whose email equals the loan brokerEmail acts as a broker too', clientIsBrokerFor({ email: 'x@y.com' }, { brokerEmail: 'X@Y.com' }), true);
  check('repeat key = the borrower on the loan for broker deals, the client email otherwise', [repeatKeyOf(broker, broker.loans[0]), repeatKeyOf(direct, direct.loans[0])], ['ann@one.com', 'ann@one.com']);
  check('two DIFFERENT borrowers through the same broker are NOT repeats', [byId.k1.isRepeat, byId.k2.isRepeat], [false, false]);
  check('the same borrower back through the broker IS a repeat (case-insensitive)', byId.k3.isRepeat, true);
  check('a broker deal with no borrower on file is never a repeat', byId.k4.isRepeat, false);
  check('the same borrower later on their own direct record is a repeat', byId.k5.isRepeat, true);
  check('broker-deal rows name the borrower, not the broker', [byId.k1.borrower, byId.k1.viaBroker, byId.k5.borrower], ['Ann One (via broker)', true, 'Ann One']);
  const other = buildRows({ 'carl.davis@slacapital.com': [{ id: 'c1', email: 'z@z.com', loans: [{ id: 'm1', status: 'closed', fundingDate: '2026-01-01', loanAmt: 1, toolType: 'dscr' }] }],
                            'sara.s@slacapital.com':     [{ id: 'c2', email: 'z@z.com', loans: [{ id: 'm2', status: 'closed', fundingDate: '2026-06-01', loanAmt: 1, toolType: 'dscr' }] }] });
  check('repeat is per LO: the same borrower closing with a DIFFERENT LO is that LO\'s first', other.map((r) => r.isRepeat), [false, false]);
}

// ── Pending commissions (236.960) ──────────────────────────────────────────
{
  const mk = (id, extra) => Object.assign({ id, address: id, toolType: 'dscr', loanAmt: 100000, points: 1, tpoSpread: 1.5 }, extra);
  check('approved + no stage → pending', isPendingApproved(mk('a', { status: 'approved' })), true);
  check('processing stages → pending', ['new_loan', 'processing', 'underwriting', 'pp_approved'].map((s) => isPendingApproved(mk('b', { status: 'approved', processingStage: s }))), [true, true, true, true]);
  check('closed / pp_closed / disposition → NOT pending', [isPendingApproved(mk('c', { status: 'closed' })), isPendingApproved(mk('c', { status: 'approved', processingStage: 'pp_closed' })), isPendingApproved(mk('c', { status: 'approved', disposition: 'sold' }))], [false, false, false]);
  check('on hold / denied / cancelled / active / submitted → NOT pending', ['on_hold', 'denied', 'cancelled', 'active', 'submitted'].map((s) => isPendingApproved(mk('d', { status: s }))), [false, false, false, false, false]);
  const book = { 'sara.s@slacapital.com': [
    { id: 'c1', email: 'ann@one.com', firstName: 'Ann', lastName: 'One', loans: [
      mk('closed1', { status: 'closed', fundingDate: '2026-06-02', finalLoanAmount: 250000 }),
      mk('pend1', { status: 'approved', processingStage: 'underwriting', loanAmt: 200000, expectedCloseDate: '2026-10-15' }),
    ] },
    { id: 'c2', email: 'bob@two.com', firstName: 'Bob', lastName: 'Two', loans: [
      mk('pend2', { status: 'approved', loanAmt: 300000, commissionReferral: 'yes' }),
      mk('hold', { status: 'on_hold', loanAmt: 1 }),
    ] },
  ] };
  const pend = buildPendingRows(book);
  const byId = {}; pend.forEach((r) => { byId[r.loanId] = r; });
  check('only approved-not-closed loans become pending rows', pend.map((r) => r.loanId).sort(), ['pend1', 'pend2']);
  check('pending rows are flagged and carry the stage label', [byId.pend1.pending, byId.pend1.stage, byId.pend2.stage], [true, 'Underwriting', 'Approved']);
  check('closeDate = expected close date, else today (tier schedule in force at closing)', [byId.pend1.closeDate, byId.pend2.closeDate === todayISO()], ['2026-10-15', true]);
  check('amount = loanAmt (nothing final yet)', [byId.pend1.amount, byId.pend2.amount], [200000, 300000]);
  check('repeat = the borrower already CLOSED with this LO', [byId.pend1.isRepeat, byId.pend2.isRepeat], [true, false]);
  check('no payout stamps on a pending row', [byId.pend1.billId, byId.pend1.payStatus, payoutState(byId.pend1).key], ['', '', 'unbilled']);
  const c1 = computeRow(byId.pend1, 'model');
  check('pending row prices on the NEW schedule: margin 2.5 → 58.75 bps + $250 repeat', [c1.tier, r2(c1.base), c1.bonus, r2(c1.total)], [58.75, 1175, 250, 1425]);
  check('closed rows still come only from buildRows', buildRows(book).map((r) => r.loanId), ['closed1']);
}

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
