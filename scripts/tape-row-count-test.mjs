/**
 * scripts/tape-row-count-test.mjs — Deploy 236.893
 *
 * Gate for the uploaded-trade-tape loan counter (_shared/tape-row-count.mjs).
 *
 * The counter was built against our real historical tapes (Colchis Trade 04,
 * Colchis DSCR Trade 2, Colchis RTL Trade 3, the Stride submission tapes).
 * Those files live in Mike's Downloads, not in the repo, so this rebuilds the
 * SHAPES that made the naive version wrong:
 *
 *   1. header on row 1, then trailing rows of empty formatting cells
 *   2. a summary block above the header (the DSCR tape's Trade Date / Total
 *      UPB / WAVG Px lines) — "first populated row is the header" read that
 *      tape as 6 loans when it holds 2
 *   3. hundreds of self-closing <row/> elements — a non-greedy
 *      <row>…</row> match swallows a run of them and undercounts
 *   4. shared strings, which is how Excel writes every label (our own writer
 *      emits inline strings, so testing only against our output proves little)
 *
 * Run: node scripts/tape-row-count-test.mjs
 */
import {
  countTapeLoans, analyzeRows, csvParse, readSheetRows,
} from '../deploy/netlify/functions/_shared/tape-row-count.mjs';
import {
  pruneGenerated, contentTypeFor, KEEP_GENERATED,
} from '../deploy/netlify/functions/_shared/trade-tape-store.mjs';

// jszip is a deploy/ dependency and node_modules is never committed, so reach
// for it by path rather than by name (this script sits outside deploy/).
let JSZip;
try {
  ({ default: JSZip } = await import('../deploy/node_modules/jszip/lib/index.js'));
} catch (e) {
  console.error('jszip not installed — run:  cd deploy && npm i');
  process.exit(1);
}

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

// ── Build workbooks the way Excel does ────────────────────────────────────
/**
 * @param rows array of arrays; null entries become a self-closing <row/>,
 *             '' cells are written as empty <c/> (formatting residue).
 */
