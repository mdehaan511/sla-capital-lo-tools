#!/usr/bin/env node
/**
 * scripts/uw-metrics-test.mjs — Deploy 237.222 (Mike)
 *
 * The key-metrics panel on Documents > Underwriting (deploy/loan-uw-metrics.js).
 *
 * Mike: "we want to add in these items as the important metrics we need to track. We
 * don't need to show the US Citizen or Marital Status. We do want to have the loan amount
 * and hold back amount just to verify they are correct. All of this information should be
 * read from and import from documents as they're uploaded. The current larger underwriting
 * tab in the Loan Details is meant to be replaced by this."
 *
 * What would actually hurt, so what this guards:
 *   1. A SECOND set of numbers. An LTARV here that differs from the Underwriting tab's, in
 *      a domain where a wrong ratio is a wrong loan. The panel must own no formulas: with
 *      no valuation read, every calculated value equals the tab's, to the character.
 *   2. An AI-read value passing as fact. Unverified values are counted, marked, and carry
 *      Confirm; a value a person typed beats the AI's reading of the same document.
 *   3. A click that edits the WRONG cell. Both renderers use the same cell markup, and
 *      document.querySelector finds the hidden tab's copy first.
 *   4. "As they're uploaded" quietly not happening, or a refresh folding in another
 *      loan's numbers, or swapping the page's loan object out from under it.
 *
 * The real files are loaded into a VM and RUN. Run: node scripts/uw-metrics-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

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
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');

// ── a page: the four real files, in the order loan-details.html loads them ───
function page(opts) {
  opts = opts || {};
  const timers = [];
  const w = {
    console: { warn() {}, log() {} },
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].dead = true; },
    JSON, Math, Object, Array, String, Number, isFinite, parseInt, parseFloat, Date, Promise,
    showToast() {},
  };
  w.window = w;
  w.document = opts.document || { getElementById: () => null, querySelector: () => { throw new Error('document.querySelector used'); }, createElement: () => ({ setAttribute() {}, appendChild() {} }), createTextNode: (t) => t, head: { appendChild() {} } };
  vm.createContext(w);
  ['loan-uw-fields.js', 'loan-uw-calc.js', 'loan-uw-tab.js', 'loan-uw-metrics.js'].forEach((f) => vm.runInContext(read(f), w, { filename: f }));
  w.__timers = timers;
  return w;
}
const flat = (b) => b.sections.reduce((a, s) => a.concat(s.rows), []);
const row = (b, key) => flat(b).filter((r) => r.key === key)[0];
const plain = (x) => JSON.parse(JSON.stringify(x));

const RTL = () => ({
  id: 'l_1', toolType: 'rtl', loanType: 'Light Rehab', loanAmt: '648750', rate: '10.625', points: '2', brokerFee: '0',
  purchasePrice: '865000', rehabBudget: '0', arv: '865000', fico: '760', experience: '5', propType: 'sfr',
  uwData: {
    titleEscrowFees: { value: '4672.50', by: 'dee@slacapital.com', byName: 'Dee', at: '2026-09-01T00:00:00Z' },
    lowCredit:    { value: '787', isAI: true, verified: false, aiNote: 'Credit Report — p.1', by: 'ai', byName: 'AI' },
    middleCredit: { value: '793', isAI: true, verified: true,  aiNote: 'Credit Report — p.1', by: 'ai', byName: 'AI' },
    account1: { value: { type: 'Checking/Savings', balance: 160545.13 }, isAI: true, verified: false, aiNote: 'Bank Statement (acct 1)' },
    account2: { value: { type: 'Checking/Savings', balance: 96151.08, weight: 1 }, by: 'dee@slacapital.com', byName: 'Dee' },
    emd: { value: '25000', isAI: true, verified: false, aiNote: 'EMD Receipt' },
  },
});

// ── 1. the sheet ────────────────────────────────────────────────────────────
console.log('\nThe sheet Mike sent, in its order');
let w = page();
let b = w.SLA_UW_METRICS.build(RTL());
assert('the panel builds', !!b && b.program === 'rtl');
check('Underwriting rows', plain(b.sections[0].rows.map((r) => r.label)),
  ['ARV', 'As-is Price', 'Purchase Price', 'Assignment Fee', 'Down Payment', 'Title/Escrow Fees', 'Low Credit', 'Middle Credit',
    'Monthly Payment', 'LTARV', 'LTC', 'LTAIV', 'Assignment to Purchase', 'Loan Amount', 'Holdback']);
check('US Citizen and Marital Status are NOT shown', flat(b).filter((r) => /citizen|marital/i.test(r.label + r.key)).length, 0);
check('Liquidity rows: accounts in use + ONE blank, then EMD, Total, Requirement',
  plain(b.sections[1].rows.map((r) => r.key)), ['account1', 'account2', 'account3', 'emd', 'liquidityTotal', 'liquidityRequirement']);
check('where each comes from, as the sheet says', plain(['purchasePrice', 'downPayment', 'titleEscrowFees', 'lowCredit', 'emd'].map((k) => row(b, k).from)),
  ['PSA / Assignment', 'Term Sheet', 'HUD Statement', 'Credit Report', 'EMD Receipt from Title']);
check('Loan Amount and Holdback come off the loan, and cannot be edited here', plain(['loanAmount', 'constructionHoldback'].map((k) => [row(b, k).display, row(b, k).editable])), [['$648,750', false], ['$0', false]]);

// ── 2. ONE set of numbers ───────────────────────────────────────────────────
console.log('\nThe panel owns no formulas');
{
  const loan = RTL(); loan.uwData.asIsPrice = { value: '865000', by: 'dee', byName: 'Dee' };
  const T = w.SLA_UW_TAB, F = w.SLA_UW_FIELDS;
  const calc = T.computeCalc(loan, loan.uwData);
  const tab = {}; F.fieldsFor('rtl', 'uw').forEach((f) => { if (f.source === 'calc') tab[f.key] = String(T.resolve(f, loan, loan.uwData, calc).value); });
  const pb = w.SLA_UW_METRICS.build(loan);
  const keys = ['monthlyPayment', 'ltarv', 'ltc', 'ltaiv', 'assignmentToPurchase', 'liquidityTotal', 'liquidityRequirement'];
  check('every calculated value equals the Underwriting tab\'s, to the character', plain(keys.map((k) => row(pb, k).display)), keys.map((k) => tab[k]));
  check('...and they are the sheet\'s numbers (75% / $5,744)', [row(pb, 'ltarv').display, row(pb, 'monthlyPayment').display], ['75.00%', '$5,744']);
  check('the red flags are the tab\'s flags', plain(keys.map((k) => row(pb, k).flag)), keys.map((k) => !!T.resolve(F.fieldsFor('rtl', 'uw').filter((f) => f.key === k)[0], loan, loan.uwData, calc).flag));
  const cc = T.calcContext(loan, loan.uwData);
  check('Down Payment, when no document gave one, is the ENGINE\'s figure (not a second formula)', [row(pb, 'downPayment').display, cc.downPaymentDerived], ['$' + Math.round(cc.downPayment).toLocaleString('en-US'), true]);
  const src = read('loan-uw-metrics.js').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"\\])\/\/[^\n]*/g, '$1');
  assert('no ratio or payment is computed in the panel file', !/\/\s*12\b|\* ?0\.20|\/ ?365|loanAmt\s*\/|\/\s*num\(loan\.arv/.test(src));
}

