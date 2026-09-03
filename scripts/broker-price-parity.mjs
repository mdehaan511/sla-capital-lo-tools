#!/usr/bin/env node
/**
 * scripts/broker-price-parity.mjs — Broker Portal, Phase 0 gate.
 *
 * Answers the one question Phase 0 exists to answer: does the server-side
 * broker pricing path return EXACTLY what the LO sizers compute?
 *
 * Replays every golden scenario through _shared/broker-pricing.mjs and
 * compares each broker-visible field against the raw engine's own output.
 * Any divergence means brokers would be quoting a different book than we
 * are, which is the failure this whole design exists to prevent.
 *
 * It also asserts the inverse: that the fields we deliberately withhold
 * (baseRate, the adjustment list, the TPO spread) are ABSENT from what a
 * broker would receive. A leak there hands out the pricing matrix.
 *
 * Run: node scripts/broker-price-parity.mjs
 * Exit 0 = parity holds and nothing leaks. Exit 1 = either failed.
 *
 * NOTE ON WHAT THIS DOES NOT COVER: this runs the module under plain
 * Node. The lambda runs it through esbuild, which is where the
 * guc-pricing -> rtl-pricing require() could still be dropped. The
 * endpoint's assertEnginesLoaded() covers that at runtime, and the live
 * smoke check after deploy is what proves it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const { priceScenario, PROGRAMS, effectiveDateFor, assertEnginesLoaded } =
  await import(join(root, 'deploy/netlify/functions/_shared/broker-pricing.mjs'));

// Fields that must NEVER appear in a broker-visible result.
const MUST_NOT_LEAK = ['baseRate', 'adjs', 'netHiddenTpoPct', 'floor', 'sandbox',
  'mLtp', 'mLtc', 'mLarv', 'refiLtv', 'defMax', 'mByLtc', 'mByLarv', 'tier'];

// Broker-visible field -> the raw engine field it must equal.
const COMPARE = {
  dscr: ['finalRate', 'ltv', 'dscr', 'pi', 'totalPayment', 'loan', 'origFee', 'totalFees'],
  rtl:  ['rate', 'bMax', 'dp', 'p', 'pDol', 'mo', 'initAdv'],
};

const SUITES = [
  { program: 'dscr', golden: 'scripts/fixtures/dscr-golden.json', module: 'deploy/dscr-pricing.js', fn: 'priceDSCR', shape: 'dscr' },
  { program: 'rtl',  golden: 'scripts/fixtures/rtl-golden.json',  module: 'deploy/rtl-pricing.js',  fn: 'priceRTL',  shape: 'rtl'  },
];

let failures = 0;
let declined = 0;
let checked = 0;

const broken = assertEnginesLoaded();
if (broken.length) {
  console.log('FAIL  engines not loadable under Node: ' + broken.join(', '));
  process.exit(1);
}
console.log('engines loaded: ' + Object.keys(PROGRAMS).join(', '));
for (const k of Object.keys(PROGRAMS)) {
  console.log('  ' + k.padEnd(5) + ' effective date: ' + (effectiveDateFor(k) || '(none published)'));
}
console.log('');

for (const suite of SUITES) {
  const engine = require(join(root, suite.module));
  const golden = JSON.parse(readFileSync(join(root, suite.golden), 'utf8'));
  const scenarios = golden.scenarios || golden;
  let suiteFail = 0;

  for (const sc of scenarios) {
    const raw = engine[suite.fn](sc.inputs);
    const out = priceScenario(suite.program, sc.inputs, 0);
    checked++;

    if (!out.ok) {
      console.log(`FAIL  ${suite.program} "${sc.name || 'scenario'}": ${out.error}`);
      suiteFail++; failures++;
      continue;
    }

    // Some goldens are deliberate declines (over-LTV, sub-minimum FICO).
    // The engine signals those as `error` / `rErr`; the server path must
    // agree, and there are no fields left to compare.
    if (out.declined) {
      if (!raw.error && !raw.rErr) {
        console.log(`FAIL  ${suite.program} "${sc.name || 'scenario'}" declined but the engine priced it`);
        suiteFail++; failures++;
      }
      declined++;
      continue;
    }
    if (raw.error) {
      console.log(`FAIL  ${suite.program} "${sc.name || 'scenario'}" engine declined but the server quoted it`);
      suiteFail++; failures++;
      continue;
    }

    // 1. Parity — every compared field identical to the engine's own.
    for (const f of COMPARE[suite.shape]) {
      if (raw[f] === undefined) continue;
      if (out.result[f] !== raw[f]) {
        console.log(`FAIL  ${suite.program} "${sc.name || 'scenario'}" field ${f}: server ${out.result[f]} vs engine ${raw[f]}`);
        suiteFail++; failures++;
      }
    }

    // 2. Nothing sensitive escaped.
    for (const f of MUST_NOT_LEAK) {
      if (Object.prototype.hasOwnProperty.call(out.result, f)) {
        console.log(`FAIL  ${suite.program} "${sc.name || 'scenario'}" LEAKED ${f}`);
        suiteFail++; failures++;
      }
    }
  }
  console.log(`${suiteFail ? 'FAIL' : 'ok  '}  ${suite.program}: ${scenarios.length} scenarios`);
}

// 3. The broker fee must not move SLA's rate or SLA's points.
const feeBase = {
  loanAmt: 400000, propValue: 600000, loanType: '30Y Fixed', isIO: 'no',
  loanPurpose: 'purchase', propType: 'sfr', fico: '740-759', prepay: '321',
  buydown: '0', rent: 6000, taxes: 300, insurance: 150, hoa: 0,
};
const noFee = priceScenario('dscr', feeBase, 0);
const withFee = priceScenario('dscr', feeBase, 2);
let feeFail = 0;
if (noFee.fee.slaRate !== withFee.fee.slaRate) {
  console.log(`FAIL  broker fee moved the rate: ${noFee.fee.slaRate} -> ${withFee.fee.slaRate}`); feeFail++;
}
if (noFee.fee.slaPoints !== withFee.fee.slaPoints) {
  console.log(`FAIL  broker fee moved SLA points: ${noFee.fee.slaPoints} -> ${withFee.fee.slaPoints}`); feeFail++;
}
if (withFee.fee.brokerDollars !== 8000) {
  console.log(`FAIL  2pts on $400k should be $8,000, got ${withFee.fee.brokerDollars}`); feeFail++;
}
if (Math.abs(withFee.allIn.points - (noFee.allIn.points + 2)) > 0.001) {
  console.log(`FAIL  all-in points should rise by exactly the fee: ${noFee.allIn.points} -> ${withFee.allIn.points}`); feeFail++;
}
failures += feeFail;
console.log(`${feeFail ? 'FAIL' : 'ok  '}  broker fee stacks on top without moving SLA's price`);

// 4. A scenario that doesn't fit must come back as an explicit DECLINE with
//    a reason and no numbers — never ok-with-an-empty-result, which a page
//    would render as a real $0 quote. (Live testing found exactly that.)
const DECLINES = [
  { program: 'dscr', why: 'over max LTV',
    inputs: Object.assign({}, feeBase, { loanAmt: 500000 }) },
  { program: 'rtl',  why: 'FICO below program minimum',
    inputs: { lt: 'bridge', fr: 600, exp: 0, pt: 'sfr', pp: 400000, arv: 0, rb: 0, term: 12, purp: 'purchase', sa: 'other', state: 'WA' } },
];
let decFail = 0;
for (const d of DECLINES) {
  const out = priceScenario(d.program, d.inputs, 1.5);
  if (!out.declined) {
    console.log(`FAIL  ${d.program} (${d.why}) should decline, got a quote`); decFail++; continue;
  }
  if (out.result !== null || out.fee !== null || out.allIn !== null) {
    console.log(`FAIL  ${d.program} (${d.why}) decline still carried numbers`); decFail++;
  }
  if (!out.reason || out.reason.length < 10) {
    console.log(`FAIL  ${d.program} (${d.why}) decline has no usable reason`); decFail++;
  }
  // Internal "reach out to a manager" wording must not reach a broker.
  if (/reach out to a manager/i.test(out.reason || '')) {
    console.log(`FAIL  ${d.program} (${d.why}) leaked the internal exception hint: ${out.reason}`); decFail++;
  }
}
failures += decFail;
console.log(`${decFail ? 'FAIL' : 'ok  '}  declines return a reason and no numbers, in broker wording`);

// 4b. fee.slaRate must be a PERCENT for every program.
//     The two engine families disagree: DIYA returns 6.895 (a percentage),
//     Colchis returns 0.10125 (a decimal fraction). Passing that through
//     rendered a 10.125% bridge loan as "0.100%" on the broker sizer —
//     wrong by 100x, with the .125 already lost to rounding. Any real
//     lending rate is between 3% and 30%, so the band catches both a
//     missed x100 and a double one.
const RATE_CASES = [
  { program: 'dscr', inputs: feeBase },
  { program: 'rtl',  inputs: { lt: 'bridge', fr: 740, exp: 8, pt: 'sfr', pp: 400000, arv: 0, rb: 0, term: 12, purp: 'purchase', sa: 'other', state: 'WA' } },
  { program: 'guc',  inputs: { fr: 740, exp: 6, pt: 'sfr', landValue: 300000, buildCost: 250000, arv: 900000, term: 12, sa: 'other', state: 'WA', ownLand: 'no', landDebt: 0 } },
];
let rateFail = 0;
for (const c of RATE_CASES) {
  const out = priceScenario(c.program, c.inputs, 0);
  if (!out.ok || out.declined) { console.log(`FAIL  ${c.program} rate-unit case did not price`); rateFail++; continue; }
  const r = out.fee.slaRate;
  if (!(r >= 3 && r <= 30)) {
    console.log(`FAIL  ${c.program} fee.slaRate = ${r} — not a percentage in the 3-30 band`);
    rateFail++;
  }
  // And three decimals must survive: 10.125 must not become 10.13.
  if (Math.abs(r - Math.round(r * 1000) / 1000) > 1e-9) {
    console.log(`FAIL  ${c.program} fee.slaRate lost precision: ${r}`);
    rateFail++;
  }
}
failures += rateFail;
console.log(`${rateFail ? 'FAIL' : 'ok  '}  fee.slaRate is a percentage on every program`);

// 5. No broker-facing page may ship a pricing module. This is
//    anti-enumeration layer 6, and it is exactly the kind of thing a
//    copied <script> tag reintroduces silently — so it's a gate, not a
//    comment. Checks real script tags only; the warning comment in
//    broker-sizer.html mentions *-pricing.js on purpose.
const BROKER_PAGES = ['deploy/broker-sizer.html', 'deploy/broker-signup.html', 'deploy/broker-partners.html'];
let leakFail = 0;
for (const page of BROKER_PAGES) {
  let html;
  try { html = readFileSync(join(root, page), 'utf8'); }
  catch (_) { continue; } // page not built yet
  const tags = html.match(/<script[^>]*\ssrc=["'][^"']+["']/gi) || [];
  for (const t of tags) {
    if (/-pricing\.js/i.test(t)) {
      console.log(`FAIL  ${page} ships a pricing module: ${t}`);
      leakFail++;
    }
  }
}
failures += leakFail;
console.log(`${leakFail ? 'FAIL' : 'ok  '}  no broker page ships a pricing engine`);

console.log('');
if (failures) {
  console.log(`${failures} FAILURE(S) across ${checked} scenarios.`);
  process.exit(1);
}
console.log(`Parity holds across ${checked} golden scenarios (${declined} declines); no withheld field leaked.`);
process.exit(0);
