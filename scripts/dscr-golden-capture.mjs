#!/usr/bin/env node
/**
 * scripts/dscr-golden-capture.mjs — capture golden pricing outputs
 * from the DSCR sizer's CURRENT inline code. Hardening Phase G.
 *
 * Slices the pricing constants + functions straight out of
 * deploy/dscr-sizer.html, runs them in a Node vm with a stubbed DOM
 * ($(id).value fed from each scenario), and records calculate()'s
 * full return value per scenario into scripts/fixtures/dscr-golden.json.
 *
 * Purpose: BEFORE the G1 extraction (pricing math moves to
 * deploy/dscr-pricing.js), this locks the current behavior. AFTER
 * the extraction, scripts/pricing-test.mjs runs the same scenarios
 * through the extracted module and diffs against this file — any
 * mismatch means the refactor changed pricing, which is a hard fail.
 * Thereafter the golden file is the regression net for every future
 * rate-sheet update (regenerate deliberately, diff the changes
 * against the sheet by hand, commit).
 *
 * Usage: node scripts/dscr-golden-capture.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'deploy', 'dscr-sizer.html'), 'utf8');

// ── Slice the two pricing regions out of the HTML ───────────────────
// Region A: const DIYA … through validateGuidelines/getFICOMin, up to
//   the </script> that closes that block.
// Region B: function ltvCol … up to (not including) renderResult.
// The `$` DOM helper between the regions is deliberately excluded —
// the sandbox provides its own fed from scenario inputs.
function slice(src, startMarker, endMarker, label) {
  const s = src.indexOf(startMarker);
  if (s < 0) throw new Error('capture: start marker not found for ' + label);
  const e = src.indexOf(endMarker, s);
  if (e < 0) throw new Error('capture: end marker not found for ' + label);
  return src.slice(s, e);
}
// NB: '"const DIYA = {" below' also appears in an HTML comment — anchor
// on the <script> tag immediately preceding the real declaration.
const aTag = html.match(/<script>\s*const DIYA = \{/);
if (!aTag) throw new Error('capture: <script>const DIYA anchor not found');
const sliceA = slice(html.slice(aTag.index + '<script>'.length), 'const DIYA = {', '</script>', 'region A (constants)');
const sliceB = slice(html, 'function ltvCol', '\nfunction renderResult', 'region B (calculate)');

// ── Sandbox with a stubbed DOM ──────────────────────────────────────
let currentInputs = {};
const sandbox = {
  $: (id) => ({ value: String(currentInputs[id] !== undefined ? currentInputs[id] : '') }),
  console,
};
vm.createContext(sandbox);
vm.runInContext(sliceA + '\n' + sliceB + '\n;__calc = calculate;', sandbox);

// ── Scenario matrix ─────────────────────────────────────────────────
// Base: eligible state, healthy DSCR, mid UPB band (200-599k = no adj).
const BASE = {
  loanAmt: 400000, propValue: 600000,           // LTV 66.7 → col 70
  loanType: '30Y Fixed', isIO: 'no', loanPurpose: 'purchase',
  propType: 'sfr', fico: '740-759', prepay: '321', buydown: '0',
  rent: 6000, taxes: 300, insurance: 150, hoa: 0,
  borrowerName: 'Golden Fixture', borrowerEmail: 'golden@example.com',
  propAddress: '123 Fixture St, Spokane, WA 99208',
  brokerFee: '', brokerProcFee: '',
};
const S = (name, over) => ({ name, inputs: { ...BASE, ...over } });

const SCENARIOS = [
  // Products
  S('base-30y-fixed', {}),
  S('product-10-6-arm', { loanType: '10/6 ARM' }),
  S('product-7-6-arm',  { loanType: '7/6 ARM' }),
  S('product-5-6-arm',  { loanType: '5/6 ARM' }),
  // FICO bands (valid at col 70)
  S('fico-780plus',  { fico: '780+' }),
  S('fico-760-779',  { fico: '760-779' }),
  S('fico-720-739',  { fico: '720-739' }),
  S('fico-700-719',  { fico: '700-719' }),
  S('fico-680-699',  { fico: '680-699' }),
  S('fico-660-679',  { fico: '660-679', loanAmt: 350000 }), // LTV 58.3 → col 60 (70 is null)
  // LTV tiers (via loan size against 600k value)
  S('ltv-col-50', { loanAmt: 290000 }),                      // 48.3
  S('ltv-col-60', { loanAmt: 350000 }),                      // 58.3
  S('ltv-col-80', { loanAmt: 475000 }),                      // 79.2 — 740-759 80-col
  S('ltv-80-fico-700-719-new-tier', { loanAmt: 475000, fico: '700-719' }), // the 7/22 sheet's new 75.01-80 tier
  // IO + cash-out
  S('io-yes', { isIO: 'yes' }),
  S('io-at-75', { isIO: 'yes', loanAmt: 445000 }),           // 74.2 → col 75
  S('cashout', { loanPurpose: 'refi_co' }),
  S('cashout-io-combined', { loanPurpose: 'refi_co', isIO: 'yes' }),
  // Property types
  S('prop-nw-condo',  { propType: 'nw_condo' }),
  S('prop-2-4-unit',  { propType: '2-4', rent: 7500 }),
  S('prop-portfolio', { propType: 'portfolio', propValue: 900000, loanAmt: 600000, rent: 9000 }),
  // Prepay options
  S('ppp-5y6m',  { prepay: '5y6m' }),
  S('ppp-54321', { prepay: '54321' }),
  S('ppp-320',   { prepay: '320' }),
  S('ppp-300',   { prepay: '300' }),
  S('ppp-none',  { prepay: 'none' }),
  // Buydowns
  S('buydown-0.25', { buydown: '0.25' }),
  S('buydown-1.00', { buydown: '1.00' }),
  S('buydown-2.00', { buydown: '2.00' }),
  // UPB bands
  S('upb-75-99k',    { loanAmt: 90000,  propValue: 150000 }),
  S('upb-100-149k',  { loanAmt: 120000, propValue: 200000 }),
  S('upb-150-199k',  { loanAmt: 180000, propValue: 280000 }),
  S('upb-600k-plus', { loanAmt: 700000, propValue: 1000000, rent: 9500 }),
  // DSCR tiers
  S('dscr-1.00-1.19', { loanAmt: 300000, propValue: 500000, rent: 2500, taxes: 200, insurance: 100 }),
  // Broker fees flow into totalFees
  S('broker-fees', { brokerFee: '1.5', brokerProcFee: '995' }),
  // Error branches — locked as goldens too (wording is part of the contract)
  S('err-sub-660',        { fico: '640-659' }),
  S('err-ltv-over-80',    { loanAmt: 550000 }),
  S('err-io-at-80',       { isIO: 'yes', loanAmt: 475000 }),
  S('err-cashout-at-80',  { loanPurpose: 'refi_co', loanAmt: 475000 }),
  S('err-680-at-80',      { fico: '680-699', loanAmt: 475000 }),
  S('err-dscr-below-1',   { rent: 1500 }),
  S('warn-ineligible-state', { propAddress: '1 Desert Rd, Phoenix, AZ 85001' }),
];

// ── Run + record ────────────────────────────────────────────────────
const results = {};
for (const sc of SCENARIOS) {
  currentInputs = sc.inputs;
  let out;
  try { out = sandbox.__calc(); }
  catch (e) { out = { __threw: String(e && e.message) }; }
  results[sc.name] = out;
}

const fixture = {
  generatedAt: new Date().toISOString(),
  source: 'deploy/dscr-sizer.html (inline, pre-G1-extraction)',
  effectiveDate: (results['base-30y-fixed'] && results['base-30y-fixed'].baseRate) !== undefined
    ? (vm.runInContext('DIYA.effectiveDate', sandbox)) : 'unknown',
  scenarios: SCENARIOS,
  results,
};

mkdirSync(join(root, 'scripts', 'fixtures'), { recursive: true });
const outPath = join(root, 'scripts', 'fixtures', 'dscr-golden.json');
writeFileSync(outPath, JSON.stringify(fixture, null, 2));

// Console summary for eyeballing
let priced = 0, errored = 0, threw = 0;
for (const [name, r] of Object.entries(results)) {
  if (r.__threw) { threw++; console.log('THREW  ' + name + ': ' + r.__threw); }
  else if (r.error) { errored++; console.log('ERROR  ' + name + ': ' + String(r.error).slice(0, 90)); }
  else { priced++; console.log('PRICED ' + name + ': rate=' + r.finalRate.toFixed(3) + ' dscr=' + (r.dscr ? r.dscr.toFixed(2) : '-') + ' fees=' + r.totalFees); }
}
console.log('\n' + priced + ' priced, ' + errored + ' error-branch, ' + threw + ' threw → ' + outPath);
if (threw > 0) process.exit(1);
