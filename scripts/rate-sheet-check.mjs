#!/usr/bin/env node
/**
 * scripts/rate-sheet-check.mjs — Deploy 237.145
 *
 * scripts/pricing-test.mjs proves the engines still price the golden scenarios.
 * It does NOT cover the two things a rate-sheet update actually breaks:
 *
 *   1. mf-pricing.js has no golden file at all, so an MF sheet edit ships untested.
 *   2. PRICING_HISTORY + setPricingAsOf — the rate-lock repricing path. Adding a
 *      sheet means pushing a new head entry AND moving the old head's values into
 *      overrides. Forget the second half and every locked loan silently reprices
 *      on today's sheet, which is the whole bug 236.878 was written to prevent.
 *      Nothing catches that: the goldens only ever run the current sheet.
 *
 * Everything here is derived from the engines, so it needs no edit when a new
 * sheet lands — run it after every rate-sheet update, for both engines at once.
 *
 * Run: node scripts/rate-sheet-check.mjs
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');

let fail = 0;
function check(name, got, want) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
}
function assert(name, cond, why) {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++;
  console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
}

// Day before a YYYY-MM-DD string, in UTC so it never drifts with the runner's TZ.
function dayBefore(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const ENGINES = [
  { label: 'DSCR 1-4',       file: 'deploy/dscr-pricing.js' },
  { label: 'Multifamily 5+', file: 'deploy/mf-pricing.js' },
];

for (const e of ENGINES) {
  const eng = require(join(root, e.file));
  const hist = eng.PRICING_HISTORY;
  console.log('\n' + e.label + '  (' + e.file + ')');

  // ── the history is shaped the way setPricingAsOf assumes ────────────────
  assert('history is a non-empty list', Array.isArray(hist) && hist.length > 0);
  check('head carries no overrides (it IS the live DIYA)', hist[0].overrides, {});
  check('head label matches DIYA.effectiveDate', hist[0].label, eng.DIYA.effectiveDate);
  assert('head effective parses as a real date',
    /^\d{4}-\d{2}-\d{2}$/.test(hist[0].effective) && !isNaN(new Date(hist[0].effective + 'T00:00:00Z')),
    'got ' + hist[0].effective);

  const dates = hist.map((h) => h.effective);
  assert('effective dates run newest → oldest with no repeats',
    dates.every((d, i) => i === 0 || d < dates[i - 1]),
    'order: ' + dates.join(' > '));
  assert('every entry below the head overrides something',
    hist.slice(1).every((h) => h.overrides && Object.keys(h.overrides).length > 0),
    'an empty overrides below the head is a no-op entry');

  // The classic half-done update: new head pushed, old head's values never moved
  // into overrides, so the sheet before this one prices at TODAY'S rates.
  const live = JSON.stringify(eng.DIYA.baseRate);
  const prior = hist.slice(1).find((h) => h.overrides.baseRate);
  assert('the previous sheet\'s baseRate was actually recorded',
    !!prior, 'no entry below the head carries a baseRate override');
  if (prior) {
    assert('...and differs from today\'s',
      JSON.stringify(prior.overrides.baseRate) !== live,
      'the ' + prior.effective + ' sheet carries the same rates as today — the old head\'s '
      + 'values were never copied into overrides, so locked loans will reprice on the new sheet');
  }

  // ── setPricingAsOf round-trips ──────────────────────────────────────────
  const liveTables = JSON.parse(JSON.stringify(eng.DIYA));

  eng.setPricingAsOf(hist[0].effective);
  check('a lock ON the effective date is the current sheet', eng.activePricing().isCurrent, true);
  check('  ...and prices at today\'s rates', eng.DIYA.baseRate, JSON.parse(live));

  if (hist.length > 1) {
    eng.setPricingAsOf(dayBefore(hist[0].effective));
    check('a lock the day BEFORE falls to the previous sheet', eng.activePricing().effective, hist[1].effective);
    check('  ...and is not flagged current', eng.activePricing().isCurrent, false);
    Object.keys(hist[1].overrides).forEach(function (k) {
      check('  ...applying its ' + k, eng.DIYA[k], hist[1].overrides[k]);
    });
  }

  const oldest = hist[hist.length - 1];
  eng.setPricingAsOf('2000-01-01');
  check('a lock older than every sheet clamps to the oldest', eng.activePricing().effective, oldest.effective);

  eng.setPricingAsOf('');
  check('no lock date restores the live sheet', eng.DIYA, liveTables);
  check('  ...flagged current again', eng.activePricing().isCurrent, true);

  // Walking the whole history and back must leave DIYA exactly as it started —
  // setPricingAsOf mutates in place, so a missed key leaks between calls.
  hist.forEach((h) => eng.setPricingAsOf(h.effective));
  eng.setPricingAsOf('');
  check('walking every sheet leaves DIYA untouched', eng.DIYA, liveTables);
}

// ── the Slack notice LOs read ──────────────────────────────────────────────
console.log('\nPricing notice (_shared/pricing-announce.mjs)');
const ann = await import(join(root, 'deploy/netlify/functions/_shared/pricing-announce.mjs'));
const cur = ann.currentPricing();
assert('current pricing reads both engines',
  isFinite(cur.dscr && cur.dscr.fixed) && isFinite(cur.mf && cur.mf.fixed),
  JSON.stringify(cur));
check('an unchanged sheet posts nothing', ann.buildMessage(cur, cur), null);

// Previous sheet straight out of PRICING_HISTORY — the same basis the deploy hook
// falls back to on its first run.
const dscrEng = require(join(root, 'deploy/dscr-pricing.js'));
const mfEng = require(join(root, 'deploy/mf-pricing.js'));
const prevOf = (eng) => {
  const o = (eng.PRICING_HISTORY.slice(1).find((h) => h.overrides.baseRate) || {}).overrides;
  return o && { fixed: o.baseRate['30Y Fixed'], arm: o.baseRate['7/6 ARM'] };
};
const prev = { dscr: prevOf(dscrEng), mf: prevOf(mfEng) };
const text = ann.buildMessage(cur, prev);
assert('a moved base rate produces a notice', !!text, 'buildMessage returned null');
if (text) {
  const dir = cur.dscr.fixed < prev.dscr.fixed ? 'decreased' : 'increased';
  assert('it names the direction (' + dir + ')', text.indexOf(dir) > 0, text);
  assert('it quotes the new floor', text.indexOf(cur.dscr.fixed.toFixed(3) + '%') > 0, text);
  assert('it says what to do about locks', /lock/i.test(text), text);
  console.log('\n  ── what will post ──\n' + text.split('\n').map((l) => '  ' + l).join('\n'));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
