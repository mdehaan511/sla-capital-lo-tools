/**
 * _shared/xlsx-write.mjs — Deploy 236.885 (Mike, trade tapes)
 *
 * Minimal .xlsx writer on top of jszip (already a dependency — an xlsx is a
 * zip of XML parts). Strings go in as inline strings, numbers as numbers, so
 * Excel opens the file natively with real types; no shared-strings table.
 *
 * buildXlsx(sheets) → Buffer
 *   sheets: [{ name, rows: [ [cell, ...], ... ], ...layout }]
 *   cell: string | number | null/undefined/'' (empty)
 *       | { v: number, s }        — styled number (see STYLES below)
 *       | { f, v?, s? }           — FORMULA (236.976); v = cached number OR
 *                                   string (237.131 — string results cache as
 *                                   t="str" so a viewer that never recalculates
 *                                   still shows them)
 *       | { t: 'text', s }        — styled STRING (237.131 — header cells)
 *
 * Deploy 237.131 (Mike, Stride tapes: "all of the formulas and appropriate
 * widths like we did with the Colchis Settlement tape") — optional per-sheet
 * layout, all backward compatible (a sheet with only name + rows renders
 * exactly as before):
 *   minWidths: [w, ...]   per-column floor (the investor template's widths);
 *                         the column is max(floor, autofit)
 *   autofitFromRow: n     first row INDEX the autofit looks at (1 = skip a
 *                         wrapped header row so a long label can't set the width)
 *   freeze: { cols, rows } frozen panes
 *   rowHeights: { 1: 56.25 }  explicit row heights by 1-based row number
 *   merges: ['Z1:AA1', ...]
 */
import JSZip from 'jszip';

function colLetter(i) { // 0 → A, 26 → AA
  let s = '';
  i = i + 1;
  while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); }
  return s;
}

function escXml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    // Excel rejects raw control chars in XML.
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

// ── Styles ────────────────────────────────────────────────────────────────
// Style key → cellXfs index. 1-3 are the original indices (236.886 / .976 /
// .977) and must not move. Everything after is Deploy 237.131: the number
// formats + header looks Stride's own submission templates use.
const ACCT = (dec) => '_(* #,##0' + dec + '_);_(* \\(#,##0' + dec + '\\);_(* "-"??_);_(@_)';
const NUM_FMTS = [ // [numFmtId, formatCode]
  [164, '"$"#,##0.00'],
  [165, '0.000%'],
  [166, '0.0%'],
  [167, ACCT('')],
  [168, ACCT('.00')],
  [169, ACCT('.000')],
  [170, '0.000'],
];
const FONTS = [
  '<font><sz val="11"/><name val="Calibri"/></font>',
  '<font><b/><sz val="11"/><name val="Calibri"/></font>',
  '<font><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>',
];
const solid = (rgb) => '<fill><patternFill patternType="solid"><fgColor rgb="' + rgb + '"/><bgColor indexed="64"/></patternFill></fill>';
const FILLS = [
  '<fill><patternFill patternType="none"/></fill>',
  '<fill><patternFill patternType="gray125"/></fill>',
  solid('FFFFFF00'), // 2 yellow  (Stride RTL: Servicer ID / Initial Escrow headers)
  solid('FFD8D8D8'), // 3 grey    (Stride RTL headers)
  solid('FF27384C'), // 4 navy    (Stride "Form, mapped" header row)
  solid('FFE2EFDA'), // 5 green   (Stride "Form, mapped" group labels)
];
const CENTER_WRAP = '<alignment horizontal="center" vertical="center" wrapText="1"/>';
const XFS = [ // [key, numFmtId, fontId, fillId, alignmentXml]
  ['', 0, 0, 0, ''],
  ['pct', 10, 0, 0, ''],
  ['date', 14, 0, 0, ''],
  ['cur', 164, 0, 0, ''],
  ['pct3', 165, 0, 0, ''],
  ['pct1', 166, 0, 0, ''],
  ['acct0', 167, 0, 0, ''],
  ['acct2', 168, 0, 0, ''],
  ['acct3', 169, 0, 0, ''],
  ['num3', 170, 0, 0, ''],
  ['int', 1, 0, 0, ''],
  ['hdrYellow', 0, 1, 2, CENTER_WRAP],
  ['hdrGrey', 0, 1, 3, CENTER_WRAP],
  ['hdrWrap', 0, 0, 0, '<alignment vertical="top" wrapText="1"/>'],
  ['hdrNavy', 0, 2, 4, '<alignment horizontal="left"/>'],
  ['hdrGreen', 0, 0, 5, '<alignment horizontal="left"/>'],
];
const STYLE_INDEX = {};
XFS.forEach((x, i) => { if (x[0]) STYLE_INDEX[x[0]] = i; });
const styleAttr = (s) => (s && STYLE_INDEX[s]) ? ' s="' + STYLE_INDEX[s] + '"' : '';

