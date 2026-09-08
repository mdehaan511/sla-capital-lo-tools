/**
 * _shared/tape-row-count.mjs — Deploy 236.893 (Mike)
 *
 * How many loans are in an uploaded trade tape?
 *
 * Mike wants the final tape an investor sends back catalogued alongside the
 * ones we generated, "then look at the doc during upload to see how many
 * loans there are" — so the count is the whole point of the upload. It has to
 * be right, or honestly absent.
 *
 * WHY IT ISN'T "ROWS MINUS ONE"
 * -----------------------------
 * Measured against our own historical tapes, three shapes show up:
 *
 *   Colchis Trade 04      header on row 1, 5 loans, then 45 rows of empty
 *                         cells Excel keeps around for formatting
 *   Colchis RTL Trade 3   header on row 1, 3 loans, then 949 SELF-CLOSING
 *                         <row/> elements
 *   Colchis DSCR Trade 2  a SUMMARY BLOCK on rows 2-5 (Trade Date, Total UPB,
 *                         WAVG Px…), header on row 8, loans from row 9
 *
 * "First populated row is the header" reads the DSCR tape as 6 loans when it
 * holds 2. So instead: the header is the WIDEST row — the one that fills the
 * most columns — and loans are the rows under it that are similarly wide.
 * A four-cell summary line can't be mistaken for a 96-column header, and
 * trailing formatting rows carry no values at all.
 *
 * ALWAYS RETURNS. A tape we can't count is still worth cataloguing — the audit
 * trail is the point — so every failure path yields { loanCount: null, reason }
 * and the caller stores the file anyway.
 */
import JSZip from 'jszip';

/** A row this wide, relative to the widest one, is the header. */
const HEADER_WIDTH_RATIO = 0.6;
/** A row under the header this wide, relative to it, is a loan. */
const DATA_WIDTH_RATIO = 0.25;
/** A header is labels: at least this share of its cells must be text. */
const HEADER_TEXT_RATIO = 0.5;

/**
 * Sheet XML we refuse to walk. Our own 61-column tapes run ~2MB of XML for a
 * few hundred loans; well past that we're being handed something that isn't a
 * trade tape, and the honest answer is "couldn't count it".
 */
const MAX_SHEET_XML = 24 * 1024 * 1024;

// .xlsm is a macro-enabled workbook — same zip-of-XML as .xlsx, and the shape
// Stride tapes actually arrive in, so it reads identically.
export function isXlsxName(name) { return /\.(xlsx|xlsm)$/i.test(String(name || '')); }
export function isCsvName(name) { return /\.(csv|txt)$/i.test(String(name || '')); }
// Two formats we can STORE but not read: .xls is a BIFF compound document,
// and .xlsb keeps its sheets as binary .bin parts inside the zip.
export function isLegacyXlsName(name) { return /\.xls$/i.test(String(name || '')); }
export function isBinaryXlsbName(name) { return /\.xlsb$/i.test(String(name || '')); }

/**
 * Decide which row is the header and how many loans sit under it.
 *
 * @param {Array<{rn:number, pop:number, text:number}>} rows
 *        one entry per row: its number, how many cells hold a value, and how
 *        many of those are text rather than numbers.
 */
