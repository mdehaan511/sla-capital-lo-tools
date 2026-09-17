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
// Deploy 236.963 — Mike: "10.5 and 1.5 base ... change it to 10% 1.5 points then its 1 point for the comp multiplier"
check('a rate BELOW the engine rate REDUCES the margin point for point (10.5 → 10.0 at 1.5 pts = 1.0)', (() => { const r = S.rowFrom({ tool: 'rtl', amount: 1, ratePct: 0.10, basePct: 0.105, points: 1.5 }); return [r2(r.margin), r.marginParts]; })(), [1, '1.50 pts − 0.50 under sizer base']);
check('DSCR without a sensitivity: a rate below the engine rate comes off the assumed TPO point for point', (() => { const r = S.rowFrom({ tool: 'dscr', amount: 1, ratePct: 6.75, basePct: 7.0, points: 1, tpoSpread: 1, tpoAssumed: true }); return [r2(r.margin), r.marginParts]; })(), [1.75, '1.00 pts + 1.00 TPO (assumed — set at closing) − 0.25 TPO for 0.25 under sizer base']);
// Deploy 236.964 — Mike: "have it scale to the TPO sensitivity": 1.00 pt of premium per 0.320 of rate = 3.125 pts per 1%
check('DSCR with the engine sensitivity: 0.25 under the base costs 0.78 of TPO (3.125 pts per 1%)', (() => { const r = S.rowFrom({ tool: 'dscr', amount: 1, ratePct: 6.75, basePct: 7.0, points: 1, tpoSpread: 1, tpoAssumed: true, tpoPerRate: 3.125 }); return [r2(r.margin), r.marginParts]; })(), [1.22, '1.00 pts + 1.00 TPO (assumed — set at closing) − 0.78 TPO for 0.25 under sizer base (3.13 pts per 1%)']);
check('DSCR over the base earns premium at the same ratio', r2(S.rowFrom({ tool: 'dscr', amount: 1, ratePct: 7.25, basePct: 7.0, points: 1, tpoSpread: 1, tpoPerRate: 3.125 }).margin), 2.78);
check('DSCR at the base: no TPO move, plain breakdown', S.rowFrom({ tool: 'dscr', amount: 1, ratePct: 7.0, basePct: 7.0, points: 1, tpoSpread: 1, tpoAssumed: true, tpoPerRate: 3.125 }).marginParts, '1.00 pts + 1.00 TPO (assumed — set at closing)');
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
{
  const sizer = S.summarize({ tool: 'rtl', amount: 500000, ratePct: 0.10, basePct: 0.105, points: 1.5 }, 'model').calc;
  const page = C.computeRow(C.buildRows({ 'lo@slacapital.com': [{ id: 'c', email: 'b@x.com', loans: [
    { id: 'l', status: 'closed', fundingDate: C.todayISO(), toolType: 'rtl', loanAmt: 500000, rate: 0.10, points: 1.5, _pricingOverrideOriginal: { rate: 0.105 } },
  ] }] })[0], 'model');
  check('model, RTL 500k sold 10.00 under a 10.50 engine rate at 1.5 pts: margin 1.0 → 35 bps on BOTH pages ($1,750)', [sizer.tier, r2(sizer.total), page.tier, r2(page.total)], [35, 1750, 35, 1750]);
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
  globalThis.SLA_DSCR = { DIYA: { HIDDEN_TPO_PCT: 1.00, HIDDEN_TPO_ADJ: 0.320 }, activePricing: () => null };
  const p = S.fromDscr('dscr');
  check('dscr reader: effective amount/rate, points = 1 + buydown, TPO assumed from the engine', [p.amount, p.ratePct, p.basePct, p.points, p.tpoSpread, p.tpoAssumed], [250000, 7.5, 7.205, 1.25, 1, true]);
  check('dscr reader: TPO sensitivity read from the engine (1.00 / 0.320)', r2(p.tpoPerRate), 3.13);
  globalThis.SLA_DSCR = { DIYA: { HIDDEN_TPO_PCT: 1.00, HIDDEN_TPO_ADJ: 0.320 }, activePricing: () => ({ HIDDEN_TPO_PCT: 1.00, HIDDEN_TPO_ADJ: 0.280 }) };
  check('dscr reader: a historical sheet from activePricing() wins (1.00 / 0.280)', r2(S.dscrTpoPerRate()), 3.57);
  globalThis.SLA_DSCR = undefined;
  check('dscr reader: no engine on the page → no scaling (point for point)', S.fromDscr('dscr').tpoPerRate, 0);
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

// ── Deploy 237.128 — comp spread stat, tier ladder, upsell hints ───────────
{
  const lad = C.tierLadder(2.5, '2026-09-16');
  check('tier ladder (current schedule): six rungs, 2.50 sits in 58.75', [lad.length, lad.map((t) => t.bps), lad.findIndex((t) => t.current)], [6, [35, 50, 58.75, 65, 70, 85], 2]);
  const nt = C.nextTierFor(2.5, '2026-09-16');
  check('next tier from 2.50: 65 bps at 2.75 — need 0.25', [nt.current.bps, nt.next.bps, r2(nt.need)], [58.75, 65, 0.25]);
  check('top tier has no next', C.nextTierFor(5, '2026-09-16').next, null);
  check('legacy schedule by close date: 1.0 → 35, next 50 at 1.5', (() => { const n = C.nextTierFor(1.0, '2026-01-01'); return [n.current.bps, n.next.bps, r2(n.need)]; })(), [35, 50, 0.5]);
  check('exactly on a bound lands in the higher tier', C.nextTierFor(2.75, '2026-09-16').current.bps, 65);
  check('salaryMultiplier matches the sheet steps', C.SALARY_RATE_STEPS.map((x) => C.salaryMultiplier(x, false)), [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.4]);
  check('salaryMultiplier: DSCR is flat 1, off-step rates snap (10.25 → 0.9, 10.99 → 1.0)', [C.salaryMultiplier(12, true), C.salaryMultiplier(10.25, false), C.salaryMultiplier(10.99, false)], [1, 0.9, 1]);
  const u = S.upsell({ tool: 'dscr', amount: 300000, ratePct: 7.2, basePct: 7.2, points: 1, tpoSpread: 1.5, tpoPerRate: 3.125 }, 'model');
  check('DSCR upsell: +0.25 spread = 1.25 pts or +0.08% rate (3.125 pts per 1%), worth +$187.50', [u.kind, r2(u.need), r2(u.targetPoints), u.lever, r2(u.rateDelta), r2(u.targetRatePct), r2(u.gain)], ['tiers', 0.25, 1.25, 'rate', 0.08, 7.28, 187.5]);
  check('company-sourced halves the gain', r2(S.upsell({ tool: 'dscr', amount: 300000, ratePct: 7.2, basePct: 7.2, points: 1, tpoSpread: 1.5, source: 'company' }, 'model').gain), 93.75);
  check('Admin Mode TPO: the lever is the TPO, not the rate', (() => { const a = S.upsell({ tool: 'dscr', amount: 1, ratePct: 7.2, basePct: 7.2, points: 1, tpoSpread: 1.5, tpoAdmin: true }, 'model'); return [a.lever, r2(a.targetTpo)]; })(), ['tpo', 1.75]);
  const v = S.upsell({ tool: 'rtl', amount: 500000, ratePct: 0.1125, basePct: 0.11, points: 2 }, 'model');
  check('RTL upsell: 2.25 → 65 bps at 2.75: +0.50 = 2.50 pts or 11.75% (+0.50%), worth +$312.50', [r2(v.need), r2(v.targetPoints), r2(v.targetRatePct), r2(v.rateDelta), r2(v.gain)], [0.5, 2.5, 11.75, 0.5, 312.5]);
  check('top tier: nothing to upsell', S.upsell({ tool: 'rtl', amount: 1, ratePct: 0.13, basePct: 0.11, points: 3 }, 'model').next, null);
  const w = S.upsell({ tool: 'rtl', amount: 200000, ratePct: 0.12, basePct: 0.12, points: 2.5 }, 'salary');
  check('salary RTL: rate steps, 12% = ×1.2, next ×1.3 from 12.25%, split on +1.00 above the floor', [w.kind, w.steps.length, w.steps.filter((s) => s.current)[0].rate, w.next.mult, r2(w.targetRatePct), r2(w.rateDelta), r2(w.above)], ['salary', 7, 12, 1.3, 12.25, 0.25, 1]);
  check('salary RTL: next step gain = computeRow at ×1.3 minus now', r2(w.gain), r2(C.computeRow({ tool: 'RTL', amount: 200000, ratePct: 12.5, points: 2.5, tpoSpread: 0 }, 'salary').total - C.computeRow({ tool: 'RTL', amount: 200000, ratePct: 12, points: 2.5, tpoSpread: 0 }, 'salary').total));
  check('salary DSCR: no rate steps, split basis = pts + TPO above 1.50', (() => { const x = S.upsell({ tool: 'dscr', amount: 1, ratePct: 7, basePct: 7, points: 1, tpoSpread: 1 }, 'salary'); return [x.steps.length, x.next, r2(x.above)]; })(), [0, null, 0.5]);
  check('flat / revenue plans: no ladder', [S.upsell({ tool: 'dscr', amount: 1, points: 1, tpoSpread: 1 }, 'flat50').kind, S.upsell({ tool: 'dscr', amount: 1, points: 1, tpoSpread: 1 }, 'revenue').kind], ['flat', 'none']);
  check('format helpers', [S.fmtBps(58.75), S.fmtBps(35), S.fmtRate(7.28), S.fmtRate(11.25), S.fmtRate(11), S.rangeLabel(lad[0]), S.rangeLabel(lad[2]), S.rangeLabel(lad[5])], ['58.75', '35', '7.28%', '11.25%', '11%', 'under 1.50', '2.25–2.74', '4.50+']);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
