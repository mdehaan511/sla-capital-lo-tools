/**
 * scripts/ev-pricing-test.mjs — Deploy 237.148
 *
 * Pins deploy/ev-pricing.js to Mike's Eastview workbook ("EV DSCR S Sizer_
 * 09.16.26.xlsx", Silver tier). The first block is the workbook's OWN example
 * loan: every number below was read out of the sheet's cached cells, so a
 * failure here means we drifted from Eastview, not that the test is stale.
 *
 * Run: node scripts/ev-pricing-test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const EV = require('../deploy/ev-pricing.js');

let failures = 0;
const ok = (cond, msg) => { console.log((cond ? '  ok   ' : '  FAIL ') + msg); if (!cond) failures++; };
const near = (a, b, eps = 1e-9) => a != null && Math.abs(a - b) < eps;

const WORKBOOK = {
  fico: 700, purpose: 'purchase', propType: 'sfr', value: 450000, purchasePrice: 450000,
  closingCostPct: 0, loanAmt: 360000, rent: 6500, taxes: 1000, insurance: 291.6666666666667,
  flood: 83.33333333333333, hoa: 0, opex: 0, rate: 6.5, rateType: 'FIXED 30', prepay: 'pp5',
  leased: true, portfolioCount: 1,
};
const w = EV.priceEastview(WORKBOOK);
console.log('— the workbook\'s own example loan —');
ok(w.sizing.maxLoan === 360000, 'max loan 360,000 (80% of 450,000, no deductions)');
ok(near(w.ltv, 0.8), 'as-is LTV 80%');
ok(near(w.pi, 2275.4448845746697, 1e-9), 'monthly P&I 2,275.4449');
ok(near(w.pitia, 3650.4448845746697, 1e-9), 'PITIA 3,650.4449');
ok(w.dscr === 1.78, 'DSCR 1.78');
ok(near(w.selected.price, 0.9726970556411036, 1e-12), 'exit price 0.9726970556411036');
ok(w.bucketLabel === 'FICO: 700 - 719', 'FICO bucket 700-719');
ok(w.eligible, 'every guideline check passes');
ok(near(w.liquidity.total, 111902.66930744801, 1e-6), 'liquidity 111,902.67 (6 payments + down payment)');

console.log('— price build-up —');
const parts = Object.fromEntries(w.selected.parts.map((p) => [p.label.replace(/ @.*/, ''), p.value]));
ok(near(parts['Base price'], 0.9801970556411037), 'base price for a 6.5% coupon');
ok(near(parts['FICO: 700 - 719'], -0.02), 'FICO 700-719 at 80% LTV = −2.000');
ok(near(parts['DSCR 1.15+'], 0.0025), 'DSCR 1.15+ = +0.250');
ok(near(parts['Prepay: 5 Years (5%/4%/3%/2%/1%)'], 0.01), '5-year prepay = +1.000');

console.log('— rate ladder + caps —');
const lad = w.ladder;
ok(lad.length === 25, '25 coupons, 9.000% down to 6.000%');
ok(lad[0].rate === 9 && lad[lad.length - 1].rate === 6, 'ladder runs high rate to low');
const at9 = lad.find((r) => r.rate === 9);
ok(near(at9.price, 1.045), '9% coupon caps at the 104.50 max price for a 5-year prepay');
ok(at9.capped === true, 'the cap is flagged');
const noPP = EV.priceEastview({ ...WORKBOOK, prepay: 'ppNone' });
ok(near(noPP.ladder.find((r) => r.rate === 9).price, 1.02), 'no prepay penalty caps at 102.00');
ok(lad.find((r) => r.rate === 6).belowMin === true, '6% coupon falls below the 96.50 minimum price');