export function analyzeRows(rows) {
  const filled = rows.filter((r) => r.pop > 0);
  if (!filled.length) return { loanCount: null, headerRow: 0, reason: 'the sheet has no data' };

  const maxPop = Math.max(...filled.map((r) => r.pop));

  // The header is the FIRST row wide enough to be one — first, so that a data
  // row that happens to be a cell wider than the header can't steal the role.
  const wide = filled.filter((r) => r.pop >= Math.max(2, maxPop * HEADER_WIDTH_RATIO));
  const header = wide[0];

  // A "header" that is mostly numbers is not a header — it's the first row of
  // a tape that simply has no header. Count it as data rather than eating it.
  const headerIsLabels = header.text >= header.pop * HEADER_TEXT_RATIO;
  if (!headerIsLabels) {
    return {
      loanCount: wide.length,
      headerRow: 0,
      reason: 'no header row found — counted every data row',
    };
  }

  const cut = Math.max(2, header.pop * DATA_WIDTH_RATIO);
  const after = filled.filter((r) => r.rn > header.rn);
  const data = after.filter((r) => r.pop >= cut);

  // Rows below the header carrying a stray value or two — a totals line, a
  // note someone typed under the tape. Not loans, but worth saying out loud
  // so a wrong count is visible instead of silent.
  const strays = after.length - data.length;

  return {
    loanCount: data.length,
    headerRow: header.rn,
    reason: strays
      ? strays + ' row' + (strays === 1 ? '' : 's') + ' below the tape had only a stray value and ' + (strays === 1 ? 'was' : 'were') + ' not counted'
      : '',
  };
}

/**
 * Split CSV into rows of fields, honouring quoted fields — an address with a
 * comma, or a note with an embedded newline, is one field and one row.
 */
export function csvParse(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let quoted = false;      // this field is a quoted field
  let inQuotes = false;
  const s = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  function endField() { row.push(quoted ? cur : cur.trim()); cur = ''; quoted = false; }
  function endRow() { endField(); rows.push(row); row = []; }

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cur += '"'; i++; }   // "" is one literal quote
        else inQuotes = false;
      } else cur += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; quoted = true; continue; }
    if (ch === ',') { endField(); continue; }
    if (ch === '\n') { endRow(); continue; }
    cur += ch;
  }
  if (cur.length || row.length) endRow();

  return rows;
}

/** Is this a number as far as the header test is concerned? */
function looksNumeric(v) {
  return /^-?[$(]?\s*-?[\d,]*\.?\d+\s*%?\)?$/.test(String(v).trim());
}

/**
 * Read a worksheet's rows.
 *
 * Rows are found by SPLITTING on the row start tag rather than matching
 * <row>…</row>: real tapes mix normal rows with hundreds of self-closing
 * <row/> elements, and a non-greedy <row …>…</row> match happily swallows a
 * run of self-closing rows on its way to the next closing tag.
 */
