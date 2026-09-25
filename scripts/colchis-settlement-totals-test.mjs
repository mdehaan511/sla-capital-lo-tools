#!/usr/bin/env node
/**
 * scripts/colchis-settlement-totals-test.mjs — Deploy 237.276 (Mike)
 *
 * "With the Colchis Settlement tape there are the 3 cells below all of the rows that sum whats
 * above them. They need to sum those columns for all of the rows not just the first 3 like
 * they were doing."
 *
 * The totals under Total Loan Amount (L), Loan Balance At Purchase (M) and Proceeds (Y) were
 * SUM(L2:L4): fixed at the last generated row, so rows added to the sheet afterwards were left
 * out. Each now sums from row 2 to the row just above itself. This builds a real tape through
 * the real xlsx writer and then evaluates the formulas on a sheet with rows inserted, the way
 * Excel would see it.
 *
 * Run: node scripts/colchis-settlement-totals-test.mjs
 */
import zlib from 'node:zlib';
import { TRADE_TAPES } from '../deploy/netlify/functions/_shared/trade-tapes.mjs';
import { buildXlsx } from '../deploy/netlify/functions/_shared/xlsx-write.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };

const loan = (i, amt) => ({
  sla: 'SLA-2026091' + i, ownerKey: 'chance', params: { tradeDate: '2026-09-25', fundingBank: 'Western Alliance' },
  loan: { id: 'l_' + i, address: i + ' Luna Court, Jacksonville, FL, 32205', fundingDate: '2026-09-18', loanAmt: String(amt), rehabBudget: '0', rate: '11', dutchInterest: 'dutch', loanType: 'bridge' },
  client: { firstName: 'Ann', lastName: 'Lee' }, guarantors: [],
});
const ctxs = [loan(1, 100000), loan(2, 200000), loan(3, 300000), loan(4, 400000), loan(5, 500000)];
const t = TRADE_TAPES.colchis_settlement.build(ctxs);
const rows = t.sheets[0].rows;
const hdr = rows[0];
const L = hdr.indexOf('Total Loan Amount'), M = hdr.indexOf('Loan Balance At Purchase'), Y = hdr.indexOf('Proceeds');
check('the three totals sit under Total Loan Amount (L), Loan Balance At Purchase (M), Proceeds (Y)', [L, M, Y], [11, 12, 24]);
const totals = rows[rows.length - 1];
check('five loans, a blank spacer, then the totals row', [rows.length, rows[rows.length - 2].length], [1 + 5 + 2, 0]);
check('each total sums from row 2 to the row above itself, with no fixed last row', [totals[L].f, totals[M].f, totals[Y].f], ['SUM(L2:INDEX(L:L,ROW()-1))', 'SUM(M2:INDEX(M:M,ROW()-1))', 'SUM(Y2:INDEX(Y:Y,ROW()-1))']);
const num = (x) => Number(x && typeof x === 'object' ? x.v : x) || 0;
check('the cached value (what shows before recalculation) is the sum of ALL five loans', totals[L].v, rows.slice(1, 6).reduce((s, r) => s + num(r[L]), 0));
assert('...which is the full $1.5M, not the first three', totals[L].v === 1500000, String(totals[L].v));

// Evaluate the formula the way a spreadsheet does, on the sheet as generated and after rows
// are inserted or pasted below the data (what broke the old SUM(L2:L4)).
function evalTotal(sheet, col, totalsRowIdx) {
  const f = sheet[totalsRowIdx][col].f;
  const m = /^SUM\(([A-Z]+)2:INDEX\(\1:\1,ROW\(\)-1\)\)$/.exec(f);
  if (!m) return NaN;
  let s = 0;
  for (let r = 1; r <= totalsRowIdx - 1; r++) s += num(sheet[r] && sheet[r][col]);   // rows 2 .. ROW()-1
  return s;
}
check('evaluated on the tape as generated: $1.5M', evalTotal(rows, L, rows.length - 1), 1500000);
const grown = rows.slice(0, 6).concat([[], [], []]).concat(rows.slice(6));
grown[6] = new Array(hdr.length).fill(''); grown[6][L] = 250000;            // a loan typed into the spacer
grown[7] = new Array(hdr.length).fill(''); grown[7][L] = 150000;            // and two more rows inserted
grown[8] = new Array(hdr.length).fill(''); grown[8][L] = 100000;
check('three loans added below the data still count ($2M)', evalTotal(grown, L, grown.length - 1), 2000000);

// And through the real file writer: the formula reaches the sheet XML intact.
const buf = await buildXlsx(t.sheets);
function sheetXml(b) {
  let off = 0;
  while (off < b.length - 30) {
    if (b.readUInt32LE(off) !== 0x04034b50) { off++; continue; }
    const method = b.readUInt16LE(off + 8), csize = b.readUInt32LE(off + 18), nlen = b.readUInt16LE(off + 26), xlen = b.readUInt16LE(off + 28);
    const name = b.slice(off + 30, off + 30 + nlen).toString();
    const start = off + 30 + nlen + xlen;
    if (/sheet1\.xml$/.test(name)) { const d = b.slice(start, start + csize); return method === 0 ? d.toString() : zlib.inflateRawSync(d).toString(); }
    off = start + csize;
  }
  return '';
}
const xml = sheetXml(Buffer.from(buf));
assert('the written .xlsx carries the three formulas on row 8 (L8, M8, Y8)', /<c r="L8"[^>]*><f>SUM\(L2:INDEX\(L:L,ROW\(\)-1\)\)<\/f><v>1500000<\/v>/.test(xml) && /<c r="M8"[^>]*><f>SUM\(M2:INDEX\(M:M,ROW\(\)-1\)\)<\/f>/.test(xml) && /<c r="Y8"[^>]*><f>SUM\(Y2:INDEX\(Y:Y,ROW\(\)-1\)\)<\/f>/.test(xml), (xml.match(/<c r="L8"[^/]*<\/c>/) || [''])[0]);
assert('no fixed-end SUM is left anywhere in the tape', !/SUM\([A-Z]+2:[A-Z]+\d+\)/.test(xml));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
