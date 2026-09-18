/**
 * scripts/financial-audit-page-test.mjs — Deploy 237.141
 *
 * The Financial Audit page is one inline script, so this LIFTS the tab code out of
 * financial-audit.html and renders every tab against fake data in a vm. Catches the
 * runtime slips node --check cannot see.
 *
 * Run: node scripts/financial-audit-page-test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
const html = fs.readFileSync(new URL('../deploy/financial-audit.html', import.meta.url), 'utf8');
const cut = (from, to) => { const a = html.indexOf(from); const b = html.indexOf(to, a); if (a < 0 || b < 0) throw new Error('marker missing: ' + from.slice(0, 40)); return html.slice(a, b); };
const code = cut("var _tab = 'all';", 'function render() {');

const els = { fSearch: { value: '' }, faTabs: { innerHTML: '' }, viewOther: { innerHTML: '', style: {} }, viewAll: { innerHTML: '', style: {} } };
const ctx = {
  console, String, Number, Array, Object, Date, Blob: function () {}, URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  document: { getElementById: (id) => (els[id] = els[id] || { value: '', innerHTML: '', style: {} }), createElement: () => ({ click() {}, style: {} }), body: { appendChild() {}, removeChild() {} } },
  setTimeout: () => {},
  esc: (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  money: (n) => '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  mdy: (d) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d || '')); return m ? (m[2] + '/' + m[3] + '/' + m[1]) : ''; },
  loanHref: (id) => '/loan-details.html?loanId=' + id,
  _rows: [], _data: null,
};
vm.createContext(ctx);
vm.runInContext(code, ctx);

let failures = 0;
const check = (name, fn) => {
  try { const v = fn(); if (v === true) { console.log('  ok   ' + name); return; } failures++; console.log('  FAIL ' + name + ' :: ' + v); }
  catch (e) { failures++; console.log('  FAIL ' + name + ' :: threw ' + (e && e.message)); }
};
const run = (s) => vm.runInContext(s, ctx);

ctx._data = {
  labels: { kinds: { draw: 'Draw', draw_reimb: 'Draw reimbursement', payoff: 'Payoff', trade: 'Trade proceeds' } },
  closings: [
    { loanId: 'L1', owner: 'lo@x.com', slaNumber: 'SLA-20260402-2149', address: '3209 Forester Way, Plano, TX', fundingLabel: 'RTL - Stride',
      closeDate: '2026-04-22', originationFee: 6016, otherFees: 3245, prepaidInterest: 1102.89, ppiCollected: false, rehabFunds: 79000, impounds: 0, totalCollected: 9261, kaf: null },
    { loanId: 'L2', owner: 'lo@x.com', slaNumber: 'SLA-20260813-0636', address: '1 KAF St', fundingLabel: 'RTL - KAF',
      closeDate: '2026-08-13', originationFee: 5342.4, otherFees: 0, prepaidInterest: 1860.1, ppiCollected: true, rehabFunds: 86000, impounds: 0, totalCollected: 7202.5,
      kaf: { upb: 210800, remainingHoldback: 86000, fees: 5342.4, ppi: 1860.1, total: 7202.5, transferDate: '2026-08-25' } },
  ],
};
ctx._rows = [
  { kind: 'trade', date: '2026-09-05', buyer: 'Colchis', amount: 310000, status: 'verified', to: { label: 'SLA Funding' },
    loans: [{ loanId: 'L3', owner: 'o', address: '5 Elm St', slaId: 'SLA-3', upb: 160000, upbOnFile: true }] },
  { kind: 'payoff', date: '2026-09-08', loanId: 'L4', owner: 'o', address: '7 Oak Ave', slaId: 'SLA-4', amount: 205000, status: 'overdue', from: { label: 'Title / payoff' }, to: { label: 'SLA Funding' } },
  { kind: 'draw', date: '2026-09-14', loanId: 'L5', owner: 'o', address: '9 Pine Rd', amount: 25000, status: 'verified', detail: 'Draw 1 — Sitewire approved', from: { label: 'SLA Funding' }, to: { label: 'Borrower (draw)' } },
  { kind: 'draw_reimb', date: '2026-09-18', loanId: 'L5', owner: 'o', address: '9 Pine Rd', amount: 25000, status: 'upcoming', detail: 'Reimburses Draw 1', from: { label: 'Stride' }, to: { label: 'SLA Funding' } },
];

check('five tabs, each with its own count', () => {
  const h = run('faTabsHtml()');
  const names = (h.match(/>(All money|Closings|Trades|Payoffs|Draws)</g) || []).length;
  return names === 5 || 'got ' + names + ' tabs';
});
check('tab counts come from the data (2 closings, 1 trade, 1 payoff, 2 draw rows)', () => {
  const got = ['closings', 'trades', 'payoffs', 'draws'].map((t) => run('tabRows(' + JSON.stringify(t) + ').length'));
  return JSON.stringify(got) === '[2,1,1,2]' || JSON.stringify(got);
});
check('Closings renders the sheet\'s columns and the KAF block', () => {
  const h = run('closingsHtml()');
  for (const c of ['Close Date', 'SLA Loan #', 'Property Address', 'Loan Type - Funding Source', 'Origination Fee', 'Other Fees', 'Pre-paid interest', 'Rehab Funds', 'Impounds', 'Total Collected', 'Trades to KAF', 'Remaining Holdback', 'Transfer Date']) {
    if (h.indexOf(c) < 0) return 'missing column ' + c;
  }
  return h.indexOf('RTL - Stride') > 0 && h.indexOf('08/25/2026') > 0 || 'data missing';
});
check('a net-funded PPI is greyed, not counted', () => {
  const h = run('closingsHtml()');
  return h.indexOf('not collected at the table') > 0 || 'no greyed PPI marker';
});
check('Closings totals row adds the columns', () => {
  const h = run('closingsHtml()');
  return h.indexOf('2 closings') > 0 && h.indexOf('$11,358.40') > 0 || 'totals wrong';
});
check('Trades lists the wire and the loans inside it', () => {
  const h = run('tradesHtml()');
  return h.indexOf('Colchis') > 0 && h.indexOf('5 Elm St') > 0 && h.indexOf('1 loan') > 0 || 'trade body wrong';
});
check('Payoffs renders', () => {
  const h = run("simpleHtml('payoffs','Payoffs','note')");
  return h.indexOf('7 Oak Ave') > 0 && h.indexOf('$205,000.00') > 0 || 'payoff body wrong';
});
check('Draws shows the draw out and the reimbursement back, with both totals', () => {
  const h = run('drawsHtml()');
  return h.indexOf('9 Pine Rd') > 0 && h.indexOf('Reimbursement') > 0 && h.indexOf('1 draw out') > 0 && h.indexOf('1 reimbursement back') > 0 || 'draw body wrong';
});
check('the search box filters closings', () => {
  els.fSearch.value = 'plano';
  const n = run("tabRows('closings').length");
  els.fSearch.value = '';
  return n === 1 || 'got ' + n;
});
check('renderTab paints each tab without throwing', () => {
  for (const t of ['closings', 'trades', 'payoffs', 'draws']) {
    run('_tab = ' + JSON.stringify(t) + '; renderTab();');
    if (!els.viewOther.innerHTML || els.viewOther.innerHTML.length < 50) return t + ' rendered empty';
  }
  return true;
});
check('CSV export builds without throwing', () => { run("exportCsv('closings'); exportCsv('draws');"); return true; });

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
