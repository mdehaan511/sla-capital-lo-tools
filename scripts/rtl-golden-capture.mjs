#!/usr/bin/env node
/**
 * scripts/rtl-golden-capture.mjs — capture golden RTL pricing outputs
 * from rtl-sizer.html's CURRENT inline code. Hardening Phase G (RTL).
 *
 * Same method as dscr-golden-capture.mjs, adapted to RTL's shape:
 * calculate() there is entangled with rendering, so we slice (a) the
 * constants/tables/helpers block and (b) the PURE SEGMENT of
 * calculate() — from `var fkey=fk(fr);` through `var mo = moMax;` —
 * VERBATIM, wrap the segment in a harness function that supplies the
 * gathered inputs, and stub the two mid-segment DOM reads
 * (targetLoanAmt, dutchInterest) plus the geo globals
 * (geoWarning/geoReductionLabel) per scenario. Zero edits to the
 * sizer's code — what runs here is what runs in the browser.
 *
 * Usage: node scripts/rtl-golden-capture.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// Two capture sources, selected by flag:
//   --from-module : run the EXTRACTED engine (deploy/rtl-pricing.js). This is
//     the mode for every rate-sheet / behavior re-baseline now that the pricing
//     math lives in the module (post-G1). priceRTL(inputs) returns the full
//     result object the golden compares against.
//   (default)     : LEGACY — slice the pure segment out of rtl-sizer.html's
//     inline calculate() and run it in a vm. Only meaningful pre-extraction; the
//     sizer no longer holds that inline segment, so this mode now errors with a
//     pointer to --from-module. Kept for historical record.
const FROM_MODULE = process.argv.includes('--from-module');
let runScenario, captureSource;

if (FROM_MODULE) {
  const require = createRequire(import.meta.url);
  const engine = require(join(root, 'deploy', 'rtl-pricing.js'));
  runScenario = (inputs) => engine.priceRTL(inputs);
  captureSource = 'deploy/rtl-pricing.js (extracted module, --from-module)';
} else {
  const html = readFileSync(join(root, 'deploy', 'rtl-sizer.html'), 'utf8');
  const lines = html.split('\n');
  const findLine = (pred, label, from) => {
    for (let i = from || 0; i < lines.length; i++) if (pred(lines[i])) return i;
    throw new Error('rtl-capture: anchor not found: ' + label +
      ' — the pricing math now lives in deploy/rtl-pricing.js. Re-baseline with:\n' +
      '  node scripts/rtl-golden-capture.mjs --from-module');
  };
  const cStart = findLine((l) => l.indexOf('── Pricing data — Colchis') >= 0, 'pricing-data comment');
  const cEndDetect = findLine((l) => l.indexOf('var detectedState=') === 0, 'detectedState');
  const sliceC = lines.slice(cStart, cEndDetect).join('\n');
  const segStart = findLine((l) => l.indexOf('var fkey=fk(fr); var eidx=ei(exp);') >= 0, 'fkey/eidx');
  const segEnd = findLine((l) => l.indexOf('var mo = moMax;') >= 0, 'mo = moMax', segStart);
  const segment = lines.slice(segStart, segEnd + 1).join('\n');
  const harness =
    sliceC + '\n' +
    'function __core(I){\n' +
    "  var lt=I.lt, fr=I.fr, exp=I.exp, pt=I.pt, pp=I.pp, arv=I.arv, rb=I.rb, term=I.term, purp=I.purp, zhvi=I.zhvi, sa=I.sa, state=I.state;\n" +
    "  var isR = lt!=='bridge';\n" +
    segment + '\n' +
    '  return {rErr:rErr, rate:rate, floor:floor, bMax:bMax, bLabel:bLabel, mLtp:mLtp, mLtc:mLtc, mLarv:mLarv,\n' +
    '    refiLtv:refiLtv, defMax:defMax, mByLtc:mByLtc, mByLarv:mByLarv, dp:dp, adjs:adjs, flags:flags,\n' +
    '    p:p, pDol:pDol, isDutch:isDutch, initAdv:initAdv, moMax:moMax, moStart:moStart, mo:mo, progLabel:progLabel};\n' +
    '}\n';
  let domVals = {};
  const sandbox = {
    console,
    document: { getElementById: (id) => ({ value: String(domVals[id] !== undefined ? domVals[id] : '') }) },
    geoWarning: '',
    geoReductionLabel: '',
  };
  vm.createContext(sandbox);
  vm.runInContext(harness, sandbox);
  runScenario = (inputs) => {
    domVals = { targetLoanAmt: inputs.targetLoanAmt, dutchInterest: inputs.dutchInterest };
    sandbox.geoWarning = inputs.geoWarning || '';
    sandbox.geoReductionLabel = inputs.geoReductionLabel || '';
    return sandbox.__core(inputs);
  };
  captureSource = 'deploy/rtl-sizer.html (inline, pre-extraction)';
}

// ── Scenario matrix ─────────────────────────────────────────────────
const BASE = {
  lt: 'bridge', fr: 740, exp: 8, pt: 'sfr',
  pp: 400000, arv: 0, rb: 0, term: 12, purp: 'purchase',
  zhvi: '', sa: 'other', state: 'WA',
  geoWarning: '', geoReductionLabel: '',
  targetLoanAmt: '', dutchInterest: '',
};
const REHAB = { lt: 'light', pp: 300000, rb: 100000, arv: 550000 };
const S = (name, over) => ({ name, inputs: { ...BASE, ...over } });

const SCENARIOS = [
  S('base-bridge-740-tier1', {}),
  // FICO spread bands (680+ matrix path)
  S('bridge-fico-720', { fr: 725 }),
  S('bridge-fico-700', { fr: 705 }),
  S('bridge-fico-680', { fr: 685 }),
  // Products
  S('light-rehab',   { ...REHAB }),
  S('heavy-rehab',   { ...REHAB, lt: 'heavy' }),
  S('construction',  { ...REHAB, lt: 'construction', rb: 400000, arv: 800000 }),
  S('construction-90ltc-rb-over-500k', { ...REHAB, lt: 'construction', rb: 600000, arv: 1200000, pp: 500000 }),
  // Experience tiers
  S('exp-tier2', { exp: 5 }),
  S('exp-tier3', { exp: 1 }),
  S('exp-tier3-light', { ...REHAB, exp: 0 }),
  // Property type
  S('mfr-bridge', { pt: 'mfr' }),
  S('mfr-heavy',  { ...REHAB, lt: 'heavy', pt: 'mfr' }),
  // Region adjustments
  S('region-nynj', { sa: 'nynj', state: 'NJ' }),
  S('region-ca',   { sa: 'ca', state: 'CA' }),
  // ZHVI
  S('zhvi-200', { zhvi: '200' }),
  S('zhvi-300', { zhvi: '300' }),
  // Term
  S('term-19-24', { term: 19 }),
  // Refis
  S('refi-cashout',  { purp: 'cashout', pp: 500000 }),
  S('refi-rateterm', { purp: 'rateterm', pp: 500000 }),
  S('refi-zhvi-200', { purp: 'cashout', pp: 500000, zhvi: '200' }),
  S('refi-geo-reduction', { purp: 'cashout', pp: 500000, geoReductionLabel: 'Geographic reduction: Lee County FL — leverage reduced 5%.' }),
  S('err-refi-sub-680', { purp: 'cashout', fr: 665 }),
  // Sub-680 SLA-funded purchase bands
  S('sub680-660-679', { fr: 665 }),
  S('sub680-640-659', { fr: 645 }),
  S('sub680-620-639', { fr: 625 }),
  S('sub680-550-619', { fr: 580 }),
  S('err-fico-below-550', { fr: 500 }),
  // Geo signals
  S('geo-reduction-purchase', { geoReductionLabel: 'Geographic reduction: Baltimore MD — leverage reduced 5%.' }),
  S('geo-warning-flag', { geoWarning: 'Orange County NY — guideline-excluded geography.' }),
  // LO target + Dutch
  S('target-loan-cap', { targetLoanAmt: 200000 }),
  // Deploy 236.526 — Admin Sandbox: Target Loan Amount ABOVE the guideline max
  // is honored (bLabel 'Admin Override'). Normal path floors to the cap.
  S('admin-sandbox-over-cap', { ...REHAB, targetLoanAmt: 900000, adminSandbox: true }),
  S('dutch-interest-light', { ...REHAB, dutchInterest: 'dutch' }),
  S('non-dutch-light',     { ...REHAB, dutchInterest: 'nondutch' }),
  // Size tiers
  S('size-over-2m', { pp: 3200000 }),
  S('size-over-3m', { pp: 4500000 }),
  S('size-cap-3.5m', { pp: 6000000 }),
  // Stacked
  S('stack-heavy-mfr-zhvi300-tier3', { ...REHAB, lt: 'heavy', pt: 'mfr', zhvi: '300', exp: 2, term: 19 }),
];

const results = {};
for (const sc of SCENARIOS) {
  let out;
  try { out = runScenario(sc.inputs); }
  catch (e) { out = { __threw: String(e && e.message) }; }
  results[sc.name] = out;
}

mkdirSync(join(root, 'scripts', 'fixtures'), { recursive: true });
const outPath = join(root, 'scripts', 'fixtures', 'rtl-golden.json');
writeFileSync(outPath, JSON.stringify({
  generatedAt: new Date().toISOString(),
  source: captureSource,
  scenarios: SCENARIOS,
  results,
}, null, 2));

let priced = 0, errored = 0, threw = 0;
for (const [name, r] of Object.entries(results)) {
  if (r.__threw) { threw++; console.log('THREW  ' + name + ': ' + r.__threw); }
  else if (r.rErr) { errored++; console.log('ERROR  ' + name + ': ' + String(r.rErr).slice(0, 80)); }
  else {
    priced++;
    console.log('PRICED ' + name + ': rate=' + (r.rate * 100).toFixed(3) + '% bMax=' + r.bMax +
      ' (' + r.bLabel + ') pts=' + r.p + (r.floor ? ' [floor]' : ''));
  }
}
console.log('\n' + priced + ' priced, ' + errored + ' error-branch, ' + threw + ' threw → ' + outPath);
if (threw > 0) process.exit(1);