// Deploy 236.977 (Mike) — approximate the on-screen width of a cell in Excel
// character units, so every sheet opens with columns wide enough to read.
function cellDisplayWidth(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'object') {
    if (typeof v.t === 'string') return v.t.length;
    if (typeof v.v === 'number' && isFinite(v.v)) {
      if (v.s === 'date') return 10;                          // m/d/yyyy
      if (v.s === 'pct' || v.s === 'pct3' || v.s === 'pct1') return String(Math.round(v.v * 100000) / 1000).length + 3;
      const base = Math.round(Math.abs(v.v)).toLocaleString('en-US').length;
      return base + (v.s === 'cur' ? 6 : (v.s === 'acct3' || v.s === 'num3') ? 5 : 3); // $ , .00
    }
    if (typeof v.v === 'string') return v.v.length;           // cached string formula
    return typeof v.f === 'string' ? 12 : 0;                  // uncached formula
  }
  if (typeof v === 'number') return String(v).length + 1;
  return String(v).length;
}

function sheetXml(rows, opts) {
  opts = opts || {};
  let out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  // Deploy 237.131 — frozen panes (element order matters: sheetViews → cols
  // → sheetData → mergeCells).
  const fz = opts.freeze || null;
  if (fz && (fz.cols > 0 || fz.rows > 0)) {
    const xs = fz.cols > 0 ? fz.cols : 0, ys = fz.rows > 0 ? fz.rows : 0;
    const pane = (xs && ys) ? 'bottomRight' : (xs ? 'topRight' : 'bottomLeft');
    out += '<sheetViews><sheetView workbookViewId="0"><pane' + (xs ? ' xSplit="' + xs + '"' : '') + (ys ? ' ySplit="' + ys + '"' : '') +
      ' topLeftCell="' + colLetter(xs) + (ys + 1) + '" activePane="' + pane + '" state="frozen"/></sheetView></sheetViews>';
  }
  // Deploy 236.977 — <cols> autofit: each column as wide as its widest cell
  // (clamped 9–42 so a stray long string can't blow the layout out).
  // Deploy 237.131 — minWidths floors each column at the investor template's
  // width; autofitFromRow skips wrapped header rows.
  let nCols = 0;
  for (const row of rows) if (row && row.length > nCols) nCols = row.length;
  const minW = Array.isArray(opts.minWidths) ? opts.minWidths : null;
  const fromRow = Math.max(0, Number(opts.autofitFromRow) || 0);
  if (nCols) {
    let cols = '';
    for (let c = 0; c < nCols; c++) {
      let w = 0;
      for (let r = fromRow; r < rows.length; r++) {
        const cw = cellDisplayWidth(rows[r] && rows[r][c]);
        if (cw > w) w = cw;
      }
      let width = minW ? Math.max(Number(minW[c]) || 0, w ? Math.min(42, w + 2) : 0) : Math.min(42, Math.max(9, w + 2));
      if (!(width > 0)) width = 9;
      cols += '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + (Math.round(width * 100) / 100) + '" customWidth="1"/>';
    }
    out += '<cols>' + cols + '</cols>';
  }
  out += '<sheetData>';
  const heights = opts.rowHeights || {};
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    const ht = Number(heights[r + 1]);
    out += '<row r="' + (r + 1) + '"' + (ht > 0 ? ' ht="' + ht + '" customHeight="1"' : '') + '>';
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      const ref = colLetter(c) + (r + 1);
      if (v && typeof v === 'object' && typeof v.f === 'string' && v.f) {
        // Deploy 236.976 (Mike, Colchis settlement) — FORMULA cell:
        // { f: 'SUM(L2:L4)', v?: cached, s?: style }. The cached value paints
        // before Excel's first recalc; fullCalcOnLoad in workbook.xml makes
        // Excel recompute everything on open regardless.
        if (typeof v.v === 'string') {
          out += '<c r="' + ref + '"' + styleAttr(v.s) + ' t="str"><f>' + escXml(v.f) + '</f><v>' + escXml(v.v) + '</v></c>';
        } else {
          out += '<c r="' + ref + '"' + styleAttr(v.s) + '><f>' + escXml(v.f) + '</f>' +
            (typeof v.v === 'number' && isFinite(v.v) ? '<v>' + v.v + '</v>' : '') + '</c>';
        }
      } else if (v && typeof v === 'object' && typeof v.t === 'string') {
        // Deploy 237.131 — styled string (header looks).
        if (v.t === '' && !styleAttr(v.s)) continue;
        out += '<c r="' + ref + '"' + styleAttr(v.s) + ' t="inlineStr"><is><t xml:space="preserve">' + escXml(v.t) + '</t></is></c>';
      } else if (v && typeof v === 'object' && typeof v.v === 'number' && isFinite(v.v)) {
        // Styled number — see XFS. Dates are Excel serials: real serials keep
        // DAYS360/EDATE-style formulas working — date STRINGS break them.
        out += '<c r="' + ref + '"' + styleAttr(v.s) + '><v>' + v.v + '</v></c>';
      } else if (typeof v === 'number' && isFinite(v)) {
        out += '<c r="' + ref + '"><v>' + v + '</v></c>';
      } else if (v && typeof v === 'object') {
        continue; // styled cell with no numeric value → blank
      } else {
        out += '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + escXml(v) + '</t></is></c>';
      }
    }
    out += '</row>';
  }
  out += '</sheetData>';
  const merges = Array.isArray(opts.merges) ? opts.merges.filter((m) => /^[A-Z]+\d+:[A-Z]+\d+$/.test(String(m))) : [];
  if (merges.length) out += '<mergeCells count="' + merges.length + '">' + merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>';
  return out + '</worksheet>';
}