// ── 3. the valuation ────────────────────────────────────────────────────────
console.log('\nARV and As-is come from the valuation once one is read');
{
  let loan = RTL();
  let pb = w.SLA_UW_METRICS.build(loan);
  check('no valuation yet: the term-sheet ARV, labelled as exactly that', plain([row(pb, 'arv').display, row(pb, 'arv').from, /term-sheet ARV/.test(row(pb, 'arv').prov)]), ['$865,000', 'Term Sheet', true]);
  loan = RTL(); loan.arvBpo = '800000'; loan.aivBpo = '700000';
  pb = w.SLA_UW_METRICS.build(loan);
  check('valuation read: its ARV, and what the term sheet said', plain([row(pb, 'arv').display, row(pb, 'arv').from, row(pb, 'arv').note]), ['$800,000', 'BPO / Valuation', 'Term sheet says $865,000']);
  check('the ratios under it use the SAME numbers shown above them', [row(pb, 'ltarv').display, row(pb, 'ltaiv').display], [(648750 / 800000 * 100).toFixed(2) + '%', (648750 / 700000 * 100).toFixed(2) + '%']);
  check('As-is shows the valuation\'s figure', row(pb, 'asIsPrice').display, '$700,000');
  assert('the loan object was not modified to do that', loan.arv === '865000' && !loan.uwData.asIsPrice);
  loan.uwData.asIsPrice = { value: '690000', by: 'dee', byName: 'Dee' };
  check('a value a PERSON entered beats the AI\'s reading', w.SLA_UW_METRICS.build(loan).sections[0].rows[1].display, '$690,000');
  loan.uwData.asIsPrice = { value: '650000', isAI: true, verified: false };
  check('an unconfirmed AI as-is does not beat the valuation\'s own field', w.SLA_UW_METRICS.build(loan).sections[0].rows[1].display, '$700,000');
}

