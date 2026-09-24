#!/usr/bin/env node
/**
 * scripts/rtl-reserve-override-test.mjs — Deploy 237.265
 *
 * Carl (2026-09-24): "small cash reserves discrepancy between sizer and terms sheet. Not sure
 * why they are off." On 151 Foothill (RTL light, $245,125, sheet rate 11.00% overridden to
 * 10.85%) the sizer's on-screen Cash Reserve card priced six months of holding at the SHEET
 * rate ($13,482) while the term sheet rescales to the displayed rate ($13,298), and the saved
 * pricing snapshot carried the sheet-rate monthly too.
 *
 * What would hurt, so what this guards (rtl-sizer.html's own functions are lifted and RUN):
 *   1. The on-screen card's holding cost ignoring a rate override (or an amount / DP override).
 *   2. The helper mis-handling the Non-Dutch rehab holdback (start = advance x rate; max = full).
 *   3. The saved snapshot no longer being recomputed at the effective rate, or the PDF's
 *      loan-record path rescaling the rate a second time on such a snapshot.
 *
 * Run: node scripts/rtl-reserve-override-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)));
  if (!ok) fail++;
};
const assert = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fail++; };
const SRC = readFileSync(new URL('../deploy/rtl-sizer.html', import.meta.url), 'utf8');
const lift = (start, end) => { const a = SRC.indexOf(start); if (a < 0) throw new Error('not found: ' + start.slice(0, 50)); const z = SRC.indexOf(end, a + start.length); if (z < 0) throw new Error('end not found after: ' + start.slice(0, 50)); return SRC.slice(a, z + end.length); };
const code = lift('function _rtlEffectiveMonthly(p) {', '\n}\n') + '\n' + lift('function renderReserveCard() {', '\n}\n');
const r2 = (n) => Math.round(n * 100) / 100;

console.log('\nThe helper: monthly figures at the effective rate and amount');
{
  const c = {}; vm.createContext(c); vm.runInContext(code, c);
  const eff = c._rtlEffectiveMonthly;
  check('nothing overridden -> null (callers keep the calc)', eff({ ovRate: null, ovAmt: null, calcRate: 0.11, baseAmt: 245125 }), null);
  let m = eff({ ovRate: 0.1085, ovAmt: null, calcRate: 0.11, baseAmt: 245125, rawMax: 245125, rawAdv: 175125, dutch: true });
  check('Carl: rate override 11.00% -> 10.85% on $245,125, Dutch: max = start = 2,216.34', [r2(m.monthlyMax), r2(m.monthlyStart), m.initialAdvance, m.rate], [2216.34, 2216.34, 175125, 0.1085]);
  m = eff({ ovRate: 0.1085, ovAmt: null, calcRate: 0.11, baseAmt: 245125, rawMax: 245125, rawAdv: 175125, dutch: false });
  check('...Non-Dutch: start on the advance (loan less the $70,000 holdback), max on the full amount', [r2(m.monthlyStart), r2(m.monthlyMax), m.initialAdvance], [1583.42, 2216.34, 175125]);
  m = eff({ ovRate: null, ovAmt: 230000, calcRate: 0.11, baseAmt: 245125, rawMax: 245125, rawAdv: 175125, dutch: false });
  check('amount override only: sheet rate on the new amount, holdback stays a fixed $70,000', [r2(m.monthlyMax), m.initialAdvance, r2(m.monthlyStart)], [2108.33, 160000, 1466.67]);
  m = eff({ ovRate: 0.12, ovAmt: 100000, calcRate: 0.11, baseAmt: 245125, dutch: true });
  check('no holdback data: start = max', [m.monthlyStart === m.monthlyMax, r2(m.monthlyMax)], [true, 1000]);
}

console.log('\nThe on-screen Cash Reserve card');
{
  const els = {
    reserveCard: { style: {} }, reserveCardRows: { innerHTML: '' }, reserveCardTotal: { textContent: '' },
    purchasePrice: { value: '195000' }, rehabBudget: { value: '70000' }, loanType: { value: 'light' }, currentLoanAmt: { value: '' }, brokerFee: { value: '' },
  };
  const run = (overrides) => {
    const c = {
      document: { getElementById: (id) => els[id] || null }, window: {},
      _rtlAdminMode: false, brokerProcFeeAmount: () => 0,
      fmt: (n) => '$' + Math.round(n).toLocaleString('en-US'),
      Math, isFinite, parseFloat, Number, String, Object,
    };
    c.window._rtlLastCalc = { bMax: 245125, rate: 0.11, points: 1.5, monthlyMax: 2246.9791666666665, monthlyStart: 2246.9791666666665, initAdv: 175125, downPayment: 19875, purpose: 'purchase', isDutch: true };
    c.window._rtlOverrides = Object.assign({ rate: null, points: null, loanAmt: null, dp: null }, overrides || {});
    c.window.renderReserveCard = null;
    vm.createContext(c); vm.runInContext(code + '\nrenderReserveCard();', c);
    const rows = els.reserveCardRows.innerHTML;
    const val = (label) => { const m = rows.match(new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '</span><span>([^<]*)</span>')); return m ? m[1] : null; };
    return { ctc: val('Cash to Close'), holding: val('6 Months Holding (Interest × 6)'), rehab: val('20% of Renovation Budget'), total: els.reserveCardTotal.textContent };
  };
  check('no override: the calc\'s own figures (11.00%): $13,482 holding, $53,184 total', run({}), { ctc: '$25,702', holding: '$13,482', rehab: '$14,000', total: '$53,184' });
  check('Carl\'s rate override to 10.85%: $13,298 holding, $53,000 total -- what the term sheet prints', run({ rate: 0.1085, points: 1.5 }), { ctc: '$25,702', holding: '$13,298', rehab: '$14,000', total: '$53,000' });
  check('an amount override moves the holding cost with the amount', run({ loanAmt: 230000 }).holding, '$12,650');
}

console.log('\nThe saved snapshot and the PDF');
{
  assert('the save recomputes the snapshot\'s monthly figures through the helper whenever the rate or the amount is overridden, and marks it', /var _effMS = _rtlEffectiveMonthly\(\{[\s\S]*?ovRate: _ovM\.rate,[\s\S]*?dutch: formData\.dutchInterest === 'dutch',[\s\S]*?snapshot\.monthlyMax = _effMS\.monthlyMax;\s*snapshot\.monthlyStart = _effMS\.monthlyStart;\s*snapshot\.initialAdvance = _effMS\.initialAdvance;\s*snapshot\.monthlyAtEffective = true;/.test(SRC));
  assert('the PDF\'s loan-record path does not rescale the rate again on such a snapshot', /var _moScale = _snap\.monthlyAtEffective\s*\?\s*\(bMaxNum \/ \(\(typeof _snap\.maxLoan === 'number' && _snap\.maxLoan > 0\) \? _snap\.maxLoan : bMaxNum\)\)\s*:\s*\(bMaxNum \/ _rawLoan\) \* \(_corrRate \/ _rawRate\);/.test(SRC));
  assert('the PDF\'s live path still rescales to the displayed rate (unchanged)', /var _scL = \(bMaxNum \/ _rawLoanL\) \* \(_corrRateL \/ _rawRateL\);/.test(SRC));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