console.log('— adjustments —');
const io = EV.priceEastview({ ...WORKBOOK, interestOnly: true });
ok(near(io.selected.price, w.selected.price - 0.005), 'interest only costs 0.500 at 80% LTV');
ok(near(io.pi, 360000 * 0.065 / 12, 1e-9), 'interest-only payment is interest only');
const condo = EV.priceEastview({ ...WORKBOOK, propType: 'condo' });
ok(near(condo.selected.price, w.selected.price - 0.0075), 'condo costs 0.750 at 80% LTV');
const duplex = EV.priceEastview({ ...WORKBOOK, propType: '2unit' });
ok(near(duplex.selected.price, w.selected.price - 0.005), '2-4 unit costs 0.500 at 80% LTV');
const small = EV.priceEastview({ ...WORKBOOK, value: 180000, purchasePrice: 180000, loanAmt: 144000, rent: 2600 });
ok(small.selected.parts.some((p) => p.label.indexOf('UPB ≤') === 0), 'a small loan picks up the UPB adjustment');
const cashOut = EV.priceEastview({ ...WORKBOOK, purpose: 'refi_co', loanAmt: 0 });
ok(cashOut.sizing.maxLtvPre === 0.75, 'cash out at FICO 700-719 tops out at 75% LTV');
ok(cashOut.selected.parts.some((p) => p.label === 'Cash-out refinance'), 'cash out is priced');

console.log('— leverage grid + deductions —');
const fn = EV.priceEastview({ ...WORKBOOK, fico: 'FN', loanAmt: 0 });
ok(fn.bucket === 'fn' && fn.sizing.maxLtvPre === 0.7, 'foreign national purchase tops out at 70% LTV');
const unleased = EV.priceEastview({ ...WORKBOOK, purpose: 'refi_rt', leased: false, loanAmt: 0 });
ok(near(unleased.sizing.maxLtv, 0.75), 'unleased refinance takes the 5% deduction');
const reno = EV.priceEastview({ ...WORKBOOK, purpose: 'refi_rt', leased: false, recentRenovation: true, loanAmt: 0 });
ok(near(reno.sizing.maxLtv, 0.8), 'recent renovation waives the unleased deduction');
const nwc = EV.priceEastview({ ...WORKBOOK, propType: 'condo', nonWarrantableCondo: true, loanAmt: 0 });
ok(near(nwc.sizing.maxLtv, 0.7), 'non-warrantable condo takes the 10% deduction');
const big5 = EV.priceEastview({ ...WORKBOOK, propType: '5unit', loanAmt: 0 });
ok(near(big5.sizing.maxLtv, 0.75), '5-9 units take the 5% deduction');
ok(big5.units === 5, 'unit count follows the property type');

console.log('— blocked combinations —');
const lowFico = EV.priceEastview({ ...WORKBOOK, fico: 650 });
ok(lowFico.selected.price == null && lowFico.selected.blocked, 'FICO 640-659 has no price at any LTV');
ok(lowFico.checks.some((c) => !c.pass && c.label === 'Minimum FICO 660'), 'and fails the 660 minimum');
const tightFico = EV.priceEastview({ ...WORKBOOK, fico: 670 });
ok(tightFico.selected.price == null, 'FICO 660-679 is not allowed at 80% LTV');
const tightOk = EV.priceEastview({ ...WORKBOOK, fico: 670, loanAmt: 315000 });
ok(tightOk.selected.price != null, 'the same borrower prices at 70% LTV');

console.log('— guideline checks —');
const thin = EV.priceEastview({ ...WORKBOOK, rent: 3400 });
ok(thin.dscr < 1 && thin.dscr > 0.8, 'rent 3,400 lands DSCR between 0.80 and 1.00');
ok(!thin.eligible && thin.checks.some((c) => !c.pass && c.label.indexOf('DSCR not between') === 0), 'which the sheet rejects');
const jumbo = EV.priceEastview({ ...WORKBOOK, value: 3000000, purchasePrice: 3000000, loanAmt: 2400000, rent: 30000 });
ok(!jumbo.eligible && jumbo.checks.some((c) => !c.pass && c.label.indexOf('Loan over $2M') === 0), 'over $2M needs LTV at or below 75%');
const over = EV.priceEastview({ ...WORKBOOK, loanAmt: 400000 });
ok(!over.eligible && over.checks.some((c) => !c.pass && c.label === 'Within max leverage'), 'a loan over the grid max fails');

console.log(failures ? '\n' + failures + ' failure(s)' : '\nall checks pass');
process.exit(failures ? 1 : 0);