// ── 4. AI values are not facts ──────────────────────────────────────────────
console.log('\nUnverified AI values');
{
  b = w.SLA_UW_METRICS.build(RTL());
  check('counted: low credit, account 1, EMD (middle credit was confirmed)', b.unverified, 3);
  check('marked row by row', plain(['lowCredit', 'middleCredit', 'account1', 'account2', 'emd'].map((k) => row(b, k).unverified)), [true, false, true, false, true]);
  const h = w.SLA_UW_METRICS.html(RTL());
  check('each gets a Confirm; nothing else does', (h.match(/class="uw-confirm"/g) || []).length, 3);
  assert('the panel says so in words', /3 values were read by AI and have not been confirmed/.test(h));
  assert('an account with no saved weight counts at its TYPE default, as the tab does', /Counts \$112,382 at 70%/.test(row(b, 'account1').note), row(b, 'account1').note);
  assert('a weight a person set is kept', /Counts \$96,151 at 100%/.test(row(b, 'account2').note), row(b, 'account2').note);
}

// ── 5. Holdback, verified against the SOW ───────────────────────────────────
console.log('\nHoldback "just to verify"');
{
  const loan = RTL(); loan.rehabBudget = '60000';
  loan.uwData.rehabBudget = { value: '60000', isAI: true, verified: false };
  let r = row(w.SLA_UW_METRICS.build(loan), 'constructionHoldback');
  check('matches the SOW', plain([r.display, r.flag, r.note]), ['$60,000', false, '\u2713 Matches the SOW total']);
  loan.uwData.rehabBudget.value = '72,500';
  r = row(w.SLA_UW_METRICS.build(loan), 'constructionHoldback');
  check('does NOT match: flagged, and says what the SOW reads', plain([r.flag, r.note]), [true, 'The SOW total reads $72,500']);
  delete loan.uwData.rehabBudget;
  check('no SOW read yet: no claim either way', row(w.SLA_UW_METRICS.build(loan), 'constructionHoldback').note, '');
}

// ── 6. DSCR ─────────────────────────────────────────────────────────────────
console.log('\nA DSCR loan gets the DSCR sheet');
{
  const pb = w.SLA_UW_METRICS.build({ id: 'l_2', toolType: 'dscr', loanAmt: '300000', rate: '7', propValue: '400000', rent: '3000', taxes: '250', insurance: '100', hoa: '0', uwData: {} });
  const keys = flat(pb).map((r) => r.key);
  assert('LTV + DSCR + reserves, no RTL ratios', keys.indexOf('ltv') >= 0 && keys.indexOf('dscr') >= 0 && keys.indexOf('reservesRequirement') >= 0 && keys.indexOf('ltarv') < 0 && keys.indexOf('constructionHoldback') < 0);
  // programOf() alone would call both of these RTL. The tab's mount() refuses them; so does the panel.
  check('GUC and legacy no-toolType loans get NO panel rather than RTL math (the tab\'s own gate)',
    [w.SLA_UW_METRICS.build({ id: 'x', toolType: 'guc', loanAmt: '1', uwData: {} }), w.SLA_UW_METRICS.build({ id: 'y', loanAmt: '1', uwData: {} }), w.SLA_UW_METRICS.html({ id: 'y' })], [null, null, '']);
}

