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
check('Liquidity rows: accounts in use, "+ Add an account", subtotal, then EMD, Total, Requirement',
  plain(b.sections[1].rows.map((r) => r.key)), ['account1', 'account2', 'accountsAdd', 'accountsSubtotal', 'emd', 'liquidityTotal', 'liquidityRequirement']);
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
  // Deploy 237.224 (Mike: "remove the sub note like you added in Luna") -- the per-account
  // weight line is gone; the weights still show up once, on the subtotal.
  check('no per-account weight note', plain([row(b, 'account1').note, row(b, 'account2').note]), ['', '']);
  const sub = row(b, 'accountsSubtotal');
  check('the subtotal is the statements\' balances; the weighted figure rides beside it (type default 70% for acct 1, a person\'s 100% for acct 2)',
    [sub.display, sub.prov], ['$256,696', '$208,533 counts toward liquidity after account weights']);
}

// ── 4b. accounts as Mike described them ─────────────────────────────────────
console.log('\nAccount rows: number, amount, what exactly it is, subtotal, alert');
{
  const loan = RTL();
  loan.uwData.account1 = { value: { type: 'Business Checking Acct.', balance: 18394.23, weight: 1, name: 'Chase Business Complete Checking', last4: '1432' }, isAI: true, verified: false, aiNote: 'Current-Month Bank Statements (acct 1) — ⚠ VERIFY: account is jointly held with a non-guarantor' };
  loan.uwData.account2 = { value: { type: 'Stocks/Mutual Funds', balance: 96151.08, name: 'Fidelity Brokerage', last4: '6739' }, by: 'dee', byName: 'Dee', verified: true };
  const pb = w.SLA_UW_METRICS.build(loan);
  check('labelled Account 1, Account 2 — the amount on the row', plain([row(pb, 'account1').label, row(pb, 'account1').display, row(pb, 'account2').label, row(pb, 'account2').display]), ['Account 1', '$18,394', 'Account 2', '$96,151']);
  check('the sub text says what it is and its number', plain([row(pb, 'account1').sub, row(pb, 'account2').sub]), ['Chase Business Complete Checking · Business Checking Acct. ••1432', 'Fidelity Brokerage · Stocks/Mutual Funds ••6739']);
  check('a row with no printed name falls back to the category', row(w.SLA_UW_METRICS.build(RTL()), 'account1').sub, 'Checking/Savings');
  check('the weird thing is an ALERT on the row, not a line of text', plain([row(pb, 'account1').alert, row(pb, 'account2').alert, row(pb, 'account1').note]), ['account is jointly held with a non-guarantor', '', '']);
  check('subtotal = the balances; weighted (100% + 50%) beside it', [row(pb, 'accountsSubtotal').display, row(pb, 'accountsSubtotal').prov], ['$114,545', '$66,470 counts toward liquidity after account weights']);
  check('the liquidity block reads: accounts, add, subtotal, EMD, Total, Requirement', plain(pb.sections[1].rows.map((r) => r.key)), ['account1', 'account2', 'accountsAdd', 'accountsSubtotal', 'emd', 'liquidityTotal', 'liquidityRequirement']);
  const h = w.SLA_UW_METRICS.html(loan);
  assert('the alert is a clickable icon carrying the note, on that row only', (h.match(/class="uwm-alert"/g) || []).length === 1 && /data-note="account is jointly held with a non-guarantor"/.test(h) && /SLA_UW_METRICS\._note\(this\)/.test(h));
  assert('the sub text is drawn, escaped', /<div class="uwm-sub">Chase Business Complete Checking · Business Checking Acct\. ••1432<\/div>/.test(h));
  loan.uwData.account1.value.name = '<img src=x onerror=alert(1)>';
  assert('a hostile printed name is escaped', !/<img src=x/.test(w.SLA_UW_METRICS.html(loan)));
  assert('the pop-up exists and closes itself', typeof w.SLA_UW_METRICS._note === 'function' && /removeEventListener\('click', close, true\)/.test(read('loan-uw-metrics.js')));
  // credit: the derived entries' working shows under the row
  const lc = RTL();
  lc.uwData.lowCredit = { value: '678', derived: true, isAI: true, verified: false, sourceNote: 'Lowest of the 2 guarantors\' middle scores — Kandiah Lingan 723 (pulled) · Jane Doe 678 (report)', aiNote: 'from the guarantors\' credit reports' };
  lc.uwData.middleCredit = { value: '723', derived: true, isAI: false, verified: true, by: 'system', byName: 'Credit pulls', sourceNote: 'Highest of the 2 guarantors\' middle scores — Kandiah Lingan 723 (pulled) · Jane Doe 723 (pulled)' };
  const pc = w.SLA_UW_METRICS.build(lc);
  check('Low / Middle Credit show the working across the guarantors', plain([row(pc, 'lowCredit').display, row(pc, 'lowCredit').note, /^Highest of the 2 guarantors' middle scores/.test(row(pc, 'middleCredit').note)]), ['678', 'Lowest of the 2 guarantors\' middle scores — Kandiah Lingan 723 (pulled) · Jane Doe 678 (report)', true]);
  check('...unverified only when an input is an unconfirmed reading', plain([row(pc, 'lowCredit').unverified, row(pc, 'middleCredit').unverified]), [true, false]);
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
  // Deploy 237.223 (Mike: "the GUC loans have the same basic rules as RTLs") -- GUC runs the RTL
  // sheet. A legacy loan with no toolType still gets nothing (programOf() alone would call it RTL).
  const guc = w.SLA_UW_METRICS.build({ id: 'g', toolType: 'guc', loanType: 'construction', loanAmt: '500000', rehabBudget: '200000', arv: '900000', purchasePrice: '250000', aivBpo: '300000', arvBpo: '900000', fico: '740', experience: '3', uwData: {} });
  check('a GUC loan gets the RTL sheet, on the RTL engine', [guc && guc.program, guc && row(guc, 'ltaiv').display, guc && row(guc, 'constructionHoldback').display], ['rtl', '100.00%', '$200,000']);
  check('legacy no-toolType loans get NO panel rather than RTL math (the tab\'s own gate)',
    [w.SLA_UW_METRICS.build({ id: 'y', loanAmt: '1', uwData: {} }), w.SLA_UW_METRICS.html({ id: 'y' })], [null, '']);
  assert('...and the Underwriting tab\'s own mount agrees', /tt === 'rtl' \|\| tt === 'dscr' \|\| tt === 'guc'/.test(read('loan-uw-tab.js')));
}

// ── 6b. LTAIV is the initial advance; the rest of the tab is still reachable ─
console.log('\nLTAIV, and what the hidden tab used to hold');
{
  const loan = RTL(); loan.rehabBudget = '89000'; loan.loanAmt = '206000'; loan.aivBpo = '130000';
  const pb = w.SLA_UW_METRICS.build(loan);
  check('LTAIV = (loan − holdback) ÷ as-is, and says so', [row(pb, 'ltaiv').display, row(pb, 'ltaiv').note, row(pb, 'ltaiv').prov], ['90.00%', 'Initial advance $117,000 (loan less the holdback) over as-is', 'Initial advance ÷ As-is (RED > 90%)']);
  check('no holdback: no note to make', row(w.SLA_UW_METRICS.build(RTL()), 'ltaiv').note, '');
  // Deploy 237.223 -- the old tab is hidden, so everything it held that the sheet does not
  // show (trade-tape fields) folds under "More from the documents", still editable.
  const more = pb.more.rows.map((r) => r.key);
  check('the rest of the registry is under "More", nothing lost', ['valuationDate', 'valuationProvider', 'valuationSqft', 'entityTin', 'floodZone', 'insuranceLiability', 'rehabBudget', 'propertySqFt', 'liquidityNotes'].filter((k) => more.indexOf(k) < 0), []);
  check('...but not what is already on the sheet, the accounts, or the two Mike excluded', ['ltaiv', 'purchasePrice', 'account1', 'usCitizen', 'maritalStatus', 'asIsPrice'].filter((k) => more.indexOf(k) >= 0), []);
  loan.uwData.floodZone = { value: 'X', isAI: true, verified: false };
  const h = w.SLA_UW_METRICS.html(loan);
  assert('drawn collapsed, with a count, and its AI values carry Confirm too', /<details class="uwm-more"[^>]*><summary[^>]*>More from the documents · 2 of \d+ filled<\/summary>/.test(h) && /_confirm\('uw','floodZone'\)/.test(h), (h.match(/More from the documents[^<]*/) || [])[0]);
  const LDJS = read('loan-details.js');
  assert('the old Underwriting tab is hidden behind a flag, not deleted', /var LD_SHOW_UNDERWRITING = false;/.test(LDJS) && /\(_uwOK && LD_SHOW_UNDERWRITING\)/.test(LDJS));
  assert('...and its pane is still mounted (that mount is the panel\'s context)', /ldPaneUnderwriting/.test(LDJS) && /SLA_UW_TAB\.mount\(\{/.test(LDJS));
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
  assert('an open account row has the tab\'s three controls plus what-it-is and last 4, and Save / Cancel', /class="uw-acct-type"/.test(open) && /class="uw-acct-bal"/.test(open) && /class="uw-acct-wt"/.test(open) &&
    /class="uw-acct-name"/.test(open) && /class="uw-acct-last4"/.test(open) && /_saveAcct\('account1'\)/.test(open) && /_cancelAcct\('account1'\)/.test(open));
  assert('...and nothing saves until Save (no per-field onchange)', !/onchange="SLA_UW_TAB\._acct/.test(open));
  w.SLA_UW_METRICS._toggleAcct('account1');
}

// ── 7b. "+ Add an account" (Deploy 237.226, Mike) ───────────────────────────
console.log('\nAdding an account by hand');
{
  const h = w.SLA_UW_METRICS.html(RTL());
  assert('no blank account rows; an explicit link that opens the first free row', !/>Account 3</.test(h) && /_addAcct\('account3'\)">\+ Add an account</.test(h));
  const full = RTL(); for (let i = 1; i <= 5; i++) full.uwData['account' + i] = { value: { type: 'Checking/Savings', balance: 1000 * i } };
  assert('all five in use: says so instead of a link', /All five account rows are in use/.test(w.SLA_UW_METRICS.html(full)) && !/_addAcct/.test(w.SLA_UW_METRICS.html(full)));
  w.SLA_UW_METRICS._addAcct('account3');
  const opened = w.SLA_UW_METRICS.html(RTL());
  assert('the free row appears WITH its editor open, and the link moves to the next free row', />Account 3</.test(opened) && /uw-acct\b[^>]*data-key="account3"/.test(opened) && /class="uw-acct-name"/.test(opened) && /_addAcct\('account4'\)/.test(opened));
  w.SLA_UW_METRICS._cancelAcct('account3');
  assert('Cancel puts it away again', !/>Account 3</.test(w.SLA_UW_METRICS.html(RTL())));
  // Save goes through the tab's own _acct, which now reads the two new inputs
  const saved = [];
  w.SLA = { api: (m, p, body) => { saved.push(body); return Promise.resolve({}); } };
  w.SLA_UW_TAB.mount({ loan: RTL(), clientId: 'c_1', loanId: 'l_1' });
  const inputs = { '.uw-acct-type': { value: 'Checking/Savings' }, '.uw-acct-bal': { value: '$5,000' }, '.uw-acct-wt': { value: '' }, '.uw-acct-name': { value: '  BofA Advantage Savings ' }, '.uw-acct-last4': { value: 'xx-9001' } };
  const cell = { querySelector: (s) => inputs[s] || null };
  const root = { querySelector: () => cell };
  w.SLA_UW_TAB._acct('uw', 'account3', root);
  check('the saved row carries type, balance, the type\'s default weight, what it is and the last four', saved[0] && saved[0].value, { type: 'Checking/Savings', balance: 5000, weight: 0.7, name: 'BofA Advantage Savings', last4: '9001' });
  check('...to the right endpoint, for the right loan', [saved[0].key, saved[0].loanId, saved[0].dataset], ['account3', 'l_1', 'uw']);
  const bare = { querySelector: (s) => ({ '.uw-acct-type': { value: 'Checking/Savings' }, '.uw-acct-bal': { value: '7000' }, '.uw-acct-wt': { value: '' } })[s] || null };
  const loanWithName = RTL(); loanWithName.uwData.account1.value.name = 'Chase'; loanWithName.uwData.account1.value.last4 = '1432';
  w.SLA_UW_TAB.mount({ loan: loanWithName, clientId: 'c_1', loanId: 'l_1' });
  w.SLA_UW_TAB._acct('uw', 'account1', { querySelector: () => bare });
  check('the tab\'s own editor (no such inputs) keeps what the statement said', [saved[1].value.name, saved[1].value.last4, saved[1].value.balance], ['Chase', '1432', 7000]);
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
  // Deploy 237.226 -- a tray's SECOND document reviewed: its own entry is stamped, the tray is not
  const before = c.refreshed;
  rev.docs.bank_stmt_current.documents = [{ docId: 'd_1', aiReviewedAt: 'T3' }, { docId: 'd_2', aiReviewedAt: '' }];
  vm.runInContext('_metricsAfterRender()', c);
  rev.docs.bank_stmt_current.documents[1].aiReviewedAt = 'T4';
  vm.runInContext('_metricsAfterRender()', c);
  check('a review landing on a tray\'s second document refreshes too (the tray itself is untouched)', c.refreshed - before, 2);
  c = mk({ source: { loanId: 'l_OTHER' }, docs: {} }, { id: 'l_1' });
  check('a review that is not for the loan on screen gets no panel', vm.runInContext('_metricsHtml()', c), '');
  c = mk(rev, { id: 'l_1' }); c.global.SLA_UW_METRICS = undefined;
  check('a page without the panel script is the single column it always was', vm.runInContext('_metricsHtml()', c), '');
  assert('only on the Underwriting subtab', /var _mx = \(_activeTab === 'uw'\) \? _metricsHtml\(\) : '';/.test(DR));
  assert('stacked unless the REVIEW column is wide enough (container query, not window width)', /container-type:inline-size/.test(DR) && /@container druw \(min-width: 900px\)/.test(DR) && /flex-direction:column-reverse/.test(DR));
  // Deploy 237.223 (Mike: "instead of making it sticky and have a scroll bar ... hold its position")
  const sideCss = (DR.match(/\.dr-root \.dr-uw-side \{[^}]*\}/g) || []).join(' ');
  assert('the panel holds its place on the page: not sticky, no scrollbar of its own', sideCss.length > 0 && !/sticky|overflow-y|max-height/.test(sideCss), sideCss);
  assert('a new review resets the baseline', /_mxSig = null;\s+\/\/ Deploy/.test(DR));
}

// ── 9b. "Review all N documents" (Deploy 237.226, Mike: Luna's four statements) ──
console.log('\nA multi-document tray reads every document');
{
  const DR = read('loan-doc-review.js');
  assert('the button is drawn under the list of a multi-document tray', /if \(liveDocsList\.length > 1 && !d\.hidden && !d\.noReview\) \{[\s\S]{0,400}dr_reviewAllDocs\(/.test(DR));
  const a = DR.indexOf('  global.dr_reviewAllDocs = function(slug, btn) {'), z = DR.indexOf('\n  // Deploy 236.690 — switch the active Collateral property tab');
  assert('the handler was found', a > 0 && z > a);
  const mk = (retry) => {
    const c = { _review: { id: 'r_1', docs: { bank_stmt_current: { documents: [] } } }, calls: [], toasts: [], renders: 0, intervals: [], _pollTimers: {}, Array, Object, JSON };
    c.global = { SLA: { LoanReviews: { retryAi: (id, slug, docId) => { c.calls.push(docId); return Promise.resolve(retry(docId)); }, get: async () => ({ review: c._review }) } } };
    c._liveDocs = () => ['d_1', 'd_2', 'd_3', 'd_4'].map((id) => ({ docId: id }));
    c.render = () => { c.renders++; };
    c.showToast = (m, k) => { c.toasts.push(m); };
    c.setInterval = (fn, ms) => { c.intervals.push({ fn, ms }); return c.intervals.length; };
    c.clearInterval = () => {};
    vm.createContext(c); vm.runInContext(DR.slice(a, z), c); return c;
  };
  let c = mk((id) => ({ review: { id: 'r_1', docs: { bank_stmt_current: { documents: [] } } } }));
  const btn = { innerHTML: 'orig', disabled: false, texts: [] };
  Object.defineProperty(btn, 'innerHTMLLog', { value: [] });
  c.btn = new Proxy(btn, { set(t, k, v) { if (k === 'innerHTML') t.texts.push(v); t[k] = v; return true; } });
  vm.runInContext('global.dr_reviewAllDocs("bank_stmt_current", btn)', c);
  await new Promise((r) => setTimeout(r, 30));
  check('every document, one after another, in order', c.calls, ['d_1', 'd_2', 'd_3', 'd_4']);
  check('the button counts up and comes back', [btn.texts.slice(0, 2), btn.texts[btn.texts.length - 1], btn.disabled], [['Reviewing 1 of 4…', 'Reviewing 2 of 4…'], 'orig', false]);
  check('then one redraw and a plain toast', [c.renders, c.toasts], [1, ['All 4 documents reviewed.']]);
  // two long ones go to the background: polled per DOCUMENT
  c = mk((id) => ({ review: { id: 'r_1', docs: { bank_stmt_current: { documents: [{ docId: 'd_2', aiReviewing: true }, { docId: 'd_3', aiReviewing: true }] } } }, aiReviewing: (id === 'd_2' || id === 'd_3') }));
  c.btn = { innerHTML: '' };
  vm.runInContext('global.dr_reviewAllDocs("bank_stmt_current", btn)', c);
  await new Promise((r) => setTimeout(r, 30));
  check('says how many are still running, and starts the per-document poll', [c.toasts[0], c.intervals.length], ['2 reviewed; 2 long documents are finishing in the background.', 1]);
  c._review.docs.bank_stmt_current.documents = [{ docId: 'd_2', aiReviewing: false, aiReviewedAt: 'T' }, { docId: 'd_3', aiReviewing: true }];
  c.intervals[0].fn(); await new Promise((r) => setTimeout(r, 20));
  check('...which keeps waiting while ANY document is still reviewing (tray flag or not)', c.toasts.length, 1);
  c._review.docs.bank_stmt_current.documents[1].aiReviewing = false;
  c.intervals[0].fn(); await new Promise((r) => setTimeout(r, 20));
  check('...and reports when the last one lands', c.toasts[1], 'Background reviews done.');
  c = mk(() => { throw new Error('boom'); });
  c.global.SLA.LoanReviews.retryAi = () => Promise.reject(new Error('502'));
  c.btn = { innerHTML: '' };
  vm.runInContext('global.dr_reviewAllDocs("bank_stmt_current", btn)', c);
  await new Promise((r) => setTimeout(r, 30));
  check('a failure on one document does not stop the rest', c.toasts.filter((t) => /could not be reviewed/.test(t)).length, 4);
}

// ── 10. the subtext is a locator, not an essay ──────────────────────────────
// Deploy 237.233 (Mike, with the screenshot: "keep the subtext to very simple 1 or 2
// lines and avoid the paragraphs like this"). The Title/Escrow Fees row had six lines
// of AI working under a one-line number. The note below is the one he sent, verbatim.
console.log('\nThe subtext under a number');
{
  const HUD = 'Final HUD / Settlement Statement — Page 2 — Title Charges & Escrow/Settlement Charges section: '
    + 'Closing Protection Letter $75 + Electronic Recording $15 + Settlement $300 + Title Services $1,470 + '
    + 'Verification Services $50 + Lender\'s Title Insurance $60 (Owner\'s Title Insurance $802 is also listed '
    + 'but is typically a buyer/owner cost; total title section debits to borrower sum to $1,885 excluding '
    + 'owner\'s policy, or $2,687 including it)';
  const loan = RTL();
  loan.uwData.titleEscrowFees = { value: '1885', isAI: true, verified: false, aiNote: HUD, by: 'ai', byName: 'AI' };
  const pb = w.SLA_UW_METRICS.build(loan);
  const r = row(pb, 'titleEscrowFees');
  check('the page and section survive; the arithmetic does not',
    r.prov, 'AI — p.2 — Title Charges & Escrow/Settlement Charges section — UNVERIFIED');
  assert('and it stays short enough to read in one glance', r.prov.length <= 80, r.prov.length + ' chars');
  assert('nothing the AI said is thrown away — the rest is on the ⋯', /Owner.s Title Insurance \$802/.test(r.provFull));
  const h = w.SLA_UW_METRICS.html(loan);
  assert('the ⋯ is rendered, and opens the note rather than the row editor',
    /class="uwm-why"[^>]*data-note="[^"]*Owner/.test(h) && /uwm-why[^>]*event\.stopPropagation\(\);SLA_UW_METRICS\._note/.test(h));
  assert('the full note is escaped into the attribute', !/<img src=x/.test(
    w.SLA_UW_METRICS.html((() => { const l = RTL(); l.uwData.titleEscrowFees = { value: '1', isAI: true, aiNote: 'HUD — p.1: "<img src=x onerror=alert(1)>"' }; return l; })())));
  assert('it is still confirmable, and still counted as unread', r.unverified === true && pb.unverified > 0);
  // The class must not be the one the "More from the documents" block already uses.
  assert('the ⋯ button does not restyle the More block', !/\.uwm-more \{ border:none/.test(read('loan-uw-metrics.js')));
}
{
  // A note that was already short is left exactly as it was, with no ⋯ to click.
  const pb = w.SLA_UW_METRICS.build(RTL());
  check('a short locator is untouched', [row(pb, 'lowCredit').prov, row(pb, 'lowCredit').provFull],
    ['AI — p.1 — UNVERIFIED', '']);
  check('a confirmed value says so instead of UNVERIFIED', row(pb, 'middleCredit').prov, 'AI — p.1 (confirmed)');
  // aiNote with no locator at all is just the document label, which the row's own
  // "from" line already gives — so the provenance is the bare fact that AI read it.
  check('no locator: no invented one', [row(pb, 'emd').prov, row(pb, 'emd').provFull], ['AI — UNVERIFIED', '']);
}
{
  // The "⚠ VERIFY" half of an aiNote has had its own alert icon since 237.224; it must
  // not leak into the locator line as well.
  const loan = RTL();
  loan.uwData.titleEscrowFees = { value: '1885', isAI: true, verified: false,
    aiNote: 'Final HUD — p.2, Title Charges — ⚠ VERIFY: the owner\'s policy may belong to the seller' };
  const r = row(w.SLA_UW_METRICS.build(loan), 'titleEscrowFees');
  check('the thing to check stays on the ⚠, out of the subtext',
    [r.prov, /owner.s policy/.test(r.alert), /VERIFY/.test(r.prov)],
    ['AI — p.2, Title Charges — UNVERIFIED', true, false]);
}
{
  // And the source of the problem: the prompt now bounds what "where" may contain.
  const P = readFileSync(new URL('../deploy/netlify/functions/_shared/anthropic-doc-review.mjs', import.meta.url), 'utf8');
  assert('the AI is told "where" is a short locator', /"where" is a SHORT locator/.test(P) && /under 60 characters/.test(P));
  assert('…and told where a caveat belongs instead', /Never put arithmetic[\s\S]{0,200}findings instead/.test(P));
}

// ── 11. the page loads a matched set ────────────────────────────────────────
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
  assert('loan-uw-calc.js is pinned too (its LTAIV changed; an old cached copy would disagree with the tape)', /loan-uw-calc\.js\?v=[0-9A-Za-z@]+/.test(LD));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
