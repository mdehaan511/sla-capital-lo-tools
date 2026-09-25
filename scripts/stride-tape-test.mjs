/**
 * scripts/stride-tape-test.mjs — Deploy 237.131
 *
 * Gate for the Stride submission tapes (deploy/netlify/functions/_shared/
 * trade-tapes.mjs + xlsx-write.mjs): the generated workbooks must carry the
 * templates' formulas, number formats, real date serials, header looks,
 * column-width floors and (RTL) the "Form, mapped" sheet — and every formula's
 * column LETTER must still sit under the header it was written for.
 *
 * Run: node scripts/stride-tape-test.mjs          (writes nothing)
 *      OUT=/some/dir node scripts/stride-tape-test.mjs   (also saves the two .xlsx)
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { TRADE_TAPES } from '../deploy/netlify/functions/_shared/trade-tapes.mjs';
import { buildXlsx } from '../deploy/netlify/functions/_shared/xlsx-write.mjs';
const require = createRequire(new URL('../deploy/package.json', import.meta.url));
const JSZip = require('jszip');

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}
const truthy = (name, v) => check(name, !!v, true);
const colIdx = (L) => { let n = 0; for (const ch of L) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };
const label = (cell) => (cell && typeof cell === 'object') ? cell.t : cell;

const client = { id: 'c1', firstName: 'Joseph', lastName: 'Benasutti', email: 'j@x.com', fico: 793, usCitizen: 'yes', loans: [] };
const rtlLoan = (id, addr, total, rehab) => ({
  id, toolType: 'rtl', loanType: 'fix_flip', address: addr, loanAmt: total, rehabBudget: rehab, rate: 10.5, buyRate: 9.75,
  loanPurpose: 'purchase', purchasePrice: 350000, aivBpo: 490000, arvBpo: 525000, aivBpoFromBpo: true, arvBpoFromBpo: true, fundingDate: '2026-03-13', loanTerm: 12,
  dutchInterest: 'dutch', propType: 'sfr', numUnits: 1, bedrooms: 3, bathrooms: 2, sqft: 2174, entityName: 'Imagine Investors LLC', experience: 3,
});
const dscrLoan = (id, addr, total, value, io) => ({
  id, toolType: 'dscr', address: addr, loanAmt: total, propValue: value, rate: 6.25, loanPurpose: 'refi', isIO: io ? 'yes' : 'no',
  dscr: 1.251, _totalPayment: 2398.73, points: 0.5, fundingDate: '2026-04-21', rateLockStart: '2026-03-13', prepay: '54321',
  propType: 'sfr', numUnits: 1, entityName: 'CF Worx, LLC',
});
const ctx = (loan, sla) => ({ loan, client, guarantors: [], ownerKey: 'lo@slacapital.com', params: {}, sla });

console.log('stride tape gate\n');

// ── RTL ───────────────────────────────────────────────────────────────────
const rtl = TRADE_TAPES.stride_rtl.build([
  ctx(rtlLoan('l1', '2794 Sawgrass Loop, Richland, WA 99354, USA', 385000, 70000), 'SLA-20260207-1657'),
  ctx(rtlLoan('l2', '1230 Jennings Ave, Santa Rosa, CA 95401, USA', 424000, 34547), 'SLA-20260227-1900'),
]);
const s1 = rtl.sheets[0], mp = rtl.sheets[1];
check('RTL workbook: Sheet1 + "Form, mapped"', rtl.sheets.map((s) => s.name), ['Sheet1', 'Form, mapped']);
check('RTL letters still under their headers (C,I,P,Q,R,S,W,H,AD,AE,AG,AI)',
  ['C', 'I', 'P', 'Q', 'R', 'S', 'W', 'H', 'AD', 'AE', 'AG', 'AI'].map((L) => label(s1.rows[0][colIdx(L)])),
  ['Loan Number', 'Loan Number', 'Total Loan Amount', 'Original Rehab Amount', 'Current Rehab Amount', 'Current Balance', 'Total Rehab Amount', 'Investor Buy Rate', 'Note Rate', 'Origination Date', 'First Due', 'Term']);
check('RTL mapped-sheet sources still under their headers (A,B,D,F,G,J,K,L,M,N,O,Y,Z,AA,AB,AJ,AK,AR,AS,AT,AU)',
  ['A', 'B', 'D', 'F', 'G', 'J', 'K', 'L', 'M', 'N', 'O', 'Y', 'Z', 'AA', 'AB', 'AJ', 'AK', 'AR', 'AS', 'AT', 'AU'].map((L) => label(s1.rows[0][colIdx(L)])),
  ['Servicer ID', 'Initial Escrow', 'Seller', 'Seller Program', 'Investor', 'Borrowing Entity', 'Guarantor', 'Address', 'City', 'State', 'Zip', 'FICO', 'Purchase Price', 'AIV', 'ARV', 'Purchase/Refi', 'Accrual Type', '# of Units', 'Property Type', 'Loan Type', 'Exit Strategy']);
check('RTL header looks: A-B yellow, the rest grey', [s1.rows[0][0].s, s1.rows[0][1].s, s1.rows[0][2].s, s1.rows[0][55].s], ['hdrYellow', 'hdrYellow', 'hdrGrey', 'hdrGrey']);
check('RTL row 2 formulas: I =+C2, S =P2-Q2 (cached 315000, $), W =R2', [s1.rows[1][colIdx('I')], s1.rows[1][colIdx('S')], s1.rows[1][colIdx('W')]],
  [{ f: '+C2', v: 'SLA-20260207-1657' }, { f: 'P2-Q2', v: 315000, s: 'cur' }, { f: 'R2', v: 70000, s: 'cur' }]);
check('RTL row 3 formulas follow the row', [s1.rows[2][colIdx('I')].f, s1.rows[2][colIdx('S')].f, s1.rows[2][colIdx('W')].f], ['+C3', 'P3-Q3', 'R3']);
check('RTL money is $ formatted, buy rate 0.000% (Closings-tab Buy Rate), note rate %', [s1.rows[1][colIdx('P')], s1.rows[1][colIdx('H')], s1.rows[1][colIdx('AD')]],
  [{ v: 385000, s: 'cur' }, { v: 0.0975, s: 'pct3' }, { v: 0.105, s: 'pct' }]);
check('RTL dates are real serials (3/13/2026 = 46094)', s1.rows[1][colIdx('AE')], { v: 46094, s: 'date' });
check('RTL layout: template width floors, header skipped by the autofit', [s1.minWidths.length, s1.minWidths[0], s1.autofitFromRow], [56, 13.86, 1]);
check('mapped sheet: two header rows + one formula row per loan', [mp.rows.length, mp.rows[1].length, label(mp.rows[1][0]), label(mp.rows[0][colIdx('C')])], [4, 67, 'Loan Number', 'Disbursment Date']);
check('mapped row 3 reads Sheet1 row 2', [mp.rows[2][colIdx('A')], mp.rows[2][colIdx('O')], mp.rows[2][colIdx('AB')].f, mp.rows[2][colIdx('AH')], mp.rows[2][colIdx('BK')]],
  [{ f: '"PK"&Sheet1!C2', v: 'PKSLA-20260207-1657' }, { f: 'Sheet1!S2', v: 315000, s: 'acct2' }, 'Sheet1!L2', 'Investment', 'RTL']);
check('mapped row 4 reads Sheet1 row 3 (own-sheet refs move too)', [mp.rows[3][colIdx('A')].f, mp.rows[3][colIdx('P')].f, mp.rows[3][colIdx('BI')].f],
  ['"PK"&Sheet1!C3', "IFERROR('Form, mapped'!$O4/Sheet1!AA3,\"\")", "'Form, mapped'!$S4-'Form, mapped'!$BH4"]);
check('mapped cached LTVs: balance / AIV, total / ARV', [Math.round(mp.rows[2][colIdx('P')].v * 1e4) / 1e4, Math.round(mp.rows[2][colIdx('Q')].v * 1e4) / 1e4], [0.6429, 0.7333]);
check('mapped term / IO / amort', [mp.rows[2][colIdx('S')].v, mp.rows[2][colIdx('BH')].v, mp.rows[2][colIdx('BI')].v, mp.rows[2][colIdx('BF')].v], ['12', '12', 0, 99]);

// ── DSCR ──────────────────────────────────────────────────────────────────
const dscr = TRADE_TAPES.stride_dscr.build([
  ctx(dscrLoan('d1', '1325 Lansing St, Aurora, CO 80010, USA', 322250, 425000, false), 'SLA-20260304-1976'),
  ctx(dscrLoan('d2', '8436 Island Pines Pl, Maineville, OH 45039, USA', 150000, 250000, true), 'SLA-20260220-1800'),
]);
const fm = dscr.sheets[0];
check('DSCR workbook: the Form sheet only', dscr.sheets.map((s) => s.name), ['Form']);
check('DSCR letters still under their headers (E,Q,T,U,Y,AH,AJ,BD,BN,BO)',
  ['E', 'Q', 'T', 'U', 'Y', 'AH', 'AJ', 'BD', 'BN', 'BO'].map((L) => String(label(fm.rows[0][colIdx(L)])).trim()),
  ['Original Loan Amount', 'Note Rate', 'LTV', 'CLTV', 'Property Value', 'Amort Term', 'IO Flag', 'Monthly P&I', 'Investor Lock Date', 'Investor Lock Expiration Date']);
check('DSCR formats: amount accounting, rate 0.000%, DSCR 0.000, value/PITI accounting', [fm.rows[1][colIdx('E')], fm.rows[1][colIdx('Q')], fm.rows[1][colIdx('V')], fm.rows[1][colIdx('Y')], fm.rows[1][colIdx('BE')]],
  [{ v: 322250, s: 'acct0' }, { v: 0.0625, s: 'pct3' }, { v: 1.251, s: 'acct3' }, { v: 425000, s: 'acct2' }, { v: 2398.73, s: 'acct2' }]);
check('DSCR live LTV / CLTV with cached values', [fm.rows[1][colIdx('T')], fm.rows[1][colIdx('U')]],
  [{ f: 'IF(Y2>0,ROUND(E2/Y2,4),"")', v: 0.7582, s: 'pct' }, { f: 'T2', v: 0.7582, s: 'pct' }]);
check('DSCR live P&I: amortizing row caches the PMT, IO row caches interest-only', [fm.rows[1][colIdx('BD')].v, fm.rows[2][colIdx('BD')].v, fm.rows[2][colIdx('BD')].f],
  [1984.15, 781.25, 'IF(AJ3="Yes",ROUND(E3*Q3/12,2),ROUND(-PMT(Q3/12,AH3,E3),2))']);
check('DSCR lock: real date + live 45-day expiry', [fm.rows[1][colIdx('BN')], fm.rows[1][colIdx('BO')]], [{ v: 46094, s: 'date' }, { f: 'BN2+45', v: 46139, s: 'date' }]);
check('DSCR layout: frozen B2, tall wrapped header, width floors', [fm.freeze, fm.rowHeights, fm.minWidths.length, fm.rows[0][0].s], [{ cols: 1, rows: 1 }, { 1: 56.25 }, 73, 'hdrWrap']);
check('required-blank report still works (investor-side hand-fills)', [rtl.missing.some((m) => /Stride ID/.test(m)), dscr.missing.some((m) => /Pass-thru Rate/.test(m))], [true, true]);

// ── the files themselves ──────────────────────────────────────────────────
const unzip = async (buf) => { const z = await JSZip.loadAsync(buf); const o = {}; for (const k of Object.keys(z.files)) o[k] = await z.files[k].async('string'); return o; };
const rtlBuf = await buildXlsx(rtl.sheets), dscrBuf = await buildXlsx(dscr.sheets);
const R = await unzip(rtlBuf), Dz = await unzip(dscrBuf);
const sheet1 = R['xl/worksheets/sheet1.xml'], mapped = R['xl/worksheets/sheet2.xml'], form = Dz['xl/worksheets/sheet1.xml'];
truthy('RTL xml: formulas written without "=" and with cached values', /<c r="S2" s="3"><f>P2-Q2<\/f><v>315000<\/v><\/c>/.test(sheet1) && /<c r="I3" t="str"><f>\+C3<\/f><v>SLA-20260227-1900<\/v><\/c>/.test(sheet1));
truthy('RTL xml: header cell styled + wrapped row height', /<row r="1" ht="60" customHeight="1"><c r="A1" s="11" t="inlineStr">/.test(sheet1));
truthy('RTL xml: width floor kept where data is short, widened where it is long', /<col min="5" max="5" width="8.71" customWidth="1"\/>/.test(sheet1) && /<col min="10" max="10" width="23" customWidth="1"\/>/.test(sheet1));
truthy('mapped xml: quoted sheet refs escaped, merges present', mapped.indexOf("<f>IFERROR('Form, mapped'!$O3/Sheet1!AA2,\"\")</f>") >= 0 && /<mergeCells count="5"><mergeCell ref="Z1:AA1"\/>/.test(mapped));
truthy('workbook lists both sheets and recalcs on open', /name="Sheet1"/.test(R['xl/workbook.xml']) && /name="Form, mapped"/.test(R['xl/workbook.xml']) && /fullCalcOnLoad="1"/.test(R['xl/workbook.xml']));
truthy('DSCR xml: frozen pane before cols, header height', /<sheetViews><sheetView workbookViewId="0"><pane xSplit="1" ySplit="1" topLeftCell="B2" activePane="bottomRight" state="frozen"\/><\/sheetView><\/sheetViews><cols>/.test(form) && /<row r="1" ht="56.25" customHeight="1">/.test(form));
truthy('DSCR xml: PMT formula + date serial style', form.indexOf('<f>IF(AJ2="Yes",ROUND(E2*Q2/12,2),ROUND(-PMT(Q2/12,AH2,E2),2))</f>') >= 0 && /<c r="BN2" s="2"><v>46094<\/v><\/c>/.test(form));
const styles = R['xl/styles.xml'];
check('styles: 16 cellXfs, 7 custom formats, the original three indices unmoved', [(styles.match(/<xf /g) || []).length - 1, (styles.match(/<numFmt /g) || []).length,
  /<cellXfs count="16"><xf numFmtId="0"[^>]*\/><xf numFmtId="10"[^>]*\/><xf numFmtId="14"[^>]*\/><xf numFmtId="164"/.test(styles)], [16, 7, true]);

// ── the writer stays backward compatible for every other caller ───────────
{
  const plain = await unzip(await buildXlsx([{ name: 'Plain', rows: [['Name', 'Amount'], ['A very long borrower name indeed', { v: 1234.5, s: 'cur' }], ['x', { f: 'SUM(B2:B2)', v: 1234.5, s: 'cur' }]] }]));
  const px = plain['xl/worksheets/sheet1.xml'];
  truthy('plain sheet: autofit 9-42 as before, no sheetViews / merges / row heights', px.indexOf('<col min="1" max="1" width="' + ('A very long borrower name indeed'.length + 2) + '" customWidth="1"/>') >= 0 && /<col min="2" max="2" width="13" customWidth="1"\/>/.test(px) && !/sheetViews|mergeCells|customHeight/.test(px));
  truthy('plain sheet: header strings + styled cells unchanged', /<c r="A1" t="inlineStr"><is><t xml:space="preserve">Name<\/t><\/is><\/c>/.test(px) && /<c r="B2" s="3"><v>1234.5<\/v><\/c>/.test(px) && /<c r="B3" s="3"><f>SUM\(B2:B2\)<\/f><v>1234.5<\/v><\/c>/.test(px));
}

if (process.env.OUT) {
  fs.writeFileSync(path.join(process.env.OUT, 'stride_rtl_sample.xlsx'), rtlBuf);
  fs.writeFileSync(path.join(process.env.OUT, 'stride_dscr_sample.xlsx'), dscrBuf);
  console.log('\nsaved samples to ' + process.env.OUT);
}
console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
