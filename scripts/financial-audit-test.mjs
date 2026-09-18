/**
 * scripts/financial-audit-test.mjs — Deploy 237.135
 * Pins the Financial Audit money-movement rules (_shared/financial-audit.mjs).
 * Run: node scripts/financial-audit-test.mjs
 */
import { buildLedger, fundingTypeOf, normalizeState, prepaidInterestOf, weekEndOf, fundingLabelOf, ppiCollectedAtClosing }
  from '../deploy/netlify/functions/_shared/financial-audit.mjs';

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };
const NOW = Date.parse('2026-09-17T18:00:00Z');
const base = (o) => Object.assign({ status: 'closed', toolType: 'rtl', loanAmt: 200000, points: '2', rehabBudget: 50000,
  fundingDate: '2026-09-10', address: '1 Main St', _clientId: 'c', _owner: 'lo@x.com', _borrower: 'B LLC' }, o);
const accounts = [
  { id: 'a1', name: 'SLA Funding', last4: '1111', entity: 'sla', roles: ['funding', 'draws', 'trades', 'payoffs'] },
  { id: 'a2', name: 'SLA Operating', last4: '2222', entity: 'sla', roles: ['fees', 'broker'] },
  { id: 'a3', name: 'KAF 1', last4: '3333', entity: 'kaf', roles: [] },
];
const find = (rows, key) => rows.find((r) => r.key === key);

// Classification
ok(fundingTypeOf(base({ fundingSource: 'king_arthur' })) === 'kaf', 'Funding Source KAF -> KAF funded');
ok(fundingTypeOf(base({ fundingSource: 'sla_capital', assignedToEntity: 'King Arthur Fund 1' })) === 'sla_to_kaf', 'SLA source + assigned to KAF -> SLA to KAF');
ok(fundingTypeOf(base({ investorName: 'King Arthur Fund 1 LLC' })) === 'sla_to_kaf', 'legacy loan held by KAF -> SLA to KAF');
ok(fundingTypeOf(base({ investorName: 'Colchis' })) === 'sla', 'legacy loan sold to Colchis -> SLA funded');
ok(fundingTypeOf(base({ toolType: 'dscr' })) === 'dscr', 'DSCR -> investor funded');
ok(fundingTypeOf(base({}), 'kaf') === 'kaf', 'override wins');

// SLA funded, gross
let st = normalizeState({ accounts });
let { rows } = buildLedger([base({ id: 'L1', closingFees: '1000', brokerFee: '1', brokerName: 'Bob' })], null, st, NOW);
let fund = find(rows, 'L1:fund');
ok(fund && fund.amount === 150000 && fund.flow === 'out' && fund.from.accountId === 'a1', 'closing wire = loan - holdback, out of SLA Funding');
ok(find(rows, 'L1:fees').amount === 5000 && find(rows, 'L1:fees').to.accountId === 'a2', 'points + fees = 4000 + 1000 into SLA Operating');
ok(find(rows, 'L1:broker').amount === 2000 && find(rows, 'L1:broker').to.label === 'Bob', 'broker fee 1 pt = 2000');
ok(find(rows, 'L1:broker').canHud && !find(rows, 'L1:broker').onHud, 'a broker fee offers the paid-on-HUD box, off by default'); // Deploy 237.143
{
  const hudSt = normalizeState({ accounts, loanOverrides: { L1: { brokerOnHud: true } } });
  const hud = find(buildLedger([base({ id: 'L1', brokerFee: '1', brokerName: 'Bob' })], null, hudSt, NOW).rows, 'L1:broker');
  ok(hud.onHud && hud.status === 'settled', 'paid on HUD: settled at closing, nothing to match in the bank');
  ok(hud.amount === 2000, 'the fee still shows \u2014 marking it off the HUD does not hide what was paid');
}
ok(find(rows, 'L1:fund').status === 'overdue', 'past + unverified = overdue');

// Net funded toggle
st = normalizeState({ accounts, loanOverrides: { L1: { net: true } } });
({ rows } = buildLedger([base({ id: 'L1', closingFees: '1000' })], null, st, NOW));
ok(find(rows, 'L1:fund').amount === 145000 && !find(rows, 'L1:fees'), 'net funded: one wire net of points + fees, no fees row');

// SLA -> KAF assignment + 24h flag
st = normalizeState({ accounts });
({ rows } = buildLedger([base({ id: 'L2', fundingSource: 'sla_capital', assignedToEntity: 'King Arthur Fund 1', closedAt: '2026-09-15T20:00:00Z' })], null, st, NOW));
const asg = find(rows, 'L2:assign');
ok(asg && asg.amount === 200000 && asg.flow === 'transfer' && asg.from.accountId === 'a3' && asg.to.accountId === 'a1', 'assignment: full loan amount KAF -> SLA');
ok(asg.late24h === true, 'assignment unverified > 24h after close is late');
st = normalizeState({ accounts, verifications: { 'L2:assign': { amount: 200000, date: '2026-09-15', expected: 200000 } } });
({ rows } = buildLedger([base({ id: 'L2', fundingSource: 'sla_capital', assignedToEntity: 'King Arthur Fund 1', closedAt: '2026-09-15T20:00:00Z' })], null, st, NOW));
ok(find(rows, 'L2:assign').status === 'verified' && !find(rows, 'L2:assign').late24h, 'verified assignment is not late');

