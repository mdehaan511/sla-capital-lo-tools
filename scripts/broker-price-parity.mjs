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
 * guc-pricing -> rgl-pricing require() could still be dropped. The
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

console.log('');
if (failures) {
  console.log(`${failures} FAILURE(S) across ${checked} scenarios.`);
  process.exit(1);
}
console.log(`Parity holds across ${checked} golden scenarios; no withheld field leaked.`);
process.exit(0);