function safeSheetName(name, idx) {
  const n = String(name || ('Sheet' + (idx + 1))).replace(/[\\/*?:\[\]]/g, ' ').trim().slice(0, 31);
  return n || ('Sheet' + (idx + 1));
}

function stylesXml() {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<numFmts count="' + NUM_FMTS.length + '">' +
    NUM_FMTS.map((f) => '<numFmt numFmtId="' + f[0] + '" formatCode="' + escXml(f[1]).replace(/"/g, '&quot;') + '"/>').join('') + '</numFmts>' +
    '<fonts count="' + FONTS.length + '">' + FONTS.join('') + '</fonts>' +
    '<fills count="' + FILLS.length + '">' + FILLS.join('') + '</fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' + XFS.length + '">' +
    XFS.map((x) => '<xf numFmtId="' + x[1] + '" fontId="' + x[2] + '" fillId="' + x[3] + '" borderId="0" xfId="0"' +
      (x[1] ? ' applyNumberFormat="1"' : '') + (x[2] ? ' applyFont="1"' : '') + (x[3] ? ' applyFill="1"' : '') +
      (x[4] ? ' applyAlignment="1">' + x[4] + '</xf>' : '/>')).join('') +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>';
}

export async function buildXlsx(sheets) {
  if (!Array.isArray(sheets) || !sheets.length) throw new Error('buildXlsx: no sheets');
  const zip = new JSZip();
  const names = sheets.map((s, i) => safeSheetName(s.name, i));

  zip.file('[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
    sheets.map((_, i) =>
      '<Override PartName="/xl/worksheets/sheet' + (i + 1) + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
    ).join('') +
    '</Types>');

  zip.file('_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '</Relationships>');

  zip.file('xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    // Deploy 237.131 — a workbook view for the frozen-pane sheetViews to point at.
    '<bookViews><workbookView/></bookViews><sheets>' +
    names.map((n, i) => '<sheet name="' + escXml(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>').join('') +
    // Deploy 236.976 — recalc every formula on open, so formula cells are
    // right even where we didn't cache a value.
    '</sheets><calcPr fullCalcOnLoad="1"/></workbook>');

  zip.file('xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    sheets.map((_, i) =>
      '<Relationship Id="rId' + (i + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>'
    ).join('') +
    '<Relationship Id="rId' + (sheets.length + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
    '</Relationships>');

  // Deploy 236.886 — minimal stylesheet (Excel requires the fonts/fills/
  // borders scaffolding even when unused); 237.131 builds it from the tables
  // above.
  zip.file('xl/styles.xml', stylesXml());

  sheets.forEach((s, i) => zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s.rows || [], s)));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