// Changed after verify
st = normalizeState({ accounts, verifications: { 'L1:fund': { amount: 150000, date: '2026-09-10', expected: 150000 } } });
({ rows } = buildLedger([base({ id: 'L1', loanAmt: 210000 })], null, st, NOW));
ok(find(rows, 'L1:fund').status === 'changed', 'expected amount moved after verification -> changed');

// Draws + grouped trade (Colchis one wire) + no payoff after a sale
const draws = { 'SLA-1': { draws: [
  { id: 9, status: 'approved', approvedCents: 1000000, updatedAt: '2026-08-20T00:00:00Z' },
  { id: 10, status: 'approved', approvedCents: 500000, updatedAt: '2026-09-05T00:00:00Z' },
  { id: 11, status: 'drafting', approvedCents: 0, updatedAt: '2026-09-06T00:00:00Z' },
] } };
st = normalizeState({ accounts });
({ rows } = buildLedger([
  base({ id: 'T1', slaDisplayId: 'SLA-1', fundingDate: '2026-08-01', disposition: 'sold', investorName: 'Colchis', soldDate: '2026-09-01', payoffDate: '2026-09-12', payoffAmount: 100 }),
  base({ id: 'T2', fundingDate: '2026-08-02', disposition: 'sold', investorName: 'Colchis (RTL)', soldDate: '2026-09-01', upb: '160000' }),
  base({ id: 'T3', fundingDate: '2026-08-03', disposition: 'sold', investorName: 'CorrFirst', soldDate: '2026-09-01' }),
], draws, st, NOW));
ok(!!find(rows, 'T1:draw:9') && !find(rows, 'T1:draw:10') && !find(rows, 'T1:draw:11'), 'approved draws before the sale only');
const grp = find(rows, 'trade:2026-09-01:colchis:sla');
ok(grp && grp.loans.length === 2 && grp.amount === 160000 + 160000, 'Colchis loans sold the same day = one wire (UPB 150k+10k draw, 160k on file)');
ok(!!find(rows, 'trade:2026-09-01:corrfirst:sla'), 'another buyer gets its own wire');
ok(!find(rows, 'T1:payoff'), 'no payoff row once the loan was sold');

// KAF held payoff
({ rows } = buildLedger([base({ id: 'P1', fundingSource: 'king_arthur', disposition: 'paid_off', payoffDate: '2026-09-12', payoffAmount: '201000' })], null, st, NOW));
ok(find(rows, 'P1:payoff').to.accountId === 'a3' && find(rows, 'P1:fund').from.accountId === 'a3', 'KAF funded: wire out of + payoff into KAF');

// DSCR
({ rows } = buildLedger([base({ id: 'D1', toolType: 'dscr', points: '1', tpo: '1.5', investorName: 'DIYA', closingFees: '2395' })], null, st, NOW));
ok(rows.length === 1 && rows[0].kind === 'dscr_comp' && rows[0].amount === 2000 + 3000 + 2395, 'DSCR: points + TPO + fees in, nothing out');

// Pipeline forecast
({ rows } = buildLedger([base({ id: 'F1', status: 'approved', processingStage: 'processing', fundingDate: '2026-09-25' })], null, st, NOW));
ok(find(rows, 'F1:fund').forecast && find(rows, 'F1:fund').status === 'upcoming', 'pipeline loan = upcoming forecast');
({ rows } = buildLedger([base({ id: 'F2', status: 'on_hold', processingStage: 'processing', fundingDate: '2026-09-25' })], null, st, NOW));
ok(!rows.length, 'on-hold loans are not forecast');

// Manual entry
st = normalizeState({ accounts, manual: [{ id: 'm1', date: '2026-09-14', amount: 50000, fromLabel: 'KAF investor', toAccountId: 'a3', memo: 'Capital call' }] });
({ rows } = buildLedger([], null, st, NOW));
ok(rows.length === 1 && rows[0].flow === 'in' && rows[0].to.last4 === '3333', 'manual capital call into KAF');


