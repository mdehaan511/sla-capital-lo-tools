#!/usr/bin/env node
/**
 * scripts/valuation-doc-test.mjs -- Deploy 237.275 (Mike)
 *
 * "We need to add BPO AIV or Appraisal AIV to RTLs on the financials page and make sure we grab
 * that from the appropriate document when uploaded and use that for the Colchis and Trade tapes
 * ... several loans on the recent trade tape had the wrong AIV." Then, on 4113 Rambling Road:
 * "it grabbed the old ARV for the Colchis Tape. Make it always grab the BPO ARV and if that isnt
 * available leave it blank."
 *
 * What went wrong, so what this guards (real code RUN, not grepped):
 *   1. The loan's aivBpo / arvBpo are SHARED fields: the BPO / appraisal read writes them (with
 *      <key>FromBpo), but the RTL sizer's AIV box and the Property tab write them too. The tape
 *      printed a typed estimate as the Third Party AIV (11415 Prairie: the borrower's $360,000
 *      ARV) and fell back to the borrower's ARV (4113 Rambling Road). docValue: a figure counts
 *      only from a document, an underwriter's matching override, or a Baseline import.
 *   2. The Colchis + Stride tapes: document AIV / ARV, else the tray's own reading, else BLANK.
 *   3. The export's review walk: a loan with no DOCUMENT ARV is walked too, and the tray's
 *      repaired value is read (each figure from the first tray that read it).
 *   4. Loan Financials: _ldDocVal / _ldValKind lifted and RUN; the grid shows AIV (BPO|Appraisal)
 *      and ARV off the document only.
 *   5. The sizer save (RUN): a document AIV survives a sizer save that typed a different number;
 *      a typed AIV is still the sizer's to change.
 *   6. admin-valuation-backfill (RUN): puts a tray's already-read AIV / ARV on the loan through
 *      writeFieldProposals, no AI; dry run by default; leaves document figures alone; appraisal
 *      after BPO; As-Is as the AIV for older trays; DSCR / hidden / N/A trays ignored; admin only.
 *
 * Run: node scripts/valuation-doc-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { TRADE_TAPES, entityNameOf, docValue } from '../deploy/netlify/functions/_shared/trade-tapes.mjs';
import { fieldsForSlug } from '../deploy/netlify/functions/_shared/uw-field-map.mjs';

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
const DEPLOY = new URL('../deploy/', import.meta.url);
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');
const readFn = (p) => readFileSync(new URL(p, FN), 'utf8');
const keySafe = (s) => String(s || '').replace(/[:/\\]/g, '_').replace(/^\.+/, '').slice(0, 128);
const jsonStub = (status, body) => ({ status, body, ok: status < 400, json: async () => body });

async function loadFunction(file, stubs) {
  const src = readFn(file);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, clearTimeout, process: { env: {} }, URL, Date, JSON, Math });
  const namesFor = (spec) => {
    const wanted = new Set();
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m;
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + esc + '[\'"]', 'g');
    while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => wanted.add(n));
    const dre = new RegExp('const\\s*\\{([^}]*)\\}\\s*=\\s*await import\\([\'"]' + esc + '[\'"]\\)', 'g');
    while ((m = dre.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s*:\s*/)[0]).filter(Boolean).forEach((n) => wanted.add(n));
    Object.keys(stubs[spec] || {}).forEach((n) => wanted.add(n));
    return [...wanted];
  };
  const synth = (spec) => {
    const table = stubs[spec] || {};
    const names = namesFor(spec);
    return new vm.SyntheticModule(names, function () { names.forEach((n) => this.setExport(n, (n in table) ? table[n] : (() => undefined))); }, { context: ctx, identifier: spec });
  };
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file,
    importModuleDynamically: async (spec) => { const m = synth(spec); await m.link(() => {}); await m.evaluate(); return m; } });
  await mod.link(async (spec) => synth(spec));
  await mod.evaluate();
  return mod.namespace;
}
const req = (body, headers) => ({ method: 'POST', url: 'https://x/api', headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || '' }, text: async () => JSON.stringify(body), body });
const storesFrom = (data, writes) => ({ getStore: ({ name }) => {
  data[name] = data[name] || {};
  const s = data[name];
  return {
    get: async (k) => (k in s ? JSON.parse(JSON.stringify(s[k])) : null),
    setJSON: async (k, v) => { s[k] = JSON.parse(JSON.stringify(v)); if (writes) writes.push(name + ':' + k); },
    list: async () => ({ blobs: Object.keys(s).map((key) => ({ key })) }),
  };
} });

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n1. docValue: which figures are a valuation document\'s');
{
  check('read off a BPO / appraisal', docValue({ aivBpo: '226660', aivBpoFromBpo: true }, 'aivBpo'), 226660);
  check('typed in the sizer / Property tab (11415 Prairie: the borrower\'s ARV)', docValue({ id: 'l_1788552250159_lyqa', aivBpo: '360000' }, 'aivBpo'), null);
  check('set by underwriting, marker still matching', docValue({ arvBpo: '300000', arvBpoUwOverride: { value: '300000', replaced: '325000' } }, 'arvBpo'), 300000);
  check('a stale marker (the field moved since) does not vouch for it', docValue({ arvBpo: '310000', arvBpoUwOverride: { value: '300000' } }, 'arvBpo'), null);
  check('a Baseline IMPORT\'s valuation of record counts; a native loan merely synced to Baseline (17 Farnwood carries _baselineRaw) does not vouch for a typed AIV',
    [docValue({ id: 'l_baseline_SLA-1084', aivBpo: '150000' }, 'aivBpo'), docValue({ id: 'l_1787966135075_sb5ntt', _baselineRaw: {}, aivBpo: '290000' }, 'aivBpo')], [150000, null]);
  check('blank / zero is nothing', [docValue({ aivBpo: '', aivBpoFromBpo: true }, 'aivBpo'), docValue({ aivBpo: '0', aivBpoFromBpo: true }, 'aivBpo'), docValue(null, 'aivBpo')], [null, null, null]);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n2. the Colchis + Stride tapes: document AIV / ARV, else the tray, else blank');
const ctxOf = (loan, extra) => Object.assign({ sla: 'SLA-1', ownerKey: 'jeremy', params: {}, client: { firstName: 'A', lastName: 'B' }, guarantors: [],
  loan: Object.assign({ id: 'l_1', address: '4113 Rambling Road, Morristown, TN, 37814', propType: 'sfr', loanPurpose: 'purchase', fundingDate: '2026-09-18',
    purchasePrice: '145000', rehabBudget: '40000', loanAmt: '170000', rate: '11', dutchInterest: 'dutch', entityName: 'X LLC', exitStrategy: 'sell' }, loan) }, extra || {});
const colchis = (c) => { const t = TRADE_TAPES.colchis_trade.build([c]); const hdr = t.sheets[0].rows[0], row = t.sheets[0].rows[1];
  const get = (name) => { const v = row[hdr.indexOf(name)]; return (v && typeof v === 'object' && 'v' in v) ? v.v : v; }; return { get, missing: t.missing }; };
const stride = (c) => { const t = TRADE_TAPES.stride_rtl.build([c]); const hdr = t.sheets[0].rows[0].map((h) => (h && typeof h === 'object') ? h.t : h), row = t.sheets[0].rows[1];
  const get = (name) => { const v = row[hdr.indexOf(name)]; return (v && typeof v === 'object' && 'v' in v) ? v.v : v; }; return { get, missing: t.missing }; };
{
  // 4113 Rambling Road as the 9/22 tape saw it: the BPO read 226,660 / 265,000 but the loan never got them
  let c = ctxOf({ arv: '230000', propValue: '230000' }, { reviewValuation: { aiv: 226660, arv: 265000, kind: 'bpo', valuationDate: '', valuationProvider: '', valuationType: '', valuationSqft: '' } });
  let t = colchis(c);
  check('Rambling Road: AIV + ARV are the BPO\'s (off the tray), never the borrower\'s ARV', [t.get('Third Party AIV'), t.get('Third Party ARV'), t.get('LTARV')], [226660, 265000, Number((170000 / 265000).toFixed(4))]);
  c = ctxOf({ arv: '230000', propValue: '230000' }, { reviewValuation: { aiv: 226660, arv: 0, kind: 'bpo' } });
  t = colchis(c);
  check('no BPO ARV anywhere: Third Party ARV BLANK (was the borrower\'s 230,000), LTARV has no cached value', [t.get('Third Party ARV'), t.get('LTARV')], ['', undefined]);
  // 11415 Prairie: the sizer's AIV box held the borrower's 360,000; the BPO read failed
  c = ctxOf({ id: 'l_1788552250159_lyqa', aivBpo: '360000', arv: '360000', propValue: '360000', purchasePrice: '290000', loanAmt: '270000', rehabBudget: '25000' });
  t = colchis(c);
  check('Prairie: the typed 360,000 is NOT printed as the Third Party AIV or ARV', [t.get('Third Party AIV'), t.get('Third Party ARV'), t.get('Third Party Valuation Type')], ['', '', '']);
  assert('...and the blank AIV is reported for hand-fill', t.missing.some((m) => /Third Party AIV/.test(m)));
  c = ctxOf({ aivBpo: '130000', aivBpoFromBpo: true, arvBpo: '325000', arvBpoFromBpo: true, arv: '400000' });
  t = colchis(c);
  check('a loan whose BPO values landed: those, and the type says BPO', [t.get('Third Party AIV'), t.get('Third Party ARV'), t.get('Third Party Valuation Type')], [130000, 325000, 'BPO']);
  c = ctxOf({ aivBpo: '360000', arvBpo: '300000', arvBpoUwOverride: { value: '300000' } }, { reviewValuation: { aiv: 290000, arv: 0, kind: 'bpo' } });
  t = colchis(c);
  check('a typed AIV loses to the tray\'s reading; an underwriter\'s ARV stands', [t.get('Third Party AIV'), t.get('Third Party ARV')], [290000, 300000]);
  // Stride RTL: same two columns
  let s = stride(ctxOf({ aivBpo: '360000', arv: '360000' }));
  check('Stride RTL: a typed AIV / the borrower\'s ARV are blank', [s.get('AIV'), s.get('ARV'), s.get('Appraisal Type')], ['', '', '']);
  assert('...and flagged for hand-fill', s.missing.some((m) => /\bAIV\b/.test(m)) && s.missing.some((m) => /\bARV\b/.test(m)));
  s = stride(ctxOf({ aivBpo: '226660', aivBpoFromBpo: true, arvBpo: '265000', arvBpoFromBpo: true }));
  check('Stride RTL: the BPO\'s figures', [s.get('AIV'), s.get('ARV'), s.get('Appraisal Type')], [226660, 265000, 'BPO']);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n3. the export\'s review walk reads the tray\'s ARV, for any loan without a document ARV');
{
  const reviews = {};
  const exp = await loadFunction('trade-tape-export.mjs', {
    '@netlify/blobs': { getStore: ({ name }) => name === 'loan_reviews' ? { list: async () => ({ blobs: Object.keys(reviews).map((key) => ({ key })) }), get: async (k) => reviews[k] } : { get: async () => null } },
    './_shared/borrower-info-keys.mjs': { loadRecord: async () => null },
    './_shared/trade-tapes.mjs': { TRADE_TAPES, entityNameOf, docValue },
  });
  const ef = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? { found: false, value: null } : { found: true, value: String(v) }]));
  reviews.r1 = { source: { loanId: 'l_rambling' }, docs: { bpo_valuation: { verdict: 'approved', aiExtractedEntities: { asIsValue: '226660' }, aiExtractedFields: ef({ aivBpo: 226660, arvBpo: 265000, valuationType: 'BPO' }) } } };
  reviews.r2 = { source: { loanId: 'l_both' }, docs: {
    appraisal: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 300000, arvBpo: null, valuationDate: '2026-09-01', valuationProvider: 'ABC Appraisals' }) },
    bpo_valuation: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 280000, arvBpo: 410000, valuationProvider: 'Clear Capital' }) } } };
  reviews.r3 = { source: { loanId: 'l_hidden' }, docs: { bpo_valuation: { hidden: true, aiExtractedFields: ef({ aivBpo: 1, arvBpo: 2 }) } } };
  const withMeta = (loan) => Object.assign(loan, { uwData: { valuationDate: { value: '2026-09-01' }, valuationProvider: { value: 'Clear Capital' }, valuationType: { value: 'BPO' } } });
  const a = ctxOf(withMeta({ id: 'l_rambling', arv: '230000' }));
  const b = ctxOf(withMeta({ id: 'l_both' }));
  const d = ctxOf(withMeta({ id: 'l_docs', aivBpo: '130000', aivBpoFromBpo: true, arvBpo: '325000', arvBpoFromBpo: true }));
  const e = ctxOf(withMeta({ id: 'l_hidden', aivBpo: '100000', aivBpoFromBpo: true }));
  await exp.attachLongAppAndValuation([a, b, d, e]);
  check('Rambling (nothing on the loan): the tray\'s AIV AND ARV', a.reviewValuation && [a.reviewValuation.aiv, a.reviewValuation.arv, a.reviewValuation.kind], [226660, 265000, 'bpo']);
  check('appraisal + BPO: the appraisal\'s AIV, the BPO\'s ARV (the appraisal read none), the appraisal\'s date / provider', b.reviewValuation && [b.reviewValuation.aiv, b.reviewValuation.arv, b.reviewValuation.kind, b.reviewValuation.valuationProvider], [300000, 410000, 'appraisal', 'ABC Appraisals']);
  check('a loan with both document figures and its metadata is not walked', d.reviewValuation, undefined);
  check('a hidden tray gives nothing', e.reviewValuation, undefined);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n4. Loan Financials: AIV (BPO | Appraisal) and ARV off the document only');
{
  const src = read('loan-details.js');
  const lift = (name) => { const start = src.indexOf('function ' + name + '('); if (start < 0) throw new Error('missing ' + name);
    let depth = 0, i = src.indexOf('{', start); for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { i++; break; } } return src.slice(start, i); };
  const ctx = vm.createContext({});
  vm.runInContext(lift('_ldDocVal') + '\n' + lift('_ldValKind'), ctx);
  ctx.L = { aivBpo: '360000', arv: '360000' };
  check('the typed estimate shows as nothing (—)', vm.runInContext('_ldDocVal(L, "aivBpo")', ctx), 0);
  ctx.L = { aivBpo: '$226,660', aivBpoFromBpo: true, arvBpo: '265000', arvBpoFromBpo: true, uwData: { valuationType: { value: 'BPO' } } };
  check('read off the BPO: the figures, labeled BPO', vm.runInContext('[_ldDocVal(L, "aivBpo"), _ldDocVal(L, "arvBpo"), _ldValKind(L)]', ctx), [226660, 265000, 'BPO']);
  ctx.L = { aivBpo: '300000', aivBpoFromBpo: true, uwData: { valuationType: { value: 'Appraisal' } } };
  check('read off an appraisal: labeled Appraisal', vm.runInContext('[_ldDocVal(L, "aivBpo"), _ldValKind(L)]', ctx), [300000, 'Appraisal']);
  ctx.L = { arvBpo: '300000', arvBpoUwOverride: { value: '300000' }, id: 'l_x' };
  check('an underwriter\'s ARV counts; a Baseline import\'s AIV counts', [vm.runInContext('_ldDocVal(L, "arvBpo")', ctx), vm.runInContext('_ldDocVal({ id: "l_baseline_SLA-1", aivBpo: "150000" }, "aivBpo")', ctx)], [300000, 150000]);
  // the grid reads them (a string-built render: check the cells are wired to the document values)
  assert('the grid\'s AIV / ARV come from _ldDocVal', /var _aivBpoNum\s+= _ldDocVal\(l, 'aivBpo'\);/.test(src) && /var _arvBpoNum\s+= _ldDocVal\(l, 'arvBpo'\);/.test(src));
  assert('the AIV cell and the ARV cell are labeled by the document', src.indexOf(`'<div class="fin-cell"><div class="fin-label">AIV (' + _valKind + ')</div>`) > 0 && src.indexOf(`'<div class="fin-cell"><div class="fin-label">ARV (' + _valKind + ')</div>`) > 0);
  assert('no raw aivBpo / arvBpo read left in the grid', !/parseFloat\(l\.aivBpo\)|parseFloat\(l\.arvBpo\)/.test(src));
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n5. the sizer save (RUN): a document AIV survives a typed one');
{
  const world = {}; const writes = [];
  const stores = storesFrom(world, writes);
  const mod = await loadFunction('sizer-save-loan.mjs', {
    '@netlify/blobs': stores,
    './_shared/auth.mjs': { handleOptions: () => null, json: jsonStub, requireAuth: async () => ({ email: 'lo@slacapital.com' }), readJsonBody: async (r) => JSON.parse(await r.text()), keySafe, normalizeEmail: (s) => String(s || '').trim().toLowerCase() },
    './_shared/access.mjs': { canOverrideOwner: () => ({ ok: true }) },
    './_shared/client-write.mjs': { writeClient: async (ownerKey, client) => { world.clients[ownerKey + '/' + keySafe(client.id)] = JSON.parse(JSON.stringify(client)); writes.push('writeClient:' + client.id); } },
    './_shared/loan-change-log.mjs': { diffLoan: () => [], recordLoanChanges: async () => {} },
  });
  const save = mod.default;
  const seed = (loan) => { world.clients = { 'lo@slacapital.com/c_1': { id: 'c_1', email: 'b@x.com', loans: [Object.assign({ id: 'l_1', toolType: 'rtl', address: '1 A St', status: 'active', createdAt: '2026-09-01' }, loan)] } }; };
  const run = async (loanIn) => { const r = await save(req({ toolType: 'rtl', editingClientId: 'c_1', editingLoanId: 'l_1', loan: Object.assign({ address: '1 A St', loanAmt: '170000' }, loanIn), borrower: { email: 'b@x.com' } }), {});
    return { status: r.status, loan: (world.clients['lo@slacapital.com/c_1'].loans || [])[0] || {}, writes: writes.slice() }; };
  seed({ aivBpo: '226660', aivBpoFromBpo: true, aivBpoBpoAt: '2026-09-16T00:40:05Z' });
  let r = await run({ aivBpo: '240000' });
  check('BPO AIV 226,660 + a sizer save typing 240,000 -> the loan keeps the BPO\'s, flagged', [r.status, r.loan.aivBpo, r.loan.aivBpoFromBpo, r.loan.aivBpoBpoAt], [200, '226660', true, '2026-09-16T00:40:05Z']);
  assert('...and the save really wrote THAT loan (no new client, no new loan)', r.writes.indexOf('writeClient:c_1') >= 0 && Object.keys(world.clients).length === 1 && world.clients['lo@slacapital.com/c_1'].loans.length === 1, JSON.stringify(r.writes));
  seed({ aivBpo: '300000', aivBpoUwOverride: { value: '300000', replaced: '280000' } });
  r = await run({ aivBpo: '350000' });
  check('an underwriter\'s AIV is kept too', [r.loan.aivBpo, !!r.loan.aivBpoUwOverride], ['300000', true]);
  seed({ aivBpo: '360000' });
  r = await run({ aivBpo: '340000' });
  check('a typed AIV (no document) is still the sizer\'s to change', [r.loan.aivBpo, r.loan.aivBpoFromBpo], ['340000', undefined]);
  assert('...every save reached the loan', r.writes.filter(function (w) { return w === 'writeClient:c_1'; }).length >= 3, JSON.stringify(r.writes));
  seed({ aivBpo: '226660', aivBpoFromBpo: true });
  r = await run({ aivBpo: '' });
  check('an empty sizer box keeps it (as before)', r.loan.aivBpo, '226660');
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n6. admin-valuation-backfill (RUN): the tray\'s reading onto the loan, no AI');
{
  // the REAL buildProposals (uw-field-write loaded with its own imports stubbed)
  const uwWrite = await loadFunction('_shared/uw-field-write.mjs', {});
  const calls = [];
  const world = {};
  const mod = await loadFunction('admin-valuation-backfill.mjs', {
    '@netlify/blobs': storesFrom(world),
    './_shared/auth.mjs': { handleOptions: () => null, json: jsonStub, readJsonBody: async (r) => JSON.parse(await r.text()), keySafe, normalizeEmail: (s) => String(s || '').trim().toLowerCase(),
      requireAuth: async (ctx, r) => (r.headers.get('x-who') === 'none' ? null : { email: r.headers.get('x-who') === 'lo' ? 'lo@slacapital.com' : 'mike@slacapital.com' }),
      isAdmin: (u) => /^mike@/.test(u.email) },
    './_shared/uw-field-map.mjs': { fieldsForSlug },
    './_shared/uw-field-write.mjs': { buildProposals: uwWrite.buildProposals, writeFieldProposals: async (src, props, actor) => { calls.push({ loanId: src.loanId, props: props.map((p) => p.key + '=' + p.value), actor }); return props.length; } },
  });
  const ef = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v == null ? { found: false, value: null } : { found: true, value: String(v), where: 'p.1' }]));
  const src = (loanId, clientId) => ({ kind: 'existing', ownerKey: 'jeremy@slacapital.com', clientId, loanId });
  world.loan_reviews = {
    r_ram: { loanType: 'rtl', address: '4113 Rambling Road', source: src('l_ram', 'c_ram'), docs: { bpo_valuation: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 226660, arvBpo: 265000, asIsPrice: 226660 }) } } },
    r_par: { loanType: 'rtl', source: src('l_par', 'c_par'), docs: { bpo_valuation: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 229000, arvBpo: 289000 }) } } },
    r_two: { loanType: 'rtl', source: src('l_two', 'c_two'), docs: { bpo_valuation: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 280000, arvBpo: 410000 }) }, appraisal: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 300000, arvBpo: null }) } } },
    r_old: { loanType: 'rtl', source: src('l_old', 'c_old'), docs: { bpo_valuation: { verdict: 'approved', aiExtractedFields: ef({ asIsPrice: 154000 }) } } },
    r_done: { loanType: 'rtl', source: src('l_done', 'c_done'), docs: { bpo_valuation: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 130000, arvBpo: 325000 }) } } },
    r_dscr: { loanType: 'dscr', source: src('l_dscr', 'c_dscr'), docs: { appraisal: { verdict: 'approved', aiExtractedFields: ef({ aivBpo: 500000, asIsPrice: 500000 }) } } },
    r_na: { loanType: 'rtl', source: src('l_na', 'c_na'), docs: { bpo_valuation: { verdict: 'na', aiExtractedFields: ef({ aivBpo: 1 }) }, appraisal: { hidden: true, aiExtractedFields: ef({ aivBpo: 2 }) } } },
    r_fail: { loanType: 'rtl', source: src('l_fail', 'c_fail'), docs: { bpo_valuation: { verdict: 'approved', aiError: 'malformed_verdict', aiExtractedFields: ef({ aivBpo: null, arvBpo: null }) } } },
  };
  const client = (cid, loan) => ({ id: cid, loans: [Object.assign({ id: cid.replace('c_', 'l_'), address: cid }, loan)] });
  world.clients = {
    'jeremy@slacapital.com/c_ram': client('c_ram', { arv: '230000' }),
    'jeremy@slacapital.com/c_par': client('c_par', { aivBpo: '229000' }),                       // typed, same number
    'jeremy@slacapital.com/c_two': client('c_two', {}),
    'jeremy@slacapital.com/c_old': client('c_old', {}),
    'jeremy@slacapital.com/c_done': client('c_done', { aivBpo: '130000', aivBpoFromBpo: true, arvBpo: '300000', arvBpoUwOverride: { value: '300000' } }),
    'jeremy@slacapital.com/c_dscr': client('c_dscr', {}),
    'jeremy@slacapital.com/c_na': client('c_na', {}),
    'jeremy@slacapital.com/c_fail': client('c_fail', {}),
  };
  const post = (body, who) => mod.default(req(body, { 'x-who': who || 'admin' }), {});
  check('not signed in -> 401; an LO -> 403', [(await post({}, 'none')).status, (await post({}, 'lo')).status], [401, 403]);
  let r = await post({});
  check('a dry run by default: nothing written', [r.body.dryRun, calls.length], [true, 0]);
  const rows = Object.fromEntries(r.body.loans.map((x) => [x.loanId, x.after]));
  check('Rambling Road: the BPO\'s AIV and ARV', rows.l_ram, { aivBpo: { value: '226660', from: 'bpo_valuation' }, arvBpo: { value: '265000', from: 'bpo_valuation' } });
  check('a typed AIV is replaced by the reading (even the same number, so it carries the BPO flag); the ARV added', rows.l_par, { aivBpo: { value: '229000', from: 'bpo_valuation' }, arvBpo: { value: '289000', from: 'bpo_valuation' } });
  check('BPO + appraisal: the appraisal\'s AIV (applied last), the BPO\'s ARV', rows.l_two, { aivBpo: { value: '300000', from: 'appraisal' }, arvBpo: { value: '410000', from: 'bpo_valuation' } });
  check('an older tray with only an As-Is answer: that is the AIV', rows.l_old, { aivBpo: { value: '154000', from: 'bpo_valuation' } });
  check('document / underwriting figures already on the loan, DSCR, N/A, hidden and failed trays: untouched', ['l_done', 'l_dscr', 'l_na', 'l_fail'].filter((id) => rows[id]), []);
  check('counts', [r.body.withReading, r.body.alreadyOnLoan, r.body.loans.length], [5, 1, 4]);
  r = await post({ dryRun: false, loanIds: ['l_two', 'l_ram'] });
  check('dryRun:false writes through writeFieldProposals, BPO then appraisal, as the admin', calls.map((c) => c.loanId + ' ' + c.props.join(',') + ' ' + c.actor),
    ['l_ram aivBpo=226660,arvBpo=265000 mike@slacapital.com', 'l_two aivBpo=280000,arvBpo=410000 mike@slacapital.com', 'l_two aivBpo=300000 mike@slacapital.com']);
  check('...only the loans asked for', [r.body.updated, r.body.loans.map((x) => x.loanId).sort()], [2, ['l_ram', 'l_two']]);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall green');
process.exit(fail ? 1 : 0);
