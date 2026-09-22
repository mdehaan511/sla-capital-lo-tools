#!/usr/bin/env node
/**
 * scripts/colchis-tape-test.mjs — Deploy 237.229 (Mike, "SLA Trade #23.xlsx")
 *
 * Mike: "we want the columns to have the columns that match this sheet. Also we want N, O, P,
 * Q, R, S, T, AD, AN, AE, AF, AG, AH, AI, AL, AX to all be currency unit type. Column B should
 * always say Loan. Valuation Date and Third Party Valuation Provider should be able to be
 * pulled off the valuation docs."
 *
 * The letters are the EXPORT's (his sheet carries an untitled column A in front). What is
 * pinned here: the 61 headers in order, the format on every cell Mike named, real dates,
 * "Loan" in B, the valuation fields reaching the tape from the tray's own reading when the
 * loan never got them, and the purchase / assignment-fee split his sheet shows for Luna
 * Court (119,000 + 21,000 where the loan says 140,000).
 *
 * Run: node scripts/colchis-tape-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { TRADE_TAPES } from '../deploy/netlify/functions/_shared/trade-tapes.mjs';
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
const letter = (i) => { let s = '', x = i + 1; while (x > 0) { const m = (x - 1) % 26; s = String.fromCharCode(65 + m) + s; x = Math.floor((x - 1) / 26); } return s; };
const col = (hdr, name) => { const i = hdr.indexOf(name); if (i < 0) throw new Error('no column ' + name); return i; };

// The sheet Mike sent, B..BJ (its column A is untitled and not part of the tape).
const SHEET_HEADERS = ['Lender Loan ID', 'Record Identifier', 'Property Address', 'Property City', 'Property State', 'Property ZIP', 'Property Type',
  'AIV Units', 'ARV Units', 'AIV Sqft', 'ARV Sqft', 'Flood Zone', 'Property Purchase Date', 'Property Purchase Price', 'Assignment Fee',
  'Remaining Rehab Budget', 'Rehab Spent to Date', 'Total Cost Basis', 'Third Party AIV', 'Third Party ARV', 'Valuation Date',
  'Third Party Valuation Type', 'Third Party Valuation Provider', 'Loan Purpose', 'Loan Strategy', 'Origination Date', 'Date of First Payment',
  'Original Maturity Date', 'Term (Mo.)', 'Total Loan Amount', 'Balance At Submission', 'Initial Loan Amount', 'Initial Rehab Holdback',
  'Initial Interest Reserve', 'Appraisal Holdback', 'Note Rate (%)', 'Orig Points (%)', 'Original P&I Amount', 'Interest Accrual Methodology',
  'Cash Out Amount (Refi)', 'Dutch/Non-Dutch', 'Initial LTC', 'LTAIV', 'Total LTC', 'LTARV', 'Borrower Name', 'Borrower Type',
  'Experience (# projects in 3yrs)', 'Foreign National Flag (Y/N)', 'Borrower Reserves', 'Borrower Address', 'Borrower City', 'Borrower State',
  'Borrower ZIP', 'Entity TIN', 'Guarantor 1 Name', 'Guarantor 1 FICO', 'Guarantor 1 DOB', 'Guarantor 2 Name', 'Guarantor 2 FICO', 'Guarantor 2 DOB'];
const CURRENCY_LETTERS = ['N', 'O', 'P', 'Q', 'R', 'S', 'T', 'AD', 'AE', 'AF', 'AG', 'AH', 'AI', 'AL', 'AN', 'AX'];
const DATE_LETTERS = ['M', 'U', 'Z', 'AA', 'AB', 'BF', 'BI'];

// Luna Court, as the loan record has it (the sheet's row 2 is this loan).
const luna = () => ({
  sla: 'SLA-20260826-2601', ownerKey: 'chance', params: {},
  loan: { id: 'l_1', address: '634 Luna Court, Jacksonville, FL, 32205', propType: 'sfr', numUnits: 1, loanPurpose: 'purchase', loanType: 'Light Rehab',
    fundingDate: '2026-09-18', purchasePrice: '140000', rehabBudget: '89000', loanAmt: '206000', rate: '11', points: '2', dutchInterest: 'dutch',
    aivBpo: '130000', arvBpo: '325000', arv: '325000', experience: '8', entityName: 'Revive Jax LLC', creditMidScore: 723,
    uwData: { entityTin: { value: '42-3514732' }, floodZone: { value: 'X' }, emd: { value: '1000' }, account1: { value: { type: 'Business Checking Acct.', balance: 18394.23, weight: 1 } } } },
  client: { firstName: 'Kandiah', lastName: 'Lingan', dob: '1964-11-19', usCitizen: 'yes', homeAddress: { street: '5024 Southwest 91st Terrace', city: 'Cooper City', state: 'FL', zip: '33328' } },
  guarantors: [],
});
const build = (ctx) => { const t = TRADE_TAPES.colchis_trade.build([ctx]); return { hdr: t.sheets[0].rows[0], row: t.sheets[0].rows[1], missing: t.missing }; };
const cell = (b, name) => b.row[col(b.hdr, name)];
const serialOf = (y, m, d) => Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86400000);

// ── 1. the columns ──────────────────────────────────────────────────────────
console.log('\nThe 61 columns, as the sheet has them');
{
  const b = build(luna());
  check('every header, in the sheet\'s order', b.hdr, SHEET_HEADERS);
  check('Mike\'s letters land on the money columns (his frame = the export\'s)', CURRENCY_LETTERS.map((L) => b.hdr[SHEET_HEADERS.indexOf(b.hdr.find((h, i) => letter(i) === L))]),
    ['Property Purchase Price', 'Assignment Fee', 'Remaining Rehab Budget', 'Rehab Spent to Date', 'Total Cost Basis', 'Third Party AIV', 'Third Party ARV',
      'Total Loan Amount', 'Balance At Submission', 'Initial Loan Amount', 'Initial Rehab Holdback', 'Initial Interest Reserve', 'Appraisal Holdback',
      'Original P&I Amount', 'Cash Out Amount (Refi)', 'Borrower Reserves']);
  check('column B always says Loan', cell(b, 'Record Identifier'), 'Loan');
}

// ── 2. formats ──────────────────────────────────────────────────────────────
console.log('\nCurrency on every column Mike named; real dates');
{
  const b = build(luna());
  const notCurrency = CURRENCY_LETTERS.filter((L) => { const v = b.row[b.hdr.findIndex((h, i) => letter(i) === L)]; return !(v && typeof v === 'object' && v.s === 'cur' && typeof v.v === 'number'); });
  check('every named column is a currency cell on a purchase loan (Cash Out included: $0.00)', notCurrency, []);
  const notDate = DATE_LETTERS.filter((L) => { const v = b.row[b.hdr.findIndex((h, i) => letter(i) === L)]; return v !== '' && !(v && typeof v === 'object' && v.s === 'date' && typeof v.v === 'number'); });
  check('date columns are real Excel dates (or blank)', notDate, []);
  check('Origination Date is the funding date as a serial', cell(b, 'Origination Date'), { v: serialOf(2026, 9, 18), s: 'date' });
  check('First Payment 11/1/2026, Maturity 10/1/2027 (12-month note, funded mid-month)', [cell(b, 'Date of First Payment').v, cell(b, 'Original Maturity Date').v], [serialOf(2026, 11, 1), serialOf(2027, 10, 1)]);
  check('Guarantor 1 DOB is a date; Guarantor 2 (none) is blank', [cell(b, 'Guarantor 1 DOB').v, cell(b, 'Guarantor 2 DOB')], [serialOf(1964, 11, 19), '']);
  check('a refi\'s Cash Out is left for hand-fill, not $0', cell(build(Object.assign(luna(), { loan: Object.assign(luna().loan, { loanPurpose: 'cashout' }) })), 'Cash Out Amount (Refi)'), '');
  check('the percent columns still carry the percent style', ['Note Rate (%)', 'Orig Points (%)', 'Initial LTC', 'LTAIV', 'Total LTC', 'LTARV'].map((n) => cell(b, n).s), ['pct', 'pct', 'pct', 'pct', 'pct', 'pct']);
  check('a blank required money cell is still reported missing', build(Object.assign(luna(), { loan: Object.assign(luna().loan, { loanAmt: '' }) })).missing.some((m) => /Total Loan Amount/.test(m)), true);
}

// ── 3. the purchase / assignment-fee split ──────────────────────────────────
console.log('\nPurchase price and assignment fee, from the documents');
{
  const money = (b, n) => { const v = cell(b, n); return v && typeof v === 'object' ? v.v : v; };
  let b = build(luna());
  check('no assignment known: the whole price, fee $0, basis = price + rehab', [money(b, 'Property Purchase Price'), money(b, 'Assignment Fee'), money(b, 'Total Cost Basis')], [140000, 0, 229000]);
  let c = luna(); c.loan.uwData.psaPrice = { value: '119000' };
  b = build(c);
  check('the PSA says 119,000 under the loan\'s 140,000: seller price + fee, as Mike\'s sheet shows Luna', [money(b, 'Property Purchase Price'), money(b, 'Assignment Fee'), money(b, 'Total Cost Basis')], [119000, 21000, 229000]);
  check('...and the LTCs use purchase + fee, so they do not move', [cell(b, 'Initial LTC').v, cell(b, 'Total LTC').v], [Number((117000 / 140000).toFixed(4)), Number((206000 / 229000).toFixed(4))]);
  c = luna(); c.loan.uwData.assignmentFee = { value: '21000' };
  b = build(c);
  check('a fee stated on the assignment agreement', [money(b, 'Property Purchase Price'), money(b, 'Assignment Fee')], [140000, 21000]);
  c = luna(); c.loan.purchasePrice = '119000'; c.loan.uwData.assignmentContractPrice = { value: '140000' };
  b = build(c);
  check('the LO entered the PSA price and the assignment contract is higher (the engine\'s rule)', [money(b, 'Property Purchase Price'), money(b, 'Assignment Fee'), money(b, 'Total Cost Basis')], [119000, 21000, 229000]);
  c = luna(); c.loan.uwData.psaPrice = { value: '150000' };
  b = build(c);
  check('a PSA price ABOVE the loan\'s price is not a negative fee', [money(b, 'Property Purchase Price'), money(b, 'Assignment Fee')], [140000, 0]);
  assert('the PSA review is asked for the seller\'s price', fieldsForSlug('psa', 'rtl').some((f) => f.key === 'psaPrice'));
  assert('...and it has a home on the registry (so a person can confirm or correct it)', /key: 'psaPrice'/.test(readFileSync(new URL('../deploy/loan-uw-fields.js', import.meta.url), 'utf8')));
}

// ── 4. valuation date / provider off the valuation docs ─────────────────────
console.log('\nValuation Date and Provider reach the tape');
{
  let c = luna(); c.loan.uwData.valuationDate = { value: '2026-08-25' }; c.loan.uwData.valuationProvider = { value: 'Clear Capital' }; c.loan.uwData.valuationType = { value: 'BPO' };
  let b = build(c);
  check('from the screened UW values', [cell(b, 'Valuation Date'), cell(b, 'Third Party Valuation Provider'), cell(b, 'Third Party Valuation Type')], [{ v: serialOf(2026, 8, 25), s: 'date' }, 'Clear Capital', 'BPO']);
  c = luna(); c.reviewValuation = { aiv: 130000, kind: 'bpo', valuationDate: '2026-08-25', valuationProvider: 'Clear Capital', valuationType: '', valuationSqft: '1395' };
  b = build(c);
  check('else from what the review read off the tray (the loan never got it)', [cell(b, 'Valuation Date'), cell(b, 'Third Party Valuation Provider'), cell(b, 'Third Party Valuation Type'), cell(b, 'AIV Sqft')], [{ v: serialOf(2026, 8, 25), s: 'date' }, 'Clear Capital', 'BPO', 1395]);
  c = luna(); c.reviewValuation = { aiv: 0, kind: 'appraisal', valuationDate: 'August 25, 2026', valuationProvider: 'ABC Appraisals', valuationType: '' };
  b = build(c);
  check('an appraisal tray says Appraisal; an unparseable date is passed through as text', [cell(b, 'Third Party Valuation Type'), cell(b, 'Valuation Date')], ['Appraisal', 'August 25, 2026']);

  // the export's attach step: walks the review store for loans missing valuation metadata
  const src = readFileSync(new URL('../deploy/netlify/functions/trade-tape-export.mjs', import.meta.url), 'utf8');
  const ctx = vm.createContext({ console: { warn() {}, log() {}, error() {} }, Buffer, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, encodeURIComponent, Response: class {} });
  const reviews = [{ source: { loanId: 'l_1' }, docs: { bpo_valuation: { verdict: 'received', aiExtractedEntities: { asIsValue: '130000' },
    aiExtractedFields: { valuationDate: { found: true, value: '2026-08-25' }, valuationProvider: { found: true, value: 'Clear Capital' }, valuationType: { found: false, value: null }, valuationSqft: { found: true, value: '1395' } } } } }];
  const stubs = {
    '@netlify/blobs': { getStore: ({ name }) => name === 'loan_reviews' ? { list: async () => ({ blobs: [{ key: 'r_1' }] }), get: async () => reviews[0] } : { get: async () => null } },
    './_shared/borrower-info-keys.mjs': { loadRecord: async () => null },
  };
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: 'trade-tape-export.mjs' });
  await mod.link(async (spec) => {
    const wanted = []; const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {}; const ex = {}; wanted.forEach((n) => { ex[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(ex), function () { Object.keys(ex).forEach((k) => this.setExport(k, ex[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  const attach = mod.namespace.attachLongAppAndValuation;
  assert('attachLongAppAndValuation is exported for this test', typeof attach === 'function');
  let c2 = luna(); c2.loan.exitStrategy = 'sell';
  await attach([c2]);
  check('a loan with an AIV but no valuation date / provider still gets the walk, and the tray\'s reading', c2.reviewValuation && [c2.reviewValuation.valuationDate, c2.reviewValuation.valuationProvider, c2.reviewValuation.valuationSqft, c2.reviewValuation.aiv], ['2026-08-25', 'Clear Capital', '1395', 130000]);
  b = build(c2);
  check('...which the tape then prints', [cell(b, 'Valuation Date').v, cell(b, 'Third Party Valuation Provider'), cell(b, 'Third Party Valuation Type')], [serialOf(2026, 8, 25), 'Clear Capital', 'BPO']);
  let c3 = luna(); c3.loan.exitStrategy = 'sell'; c3.loan.uwData.valuationDate = { value: '2026-08-25' }; c3.loan.uwData.valuationProvider = { value: 'Clear Capital' }; c3.loan.uwData.valuationType = { value: 'BPO' };
  await attach([c3]);
  check('a loan that has it all is not walked', c3.reviewValuation, undefined);
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
