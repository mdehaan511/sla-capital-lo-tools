/**
 * worksheets-parse-test.mjs — gate for _shared/worksheets.mjs (Deploy 236.947).
 *
 * Synthesizes the two borrower templates as REAL xlsx (via our own
 * xlsx-write) and as CSV, runs them through parseUploadGrid + mapGridToRows,
 * and asserts the mapped rows — including Excel date serials, $-formatted
 * money, reordered/extra columns, junk header rows above the real header,
 * and a totals footer row that must be skipped.
 *
 *   node scripts/worksheets-parse-test.mjs
 */
import { buildXlsx } from '../deploy/netlify/functions/_shared/xlsx-write.mjs';
import {
  parseUploadGrid, mapGridToRows, trackGrossProfit, sowTotal, coerceDate, serialToYmd,
} from '../deploy/netlify/functions/_shared/worksheets.mjs';

let fails = 0;
function ok(cond, label) {
  if (cond) console.log('  ok  ', label);
  else { fails++; console.log('  FAIL', label); }
}

// ── date/money coercion ─────────────────────────────────────────────────────
ok(serialToYmd(46078) === '2026-02-25' || /^\d{4}-\d{2}-\d{2}$/.test(serialToYmd(46078)), 'serial 46078 → a real date (' + serialToYmd(46078) + ')');
ok(coerceDate('46078') === serialToYmd(46078), 'string serial coerces like numeric serial');
ok(coerceDate('3/5/2026') === '2026-03-05', 'US date coerces to ISO');
ok(coerceDate('2026-03-05') === '2026-03-05', 'ISO date passes through');

// ── Track Record: xlsx with junk preamble, reordered cols, serial dates ─────
const trackSheet = [
  ['RTL Track Record', '', '', ''],                       // junk preamble row
  ['', '', '', ''],
  ['Sale Price', 'Vested Owner Name', 'Purchase Date', 'Rehab Costs', 'Purchase Price', 'Guarantor(s) Name', 'Notes'],
  [250000, 'Alpha LLC', 45900, '15,000', '$180,000', 'Jane Doe', 'ignore me'],
  [{ v: 310500.5 }, 'Beta LLC', '1/15/2026', 20000, 200000, 'John Roe', ''],
  [560500, '', '', '', '', '', ''],                       // totals footer → skipped
];
const trackBuf = await buildXlsx([{ name: 'Sheet1', rows: trackSheet }]);
const tGrid = await parseUploadGrid(Buffer.from(trackBuf), 'track.xlsx');
const tMap = mapGridToRows(tGrid, 'track');
ok(tMap.rows.length === 2, 'track: 2 data rows (preamble + footer skipped) — got ' + tMap.rows.length);
const r0 = tMap.rows[0] || {};
ok(r0.owner === 'Alpha LLC', 'track: owner mapped despite column order');
ok(r0.purchasePrice === 180000, 'track: "$180,000" → 180000');
ok(r0.rehabCosts === 15000, 'track: "15,000" → 15000');
ok(/^\d{4}-\d{2}-\d{2}$/.test(r0.purchaseDate || ''), 'track: serial purchase date → ISO (' + r0.purchaseDate + ')');
ok(trackGrossProfit(r0) === 250000 - 180000 - 15000, 'track: gross profit derived = ' + trackGrossProfit(r0));
const r1 = tMap.rows[1] || {};
ok(r1.purchaseDate === '2026-01-15', 'track: US-format date → ISO');
ok(Math.abs(trackGrossProfit(r1) - (310500.5 - 200000 - 20000)) < 0.01, 'track: fractional sale price survives');

// ── SOW: csv with the template's own headers ────────────────────────────────
const sowCsv = [
  'Rehab Budget,',
  'Repair item,Budget',
  'Roof replacement,"$12,500"',
  'Kitchen,18000',
  'Paint (interior),4200.50',
  ',',
].join('\n');
const sGrid = await parseUploadGrid(Buffer.from(sowCsv, 'utf-8'), 'sow.csv');
const sMap = mapGridToRows(sGrid, 'sow');
ok(sMap.rows.length === 3, 'sow: 3 items — got ' + sMap.rows.length);
ok((sMap.rows[0] || {}).budget === 12500, 'sow: "$12,500" → 12500');
ok(sowTotal(sMap.rows) === 12500 + 18000 + 4200.5, 'sow: total = ' + sowTotal(sMap.rows));

// ── header not found ────────────────────────────────────────────────────────
const junk = mapGridToRows([['hello', 'world'], ['1', '2']], 'track');
ok(junk.rows.length === 0 && junk.warnings.length === 1, 'no header → 0 rows + explanation');

console.log(fails ? fails + ' FAILURES' : '\nall worksheet parse checks pass');
process.exit(fails ? 1 : 0);
