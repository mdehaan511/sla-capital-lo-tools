#!/usr/bin/env node
/**
 * scripts/uw-field-write-test.mjs — Deploy 237.224 (Mike)
 *
 * Mike: "for Low Credit it should grab the lowest middle credit of all guarantors. For
 * middle credit it should grab the highest middle credit of all the guarantors. For
 * liquidity it should look at the number of accounts ... showing the account number,
 * amount, and what exactly it is, and then the sub total."
 *
 * What would hurt, so what this guards (the real _shared/uw-field-write.mjs is loaded with
 * its imports stubbed and RUN — see scripts/review-path-run-test.mjs for the harness):
 *   1. Low / Middle Credit read off ONE report again, or the min/max the wrong way round,
 *      or a second guarantor's report overwriting the first's score (shared key).
 *   2. A pulled score losing to an AI reading of the same person; a value a person typed
 *      being overwritten; derived values passing as verified when an input is not.
 *   3. A re-read of the same account eating a fresh row, or two banks' statements
 *      collapsing into one row, or a person's row being replaced.
 *   4. The account's printed name / last four not surviving to the row.
 *
 * Run: node scripts/uw-field-write-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
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
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const read = (p) => readFileSync(new URL(p, FN), 'utf8');

async function loadModule(file, stubs) {
  const src = read(file);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Infinity });
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const exportsObj = {};
    wanted.forEach((n) => { exportsObj[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(exportsObj), function () { Object.keys(exportsObj).forEach((k) => this.setExport(k, exportsObj[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  return mod.namespace;
}

// A clients store holding one client with one loan; writeClient records what was saved.
function world() {
  const w = { saved: [], loan: { id: 'l_1', purchasePrice: '140000', uwData: {}, uwAudit: [] } };
  w.client = { id: 'c_1', loans: [w.loan] };
  w.stubs = {
    '@netlify/blobs': { getStore: () => ({ get: async () => JSON.parse(JSON.stringify(w.client)) }) },
    './auth.mjs': { keySafe: (s) => String(s).replace(/[^A-Za-z0-9_-]/g, '_') },
    './client-write.mjs': { writeClient: async (ownerKey, client) => { w.saved.push(client); w.client = client; w.loan = client.loans[0]; } },
    './loan-change-log.mjs': { diffLoan: () => [], recordLoanChanges: async () => {} },
  };
  return w;
}
const NOW = '2026-09-22T00:00:00.000Z';
const src = { kind: 'existing', clientId: 'c_1', loanId: 'l_1', ownerKey: 'lo' };
const found = (v, where) => ({ found: true, value: v, where: where || 'p.1' });

const W = await loadModule('_shared/uw-field-write.mjs', world().stubs);

// ── 1. bank statement accounts ──────────────────────────────────────────────
console.log('\nAccounts off a bank statement: what it is, its number, its own row');
{
  const spec = fieldsForSlug('bank_stmt_current', 'rtl');
  check('the AI is asked for five accounts, each with its printed name and last four', spec.filter((f) => /^acctStmt[1-5](Name|Last4)$/.test(f.key)).length, 10);
  const props = W.buildProposals(spec, {
    acctStmt1Type: found('Business Checking Acct.'), acctStmt1Balance: found('18394.23'), acctStmt1Name: found('Chase Business Complete Checking'), acctStmt1Last4: found('xxxx1432'),
    acctStmt2Type: found('Stocks/Mutual Funds'), acctStmt2Balance: found('96151.08'), acctStmt2Name: found('Fidelity Brokerage'), acctStmt2Last4: found('6739'),
    acctStmt3Type: found(null), acctStmtDoubt: found('account 2 is jointly held with a non-guarantor'),
  }, 'Current-Month Bank Statements');
  const loan = { uwData: {}, uwAudit: [] };
  check('two accounts → two rows, name + last four on each, the doubt as a VERIFY tail', W.applyStmtAccountProposals(loan, props, NOW), 2);
  check('row 1', loan.uwData.account1.value, { type: 'Business Checking Acct.', balance: 18394.23, weight: 1, name: 'Chase Business Complete Checking', last4: '1432' });
  check('row 2', loan.uwData.account2.value, { type: 'Stocks/Mutual Funds', balance: 96151.08, weight: 0.5, name: 'Fidelity Brokerage', last4: '6739' });
  assert('the doubt rides on the note the panel turns into an alert icon', /⚠ VERIFY: account 2 is jointly held/.test(loan.uwData.account1.aiNote));
  // a re-read of the SAME account (new balance) updates its row, does not eat a third
  const again = W.buildProposals(spec, { acctStmt1Type: found('Business Checking Acct.'), acctStmt1Balance: found('20000'), acctStmt1Name: found('Chase Business Complete Checking'), acctStmt1Last4: found('1432') }, 'Current-Month Bank Statements');
  W.applyStmtAccountProposals(loan, again, NOW);
  check('same last four, new balance: the SAME row, no third row', [loan.uwData.account1.value.balance, !!loan.uwData.account3], [20000, false]);
  // the same account listed SECOND on a later combined statement: still its own row, by number
  const reordered = W.buildProposals(spec, { acctStmt1Type: found('Stocks/Mutual Funds'), acctStmt1Balance: found('96151.08'), acctStmt1Name: found('Fidelity Brokerage'), acctStmt1Last4: found('6739'),
    acctStmt2Type: found('Business Checking Acct.'), acctStmt2Balance: found('21000'), acctStmt2Name: found('Chase Business Complete Checking'), acctStmt2Last4: found('1432') }, 'Current-Month Bank Statements');
  W.applyStmtAccountProposals(loan, reordered, NOW);
  check('the account is found by its NUMBER, not its position on the statement', [loan.uwData.account1.value.balance, loan.uwData.account2.value.last4, !!loan.uwData.account3], [21000, '6739', false]);
  // a second bank's statement (different last four) gets its own row
  const other = W.buildProposals(spec, { acctStmt1Type: found('Checking/Savings'), acctStmt1Balance: found('5000'), acctStmt1Name: found('BofA Advantage Savings'), acctStmt1Last4: found('9001') }, 'Current-Month Bank Statements');
  W.applyStmtAccountProposals(loan, other, NOW);
  check('a second bank: its own row', [loan.uwData.account3 && loan.uwData.account3.value.last4, loan.uwData.account1.value.last4], ['9001', '1432']);
  // a person's row is never replaced
  loan.uwData.account1 = { value: { type: 'Business Checking Acct.', balance: 99999, weight: 1, name: 'Chase', last4: '1432' }, by: 'dee', verified: true };
  W.applyStmtAccountProposals(loan, again, NOW);
  check('a person\'s row for that account is kept', loan.uwData.account1.value.balance, 99999);
  // type read off the name when the category is missing
  const noType = W.buildProposals(spec, { acctStmt1Balance: found('100'), acctStmt1Name: found('Vanguard Roth IRA'), acctStmt1Last4: found('0001') }, 'Current-Month Bank Statements');
  const l2 = { uwData: {}, uwAudit: [] }; W.applyStmtAccountProposals(l2, noType, NOW);
  check('no category answered: read off the printed name (Roth IRA → retirement, 0%)', [l2.uwData.account1.value.type, l2.uwData.account1.value.weight], ['IRA/401k/Retirement Plans', 0]);
  const five = {}; for (let i = 1; i <= 5; i++) { five['acctStmt' + i + 'Type'] = found('Checking/Savings'); five['acctStmt' + i + 'Balance'] = found(String(i * 1000)); five['acctStmt' + i + 'Last4'] = found('000' + i); }
  const l3 = { uwData: {}, uwAudit: [] }; W.applyStmtAccountProposals(l3, W.buildProposals(spec, five, 'Current-Month Bank Statements'), NOW);
  check('five accounts fill five rows', Object.keys(l3.uwData).sort(), ['account1', 'account2', 'account3', 'account4', 'account5']);
}

// ── 2. credit across all guarantors ─────────────────────────────────────────
console.log('\nLow Credit = lowest middle score of all guarantors; Middle Credit = highest');
{
  const loan = { uwData: {}, uwAudit: [] };
  check('nothing known: nothing written', W.deriveGuarantorCredit(loan, NOW), 0);
  W.recordGuarantorScore(loan, { name: 'Kandiah Lingan', mid: 723, source: 'xactus', at: NOW });
  W.deriveGuarantorCredit(loan, NOW);
  check('one guarantor pulled: low = middle = that score, verified', [loan.uwData.lowCredit.value, loan.uwData.middleCredit.value, loan.uwData.lowCredit.verified, loan.uwData.lowCredit.isAI], ['723', '723', true, false]);
  loan.uwData['guarantorMidCredit__g1'] = { value: '678', guarantorName: 'Jane Doe', isAI: true, verified: false };
  W.deriveGuarantorCredit(loan, NOW);
  check('a second guarantor\'s report: low is the LOWER middle, middle is the HIGHER', [loan.uwData.lowCredit.value, loan.uwData.middleCredit.value], ['678', '723']);
  check('...unverified with Confirm, because one input is an unconfirmed reading', [loan.uwData.lowCredit.isAI, loan.uwData.lowCredit.verified], [true, false]);
  assert('...and the working is on the entry', /Lowest of the 2 guarantors' middle scores — Kandiah Lingan 723 \(pulled\) · Jane Doe 678 \(report\)/.test(loan.uwData.lowCredit.sourceNote), loan.uwData.lowCredit.sourceNote);
  loan.uwData['guarantorMidCredit__g0'] = { value: '650', guarantorName: 'Kandiah Lingan', isAI: true, verified: false };
  W.deriveGuarantorCredit(loan, NOW);
  check('a pull beats an AI reading of the SAME person', [loan.uwData.lowCredit.value, W.guarantorScores(loan).length], ['678', 2]);
  W.recordGuarantorScore(loan, { name: 'Jane Doe', mid: 701, source: 'xactus', at: NOW });
  W.deriveGuarantorCredit(loan, NOW);
  check('both pulled: verified, no Confirm needed', [loan.uwData.lowCredit.value, loan.uwData.middleCredit.value, loan.uwData.lowCredit.verified, loan.uwData.lowCredit.byName], ['701', '723', true, 'Credit pulls']);
  W.recordGuarantorScore(loan, { name: 'Jane Doe', mid: 710, source: 'xactus', at: NOW });
  check('a re-pull replaces that person, not adds', loan.guarantorCreditScores.length, 2);
  loan.uwData.lowCredit = { value: '600', source: 'manual', by: 'dee', byName: 'Dee', verified: true };
  W.deriveGuarantorCredit(loan, NOW);
  check('a value a person typed is never overwritten', loan.uwData.lowCredit.value, '600');
  check('...but the other one still follows the data', loan.uwData.middleCredit.value, '723');
  assert('lowCredit / middleCredit can no longer be written straight off one report', !fieldsForSlug('credit_report', 'rtl').some((f) => f.key === 'lowCredit' || f.key === 'middleCredit'));
  assert('...and the choke point refuses them even if a future map entry tries', /const NEVER_AI_WRITE = \{[^}]*\blowCredit: 1, middleCredit: 1,/.test(read('_shared/uw-field-map.mjs')));
  check('a credit report is asked for the middle score and the person', fieldsForSlug('credit_report__g1', 'rtl').map((f) => [f.key, f.perGuarantor, f.traySlug]), [['guarantorMidCredit', true, 'credit_report__g1'], ['guarantorReportName', true, 'credit_report__g1']]);
}

// ── 3. the full write path, per-guarantor trays ─────────────────────────────
console.log('\nwriteFieldProposals: each guarantor\'s report lands in that guarantor\'s slot');
{
  const w = world();
  const M = await loadModule('_shared/uw-field-write.mjs', w.stubs);
  const propsFor = (tray, name, mid) => M.buildProposals(fieldsForSlug(tray, 'rtl'), { guarantorMidCredit: found(mid), guarantorReportName: found(name) }, 'Credit Report');
  check('proposals carry the tray and the per-guarantor flag', propsFor('credit_report__g1', 'Jane Doe', 678).map((p) => [p.key, p.perGuarantor, p.traySlug]), [['guarantorMidCredit', true, 'credit_report__g1'], ['guarantorReportName', true, 'credit_report__g1']]);
  await M.writeFieldProposals(src, propsFor('credit_report__g1', 'Jane Doe', '678'), 'dee@slacapital.com');
  await M.writeFieldProposals(src, propsFor('credit_report__g0', 'Kandiah Lingan', '723'), 'dee@slacapital.com');
  const uw = w.loan.uwData;
  check('two reports, two slots, nothing overwritten', [uw.guarantorMidCredit__g0 && uw.guarantorMidCredit__g0.value, uw.guarantorMidCredit__g1 && uw.guarantorMidCredit__g1.value], ['723', '678']);
  check('...names kept for the working', [uw.guarantorMidCredit__g0.guarantorName, uw.guarantorMidCredit__g1.guarantorName], ['Kandiah Lingan', 'Jane Doe']);
  check('...and Low / Middle derived across both, unverified', [uw.lowCredit.value, uw.middleCredit.value, uw.lowCredit.isAI], ['678', '723', true]);
  check('...saved to the client', w.saved.length, 2);
  await M.writeFieldProposals(src, propsFor('credit_report', 'Kandiah Lingan', '730'), 'dee@slacapital.com');
  check('a legacy base tray is Guarantor 1\'s slot', [w.loan.uwData.guarantorMidCredit__g0.value, w.loan.uwData.middleCredit.value], ['730', '730']);
}

// ── 4. the Xactus pull feeds the same derivation ────────────────────────────
console.log('\nA Xactus pull');
{
  const X = read('xactus-credit-order.mjs');
  const blk = X.slice(X.indexOf('  if (loan) {\n    if (parsed.pdfBase64) {'), X.indexOf('  // Deploy 236.780 — the SUBJECT\'s client profile'));
  assert('records the subject\'s middle score BY NAME on the loan and derives Low / Middle', /recordGuarantorScore\(loan, \{ name: subjectName, mid: parsed\.mid/.test(blk) && /deriveGuarantorCredit\(loan, nowIso\)/.test(blk));
  assert('...for every subject, not just the primary', blk.indexOf('recordGuarantorScore') > blk.indexOf('if (isPrimary) {') && blk.indexOf('recordGuarantorScore') > blk.indexOf('loan.creditReportId = parsed.reportId;\n    }'));
  assert('the tab\'s account editor keeps the printed name and last four through a correction', /if \(_curV\.name\)\s+_val\.name\s+= _curV\.name;/.test(readFileSync(new URL('../deploy/loan-uw-tab.js', import.meta.url), 'utf8')));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