async function makeXlsx(rows, { sheetName = 'Submission', extraSheets = 0, reverseRels = false } = {}) {
  const shared = [];
  const sidx = new Map();
  function si(v) {
    if (!sidx.has(v)) { sidx.set(v, shared.length); shared.push(v); }
    return sidx.get(v);
  }
  const col = (i) => {
    let s = '', n = i + 1;
    while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
    return s;
  };

  let body = '';
  rows.forEach((cells, r) => {
    const rn = r + 1;
    if (cells === null) { body += '<row r="' + rn + '" spans="1:8" ht="15"/>'; return; }
    let cs = '';
    cells.forEach((v, c) => {
      const ref = col(c) + rn;
      if (v === '' || v === null || v === undefined) { cs += '<c r="' + ref + '" s="2"/>'; return; }
      if (typeof v === 'number') { cs += '<c r="' + ref + '"><v>' + v + '</v></c>'; return; }
      cs += '<c r="' + ref + '" t="s"><v>' + si(String(v)) + '</v></c>';
    });
    body += '<row r="' + rn + '" spans="1:8">' + cs + '</row>';
  });

  const zip = new JSZip();
  const sheetXml = '<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + body + '</sheetData></worksheet>';

  // With reverseRels the first TAB is sheet2.xml — workbook order and file
  // numbering are independent, and assuming sheet1.xml counts the wrong sheet.
  const dataSheet = reverseRels ? 'sheet2.xml' : 'sheet1.xml';
  const otherSheet = reverseRels ? 'sheet1.xml' : 'sheet2.xml';
  zip.file('xl/worksheets/' + dataSheet, sheetXml);
  if (extraSheets || reverseRels) {
    zip.file('xl/worksheets/' + otherSheet,
      '<?xml version="1.0"?><worksheet><sheetData><row r="1"><c r="A1" t="s"><v>' + si('Instructions') + '</v></c></row></sheetData></worksheet>');
  }

  zip.file('xl/sharedStrings.xml',
    '<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="' + shared.length + '">' +
    shared.map((s) => '<si><t>' + String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</t></si>').join('') + '</sst>');

  const sheetTags = [
    '<sheet name="' + sheetName + '" sheetId="1" r:id="rId1"/>',
    (extraSheets || reverseRels) ? '<sheet name="Instructions" sheetId="2" r:id="rId2"/>' : '',
  ].join('');
  zip.file('xl/workbook.xml',
    '<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' + sheetTags + '</sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type=".../worksheet" Target="worksheets/' + dataSheet + '"/>' +
    '<Relationship Id="rId2" Type=".../worksheet" Target="worksheets/' + otherSheet + '"/>' +
    '</Relationships>');

  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer' }));
}

const HEADER = ['Lender Loan ID', 'Property Address', 'City', 'State', 'Loan Amount', 'Rate', 'Term', 'Borrower'];
const loan = (n) => ['SLA-' + (3000 + n), n + ' Main St', 'Spokane', 'WA', 250000 + n, 0.1025, 12, 'Borrower ' + n];
const blankCells = () => ['', '', '', '', '', '', '', ''];

console.log('tape-row-count gate\n');

// ── 1. The plain shape: header, loans, trailing formatting rows ───────────
{
  const rows = [HEADER, loan(1), loan(2), loan(3), loan(4), loan(5)];
  for (let i = 0; i < 45; i++) rows.push(blankCells());   // Excel's residue
  const r = await countTapeLoans(await makeXlsx(rows), 'Colchis Trade.xlsx');
  check('header r1 + 5 loans + 45 empty rows → 5', r.loanCount, 5);
  check('  header row reported', r.headerRow, 1);
  check('  sheet name read from the workbook', r.sheetName, 'Submission');
}

// ── 2. Summary block ABOVE the header (the DSCR tape) ─────────────────────
{
  const rows = [
    blankCells(),
    ['', 'Trade Date:', 46003, '', '', '', '', ''],
    ['', 'Total UPB:', 432000, 'Principal Proceeds:', 431716, '', '', ''],
    ['', 'WAVG Inv Rate:', 0.0663, 'Accrued Interest:', 284, '', '', ''],
    ['', 'WAVG Px:', 99.93, 'Total Wire:', 432000, '', '', ''],
    blankCells(),
    blankCells(),
    HEADER,
    loan(1),
    loan(2),
  ];
  const r = await countTapeLoans(await makeXlsx(rows), 'Colchis DSCR Trade.xlsx');
  check('summary rows above the header → 2 loans, not 6', r.loanCount, 2);
  check('  header found on row 8', r.headerRow, 8);
}

// ── 3. Self-closing <row/> elements ───────────────────────────────────────
{
  const rows = [HEADER, loan(1), loan(2), loan(3)];
  for (let i = 0; i < 949; i++) rows.push(null);          // <row r="N"/>
  const buf = await makeXlsx(rows);
  const r = await countTapeLoans(buf, 'Colchis RTL Trade.xlsx');
  check('949 self-closing rows after 3 loans → 3', r.loanCount, 3);

  // Prove the rows were actually read one-by-one rather than merged.
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('xl/worksheets/sheet1.xml').async('string');
  check('  every row element is seen individually', readSheetRows(xml, []).length, 953);
}

// ── 4. A totals line under the tape is not a loan ─────────────────────────
{
  const rows = [HEADER, loan(1), loan(2), loan(3), ['', '', '', '', 661600, '', '', '']];
  const r = await countTapeLoans(await makeXlsx(rows), 'tape with total.xlsx');
  check('a one-cell totals row is excluded', r.loanCount, 3);
  check('  and is called out', /stray value/.test(r.reason), true);
}

// ── 5. The first TAB is not always sheet1.xml ─────────────────────────────
{
  const rows = [HEADER, loan(1), loan(2)];
  const r = await countTapeLoans(await makeXlsx(rows, { reverseRels: true }), 'reordered.xlsx');
  check('first workbook tab resolved through the rels → 2', r.loanCount, 2);
}

// ── 6. An empty template counts zero, not one ─────────────────────────────
{
  const r = await countTapeLoans(await makeXlsx([HEADER, blankCells(), blankCells()]), 'blank template.xlsx');
  check('header only → 0 loans', r.loanCount, 0);
}

// ── 7. Headerless data is not silently docked a row ───────────────────────
{
  const r = analyzeRows([
    { rn: 1, pop: 8, text: 1 },   // all numbers — not labels
    { rn: 2, pop: 8, text: 1 },
    { rn: 3, pop: 8, text: 1 },
  ]);
  check('no header row → every row counts', r.loanCount, 3);
  check('  and says so', /no header row/.test(r.reason), true);
}

// ── 8. CSV, including quoted commas and newlines ──────────────────────────
{
  const csv = [
    'Lender Loan ID,Property Address,City,State,Loan Amount',
    'SLA-3001,"1205 W Palmetto St, Unit 2",Florence,SC,250000',
    'SLA-3002,"5621 S Conklin Rd",Greenacres,WA,310000',
    'SLA-3003,"1906 Whitlock Dr",Benton,AR,180000',
    '',
  ].join('\n');
  const r = await countTapeLoans(Buffer.from(csv, 'utf8'), 'SLA Trade 16.csv');
  check('CSV with quoted commas → 3 loans', r.loanCount, 3);

  const parsed = csvParse('a,"b,c",d\n"line\nbreak",e,f\n');
  check('  quoted comma stays one field', parsed[0], ['a', 'b,c', 'd']);
  check('  quoted newline stays one row', parsed.length, 2);
  check('  embedded newline preserved', parsed[1][0], 'line\nbreak');
}

// ── 9. Formats we store but cannot read say why ───────────────────────────
{
  for (const [f, hint] of [['Trade.xls', '.xls'], ['Trade.xlsb', '.xlsb']]) {
    const r = await countTapeLoans(Buffer.from('not a zip'), f);
    check(f + ' → no count, with a reason', r.loanCount, null);
    check('  reason names the format', r.reason.includes(hint), true);
  }
  const bad = await countTapeLoans(Buffer.from('definitely not a workbook'), 'Trade.xlsx');
  check('a corrupt .xlsx → no count, no crash', bad.loanCount, null);
  check('  reason is non-empty', bad.reason.length > 0, true);
}

// ── 10. .xlsm reads like .xlsx (Stride tapes arrive macro-enabled) ────────
{
  const r = await countTapeLoans(await makeXlsx([HEADER, loan(1)]), 'Stride Submission Loan Tape.xlsm');
  check('.xlsm parses as a workbook → 1', r.loanCount, 1);
}

// ── 11. Retention: an export must never age out an uploaded final ─────────
// The catalogue exists so tapes can be produced for an audit years later.
// The 300-tape prune is there to stop generated working output piling up; if
// it ever starts counting uploaded finals, the audit record quietly rots.
{
  const deleted = [];
  const fakeStore = { delete: async (k) => { deleted.push(k); } };
  const idx = { tapes: [] };
  for (let i = 0; i < 320; i++) idx.tapes.push({ id: 'g' + i, source: 'generated' });
  // Three finals, deliberately at the OLD end where the prune bites.
  idx.tapes.splice(305, 0, { id: 'final-a', source: 'uploaded' });
  idx.tapes.splice(312, 0, { id: 'final-b', source: 'uploaded' });
  idx.tapes.push({ id: 'final-c', source: 'uploaded' });

  await pruneGenerated(fakeStore, idx);

  const kept = idx.tapes.filter((t) => t.source === 'uploaded').map((t) => t.id);
  check('uploaded finals survive the prune', kept, ['final-a', 'final-b', 'final-c']);
  check('  generated tapes trimmed to the cap', idx.tapes.filter((t) => t.source === 'generated').length, KEEP_GENERATED);
  check('  only generated files deleted', deleted.every((k) => /^file\/g\d+$/.test(k)), true);
  check('  20 of them', deleted.length, 320 - KEEP_GENERATED);
}

// ── 12. Re-download content types match the stored file ───────────────────
{
  check('.xlsx → spreadsheet', contentTypeFor('Trade.xlsx').endsWith('spreadsheetml.sheet'), true);
  check('.csv → text/csv', contentTypeFor('Trade 16.csv'), 'text/csv');
  check('.xls → legacy excel', contentTypeFor('Old.xls'), 'application/vnd.ms-excel');
  check('.xlsm is not mistaken for .xls', contentTypeFor('Stride.xlsm'), 'application/vnd.ms-excel.sheet.macroEnabled.12');
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