export function readSheetRows(xml, shared) {
  const parts = String(xml || '').split(/(?=<row\b)/);
  const rows = [];
  for (const part of parts) {
    if (!/^<row\b/.test(part)) continue;
    const rn = +((part.match(/^<row\b[^>]*\br="(\d+)"/) || [])[1] || rows.length + 1);
    const end = part.indexOf('</row>');
    const body = end >= 0 ? part.slice(0, end) : part;

    let pop = 0, text = 0;
    for (const c of body.match(/<c\b[\s\S]*?(?:<\/c>|\/>)/g) || []) {
      let v = '', isText = false;
      if (/\bt="s"/.test(c)) {
        // Shared string: the value is an index into sharedStrings.xml. Excel
        // writes these for every label, so resolving them is not optional.
        const i = (c.match(/<v>(\d+)<\/v>/) || [])[1];
        v = shared[+i] || '';
        isText = true;
      } else if (/\bt="(inlineStr|str)"/.test(c)) {
        v = (c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
        isText = true;
      } else {
        v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
        isText = v !== '' && !looksNumeric(v);
      }
      if (String(v).trim() !== '') { pop++; if (isText) text++; }
    }
    rows.push({ rn, pop, text });
  }
  return rows;
}

/** Resolve the workbook's FIRST sheet — the one a human sees on open. */
async function firstSheet(zip) {
  const fallback = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
    .sort((a, b) => (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0))[0];

  try {
    const wbf = zip.file('xl/workbook.xml');
    if (!wbf) return { key: fallback, name: '' };
    const wb = await wbf.async('string');
    const tag = (wb.match(/<sheet\b[^>]*>/) || [])[0] || '';
    const name = (tag.match(/\bname="([^"]*)"/) || [])[1] || '';
    const rid = (tag.match(/r:id="([^"]*)"/) || [])[1];

    // Workbook order and sheetN.xml numbering are independent — the first tab
    // is often sheet1.xml but nothing guarantees it, so follow the rels.
    if (rid) {
      const relf = zip.file('xl/_rels/workbook.xml.rels');
      if (relf) {
        const rels = await relf.async('string');
        const m = rels.match(new RegExp('Id="' + rid.replace(/[^\w]/g, '') + '"[^>]*Target="([^"]*)"'));
        if (m) {
          const key = 'xl/' + String(m[1]).replace(/^\/?xl\//, '').replace(/^\//, '');
          if (zip.file(key)) return { key, name };
        }
      }
    }
    return { key: fallback, name };
  } catch (e) {
    return { key: fallback, name: '' };
  }
}

async function sharedStrings(zip) {
  const f = zip.file('xl/sharedStrings.xml');
  if (!f) return [];
  const xml = await f.async('string');
  return (xml.match(/<si>[\s\S]*?<\/si>/g) || []).map((si) =>
    (si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [])
      .map((t) => t.replace(/<[^>]+>/g, ''))
      .join('')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&'));
}

/**
 * @returns {Promise<{loanCount:number|null, headerRow:number, sheetName:string,
 *                    sheetCount:number|null, reason:string}>}
 */
export async function countTapeLoans(buf, filename) {
  const name = String(filename || '');

  if (isCsvName(name)) {
    try {
      const parsed = csvParse(buf.toString('utf8'));
      const rows = parsed.map((fields, i) => {
        let pop = 0, text = 0;
        for (const f of fields) {
          if (String(f).trim() === '') continue;
          pop++;
          if (!looksNumeric(f)) text++;
        }
        return { rn: i + 1, pop, text };
      });
      const a = analyzeRows(rows);
      return { loanCount: a.loanCount, headerRow: a.headerRow, sheetName: '', sheetCount: 1, reason: a.reason };
    } catch (e) {
      return none('could not read the CSV: ' + ((e && e.message) || 'unknown'));
    }
  }

  if (isLegacyXlsName(name) || isBinaryXlsbName(name)) {
    // Neither can be read here. Store the file — it's still the audit record —
    // but say why the count is missing instead of guessing at one.
    const ext = isBinaryXlsbName(name) ? '.xlsb' : '.xls';
    return none(ext + ' files can’t be read here — re-save as .xlsx to get a loan count');
  }

  if (!isXlsxName(name)) return none('unrecognised file type');

  try {
    const zip = await JSZip.loadAsync(buf);
    const sheetCount = Object.keys(zip.files).filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p)).length;
    const { key, name: sheetName } = await firstSheet(zip);
    if (!key) return none('no worksheet found in the workbook');

    const entry = zip.file(key);
    const declared = entry && entry._data && entry._data.uncompressedSize;
    if (declared && declared > MAX_SHEET_XML) {
      return Object.assign(none('the first sheet is too large to scan'), { sheetName, sheetCount });
    }

    const xml = await entry.async('string');
    if (xml.length > MAX_SHEET_XML) {
      return Object.assign(none('the first sheet is too large to scan'), { sheetName, sheetCount });
    }

    const shared = await sharedStrings(zip);
    const a = analyzeRows(readSheetRows(xml, shared));
    return {
      loanCount: a.loanCount,
      headerRow: a.headerRow,
      sheetName,
      sheetCount,
      reason: a.loanCount === null ? (a.reason || 'the first sheet is empty') : a.reason,
    };
  } catch (e) {
    return none('could not open the workbook: ' + ((e && e.message) || 'unknown'));
  }
}

function none(reason) {
  return { loanCount: null, headerRow: 0, sheetName: '', sheetCount: null, reason };
}
