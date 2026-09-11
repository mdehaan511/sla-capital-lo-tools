/**
 * _shared/xlsx-write.mjs — Deploy 236.885 (Mike, trade tapes)
 *
 * Minimal .xlsx writer on top of jszip (already a dependency — an xlsx is a
 * zip of XML parts). Strings go in as inline strings, numbers as numbers, so
 * Excel opens the file natively with real types; no shared-strings table, no
 * styles beyond the defaults (investor tapes care about values + column
 * order, not fonts).
 *
 * buildXlsx(sheets) → Buffer
 *   sheets: [{ name, rows: [ [cell, ...], ... ] }]
 *   cell: string | number | null/undefined/'' (empty)
 *       | { v: number, s: 'pct' }  — percent-formatted number (Deploy 236.886:
 *         rates/points/LTC columns read as "below zero" when left as raw
 *         decimals; a minimal styles.xml with built-in numFmt 10 "0.00%"
 *         renders 0.1099 as 10.99%)
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

// Deploy 236.977 (Mike) — approximate the on-screen width of a cell in Excel
// character units, so every sheet opens with columns wide enough to read.
function cellDisplayWidth(v) {
  if (v === null || v === undefined || v === '') return 0;
  if (typeof v === 'object') {
    if (typeof v.v === 'number' && isFinite(v.v)) {
      if (v.s === 'date') return 10;                          // m/d/yyyy
      if (v.s === 'pct') return String(Math.round(v.v * 10000) / 100).length + 3;
      const base = Math.round(Math.abs(v.v)).toLocaleString('en-US').length;
      return base + (v.s === 'cur' ? 6 : 3);                  // $ , .00
    }
    return typeof v.f === 'string' ? 12 : 0;                  // uncached formula
  }
  if (typeof v === 'number') return String(v).length + 1;
  return String(v).length;
}

function sheetXml(rows) {
  let out = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
  // Deploy 236.977 — <cols> autofit: each column as wide as its widest cell
  // (clamped 9–42 so a stray long string can't blow the layout out).
  let nCols = 0;
  for (const row of rows) if (row && row.length > nCols) nCols = row.length;
  if (nCols) {
    let cols = '';
    for (let c = 0; c < nCols; c++) {
      let w = 0;
      for (const row of rows) {
        const cw = cellDisplayWidth(row && row[c]);
        if (cw > w) w = cw;
      }
      cols += '<col min="' + (c + 1) + '" max="' + (c + 1) + '" width="' + Math.min(42, Math.max(9, w + 2)) + '" customWidth="1"/>';
    }
    out += '<cols>' + cols + '</cols>';
  }
  out += '<sheetData>';
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r] || [];
    out += '<row r="' + (r + 1) + '">';
    for (let c = 0; c < row.length; c++) {
      const v = row[c];
      if (v === null || v === undefined || v === '') continue;
      const ref = colLetter(c) + (r + 1);
      if (v && typeof v === 'object' && typeof v.f === 'string' && v.f) {
        // Deploy 236.976 (Mike, Colchis settlement) — FORMULA cell:
        // { f: 'SUM(L2:L4)', v?: cachedNumber, s?: 'pct'|'date' }. The cached
        // value paints before Excel's first recalc; fullCalcOnLoad in
        // workbook.xml makes Excel recompute everything on open regardless.
        const fstyle = v.s === 'pct' ? ' s="1"' : v.s === 'date' ? ' s="2"' : v.s === 'cur' ? ' s="3"' : '';
        out += '<c r="' + ref + '"' + fstyle + '><f>' + escXml(v.f) + '</f>' +
          (typeof v.v === 'number' && isFinite(v.v) ? '<v>' + v.v + '</v>' : '') + '</c>';
      } else if (v && typeof v === 'object' && typeof v.v === 'number' && isFinite(v.v)) {
        // Styled number — 'pct' (cellXfs 1 = 0.00%), 'date' (cellXfs 2 =
        // m/d/yyyy, value is an Excel date serial; real serials keep
        // DAYS360/EDATE-style formulas working — date STRINGS break them),
        // or 'cur' (cellXfs 3 = $#,##0.00; Deploy 236.977).
        const style = v.s === 'pct' ? ' s="1"' : v.s === 'date' ? ' s="2"' : v.s === 'cur' ? ' s="3"' : '';
        out += '<c r="' + ref + '"' + style + '><v>' + v.v + '</v></c>';
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
  return out + '</sheetData></worksheet>';
}

function safeSheetName(name, idx) {
  const n = String(name || ('Sheet' + (idx + 1))).replace(/[\\/*?:\[\]]/g, ' ').trim().slice(0, 31);
  return n || ('Sheet' + (idx + 1));
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
    'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
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

  // Deploy 236.886 — minimal stylesheet: xf 0 = default, xf 1 = built-in
  // numFmt 10 ("0.00%") for the { v, s:'pct' } cells. Excel requires the
  // fonts/fills/borders scaffolding even when unused.
  zip.file('xl/styles.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    // Deploy 236.977 — custom currency format for { s:'cur' } cells.
    '<numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>' +
    '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
    '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="1"><border/></borders>' +
    '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="4">' +
    '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
    '<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    // Deploy 236.976 — built-in numFmt 14 = m/d/yyyy for { v: serial, s:'date' }.
    '<xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    // Deploy 236.977 — currency (numFmt 164 above) for { s:'cur' }.
    '<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>' +
    '</cellXfs>' +
    '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
    '</styleSheet>');

  sheets.forEach((s, i) => zip.file('xl/worksheets/sheet' + (i + 1) + '.xml', sheetXml(s.rows || [])));

  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}
