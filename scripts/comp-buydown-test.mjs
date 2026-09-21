/**
 * scripts/comp-buydown-test.mjs — Deploy 237.214
 *
 * Mike: "Currently on a sizer if an LO adds buydown points it increases their
 * spread and thus their commission. Buydown points go to our end investor and
 * dont increase our revenue at all so it shouldnt effect their commission in
 * any way."
 *
 * The sizer box and the LO Commissions page share lo-comp.js, and loan.points is
 * the TOTAL the borrower pays (1.00 + buy-down), so the closed book paid on the
 * buy-down too. Both are locked here: with or without a buy-down the comp is
 * identical.
 *
 * Run: node scripts/comp-buydown-test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const C = require('../deploy/lo-comp.js');
const S = require('../deploy/lo-comp-sizer.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let pass = 0; const fails = [];
const ok = (cond, label) => { if (cond) pass++; else fails.push(label); };
const r2 = (n) => Math.round(n * 100) / 100;

// ── 1. The live sizer box ───────────────────────────────────────────────────
const base = { tool: 'dscr', amount: 400000, ratePct: 7.0, basePct: 7.0, tpoSpread: 1, tpoAssumed: true };
const plain = S.rowFrom(Object.assign({}, base, { points: 1, buydown: 0 }));
for (const bd of [0.25, 0.5, 1, 2]) {
  const withBd = S.rowFrom(Object.assign({}, base, { points: 1 + bd, buydown: bd }));
  ok(r2(withBd.margin) === r2(plain.margin), 'sizer: a ' + bd.toFixed(2) + ' buy-down leaves the spread at ' + r2(plain.margin) + ' [got ' + r2(withBd.margin) + ']');
  ok(withBd.points === 1, 'sizer: comp points stay 1.00 with a ' + bd.toFixed(2) + ' buy-down');
  ok(/buy-down pts excluded/.test(withBd.marginParts), 'sizer: the breakdown says the buy-down was excluded');
  for (const plan of ['tiered', 'salary', 'flat50']) {
    const a = C.computeRow(plain, plan), b = C.computeRow(withBd, plan);
    ok(r2(a.total) === r2(b.total), 'sizer: ' + plan + ' plan pays the same with a ' + bd.toFixed(2) + ' buy-down [' + r2(a.total) + ' vs ' + r2(b.total) + ']');
  }
}
ok(!/buy-down/.test(plain.marginParts), 'sizer: no buy-down, no note');

// An LO who overrides the TOTAL points keeps only what is above the buy-down.
{
  const r = S.rowFrom(Object.assign({}, base, { points: 2.5, buydown: 1 }));
  ok(r.points === 1.5 && r2(r.margin) === 2.5, 'sizer: 2.50 total with a 1.00 buy-down = 1.50 comp points');
  const under = S.rowFrom(Object.assign({}, base, { points: 0.5, buydown: 1 }));
  ok(under.points === 0, 'sizer: a total below the buy-down floors at 0, never negative');
}
// RTL / GUC have no buy-down — a stray value must not touch them.
{
  const a = S.rowFrom({ tool: 'rtl', amount: 500000, ratePct: 0.11, basePct: 0.11, points: 2 });
  const b = S.rowFrom({ tool: 'rtl', amount: 500000, ratePct: 0.11, basePct: 0.11, points: 2, buydown: 1 });
  ok(a.margin === b.margin && b.points === 2, 'sizer: RTL is untouched by a buy-down field');
}

// ── 2. The closed book (LO Commissions page → BILL.com amounts) ─────────────
{
  const loan = (extra) => Object.assign({ toolType: 'dscr', points: '1', tpoSpread: '1', rate: '7.0' }, extra);
  const m0 = C.marginOf(loan({}));
  const m1 = C.marginOf(loan({ points: '1.5', buydown: '0.50' }));
  ok(r2(m0.margin) === 2 && r2(m1.margin) === 2, 'closed DSCR: 1.50 pts with a 0.50 buy-down has the same margin as 1.00 pts flat');
  ok(/0\.50 buy-down pts excluded/.test(m1.parts), 'closed DSCR: the margin breakdown names the excluded buy-down');
  ok(!/buy-down/.test(m0.parts), 'closed DSCR: no buy-down, no note');
  ok(C.compPoints(loan({ points: '3', buydown: '2.00' })) === 1, 'compPoints: 3.00 total − 2.00 buy-down = 1.00');
  ok(C.compPoints(loan({ points: '1.25', formData: { buydown: '0.25' } })) === 1, 'compPoints: reads a buy-down kept under formData');
  ok(C.compPoints(loan({ points: '1', buydown: '' })) === 1 && C.compPoints(loan({ points: '1', buydown: '0' })) === 1, 'compPoints: blank / zero buy-down changes nothing');
  ok(C.compPoints({ toolType: 'rtl', points: '2', buydown: '1' }) === 2, 'compPoints: RTL ignores the field');
  ok(C.buydownOf(null) === 0 && C.compPoints(null) === 0, 'null loan is safe');
}

// ── 2b. loan.points is NOT always the sizer's total (found on the live book) ─
// Three closed June loans carry a 1.00 buy-down. One still holds the sizer's
// total (2.00); two were rewritten by the Baseline enrich to ORIGINATION ONLY
// (1) while the sizer snapshot formData._points still says 2.00. Taking the
// buy-down off those two would remove it twice and under-pay.
{
  const davisville = { toolType: 'dscr', points: '2.00 pts', buydown: '1.00', tpoSpread: '1', formData: { _points: '2.00 pts' } };
  const updike = { toolType: 'dscr', points: 1, buydown: '1.00', tpoSpread: '1', formData: { _points: '2.00 pts' } };
  ok(C.compPoints(davisville) === 1, 'real loan, points still the sizer total (2.00): buy-down comes off → 1.00');
  ok(C.buydownExcluded(davisville) === 1 && /1\.00 buy-down pts excluded/.test(C.marginOf(davisville).parts), '…and the breakdown says so');
  ok(C.compPoints(updike) === 1, 'real loan, points already rewritten to origination only (1): NOT taken off twice');
  ok(C.buydownExcluded(updike) === 0 && !/buy-down/.test(C.marginOf(updike).parts), '…and the breakdown claims no exclusion it did not make');
  ok(r2(C.marginOf(davisville).margin) === r2(C.marginOf(updike).margin), 'both shapes of the same deal land on the same margin');

  // No snapshot at all (older / imported records): fall back to the default shape.
  ok(C.compPoints({ toolType: 'dscr', points: 2, buydown: '1.00' }) === 1, 'no snapshot, 2.00 with a 1.00 buy-down: has the total shape → 1.00');
  ok(C.compPoints({ toolType: 'dscr', points: 1, buydown: '1.00' }) === 1, 'no snapshot, 1.00 with a 1.00 buy-down: already net → stays 1.00');
  // An LO's override BELOW the default total is still the total when the snapshot agrees.
  ok(C.compPoints({ toolType: 'dscr', points: '1.50', buydown: '1.00', formData: { _points: '1.50' } }) === 0.5, 'override total 1.50 with a 1.00 buy-down (snapshot agrees) → 0.50');
  // The live sizer box always passes the total, whatever its shape.
  ok(C.compPoints({ toolType: 'dscr', points: 1.5, buydown: 1 }, { pointsAreTotal: true }) === 0.5, 'sizer box: pointsAreTotal forces the subtraction');
  ok(S.rowFrom({ tool: 'dscr', amount: 1, ratePct: 7, basePct: 7, tpoSpread: 1, points: 1.5, buydown: 1 }).points === 0.5, 'sizer box: a discounted 1.50 total with a 1.00 buy-down = 0.50 comp points');
}

// ── 3. The fields have to REACH the commission page ─────────────────────────
for (const f of ['clients-list.mjs', 'clients-list-pg.mjs']) {
  const src = fs.readFileSync(path.join(ROOT, 'deploy/netlify/functions', f), 'utf8');
  ok(/'buydown'/.test(src), f + ' projects loan.buydown into the summary the commission page reads');
  ok(/_points:\s+l\.form_?[dD]ata\._points/.test(src), f + ' carries the sizer points snapshot in the trimmed formData');
}

console.log(pass + ' checks passed' + (fails.length ? ', ' + fails.length + ' FAILED' : ''));
if (fails.length) { fails.forEach((f) => console.error('  FAIL ' + f)); process.exit(1); }
