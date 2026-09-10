/**
 * scripts/comp-sizer-test.mjs — Deploy 236.960
 *
 * Gate for the sizers' "Your expected commission" box (deploy/lo-comp-sizer.js):
 * the row it builds from a sizer's stashes must be the row lo-commissions.html
 * builds from the same loan once it closes, so both pages quote one number.
 *
 * Run: node scripts/comp-sizer-test.mjs
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../deploy/lo-comp.js');
const S = require('../deploy/lo-comp-sizer.js');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const r2 = (n) => Math.round(n * 100) / 100;

console.log('sizer comp box gate\n');

// ── rowFrom: DSCR (points + TPO), RTL (points + markup over the engine rate) ─
const d = S.rowFrom({ tool: 'dscr', amount: 300000, ratePct: 7.205, basePct: 7.205, points: 1, tpoSpread: 1.5 });
check('DSCR margin = points + TPO spread', [d.tool, d.amount, d.points, d.tpoSpread, d.margin], ['DSCR', 300000, 1, 1.5, 2.5]);
check('DSCR closeDate defaults to today → the schedule in force now', d.closeDate, C.todayISO());
const rtl = S.rowFrom({ tool: 'rtl', amount: 500000, ratePct: 0.1125, basePct: 0.11, points: 2 });
check('RTL: decimal rates normalized, margin = points + (rate − engine base)', [rtl.ratePct, r2(rtl.margin), rtl.marginParts], [11.25, 2.25, '2.00 pts + 0.25 over sizer base']);
const flat = S.rowFrom({ tool: 'guc', amount: 500000, ratePct: 0.11, basePct: 0.11, points: 2 });
check('RTL at the engine rate: no markup, says so', [flat.margin, flat.marginParts], [2, '2.00 pts (at the sizer rate — no markup)']);
check('a rate BELOW the engine rate never produces a negative markup', S.rowFrom({ tool: 'rtl', amount: 1, ratePct: 0.105, basePct: 0.11, points: 2 }).margin, 2);
check('source / referral stamps pass through; repeat is never guessed', (() => { const r = S.rowFrom({ tool: 'dscr', amount: 1, points: 1, tpoSpread: 1, source: 'company', referral: true }); return [r.source, r.referral, r.isRepeat]; })(), ['company', true, false]);

// ── summarize = computeRow on that row: same number as the commissions page ─
{
  const sizer = S.summarize({ tool: 'dscr', amount: 300000, ratePct: 7.2, basePct: 7.2, points: 1, tpoSpread: 1.5 }, 'model').calc;
  const page = C.computeRow(C.buildRows({ 'lo@slacapital.com': [{ id: 'c', email: 'b@x.com', loans: [
    { id: 'l', status: 'closed', fundingDate: C.todayISO(), toolType: 'dscr', loanAmt: 300000, rate: 7.2, points: 1, tpoSpread: 1.5 },
  ] }] })[0], 'model');
  check('model, DSCR 300k @ 1 pt + 1.5 TPO: sizer box == commissions page (58.75 bps → $1,762.50)', [sizer.tier, r2(sizer.total), r2(page.total)], [58.75, 1762.5, 1762.5]);
}
{
  const sizer = S.summarize({ tool: 'rtl', amount: 500000, ratePct: 0.1125, basePct: 0.11, points: 2 }, 'model').calc;
  const page = C.computeRow(C.buildRows({ 'lo@slacapital.com': [{ id: 'c', email: 'b@x.com', loans: [
    { id: 'l', status: 'closed', fundingDate: C.todayISO(), toolType: 'rtl', loanAmt: 500000, rate: 0.1125, points: 2, _pricingOverrideOriginal: { rate: 0.11 } },
  ] }] })[0], 'model');
  check('model, RTL 500k @ 2 pts sold 11.25 over an 11.00 engine rate: sizer box == commissions page (58.75 bps)', [sizer.tier, r2(sizer.total), r2(page.total)], [58.75, 2937.5, 2937.5]);
}
check('company-sourced halves the tier', r2(S.summarize({ tool: 'dscr', amount: 300000, points: 1, tpoSpread: 1.5, source: 'company' }, 'model').calc.total), 881.25);
check('flat50', r2(S.summarize({ tool: 'dscr', amount: 300000, points: 1, tpoSpread: 1 }, 'flat50').calc.total), 1500);
check('salary (Jeremy): RTL 200k @ 12% / 2.5 pts → 25 bps × 1.2 + point split × 1.2', (() => { const c = S.summarize({ tool: 'rtl', amount: 200000, ratePct: 0.12, basePct: 0.12, points: 2.5 }, 'salary').calc; return [c.applied, r2(c.base), r2(c.bonus), r2(c.total)]; })(), [30, 600, 1200, 1800]);
check('revenue plan quotes no per-loan number', S.summarize({ tool: 'dscr', amount: 300000, points: 1, tpoSpread: 1 }, 'revenue').calc.total, 0);

// ── family readers against the sizers' own stash shapes ────────────────────
{
  globalThis._dscrLastCalc = { loan: 240000, finalRate: 7.205, buydown: 0.25, netHiddenTpoPct: 1 };
  globalThis._dscrLastCalcEffective = { loan: 250000, finalRate: 7.5 };
  globalThis._dscrOverrides = { points: null };
  globalThis._loadedLoan = undefined;
  const p = S.fromDscr('dscr');
  check('dscr reader: effective amount/rate, points = 1 + buydown, TPO assumed from the engine', [p.amount, p.ratePct, p.basePct, p.points, p.tpoSpread, p.tpoAssumed], [250000, 7.5, 7.205, 1.25, 1, true]);
  globalThis._dscrOverrides = { points: 0.75 };
  check('dscr reader: an overridden points value wins', S.fromDscr('dscr').points, 0.75);
  globalThis._dscrLastCalc = { loan: 1, finalRate: 7 };
  check('dscr reader: no engine TPO on the result → the 1.00 default', S.fromDscr('dscr').tpoSpread, S.DEFAULT_DSCR_TPO);
  globalThis._rtlLastCalc = { bMax: 400000, rate: 0.11, points: 2 };
  globalThis._rtlLastCalcEffective = { bMax: 410000, rate: 0.115, points: 2.5 };
  globalThis._loadedLoan = { commissionSource: 'company', commissionReferral: 'yes' };
  const q = S.fromRtl('guc');
  check('rtl reader: effective amount/rate/points, engine rate as the base, loan stamps honoured', [q.tool, q.amount, q.ratePct, q.basePct, q.points, q.source, q.referral], ['guc', 410000, 0.115, 0.11, 2.5, 'company', true]);
  globalThis._rtlLastCalc = null;
  check('no calc yet → nothing to show', S.fromRtl('rtl'), null);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
