#!/usr/bin/env node
/**
 * scripts/review-path-run-test.mjs — Deploy 237.223 (Mike)
 *
 * Mike: "after the BPO was reviewed the BPO AIV and ARV aren't reviewed."
 *
 * The REAL cause, found on 634 Luna Court: the background reviewer -- the path every big
 * BPO / appraisal / bank statement takes, and every re-grade the truth refresher queues --
 * extracted the fields and then threw `ReferenceError: user is not defined` at the write,
 * inside that write's own try/catch. Deploy 236.818 (Aug 31) had moved `const user` into
 * an `if` block. Three weeks of AIV / ARV / credit scores / liquidity accounts, all thrown
 * away, and no error anywhere a person looks.
 *
 * `node --check` cannot see an undeclared identifier. The 236.980 lesson ("every review
 * entry point must wire extraction itself") was checked by grep, and grep saw the call.
 * So this gate RUNS the functions: the real module source is loaded as an ES module with
 * every import replaced by a stub, a request is sent through the default export, and
 * what reaches writeFieldProposals is checked -- on both credentials the background
 * function accepts.
 *
 * Needs --experimental-vm-modules (vm.SourceTextModule); re-launches itself with it.
 * Run: node scripts/review-path-run-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { fieldsForSlug } from '../deploy/netlify/functions/_shared/uw-field-map.mjs';
import { TRADE_TAPES } from '../deploy/netlify/functions/_shared/trade-tapes.mjs';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const read = (p) => readFileSync(new URL(p, FN), 'utf8');

// ── the harness: a function file, its imports stubbed, run for real ─────────
// Each stub table maps an import specifier to the named exports the file asks for. A name
// the file imports but the table leaves out becomes a no-op returning undefined, so a new
// import never breaks the harness -- only a new BEHAVIOUR the test depends on does.
async function loadFunction(file, stubs, log) {
  const src = read(file);
  const ctx = vm.createContext({ console: { log() {}, warn: (...a) => log.push(['warn', a.join(' ')]), error: (...a) => log.push(['error', a.join(' ')]) }, Buffer, setTimeout, fetch: async () => ({ ok: true }), process: { env: {} }, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp });
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const exportsObj = {};
    wanted.forEach((n) => { exportsObj[n] = (n in table) ? table[n] : (() => undefined); });
    const syn = new vm.SyntheticModule(Object.keys(exportsObj), function () { Object.keys(exportsObj).forEach((k) => this.setExport(k, exportsObj[k])); }, { context: ctx, identifier: spec });
    return syn;
  });
  await mod.evaluate();
  return mod.namespace.default;
}

// A world: one review with a BPO tray, its bytes, and a recorder for every write.
function world(opts) {
  opts = opts || {};
  const review = {
    id: 'r_1', loanType: 'rtl', address: '634 Luna Court', aiCostCents: 0,
    source: { kind: 'existing', clientId: 'c_1', loanId: 'l_1', ownerKey: 'chance_at_slacapital_com' },
    sourceLoanSnapshot: { loanAmt: '206000', purchasePrice: '140000' },
    docs: { bpo_valuation: { currentDocId: 'd_1', label: 'BPO / Valuation', aiReviewing: true, documents: [{ docId: 'd_1', mimeType: 'application/pdf' }] } },
  };
  const w = { review, writes: [], proposals: [], reviewCalls: [], log: [] };
  const stores = {
    'loan_reviews': { get: async () => JSON.parse(JSON.stringify(w.review)), setJSON: async (k, v) => { w.review = v; w.writes.push(k); } },
    'loan-review-docs': { getWithMetadata: async () => ({ data: new Uint8Array([37, 80, 68, 70]).buffer, metadata: { mimeType: 'application/pdf' } }) },
  };
  const nullStore = { get: async () => null, getWithMetadata: async () => null, setJSON: async () => {} };
  w.stubs = {
    '@netlify/blobs': { getStore: ({ name }) => stores[name] || nullStore },
    './_shared/auth.mjs': {
      handleOptions: () => null,
      json: (status, body) => ({ status, body }),
      requireAuth: async () => opts.user === undefined ? { email: 'Dee@SLAcapital.com', role: 'processor' } : opts.user,
      readJsonBody: async (req) => req.body,
      isProcessor: () => true,
      keySafe: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_'),
      normalizeEmail: (s) => String(s || '').trim().toLowerCase(),
    },
    './_shared/loan-review-checklists.mjs': { getChecklist: () => [{ slug: 'bpo_valuation', label: 'BPO / Valuation', conditions: 'Read the values.' }], staleAfterFor: () => '', expectedMortgagee: () => '' },
    './_shared/anthropic-doc-review.mjs': {
      reviewDocument: async (o) => { w.reviewCalls.push(o); return { verdict: 'approved', summary: 'fine', findings: [], extractedEntities: {}, costCents: 3,
        extractedFields: { aivBpo: { found: true, value: '130000', where: 'p.1' }, arvBpo: { found: true, value: '325000', where: 'p.1' }, valuationDate: { found: false, value: null } } }; },
    },
    './_shared/doc-integrity.mjs': { analyzeDocIntegrity: () => null, classifyDocCategory: () => 'valuation', mergeIntegrity: () => null },
    './_shared/uw-field-map.mjs': { fieldsForSlug },
    './_shared/uw-field-write.mjs': {
      buildProposals: (spec, ef, label) => { const out = []; Object.keys(ef || {}).forEach((k) => { if (ef[k] && ef[k].found === true && ef[k].value != null) out.push({ dataset: (spec.find((s) => s.key === k) || {}).dataset, key: k, value: ef[k].value, aiNote: label }); }); return out.length ? out : null; },
      writeFieldProposals: async (source, props, actor) => { w.proposals.push({ source, props, actor, reviewSavesBefore: w.writes.length }); return props.length; },
      bpoAlertFor: () => null, felonyAlertFor: () => null,
    },
    './_shared/review-truth.mjs': { internalBgSig: () => 'SIG-r_1-bpo', queueEntityNameDependents: async () => {}, guarantorIdNames: () => [], queueIdNameDependents: async () => {} },
    './_shared/doc-naming.mjs': { applyCanonicalDocName: () => {} },
    './_shared/guidelines-text.mjs': { guidelinesTextFor: async () => null },
    './_shared/review-tray-save.mjs': { saveTrayFresh: async (store, id, slug, docState, mut) => { const fresh = JSON.parse(JSON.stringify(w.review)); fresh.docs[slug] = docState; mut(fresh); await store.setJSON(id, fresh); return fresh; } },
  };
  w.request = (headers, body) => ({ method: 'POST', headers: { get: (k) => headers[k.toLowerCase()] || '' }, body: body || { reviewId: 'r_1', slug: 'bpo_valuation' } });
  return w;
}

// ── 1. the background reviewer ──────────────────────────────────────────────
console.log('\nloan-review-ai-background: what it extracts reaches the loan');
{
  let w = world();
  let fn = await loadFunction('loan-review-ai-background.mjs', w.stubs, w.log);
  let res = await fn(w.request({ authorization: 'Bearer jwt' }), {});
  check('staff JWT: 200', res.status, 200);
  check('...asked the AI for the tray\'s fields, the BPO\'s own values among them', ['aivBpo', 'arvBpo'].filter((k) => !(w.reviewCalls[0].extractFields || []).some((f) => f.key === k)), []);
  check('...and WROTE them (this was the three-week silence)', w.proposals.length, 1);
  check('...the BPO\'s own values, to the loan', w.proposals[0].props.filter((p) => p.dataset === 'loan').map((p) => p.key + '=' + p.value), ['aivBpo=130000', 'arvBpo=325000']);
  check('...as the person who asked', w.proposals[0].actor, 'dee@slacapital.com');
  check('...after the review was saved (a write failure can never lose the review)', [w.proposals[0].reviewSavesBefore >= 1, w.review.docs.bpo_valuation.aiReviewing], [true, false]);
  check('no swallowed error on the way', w.log.filter((l) => l[0] === 'error'), []);

  w = world({ user: null }); // no JWT at all: only the internal signature can get in
  fn = await loadFunction('loan-review-ai-background.mjs', w.stubs, w.log);
  res = await fn(w.request({ 'x-sla-internal': 'SIG-r_1-bpo' }), {});
  check('internal signature (the truth refresher\'s re-grade): 200', res.status, 200);
  check('...also writes what it extracted', w.proposals.length, 1);
  check('...as the AI, since no person is behind a re-grade', w.proposals[0].actor, '');
  check('no swallowed error on that path either', w.log.filter((l) => l[0] === 'error'), []);

  w = world({ user: null });
  fn = await loadFunction('loan-review-ai-background.mjs', w.stubs, w.log);
  res = await fn(w.request({ 'x-sla-internal': 'WRONG' }), {});
  check('a bad signature and no JWT is refused', [res.status, w.proposals.length, w.reviewCalls.length], [401, 0, 0]);
}

// ── 2. the retry endpoint, same harness ─────────────────────────────────────
console.log('\nloan-review-ai-retry: same contract');
{
  const w = world();
  w.review.docs.bpo_valuation.aiReviewing = false;
  const fn = await loadFunction('loan-review-ai-retry.mjs', w.stubs, w.log);
  const res = await fn(w.request({ authorization: 'Bearer jwt' }), {});
  check('200', res.status, 200);
  check('writes what it extracted, as the person', [w.proposals.length, w.proposals[0] && w.proposals[0].actor], [1, 'dee@slacapital.com']);
  check('no swallowed error', w.log.filter((l) => l[0] === 'error'), []);
}

// ── 3. the same class of bug, statically, in every review path ──────────────
console.log('\nNo review path reads an identifier that was declared inside a block');
{
  // Block-scoped `const user` used after its block. Cheap to check for exactly this shape;
  // the run above is the real guard, this names the pattern for the next person.
  const bad = [];
  ['loan-review-ai-background.mjs', 'loan-review-ai-retry.mjs', 'loan-review-doc-upload.mjs', 'borrower-intake-upload.mjs', 'loan-review-refresh-background.mjs'].forEach((f) => {
    const s = read(f).split('\n');
    let depthDecl = -1, depth = 0;
    s.forEach((raw, i) => {
      const line = raw.replace(/\s*\/\/.*$/, ''); // the fix's own comment says "was user.email"
      const opens = (line.match(/\{/g) || []).length, closes = (line.match(/\}/g) || []).length;
      if (/^\s*const user = await requireAuth/.test(line)) depthDecl = depth + (line.indexOf('{') >= 0 ? 1 : 0);
      depth += opens - closes;
      if (depthDecl >= 0 && depth < depthDecl) depthDecl = -2; // the block that declared it has closed
      if (depthDecl === -2 && /[^A-Za-z_.]user\.(email|role)/.test(line)) bad.push(f + ':' + (i + 1));
    });
  });
  check('every `user.email` is inside the scope that declared it', bad, []);
}

// ── 4. LTAIV = initial advance, everywhere it is computed ───────────────────
console.log('\nLTAIV means the initial advance over as-is, in every place that computes it');
{
  const calcSrc = readFileSync(new URL('../deploy/loan-uw-calc.js', import.meta.url), 'utf8');
  const c = { window: {} }; vm.createContext(c); vm.runInContext(calcSrc, c);
  const v = c.window.SLA_UW_CALC.computeUwCalcs({ loanAmt: 206000, rate: 0.11, renovation: 89000, asIsValue: 130000, arv: 325000, purchasePrice: 140000 }).values;
  check('the underwriting engine: (206,000 − 89,000) ÷ 130,000', [v.ltaiv.toFixed(4), v.initialAdvance], ['0.9000', 117000]);
  check('...LTC and LTARV still use the full loan', [v.ltc.toFixed(4), v.ltarv.toFixed(4)], [(206000 / 229000).toFixed(4), (206000 / 325000).toFixed(4)]);
  check('...no rehab: the advance IS the loan', c.window.SLA_UW_CALC.computeUwCalcs({ loanAmt: 100000, renovation: 0, asIsValue: 125000 }).values.ltaiv, 0.8);
  const tape = TRADE_TAPES.colchis_trade.build([{ sla: 'SLA-1', loan: { loanAmt: '206000', rehabBudget: '89000', aivBpo: '130000', purchasePrice: '140000', arvBpo: '325000' }, client: {} }]);
  const hdr = tape.sheets[0].rows[0], row = tape.sheets[0].rows[1];
  const cell = (name) => { const i = hdr.indexOf(name); return i < 0 ? undefined : row[i]; };
  check('the Colchis tape: the same 90.00%', cell('LTAIV') && cell('LTAIV').v, 0.9);
  check('...beside an Initial LTC on the same basis and a Total LTC on the full loan', [cell('Initial LTC').v, cell('Total LTC').v], [Number((117000 / 140000).toFixed(4)), Number((206000 / 229000).toFixed(4))]);
  const sub = readFileSync(new URL('../deploy/loan-submissions.js', import.meta.url), 'utf8');
  assert('the RTL submission template already divides the INITIAL loan column by AIV', /AQ: LTAIV = AF \/ S/.test(sub) && /AP: Initial LTC = AF/.test(sub));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
