#!/usr/bin/env node
/**
 * scripts/prepaid-interest-fees-test.mjs — Deploy 237.255 (Mike)
 *
 * "In closing tabs in Fee/Cash to close we need to add the Prepaid interest which should be
 * the daily interest on a 30/365 method from the closing date to the end of the closing
 * month. This changes if the closing date changes."
 *
 * The functions live in deploy/loan-details.js (browser ES5); they are lifted by name and
 * run, so the page and this gate cannot drift. What would hurt:
 *   - the wrong day count or the wrong year (it is the 30-day month count the Loan Terms
 *     card already uses, on a 365-day year -- NOT the card's 30/360 figure);
 *   - a Cash to Close that does not include it, or a Cash Reserve that does not;
 *   - a card that does not follow the Closing Date.
 *
 * Run: node scripts/prepaid-interest-fees-test.mjs
 */
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../deploy/loan-details.js', import.meta.url), 'utf8');
function extract(name) {
  const start = src.indexOf('function ' + name + '(');
  if (start < 0) throw new Error('function ' + name + ' not found');
  let i = src.indexOf('{', start), depth = 0;
  for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); } }
  throw new Error('unbalanced ' + name);
}
const flat = src.match(/var LD_RTL_FLAT_FEES = \[[\s\S]*?\];/)[0];
const names = ['_ldParseYmd', '_ldDrawsNum', '_ldRatePctOf', '_days30360ToNextFirst', '_isGucLoan', '_ldMoney2', '_ldPrepaidInterest30365', '_fmtMoney0', '_feeRow', '_feesReserveParts', 'escH'];
const stubs = `
  var window = {};
  function _ldRehabHoldback(l) { return (l && l.rehabBudget) || 0; }
`;
const fns = new Function(flat + '\n' + stubs + names.map(extract).join('\n') + '\nreturn { ' + names.join(', ') + ' };')();
const { _days30360ToNextFirst: days, _ldPrepaidInterest30365: prepaid, _feesReserveParts: parts } = fns;

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const r2 = (n) => Math.round(n * 100) / 100;
const rowAmt = (html, label) => { const m = html.match(new RegExp('<span class="fee-lbl">' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[^<]*</span><span class="fee-amt">([^<]*)</span>')); return m ? m[1] : null; };
const rowLbl = (html, prefix) => { const m = html.match(new RegExp('<span class="fee-lbl">(' + prefix + '[^<]*)</span>')); return m ? m[1] : null; };

console.log('\nThe day count: the closing day through the end of that month, 30-day months');
check('Sept 23 → 8 days (23rd through the 30th)', days('2026-09-23'), 8);
check('closing on the 1st → the whole month, 30', days('2026-10-01'), 30);
check('closing on the 30th → 1', days('2026-09-30'), 1);
check('the 31st counts as the 30th → 1', days('2026-01-31'), 1);
check('no date → 0', days(''), 0);

console.log('\nThe daily rate is on a 365-day year');
{
  const jeremy = { loanAmt: '281200', rate: '7.250', toolType: 'dscr', fundingDate: '2026-09-23' };
  const p = prepaid(jeremy, '2026-09-23', '');
  check('$281,200 at 7.250%: $55.85 a day, 8 days, $446.84', [r2(p.daily), p.days, r2(p.prepaid), p.hasDate, p.dutch], [55.85, 8, 446.84, true, true]);
  check('...which is NOT the Loan Terms card\'s 30/360 daily ($56.63)', r2(281200 * 0.0725 / 360), 56.63);
  const rtl = { loanAmt: '206000', rate: '10.500', toolType: 'rtl', rehabBudget: '89000', dutchInterest: 'non_dutch' };
  const q = prepaid(rtl, '2026-10-01', '');
  check('Non-Dutch: on the initial advance (loan less the holdback), 30 days', [q.base, r2(q.daily), q.days, r2(q.prepaid)], [117000, 33.66, 30, 1009.73]);
  check('the live structure select wins over the loan on file', prepaid(rtl, '2026-10-01', 'dutch').base, 206000);
  check('the card\'s own amount and rate win over the loan record (still less the holdback when Non-Dutch)', [prepaid(rtl, '2026-10-01', '', 250000, 12).base, r2(prepaid(rtl, '2026-10-01', '', 250000, 12).daily)], [161000, 52.93]);
  check('...and on the full amount when Dutch', prepaid(rtl, '2026-10-01', 'dutch', 250000, 12).base, 250000);
  check('a rate stored as a decimal (0.105) is 10.5%', r2(prepaid({ loanAmt: '100000', rate: '0.105' }, '2026-10-01', '').daily), 28.77);
  check('no closing date: nothing to prepay, and says so', [prepaid(jeremy, '', '').prepaid, prepaid(jeremy, '', '').hasDate], [0, false]);
}

console.log('\nThe Fees / Cash to Close card');
{
  const l = { loanAmt: '281200', rate: '7.250', toolType: 'dscr', fundingDate: '2026-09-23', investorName: 'DIYA' };
  const base = { loanAmt: 281200, ratePct: 7.25, pointsNum: 2, rehab: 0, downPayment: 70300, currentLoanAmt: 0, brokerFeePts: 0, isRefi: false };
  const dscr = parts(l, true, base);
  check('the line is on the card, labelled with the days and the method', rowLbl(dscr.fees, 'Prepaid Interest'), 'Prepaid Interest (8 days · 30/365)');
  check('...with the amount', rowAmt(dscr.fees, 'Prepaid Interest'), '$447');
  // origination 2 pts = 5,624 + flat 995+700+500+200 = 2,395 → 8,019 + 447 = 8,466 ; cash to close = 70,300 + 8,466
  check('Total Fees includes it', rowAmt(dscr.fees, 'Total Fees'), '$8,466');
  check('Estimated Cash to Close includes it', rowAmt(dscr.fees, 'Estimated Cash to Close'), '$78,766');
  check('the note names the daily figure', /Prepaid interest is the daily interest \(30\/365\) from the Closing Date through the end of that month — \$55\.85 a day\./.test(dscr.fees), true);
  check('no Cash Reserve card on DSCR', dscr.reserve, '');

  // the Closing Date moves → the line moves (this is what the live redraw passes)
  const moved = parts(l, true, Object.assign({}, base, { closingYmd: '2026-10-01' }));
  check('close on the 1st instead: 30 days', [rowLbl(moved.fees, 'Prepaid Interest'), rowAmt(moved.fees, 'Prepaid Interest'), rowAmt(moved.fees, 'Total Fees')], ['Prepaid Interest (30 days · 30/365)', '$1,676', '$9,695']);
  const none = parts(l, true, Object.assign({}, base, { closingYmd: '' }));
  check('no Closing Date yet: the line asks for one and adds nothing', [rowLbl(none.fees, 'Prepaid Interest'), rowAmt(none.fees, 'Prepaid Interest'), rowAmt(none.fees, 'Total Fees')], ['Prepaid Interest (set the Closing Date)', '$0', '$8,019']);

  // RTL: the Cash Reserve's Cash to Close carries it too
  const rtl = { loanAmt: '206000', rate: '10.500', toolType: 'rtl', loanType: 'light', rehabBudget: '89000', fundingDate: '2026-10-01' };
  const r = parts(rtl, false, { loanAmt: 206000, ratePct: 10.5, pointsNum: 2, rehab: 89000, downPayment: 23000, currentLoanAmt: 0, brokerFeePts: 0, isRefi: false });
  // dutch (default on RTL): 206000*.105/365*30 = 1777.81 ; fees 4120 + 2150 + 1778 = 8048 ; ctc = 23000 + 8048 = 31048
  check('RTL: on the full note when Dutch, 30 days', [rowLbl(r.fees, 'Prepaid Interest'), rowAmt(r.fees, 'Prepaid Interest'), rowAmt(r.fees, 'Total Fees'), rowAmt(r.fees, 'Estimated Cash to Close')], ['Prepaid Interest (30 days · 30/365)', '$1,778', '$8,048', '$31,048']);
  check('...and the Cash Reserve starts from that Cash to Close', rowAmt(r.reserve, 'Cash to Close'), '$31,048');
  const nd = parts(rtl, false, { loanAmt: 206000, ratePct: 10.5, pointsNum: 2, rehab: 89000, downPayment: 23000, currentLoanAmt: 0, brokerFeePts: 0, isRefi: false, dutchVal: 'non_dutch' });
  check('the live Non-Dutch selection: on the initial advance ($1,010)', rowAmt(nd.fees, 'Prepaid Interest'), '$1,010');
  check('unpriced loan: no card at all, as before', parts({}, true, { loanAmt: 0, ratePct: 0 }), { fees: '', reserve: '' });
}

console.log('\nThe page keeps it live');
check('the Closing Date / structure change redraws the card', /_ldRefreshInterestFields\(\);[^\n]*\n\s*_ldRefreshFeesCard\(\);/.test(src), true);
check('the redraw reads the live Closing Date and structure', /p\.closingYmd = _ldVal\('af-fundingDate'\);\s*\n\s*p\.dutchVal = \(document\.getElementById\('lt-dutchInterest'\)/.test(src), true);
check('the card remembers what it was drawn from', /_ldFeesCtx = \{ l: l, isDscr: isDscr, p: p \};/.test(src), true);

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
