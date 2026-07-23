#!/usr/bin/env node
/**
 * scripts/pricing-test.mjs — golden pricing tests. Hardening Phase G3.
 *
 * Runs every scenario in scripts/fixtures/dscr-golden.json through
 * deploy/dscr-pricing.js (the extracted engine) and requires the
 * output to EXACTLY equal the recorded golden. Run:
 *
 *   node scripts/pricing-test.mjs
 *
 * When to run:
 *   - after ANY edit to deploy/dscr-pricing.js (rate sheets!):
 *     expected diffs only — eyeball each reported mismatch against
 *     the new sheet, then re-baseline with dscr-golden-capture.mjs
 *   - as part of the pre-deploy gate alongside scripts/smoke.mjs
 *
 * Exit 0 = all identical. Exit 1 = any mismatch/missing.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const engine = require(join(root, 'deploy', 'dscr-pricing.js'));
const golden = JSON.parse(readFileSync(join(root, 'scripts', 'fixtures', 'dscr-golden.json'), 'utf8'));

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

let pass = 0, fail = 0;
console.log('DSCR golden pricing tests — engine eff. ' + engine.DIYA.effectiveDate +
  ' vs golden eff. ' + golden.effectiveDate + ' (' + golden.scenarios.length + ' scenarios)');
for (const sc of golden.scenarios) {
  const expected = golden.results[sc.name];
  let actual;
  try { actual = engine.priceDSCR(sc.inputs); }
  catch (e) { actual = { __threw: String(e && e.message) }; }
  const diffs = [];
  diffPaths(expected, actual, '', diffs);
  if (diffs.length === 0) { pass++; }
  else {
    fail++;
    console.log('✗ ' + sc.name);
    diffs.slice(0, 6).forEach((d) => console.log('    ' + d));
    if (diffs.length > 6) console.log('    …' + (diffs.length - 6) + ' more');
  }
}
console.log(pass + ' identical, ' + fail + ' mismatched');
if (fail) process.exit(1);
console.log('✓ pricing engine matches golden exactly');
