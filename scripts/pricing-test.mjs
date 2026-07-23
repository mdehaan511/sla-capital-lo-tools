#!/usr/bin/env node
/**
 * scripts/pricing-test.mjs — golden pricing tests. Hardening Phase G3.
 *
 * Replays every golden scenario through the extracted pricing engines
 * and requires outputs to EXACTLY equal the recorded goldens:
 *
 *   DSCR: deploy/dscr-pricing.js  vs scripts/fixtures/dscr-golden.json
 *   RTL:  deploy/rtl-pricing.js   vs scripts/fixtures/rtl-golden.json
 *
 * Run: node scripts/pricing-test.mjs
 *
 * When to run:
 *   - after ANY edit to a pricing engine (rate sheets!): expected
 *     diffs only — eyeball each mismatch against the new sheet, then
 *     re-baseline with the matching *-golden-capture script
 *   - as part of the pre-deploy gate alongside scripts/smoke.mjs
 *
 * Exit 0 = all identical. Exit 1 = any mismatch.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

const SUITES = [
  {
    name: 'DSCR',
    module: 'deploy/dscr-pricing.js',
    golden: 'scripts/fixtures/dscr-golden.json',
    run: (engine, sc) => engine.priceDSCR(sc.inputs),
    banner: (engine) => 'eff. ' + engine.DIYA.effectiveDate,
  },
  {
    name: 'RTL',
    module: 'deploy/rtl-pricing.js',
    golden: 'scripts/fixtures/rtl-golden.json',
    run: (engine, sc) => engine.priceRTL(sc.inputs),
    banner: () => 'Colchis wholesale matrix',
  },
];

function diffPaths(a, b, path, out) {
  if (a === b) return;
  if (typeof a === 'number' && typeof b === 'number' && Object.is(a, b)) return;
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) diffPaths(a[k], b[k], path + '.' + k, out);
    return;
  }
  out.push(path + ': golden=' + JSON.stringify(a) + ' now=' + JSON.stringify(b));
}

let totalFail = 0;
for (const suite of SUITES) {
  const engine = require(join(root, suite.module));
  const golden = JSON.parse(readFileSync(join(root, suite.golden), 'utf8'));
  let pass = 0, fail = 0;
  console.log(suite.name + ' golden tests — ' + suite.banner(engine) +
    ' (' + golden.scenarios.length + ' scenarios)');
  for (const sc of golden.scenarios) {
    const expected = golden.results[sc.name];
    let actual;
    try { actual = suite.run(engine, sc); }
    catch (e) { actual = { __threw: String(e && e.message) }; }
    const diffs = [];
    diffPaths(expected, actual, '', diffs);
    if (diffs.length === 0) { pass++; }
    else {
      fail++;
      console.log('  ✗ ' + sc.name);
      diffs.slice(0, 6).forEach((d) => console.log('      ' + d));
      if (diffs.length > 6) console.log('      …' + (diffs.length - 6) + ' more');
    }
  }
  console.log('  ' + pass + ' identical, ' + fail + ' mismatched\n');
  totalFail += fail;
}
if (totalFail) process.exit(1);
console.log('✓ both pricing engines match their goldens exactly');