// ── Deploy 237.141 — the tab data (Closings / Trades / Payoffs / Draws) ──────
// Prepaid interest: loan x rate / 365 x days from funding through month end, the
// same formula the UW tab uses (loan-uw-calc.js).
ok(prepaidInterestOf({ loanAmt: 200000, rate: 10.95, fundingDate: '2026-09-10' }) === 1260, 'PPI = 200k x 10.95% / 365 x 21 days = $1,260');
ok(prepaidInterestOf({ loanAmt: 200000, rate: 0.1095, fundingDate: '2026-09-10' }) === 1260, 'PPI takes a rate stored as a fraction too');
ok(prepaidInterestOf({ loanAmt: 200000, rate: 10.95, fundingDate: '2026-09-30' }) === 60, 'closing on the last day = one day of interest');
ok(prepaidInterestOf({ loanAmt: 200000, fundingDate: '2026-09-10' }) === 0, 'no rate on file = no PPI guessed');
ok(ppiCollectedAtClosing('sla') && ppiCollectedAtClosing('kaf') && ppiCollectedAtClosing('sla_to_kaf') &&
   !ppiCollectedAtClosing('stride') && !ppiCollectedAtClosing('dscr'),
   "PPI is collected at the table on SLA + KAF funded only (the sheet's note)");

// Mike: draw reimbursements "occur at the end of the week that draws are approved".
ok(weekEndOf('2026-09-14') === '2026-09-18', 'a Monday draw is reimbursed that Friday');
ok(weekEndOf('2026-09-18') === '2026-09-18', 'a Friday draw is reimbursed the same day');
ok(weekEndOf('2026-09-19') === '2026-09-25', 'a Saturday draw rolls to the next Friday');

ok(fundingLabelOf(base({ toolType: 'rtl' }), 'stride') === 'RTL - Stride' &&
   fundingLabelOf(base({ toolType: 'dscr', investorName: 'DIYA' }), 'dscr') === 'DSCR - DIYA' &&
   fundingLabelOf(base({ toolType: 'rtl' }), 'sla_to_kaf') === 'RTL - KAF',
   "Loan Type - Funding Source reads like the sheet");

// The closings table
st = normalizeState({ accounts });
let built = buildLedger([base({ id: 'C1', fundingSource: 'sla_capital', rate: 10.95, closingFees: '1000', slaDisplayId: 'SLA-1' })], null, st, NOW);
let c1 = built.closings[0];
ok(built.closings.length === 1 && c1.slaNumber === 'SLA-1' && c1.fundingLabel === 'RTL - SLA', 'one closing row per closed loan');
ok(c1.originationFee === 4000 && c1.otherFees === 1000 && c1.rehabFunds === 50000, 'origination = points in dollars, other fees + rehab split out');
ok(c1.initialAdvance === 150000, 'initial advance = loan less the rehab holdback');
ok(buildLedger([base({ id: 'C1b', initialAdvance: '142500' })], null, st, NOW).closings[0].initialAdvance === 142500,
   'an initial advance entered on the Loan Terms tab wins over the derived one');
ok(c1.ppiCollected && c1.prepaidInterest === 1260 && c1.totalCollected === 6260,
   'SLA funded: Total Collected = origination + other fees + PPI');
built = buildLedger([base({ id: 'C2', fundingSource: 'stride', rate: 10.95, closingFees: '1000' })], null, st, NOW);
ok(!built.closings[0].ppiCollected && built.closings[0].totalCollected === 5000,
   'Stride: PPI is net funded, so it is shown but left out of Total Collected');
built = buildLedger([base({ id: 'C3', fundingSource: 'sla_capital', assignedToEntity: 'King Arthur Fund 1', rate: 10.95, closingFees: '1000' })], null, st, NOW);
ok(built.closings[0].kaf && built.closings[0].kaf.upb === 150000 && built.closings[0].kaf.remainingHoldback === 50000 &&
   built.closings[0].kaf.total === 6260, 'an SLA -> KAF assignment fills the Trades to KAF block');
ok(!buildLedger([base({ id: 'C4' })], null, st, NOW).closings[0].kaf, 'a loan SLA keeps has no KAF transfer block');
ok(!buildLedger([base({ id: 'C5', status: 'approved', processingStage: 'processing', fundingDate: '2026-09-25' })], null, st, NOW).closings.length,
   'a loan still in the pipeline is not a closing yet');

// Draw reimbursement: only when the party fronting the draw is not the holder.
const drawCache = { 'SLA-1': { draws: [{ id: 'd1', number: 1, name: 'Draw 1', status: 'approved', approvedCents: 2500000, updatedAt: '2026-09-14' }] } };
built = buildLedger([base({ id: 'D1', slaDisplayId: 'SLA-1', fundingSource: 'stride' })], drawCache, st, NOW);
const reimb = built.rows.find((r) => r.kind === 'draw_reimb');
ok(built.rows.some((r) => r.kind === 'draw' && r.amount === 25000), 'the draw itself goes out');
ok(reimb && reimb.amount === 25000 && reimb.date === '2026-09-18', 'Stride reimburses the draw that Friday');
ok(reimb && reimb.from.entity === 'stride' && reimb.to.entity === 'sla', 'the line pays SLA back');
built = buildLedger([base({ id: 'D2', slaDisplayId: 'SLA-1', fundingSource: 'sla_capital' })], drawCache, st, NOW);
ok(!built.rows.some((r) => r.kind === 'draw_reimb'), 'a loan SLA funds and holds has nothing to reimburse');

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall checks pass');
process.exit(failures ? 1 : 0);