// ── 7. the click edits THIS cell ────────────────────────────────────────────
console.log('\nEditing from the panel');
{
  const h = w.SLA_UW_METRICS.html(RTL());
  assert('an editable value opens the shared editor SCOPED to the panel', /SLA_UW_TAB\._edit\('uw','titleEscrowFees',document\.getElementById\('uwMetricsPanel'\)\)/.test(h));
  assert('sizer-owned values are not clickable', !/_edit\('uw','(purchasePrice|loanAmount|arv|constructionHoldback)'/.test(h));
  assert('calculated values are not clickable', !/_edit\('uw','(ltarv|ltc|ltaiv|monthlyPayment|liquidityTotal)'/.test(h));
  // run _edit with a root: it must look in the root and never in the document
  const seen = [];
  const cell = { querySelector: (s) => (s === '.uw-edit-input' ? null : { set innerHTML(v) { seen.push('html'); }, querySelector: () => ({ focus() {}, select() {}, tagName: 'INPUT' }) }) };
  const root = { querySelector: (s) => { seen.push(s); return cell; } };
  w.SLA_UW_TAB.mount({ loan: RTL(), clientId: 'c_1', loanId: 'l_1' });
  let threw = '';
  try { w.SLA_UW_TAB._edit('uw', 'emd', root); } catch (e) { threw = e.message; }
  check('the editor looks inside the panel, not at the first match in the page', [threw, seen[0]], ['', '.uw-r-value[data-key="emd"]']);
  const hostile = RTL(); hostile.uwData.account1.value.type = '<img src=x onerror=alert(1)>';
  assert('a hostile account type is escaped', !/<img src=x/.test(w.SLA_UW_METRICS.html(hostile)));
  w.SLA_UW_METRICS._toggleAcct('account1');
  const open = w.SLA_UW_METRICS.html(RTL());
  assert('an open account row has the tab\'s three controls, scoped, and a way out', /class="uw-acct-type"/.test(open) && /class="uw-acct-bal"/.test(open) && /class="uw-acct-wt"/.test(open) &&
    /_acct\('uw','account1',document\.getElementById\('uwMetricsPanel'\)\)/.test(open) && /uwm-acct-done/.test(open));
  w.SLA_UW_METRICS._toggleAcct('account1');
}

// ── 8. "as they're uploaded" ────────────────────────────────────────────────
console.log('\nA review landing refreshes the numbers');
{
  w = page();
  const live = RTL(); live.decoratedByPage = 'keep me';
  let swapped = 0;
  w.SLA_UW_TAB.mount({ loan: live, clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', refreshLoan: () => { swapped++; } });
  const heard = [];
  w.SLA_UW_TAB.subscribe((l) => heard.push(l));
  const fresh = RTL(); fresh.arvBpo = '800000'; fresh.arvBpoFromBpo = true; fresh.loanAmt = '1'; fresh.uwData.emd.verified = true;
  check('a fresh copy is folded in', w.SLA_UW_TAB.mergeFresh(fresh), true);
  check('...IN PLACE: same object, page decorations kept, nothing swapped', [w.SLA_UW_TAB.ctx().loan === live, live.decoratedByPage, swapped], [true, 'keep me', 0]);
  check('...only what a review can change (loanAmt is the sizer\'s)', [live.arvBpo, live.arvBpoFromBpo, live.uwData.emd.verified, live.loanAmt], ['800000', true, true, '648750']);
  check('...and whoever draws this data heard about it, once', [heard.length, heard[0] === live], [1, true]);
  check('nothing changed: nobody is told', [w.SLA_UW_TAB.mergeFresh(fresh), heard.length], [false, 1]);
  const other = RTL(); other.id = 'l_OTHER'; other.arvBpo = '1';
  check('another loan\'s numbers are refused', [w.SLA_UW_TAB.mergeFresh(other), live.arvBpo], [false, '800000']);

  // refresh(): coalesced, asks for THIS client as THIS owner, picks THIS loan
  const calls = [];
  w.SLA = { Clients: { get: (id, o) => { calls.push([id, o && o.owner]); const f2 = RTL(); f2.aivBpo = '700000'; return Promise.resolve({ client: { loans: [{ id: 'l_zzz', aivBpo: '9' }, f2] }, ownerKey: 'x' }); } } };
  w.SLA_UW_METRICS.refresh(); w.SLA_UW_METRICS.refresh(); w.SLA_UW_METRICS.refresh();
  const liveTimers = w.__timers.filter((t) => !t.dead);
  check('a ZIP of twenty documents is one fetch, a beat after the review', [liveTimers.length, liveTimers[0].ms], [1, 1500]);
  liveTimers[0].fn();
  await new Promise((r) => setTimeout(r, 20));
  check('it asked for this client, as this owner', calls, [['c_1', 'chance@slacapital.com']]);
  check('and folded in THIS loan, not the first one in the file', live.aivBpo, '700000');
}

// ── 9. the Documents > Underwriting column ──────────────────────────────────
console.log('\nloan-doc-review.js gives it a column and tells it when to look');
{
  const DR = read('loan-doc-review.js');
  const a = DR.indexOf('  var _mxSig = null;'), z = DR.indexOf('\n  function renderSections(slugs) {');
  assert('the integration block was found', a > 0 && z > a);
  const mk = (review, liveLoan) => {
    const c = { _review: review, _liveLoan: liveLoan, _activeTab: 'uw', refreshed: 0, drew: [], console: { warn() {} }, Object, JSON };
    c._liveFor = (r) => (c._liveLoan && r && r.source && c._liveLoan.id === r.source.loanId) ? c._liveLoan : null;
    c._root = { querySelector: () => null };
    c.global = { SLA_UW_METRICS: { html: (l) => { c.drew.push(l.id); return '<panel>'; }, refresh: () => { c.refreshed++; } }, SLA_UW_TAB: { subscribe() {} } };
    vm.createContext(c); vm.runInContext(DR.slice(a, z), c); return c;
  };
  const rev = { source: { loanId: 'l_1' }, docs: { bpo_valuation: { aiReviewedAt: '' }, psa: { aiReviewedAt: 'T1' } } };
  let c = mk(rev, { id: 'l_1' });
  check('drawn for the loan on screen', [vm.runInContext('_metricsHtml()', c), c.drew], ['<panel>', ['l_1']]);
  vm.runInContext('_metricsAfterRender()', c);
  check('the first render is a baseline, not a change', c.refreshed, 0);
  vm.runInContext('_metricsAfterRender()', c);
  check('re-rendering with nothing new does not fetch', c.refreshed, 0);
  rev.docs.bpo_valuation.aiReviewedAt = 'T2';
  vm.runInContext('_metricsAfterRender()', c);
  check('a review landing on ANY tray does', c.refreshed, 1);
  rev.docs.bank_stmt_current = { aiReviewing: true };
  vm.runInContext('_metricsAfterRender()', c);
  rev.docs.bank_stmt_current = { aiReviewing: false, aiReviewedAt: 'T3' };
  vm.runInContext('_metricsAfterRender()', c);
  assert('...including one that finishes in the background', c.refreshed >= 2);
  c = mk({ source: { loanId: 'l_OTHER' }, docs: {} }, { id: 'l_1' });
  check('a review that is not for the loan on screen gets no panel', vm.runInContext('_metricsHtml()', c), '');
  c = mk(rev, { id: 'l_1' }); c.global.SLA_UW_METRICS = undefined;
  check('a page without the panel script is the single column it always was', vm.runInContext('_metricsHtml()', c), '');
  assert('only on the Underwriting subtab', /var _mx = \(_activeTab === 'uw'\) \? _metricsHtml\(\) : '';/.test(DR));
  assert('stacked unless the REVIEW column is wide enough (container query, not window width)', /container-type:inline-size/.test(DR) && /@container druw \(min-width: 900px\)/.test(DR) && /flex-direction:column-reverse/.test(DR));
  assert('a new review resets the baseline', /_mxSig = null;\s+\/\/ Deploy/.test(DR));
}

// ── 10. the page loads a matched set ────────────────────────────────────────
console.log('\nloan-details.html');
{
  const LD = read('loan-details.html');
  const iTab = LD.indexOf('/loan-uw-tab.js?v='), iMx = LD.indexOf('/loan-uw-metrics.js?v=');
  assert('the panel script loads AFTER the tab it depends on', iTab > 0 && iMx > iTab);
  const pin = (name) => (LD.match(new RegExp(name.replace('.', '\\.') + '\\?v=([0-9A-Za-z@]+)')) || [])[1];
  check('the three coupled files carry ONE pin (guard the function, not the namespace)', [pin('loan-uw-tab.js') === pin('loan-uw-metrics.js'), pin('loan-uw-metrics.js') === pin('loan-doc-review.js')], [true, true]);
  const need = ['computeCalc', 'calcContext', 'resolve', 'fmtDisplay', 'provText', 'programOf', 'buildChecksSummary', 'acctWeight', 'ctx', 'subscribe', 'mergeFresh'];
  check('every export the panel calls exists on SLA_UW_TAB', need.filter((k) => typeof page().SLA_UW_TAB[k] !== 'function'), []);
  const bare = page(); bare.SLA_UW_TAB = { mount() {} };
  check('an OLD cached loan-uw-tab.js means no panel, not a crash', bare.SLA_UW_METRICS.html(RTL()), '');
  assert('the big Underwriting tab is still there (it is replaced when Mike says so, not as a side effect)', /ldPaneUnderwriting/.test(read('loan-details.js')));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
