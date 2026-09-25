#!/usr/bin/env node
/**
 * scripts/portfolio-longapp-test.mjs -- Deploy 237.268 (Mike)
 *
 * "in portfolio loans on the loan app it asks for the information on all properties. Address,
 * Bedrooms, Bathrooms, sq footage, estimated property value, existing debt if any, monthly rent,
 * annual taxes, annual insurance, annual HOA. Those should all be put into the property/collateral
 * section for that property and then summed up in the Portfolio total."
 *
 * What would hurt, so what this guards (the real code is loaded and RUN, not grepped):
 *   1. The application (borrower-info.html, its functions lifted into a vm): a portfolio shows one
 *      card per property with the ten answers, hides the loan-level beds / baths / sq ft, locks the
 *      loan-level rent / taxes / insurance / HOA / value / debt to the portfolio sums, re-sums on
 *      every answer, packs the cards as properties[] for the server (and unpacks them on load),
 *      prefills the cards from the loan's rows, and reviews every property + the total on the
 *      signing page. A single-property application is untouched.
 *   2. The sync (borrower-info-sync, RUN in the harness): the answers land on the loan's Property /
 *      Collateral rows by position, the LO's other fields and extra rows survive, a blank answer
 *      never clears an LO value, annual becomes monthly to the cent, the tab count / flags are set,
 *      the loan-level beds / baths / sq ft are NOT written for a portfolio, and a re-run writes
 *      nothing.
 *   3. The prefill (borrower-prefill): a portfolio loan hands over its rows, annual from monthly.
 *   4. The signed application PDF (RUN with pdfkit stubbed): every property and the totals print;
 *      a single-property application prints no portfolio section.
 *
 * Run: node scripts/portfolio-longapp-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as PF from '../deploy/netlify/functions/_shared/portfolio-properties.mjs';
import { applyLoanPrefill } from '../deploy/netlify/functions/_shared/borrower-prefill.mjs';

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

// ── the harness: every static AND dynamic import → a synthetic module from the stub table ──
async function loadFunction(file, stubs, extraGlobals) {
  const src = readFn(file);
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, clearTimeout, process: { env: {} } }, extraGlobals || {}));
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
  const mod = new vm.SourceTextModule(src, {
    context: ctx, identifier: file,
    importModuleDynamically: async (spec) => { const m = synth(spec); await m.link(() => {}); await m.evaluate(); return m; },
  });
  await mod.link(async (spec) => synth(spec));
  await mod.evaluate();
  return mod.namespace;
}
const storesFrom = (data, log) => ({ getStore: ({ name }) => {
  data[name] = data[name] || {};
  const s = data[name];
  return {
    get: async (k, o) => (k in s ? (o && o.type === 'json' && typeof s[k] === 'string' ? JSON.parse(s[k]) : JSON.parse(JSON.stringify(s[k]))) : null),
    setJSON: async (k, v) => { s[k] = JSON.parse(JSON.stringify(v)); if (log) log.push(name + ':' + k); },
    set: async (k, v) => { s[k] = v; },
    delete: async (k) => { delete s[k]; },
    list: async () => ({ blobs: Object.keys(s).map((key) => ({ key })) }),
  };
} });
const REAL_PF = Object.assign({}, PF);

// ── fixtures ──────────────────────────────────────────────────────────────────
const ROW0 = { address: '12 Elm St, Spokane, WA 99201', bedrooms: '3', bathrooms: '2', sqft: '1800', propValue: '400000', existingDebt: '', monthlyRent: '2500', annualTaxes: '3600', annualInsurance: '1500', annualHoa: '600' };
const ROW1 = { address: '40 Oak Ave, Spokane, WA 99203', bedrooms: '4', bathrooms: '2.5', sqft: '1500', propValue: '325000', existingDebt: '180000', monthlyRent: '1800', annualTaxes: '3000', annualInsurance: '1200', annualHoa: '' };
const flat = (rows) => { const d = {}; rows.forEach((r, i) => Object.keys(r).forEach((k) => { d['p' + i + '_' + k] = r[k]; })); return d; };

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n1. portfolio-properties: the rows, the sums, the merge, the prefill');
{
  const rows = PF.applicationProperties({ properties: [Object.assign({}, ROW0, { evil: 'x', address: 'A'.repeat(300) }), ROW1, 'junk', ...Array(9).fill({ address: 'more' })] });
  check('at most 10 rows, known fields only, address capped at 200', [rows.length, Object.keys(rows[0]).sort(), rows[0].address.length, rows[2].address], [10, PF.APP_PROPERTY_FIELDS.slice().sort(), 200, '']);
  const t = PF.portfolioTotals([ROW0, ROW1]);
  check('the totals', t, { count: 2, bedrooms: 7, bathrooms: 4.5, sqft: 3300, propValue: 725000, existingDebt: 180000, monthlyRent: 4300, annualTaxes: 6600, annualInsurance: 2700, annualHoa: 600 });
  check('annual → monthly to the cent (blank stays blank, zero is zero)', ['3000', '1000', '', '0', '$2,400'].map(PF.monthlyFromAnnual), ['250', '83.33', '', '0', '200']);
  check('not a portfolio → no merge', [PF.mergePortfolioIntoLoan({}, { propertyType: 'sfr', properties: [ROW0] }), PF.mergePortfolioIntoLoan({}, { propertyType: 'portfolio', properties: [] })], [null, null]);
  const loan = { isPortfolio: true, propertyCount: 3, properties: [{ address: 'old', propType: 'sfh', appraisedValue: '410000', existingDebt: '150000', monthlyHoa: '10' }, { propType: '2-4' }, { address: 'LO third', propValue: '100000' }] };
  const m = PF.mergePortfolioIntoLoan(loan, { propertyType: 'portfolio', propertyCount: '2', properties: [ROW0, ROW1] });
  check('row 1: the answers land, the LO\'s propType / appraised value kept, a BLANK answer keeps the LO\'s debt, annual → monthly',
    m.properties[0], { address: ROW0.address, propType: 'sfh', appraisedValue: '410000', existingDebt: '150000', monthlyHoa: '50', bedrooms: '3', bathrooms: '2', sqft: '1800', propValue: '400000', monthlyRent: '2500', annualTaxes: '3600', annualInsurance: '1500', annualHoa: '600', monthlyTaxes: '300', monthlyInsurance: '125' });
  check('row 2: propType kept, no HOA answer → no monthlyHoa written', [m.properties[1].propType, m.properties[1].existingDebt, 'monthlyHoa' in m.properties[1], m.properties[1].monthlyTaxes], ['2-4', '180000', false, '250']);
  check('the LO\'s third row survives; count = the larger; flags set', [m.properties[2], m.propertyCount, m.isPortfolio, m.propType], [{ address: 'LO third', propValue: '100000' }, 3, true, 'portfolio']);
  check('a fresh loan (no rows) takes the application\'s count', PF.mergePortfolioIntoLoan({}, { propertyType: 'portfolio', propertyCount: '2', properties: [ROW0] }).propertyCount, 2);
  const pre = PF.loanPortfolioPrefill({ isPortfolio: true, propertyCount: 2, properties: [{ address: 'A', bedrooms: 3, monthlyTaxes: '300', monthlyInsurance: '83.33', annualHoa: '600' }] });
  check('the prefill: the loan\'s rows in the application\'s shape, annual from the MONTHLY the LO edits (x12), else the annual on file',
    pre, { propertyCount: 2, properties: [{ address: 'A', bedrooms: '3', bathrooms: '', sqft: '', propValue: '', existingDebt: '', monthlyRent: '', annualTaxes: '3600', annualInsurance: '1000', annualHoa: '600' }] });
  check('not a portfolio → no prefill', PF.loanPortfolioPrefill({ propType: 'sfr', properties: [ROW0] }), null);
}

console.log('\n2. borrower-prefill: the loan hands the application its rows');
{
  const pf = applyLoanPrefill({ property: {}, loan: {} }, { isPortfolio: true, propType: 'portfolio', propertyCount: 2, properties: [{ address: 'A', monthlyTaxes: '300' }, { address: 'B' }], taxes: '' });
  check('isPortfolio + count + rows', [pf.loan.isPortfolio, pf.loan.propertyCount, pf.loan.properties.map((p) => p.address), pf.loan.properties[0].annualTaxes], [true, 2, ['A', 'B'], '3600']);
  const single = applyLoanPrefill({ property: {}, loan: {} }, { propType: 'sfr', bedrooms: '3', taxes: '250' });
  check('a single-property loan: isPortfolio false, no rows, everything else as before', [single.loan.isPortfolio, 'properties' in single.loan, single.property.bedrooms, single.loan.annualTaxes], [false, false, '3', 3000]);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n3. borrower-info-sync RUN: the answers land on the loan\'s Property / Collateral rows');
{
  const writes = [];
  const world = { clients: { 'owner/c_1': { id: 'c_1', email: 'b@x.com', loans: [
    { id: 'l_1', isPortfolio: true, propType: 'portfolio', propertyCount: 2, bedrooms: '9', sqft: '9999', properties: [{ address: 'old', propType: 'sfh', appraisedValue: '410000', existingDebt: '150000' }, {}] },
  ] } } };
  const sync = await loadFunction('_shared/borrower-info-sync.mjs', {
    '@netlify/blobs': storesFrom(world, writes),
    './notes-log.mjs': { appendNoteEntry: async () => {} },
    './clients-index.mjs': { upsertClient: async () => {}, upsertClientStrict: async () => {} },
    './pg-mirror.mjs': { mirror: { upsertClientWithLoansStrict: async () => {} } },
    './address.mjs': { parseAddress: () => ({}) },
    './portfolio-properties.mjs': REAL_PF,
  });
  const record = { ownerKey: 'owner', clientId: 'c_1', loanId: 'l_1', data: { loanType: 'dscr', propertyType: 'portfolio', propertyCount: '2', properties: [ROW0, ROW1], bedrooms: '3', sqft: '1500', currentLoanAmount: '180000', dscrPurchaseRefi: 'refinance' } };
  await sync.syncPropertyFieldsToLoan(record);
  const loan = world.clients['owner/c_1'].loans[0];
  check('row 1 on the loan: the answers, the LO\'s appraised value / propType / debt kept, monthly derived',
    [loan.properties[0].address, loan.properties[0].appraisedValue, loan.properties[0].propType, loan.properties[0].existingDebt, loan.properties[0].monthlyTaxes, loan.properties[0].monthlyRent],
    [ROW0.address, '410000', 'sfh', '150000', '300', '2500']);
  check('row 2 on the loan', [loan.properties[1].address, loan.properties[1].existingDebt, loan.properties[1].monthlyInsurance], [ROW1.address, '180000', '100']);
  check('flags / count / propType', [loan.isPortfolio, loan.propertyCount, loan.propType], [true, 2, 'portfolio']);
  check('the loan-level beds / sq ft NOT written for a portfolio (they live per property)', [loan.bedrooms, loan.sqft], ['9', '9999']);
  check('the other loan-level answers still flow (current loan amount = the portfolio\'s debt total)', [loan.currentLoanAmt, loan.purchaseOrRefi], ['180000', 'refinance']);
  check('one client write', writes, ['clients:owner/c_1']);
  await sync.syncPropertyFieldsToLoan(record);
  check('a re-run with the same answers writes nothing', writes.length, 1);

  // a single-property application is untouched by all this
  world.clients['owner/c_2'] = { id: 'c_2', loans: [{ id: 'l_2', propType: 'sfr', bedrooms: '1' }] };
  await sync.syncPropertyFieldsToLoan({ ownerKey: 'owner', clientId: 'c_2', loanId: 'l_2', data: { propertyType: 'sfr', bedrooms: '3', sqft: '1500', properties: [] } });
  const l2 = world.clients['owner/c_2'].loans[0];
  check('single property: beds / sq ft written as before, no portfolio fields', [l2.bedrooms, l2.sqft, l2.propType, 'properties' in l2, 'isPortfolio' in l2], ['3', '1500', 'sfr', false, false]);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n4. the signed application PDF RUN: every property + the totals');
{
  const texts = [];
  function FakeDoc() {
    const d = {
      y: 54, x: 54, page: { width: 612, height: 792, margins: { top: 54, bottom: 54, left: 54, right: 54 } }, _h: {}, pages: 1,
      on(ev, cb) { (d._h[ev] = d._h[ev] || []).push(cb); return proxy; },
      text(s) { texts.push(String(s)); d.y += 12; return proxy; },
      addPage() { d.pages++; d.y = 54; (d._h.pageAdded || []).forEach((cb) => cb()); return proxy; },
      moveDown(n) { d.y += 12 * (n || 1); return proxy; },
      moveUp() { return proxy; },
      end() { (d._h.data || []).forEach((cb) => cb(Buffer.from('%PDF-fake'))); (d._h.end || []).forEach((cb) => cb()); },
      widthOfString() { return 50; }, heightOfString() { return 12; }, currentLineHeight() { return 12; },
      bufferedPageRange() { return { start: 0, count: d.pages }; },
    };
    const proxy = new Proxy(d, { get(t, k) { if (k in t) return t[k]; if (typeof k === 'string') return () => proxy; return undefined; } });
    return proxy;
  }
  const pdf = await loadFunction('_shared/loan-application-pdf.mjs', {
    'pdfkit': { default: FakeDoc },
    './esign.mjs': { ESIGN_CONSENT_TEXT: 'esign', LOAN_ACKNOWLEDGEMENT_TEXT: 'ack', PREQUAL_CREDIT_AUTH_TEXT: 'prequal', INFO_RELEASE_AUTH_TEXT: 'release' },
    './crypto.mjs': { decryptField: () => '' },
    './address.mjs': { parseAddress: () => ({}) },
    './portfolio-properties.mjs': REAL_PF,
  });
  const base = { borrowerFirstName: 'Pat', borrowerLastName: 'Lee', loanType: 'dscr', dscrPurchaseRefi: 'refinance', propertyAddress: ROW0.address, guarantors: [{ firstName: 'Pat', lastName: 'Lee', email: 'p@x.com' }] };
  const render = async (data) => {
    texts.length = 0;
    const r = await pdf.renderSignedApplicationWithPages({ record: { data, prefill: {} }, client: null, signers: [], status: 'complete', unsigned: true, enteredBy: { name: 'LO', email: 'lo@x.com', at: '2026-09-24T00:00:00Z' } });
    return { r, all: texts.join('\n') };
  };
  const pfOut = await render(Object.assign({}, base, { propertyType: 'portfolio', propertyCount: '2', properties: [ROW0, ROW1], currentRent: '4300', currentValue: '725000', currentLoanAmount: '180000', annualTaxes: '6600' }));
  assert('the PDF rendered', pfOut.r && pfOut.r.buffer && pfOut.r.buffer.length > 0);
  assert('the Portfolio Properties section, both addresses', /PORTFOLIO PROPERTIES \(2\)/.test(pfOut.all) && pfOut.all.indexOf(ROW0.address) > 0 && pfOut.all.indexOf(ROW1.address) > 0);
  assert('each property\'s beds / baths / sq ft, value / debt, rent, annual taxes / insurance / HOA', /3 bd \/ 2 ba \/ 1,800 sq ft/.test(pfOut.all) && /\$400,000 \/ none/.test(pfOut.all) && /\$325,000 \/ \$180,000/.test(pfOut.all) && /\$3,600 \/ \$1,500 \/ \$600/.test(pfOut.all) && /\$3,000 \/ \$1,200 \/ —/.test(pfOut.all));
  assert('the Portfolio Totals', /PORTFOLIO TOTALS/.test(pfOut.all) && /7 bd \/ 4\.5 ba \/ 3,300 sq ft/.test(pfOut.all) && /\$725,000/.test(pfOut.all) && /\$4,300/.test(pfOut.all) && /\$6,600/.test(pfOut.all) && /\$2,700/.test(pfOut.all));
  const singleOut = await render(Object.assign({}, base, { propertyType: 'sfr', bedrooms: '3' }));
  assert('a single-property application prints no portfolio section', singleOut.all.indexOf('PORTFOLIO PROPERTIES') < 0 && singleOut.all.indexOf('PORTFOLIO TOTALS') < 0);
}

// ═══════════════════════════════════════════════════════════════════════════════
console.log('\n5. borrower-info.html: the cards, the locked totals, pack / hydrate / prefill / review (functions lifted and RUN)');
{
  const src = read('borrower-info.html');
  function lift(name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('not found: function ' + name);
    let depth = 0, i = src.indexOf('{', start);
    for (; i < src.length; i++) { if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) { i++; break; } }
    return src.slice(start, i);
  }
  const vars = ['PF_FIELDS', 'PF_LOCK_TITLE'].map((v) => { const m = src.match(new RegExp('^var ' + v + ' = .*;$', 'm')); if (!m) throw new Error('not found: var ' + v); return m[0]; }).join('\n');
  const fns = ['escAttr', 'escH', 'formatMoneyDisplay', 'field', 'pfNum', 'pfCount', 'hydratePropertyFields', 'pfCollectRows', 'pfComputeTotals', 'pfTotalsInner', 'pfApplyTotals', 'pfLockOpts',
    'renderPortfolioBlock', 'renderPage3', 'renderPage5', 'packDataForSave', 'applyPrefillToData', 'mapPropType', 'onFieldChange'].map(lift).join('\n');
  const ctx = vm.createContext({ console, STATE: { data: {}, prefill: {}, companies: [] }, REVIEW_MODE: true, scheduleAutoSave() {}, document: { getElementById: () => null, querySelectorAll: () => [] } });
  vm.runInContext(vars + '\n' + fns, ctx);
  const run = (code) => vm.runInContext(code, ctx);
  const setData = (d) => { ctx.STATE.data = JSON.parse(JSON.stringify(d)); return ctx.STATE.data; };
  const inputOf = (html, id) => { const m = html.match(new RegExp('<input [^>]*id="' + id + '"[^>]*>')); return m ? m[0] : ''; };
  const labelHasReq = (html, id) => { const m = html.match(new RegExp('<label for="' + id + '">[^<]*(<span class="req">)?')); return !!(m && m[1]); };

  // page 3: a DSCR refinance portfolio of two
  let d = setData(Object.assign({ loanType: 'dscr', propertyType: 'portfolio', propertyCount: '2', dscrPurchaseRefi: 'refinance', propertyAddress: ROW0.address, bedrooms: '3', sqft: '1500' }, flat([ROW0, ROW1])));
  let html = run('renderPage3()');
  check('two property cards, the count select, the totals box', [(html.match(/class="pf-prop"/g) || []).length, !!inputOf(html, 'f_p0_address'), /<select id="f_propertyCount"/.test(html), /id="pfTotals"/.test(html)], [2, true, true, true]);
  assert('the address card input carries the Google autocomplete hook', /data-sla-autocomplete/.test(inputOf(html, 'f_p0_address')));
  check('the loan-level beds / baths / sq ft / lot size are gone', [inputOf(html, 'f_bedrooms'), inputOf(html, 'f_bathrooms'), inputOf(html, 'f_sqft'), inputOf(html, 'f_lotSize')], ['', '', '', '']);
  check('every card answer present (card 2)', PF.APP_PROPERTY_FIELDS.map((k) => !!inputOf(html, 'f_p1_' + k)), PF.APP_PROPERTY_FIELDS.map(() => true));
  check('required: address / beds / baths / sq ft / value, and rent / taxes / insurance for a rental; not debt / HOA',
    ['address', 'bedrooms', 'bathrooms', 'sqft', 'propValue', 'monthlyRent', 'annualTaxes', 'annualInsurance', 'existingDebt', 'annualHoa'].map((k) => labelHasReq(html, 'f_p0_' + k)),
    [true, true, true, true, true, true, true, true, false, false]);
  const locked = (id) => { const i = inputOf(html, id); const v = (i.match(/value="([^"]*)"/) || [])[1]; return [/ disabled /.test(i), v, /title="Total of the properties above"/.test(i)]; };
  check('rent / taxes / insurance / HOA / value / debt locked to the sums', [locked('f_currentRent'), locked('f_annualTaxes'), locked('f_annualInsurance'), locked('f_annualHOA'), locked('f_currentValue'), locked('f_currentLoanAmount')],
    [[true, '$4,300', true], [true, '$6,600', true], [true, '$2,700', true], [true, '$600', true], [true, '$725,000', true], [true, '$180,000', true]]);
  check('...and not required (computed)', ['f_currentRent', 'f_annualTaxes', 'f_currentValue', 'f_currentLoanAmount'].map((id) => labelHasReq(html, id)), [false, false, false, false]);
  check('the sums are the loan-level answers (what the review, the PDF and the sync read)', [d.currentRent, d.annualTaxes, d.annualInsurance, d.annualHOA, d.currentValue, d.currentLoanAmount], ['4300', '6600', '2700', '600', '725000', '180000']);
  assert('the totals box: count, beds / baths, sq ft, money', /Properties<strong>2</.test(html) && /Bedrooms \/ Bathrooms<strong>7 \/ 4\.5</.test(html) && /Square Footage<strong>3,300</.test(html) && /Monthly Rent<strong>\$4,300</.test(html));

  // property 1 starts as the page-2 address
  d = setData({ loanType: 'dscr', propertyType: 'portfolio', propertyCount: '1', dscrPurchaseRefi: 'purchase', propertyAddress: '9 Pine Rd, Spokane, WA 99208' });
  html = run('renderPage3()');
  check('property 1 seeded from the page-2 address; a purchase portfolio still asks the purchase price', [d.p0_address, (inputOf(html, 'f_p0_address').match(/value="([^"]*)"/) || [])[1], !!inputOf(html, 'f_purchasePrice')], ['9 Pine Rd, Spokane, WA 99208', '9 Pine Rd, Spokane, WA 99208', true]);

  // a fix & flip portfolio: rent / taxes / insurance optional
  setData(Object.assign({ loanType: 'fix_flip', propertyType: 'portfolio', propertyCount: '2' }, flat([ROW0, ROW1])));
  html = run('renderPage3()');
  check('fix & flip portfolio: rent / taxes / insurance not required, value still is', ['monthlyRent', 'annualTaxes', 'annualInsurance', 'propValue'].map((k) => labelHasReq(html, 'f_p0_' + k)), [false, false, false, true]);

  // a single property: untouched
  d = setData({ loanType: 'dscr', propertyType: 'sfr', dscrPurchaseRefi: 'refinance', bedrooms: '3', currentRent: '2000' });
  html = run('renderPage3()');
  check('single property: beds / sq ft asked, no cards, rent editable and required, nothing locked', [!!inputOf(html, 'f_bedrooms'), !!inputOf(html, 'f_sqft'), (html.match(/class="pf-prop"/g) || []).length, / disabled /.test(inputOf(html, 'f_currentRent')), labelHasReq(html, 'f_currentRent'), d.currentRent], [true, true, 0, false, true, '2000']);

  // pack for the server / unpack on load
  d = setData(Object.assign({ loanType: 'dscr', propertyType: 'portfolio', propertyCount: '2', g0_firstName: 'Pat', p5_address: 'beyond the count' }, flat([ROW0, ROW1])));
  let out = run('packDataForSave()');
  check('packed: properties[] = the rows within the count, the p<i>_ keys stripped, guarantors as before', [out.properties.length, out.properties[1].address, Object.keys(out).filter((k) => /^p\d+_/.test(k)), out.propertyCount, out.guarantors[0].firstName], [2, ROW1.address, [], '2', 'Pat']);
  check('packed row 1 has every field as a string', out.properties[0], ROW0);
  setData({ loanType: 'dscr', propertyType: 'sfr', propertyCount: '2', p0_address: 'left over' });
  out = run('packDataForSave()');
  check('leaving portfolio mode clears the rows and the count', [out.properties, out.propertyCount, 'p0_address' in out], [[], '', false]);
  const hyd = { propertyType: 'portfolio', propertyCount: '2', properties: [ROW0, ROW1], p0_bedrooms: '5' };
  run('hydratePropertyFields(' + JSON.stringify(hyd) + ')');
  ctx.H = hyd; run('hydratePropertyFields(H)');
  check('hydrated on load: properties[] → p<i>_ keys, an answer already in hand kept', [hyd.p0_address, hyd.p1_annualTaxes, hyd.p0_bedrooms], [ROW0.address, '3000', '5']);

  // prefill from the loan's rows
  d = setData({ p0_bedrooms: '5' });
  ctx.STATE.prefill = { borrower: {}, property: { address: 'A', propType: 'portfolio' }, loan: { toolType: 'dscr', isBrokerLoan: false, isPortfolio: true, propertyCount: 2, properties: [{ address: 'A', bedrooms: '3', annualTaxes: '3600' }, { address: 'B', monthlyRent: '1800' }] }, companies: [] };
  run('applyPrefillToData()');
  check('prefill: portfolio mode, the count, the cards from the loan\'s rows, the borrower\'s own answer kept', [d.propertyType, d.propertyCount, d.p0_address, d.p0_bedrooms, d.p0_annualTaxes, d.p1_monthlyRent], ['portfolio', '2', 'A', '5', '3600', '1800']);

  // an answer re-sums the totals
  d = setData(Object.assign({ loanType: 'dscr', propertyType: 'portfolio', propertyCount: '2' }, flat([ROW0, ROW1])));
  ctx.EL = { name: 'p0_monthlyRent', type: 'text', value: '$3,000', getAttribute: (k) => (k === 'data-money' ? '1' : null) };
  run('onFieldChange(EL)');
  check('typing a rent re-sums the portfolio rent', [d.p0_monthlyRent, d.currentRent], ['3000', '4800']);

  // the review page
  d = setData(Object.assign({ loanType: 'dscr', propertyType: 'portfolio', propertyCount: '2', propertyAddress: ROW0.address, bedrooms: '3', currentRent: '4300', annualTaxes: '6600' }, flat([ROW0, ROW1])));
  html = run('renderPage5()');
  assert('the review lists every property and the Portfolio Total, not the single-property beds row', /Portfolio Properties \(2\)/.test(html) && html.indexOf(ROW0.address) > 0 && html.indexOf(ROW1.address) > 0 && /Portfolio Total/.test(html) && /Total Monthly Rent<\/div><div class="rv-value">\$4,300/.test(html) && !/rv-label">Bedrooms</.test(html));
  d = setData({ loanType: 'dscr', propertyType: 'sfr', bedrooms: '3', propertyAddress: 'X' });
  html = run('renderPage5()');
  assert('a single-property review is as before', /rv-label">Bedrooms</.test(html) && html.indexOf('Portfolio') < 0);
}

console.log(fail ? '\n' + fail + ' FAILED' : '\nall green');
process.exit(fail ? 1 : 0);
