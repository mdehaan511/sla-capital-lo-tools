/**
 * _shared/worksheets.mjs — Deploy 236.947 (Mike)
 *
 * Borrower worksheets: structured versions of the Excel templates borrowers
 * used to fill by hand. Two kinds for now (PFS/REO deliberately deferred —
 * Mike is reworking that template):
 *
 *   track — RTL Track Record. PROFILE-level (keyed by the borrower's portal
 *           email): filled once, reused on every submission, refreshed every
 *           6 months (TRACK_FRESH_DAYS drives the stale badge + portal nag).
 *   sow   — Scope of Work / Rehab Budget. PER-LOAN (keyed by LOAN id — loan
 *           ids are immutable and survive reassign/promote, the same lesson
 *           as the 236.861 audit-log keying). Required on every RTL.
 *
 * Storage: `borrower_worksheets` blob store.
 *   track/<emailKey>  { rows:[...], updatedAt, updatedBy, source }
 *   sow/<loanId>      { borrowerName, propertyAddress, items:[...], updatedAt, updatedBy, source }
 *
 * Import: borrowers upload the ORIGINAL Excel template (or a CSV). We parse
 * server-side (jszip — same stack as the tape upload catalogue), find the
 * header row by alias matching, and map columns by NAME, not position, so a
 * template with reordered or extra columns still imports. Excel date serials
 * are converted; money strings are stripped of $ and commas. Derived columns
 * (Gross Profit, totals) are recomputed, never imported.
 */
import { getStore } from '@netlify/blobs';
import JSZip from 'jszip';
import { csvParse, isXlsxName, isCsvName } from './tape-row-count.mjs';

export const TRACK_FRESH_DAYS = 183; // ~6 months, per Mike

export const WORKSHEET_DEFS = {
  track: {
    label: 'RTL Track Record',
    // Deploy 236.955 (Mike) — reordered: identity → address → exit → dates →
    // money → lender. Dates are MONTH precision ("hard to remember days");
    // Sale columns renamed to cover refis; Exit Strategy select (only Sold /
    // Refinanced count toward pricing experience); optional Lender Used.
    columns: [
      { key: 'owner',         label: 'Vested Owner Name',  type: 'text',  aliases: ['vested owner name', 'vested owner', 'owner', 'entity'] },
      { key: 'guarantors',    label: 'Guarantor(s) Name',  type: 'text',  aliases: ['guarantor(s) name', 'guarantors name', 'guarantor', 'guarantors'] },
      { key: 'address',       label: 'Property Address',   type: 'text',  aliases: ['property address', 'address', 'property'], ac: true },
      { key: 'exitStrategy',  label: 'Exit Strategy',      type: 'select', optional: true,
        options: [['sell', 'Sell'], ['refinance', 'Refinance'], ['in_progress', 'Still In Progress']],
        aliases: ['exit strategy', 'exit', 'strategy', 'disposition'] },
      { key: 'purchaseDate',  label: 'Purchase Date',      type: 'month', aliases: ['purchase date', 'buy date', 'acquired'] },
      { key: 'saleDate',      label: 'Sale/Refi Date',     type: 'month', aliases: ['sale/refi date', 'sale refi date', 'sale date', 'sold date', 'sold', 'refi date'] },
      { key: 'purchasePrice', label: 'Purchase Price',     type: 'money', aliases: ['purchase price', 'purchase $', 'buy price'] },
      { key: 'rehabCosts',    label: 'Rehab Costs',        type: 'money', aliases: ['rehab costs', 'rehab cost', 'rehab', 'rehab budget'] },
      { key: 'salePrice',     label: 'Sale Price/Refi Appraised Value', type: 'money',
        aliases: ['sale price/refi appraised value', 'sale price', 'sold price', 'sales price', 'refi appraised value', 'appraised value'] },
      { key: 'lender',        label: 'Lender Used',        type: 'text',  optional: true, aliases: ['lender used', 'lender'] },
      // Recognized so an imported template's column doesn't read as "extra",
      // but the VALUE is always recomputed (sale − purchase − rehab).
      { key: '_grossProfit',  label: 'Gross Profit',       type: 'money', aliases: ['gross profit', 'profit'], derived: true },
    ],
  },
  sow: {
    label: 'Scope of Work (Rehab Budget)',
    columns: [
      { key: 'item',        label: 'Repair item', type: 'text',  aliases: ['repair item', 'item', 'work item', 'line item', 'scope'] },
      { key: 'budget',      label: 'Budget',      type: 'money', aliases: ['budget', 'cost', 'amount', 'price', 'estimate'] },
      // Deploy 236.954 (Mike) — optional per-line description, third column.
      { key: 'description', label: 'Description', type: 'text',  aliases: ['description', 'description - provide detailed description for each line item', 'details', 'notes'], optional: true },
    ],
  },
};

// Deploy 236.954 (Mike) — the SOW template's own repair-item list, seeded
// into a fresh SOW so borrowers delete what doesn't apply instead of typing
// the common lines. Order follows the template (its three 'Other' rows are
// dropped — borrowers add their own rows for those).
export const SOW_DEFAULT_ITEMS = [
  'Permits & Plans', 'Demo & Junk Out',
  'Roof', 'Siding', 'Exterior Paint', 'Windows', 'Foundation', 'Landscaping',
  'Framing', 'Insulation', 'Egress Windows', 'Drywall', 'Electrical',
  'Plumbing', 'Sewer Line', 'HVAC', 'Hot Water Tank',
  'Kitchen Cabinets', 'Kitchen Countertops', 'Appliances',
  'Bathroom 1', 'Bathroom 2', 'Bathroom 3',
  'Hard Surface Flooring', 'Carpet', 'Doors', 'Trim', 'Interior Paint',
  'Contingencies (5%-10% recommended)',
];

export function worksheetStore() {
  return getStore({ name: 'borrower_worksheets', consistency: 'strong' });
}
export function trackKey(email) {
  return 'track/' + String(email || '').toLowerCase().trim().replace(/[^a-z0-9@._+-]/g, '_');
}
export function sowKey(loanId) {
  return 'sow/' + String(loanId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
}

// ── value coercion ──────────────────────────────────────────────────────────
export function moneyNum(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, ''));
  return isFinite(n) ? Math.round(n * 100) / 100 : null;
}
// Excel serial → YYYY-MM-DD (serial day 0 = 1899-12-30). Plausible loan-era
// serials are ~36k (1998) to ~55k (2050); anything else is treated as text.
export function serialToYmd(n) {
  if (!isFinite(n) || n < 20000 || n > 60000) return null;
  const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
  return d.toISOString().slice(0, 10);
}
// Deploy 236.955 — MONTH precision ("hard to remember days"): YYYY-MM.
// Accepts serials, ISO dates, MM/YYYY, MM/DD/YYYY, YYYY-MM.
export function coerceMonth(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^\d{4}-\d{1,2}$/.test(s)) {
    const [y, m] = s.split('-');
    return y + '-' + m.padStart(2, '0');
  }
  const my = s.match(/^(\d{1,2})[\/.-](\d{4})$/);           // MM/YYYY
  if (my) return my[2] + '-' + my[1].padStart(2, '0');
  const full = coerceDate(s);                                // serials, ISO, MM/DD/YYYY
  if (/^\d{4}-\d{2}-\d{2}/.test(full)) return full.slice(0, 7);
  return s;
}
// Deploy 236.955 — normalize an imported Exit Strategy cell to our keys.
export function coerceExit(v) {
  const s = String(v == null ? '' : v).toLowerCase();
  if (!s.trim()) return '';
  if (s.indexOf('refi') >= 0) return 'refinance';
  if (s.indexOf('progress') >= 0 || s.indexOf('hold') >= 0 || s.indexOf('own') >= 0) return 'in_progress';
  if (s.indexOf('sell') >= 0 || s.indexOf('sold') >= 0 || s.indexOf('sale') >= 0 || s.indexOf('flip') >= 0) return 'sell';
  return '';
}
export function coerceDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s) return '';
  const serial = serialToYmd(parseFloat(s));
  if (serial && /^\d+(\.\d+)?$/.test(s)) return serial;
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (iso) return iso[1] + '-' + iso[2].padStart(2, '0') + '-' + iso[3].padStart(2, '0');
  const us = s.match(/^(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})$/);
  if (us) {
    let y = +us[3]; if (y < 100) y += y < 50 ? 2000 : 1900;
    return y + '-' + String(us[1]).padStart(2, '0') + '-' + String(us[2]).padStart(2, '0');
  }
  return s; // keep as typed; the UI shows it for the borrower to fix
}

// ── xlsx/csv → grid of cell values ─────────────────────────────────────────
function colIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
function decodeEnt(s) {
  return String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&');
}
async function xlsxGrid(buf) {
  const zip = await JSZip.loadAsync(buf);
  const sheetKey = Object.keys(zip.files)
    .filter((p) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(p))
    .sort((a, b) => (parseInt(a.replace(/\D+/g, ''), 10) || 0) - (parseInt(b.replace(/\D+/g, ''), 10) || 0))[0];
  if (!sheetKey) throw new Error('No worksheet found in the file');
  const ssf = zip.file('xl/sharedStrings.xml');
  const shared = !ssf ? [] : ((await ssf.async('string')).match(/<si>[\s\S]*?<\/si>/g) || []).map((si) =>
    decodeEnt((si.match(/<t[^>]*>([\s\S]*?)<\/t>/g) || []).map((t) => t.replace(/<[^>]+>/g, '')).join('')));
  const xml = await zip.file(sheetKey).async('string');
  const grid = [];
  for (const part of String(xml).split(/(?=<row\b)/)) {
    if (!/^<row\b/.test(part)) continue;
    const rn = +((part.match(/^<row\b[^>]*\br="(\d+)"/) || [])[1] || grid.length + 1);
    const row = [];
    for (const c of part.match(/<c\b[\s\S]*?(?:<\/c>|\/>)/g) || []) {
      const ref = (c.match(/\br="([A-Z]+)\d+"/) || [])[1];
      if (!ref) continue;
      let v = '';
      if (/\bt="s"/.test(c)) {
        const i = (c.match(/<v>(\d+)<\/v>/) || [])[1];
        v = shared[+i] || '';
      } else if (/\bt="(inlineStr|str)"/.test(c)) {
        v = decodeEnt((c.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '');
      } else {
        v = (c.match(/<v>([\s\S]*?)<\/v>/) || [])[1] || '';
      }
      if (String(v).trim() !== '') row[colIndex(ref)] = String(v).trim();
    }
    if (row.some((x) => x !== undefined)) grid[rn - 1] = row;
  }
  return grid.map((r) => r || []);
}

export async function parseUploadGrid(buf, filename) {
  if (isXlsxName(filename)) return xlsxGrid(buf);
  if (isCsvName(filename)) return csvParse(buf.toString('utf-8'));
  throw new Error('Upload the Excel template (.xlsx) or a .csv — got "' + filename + '"');
}

// ── grid → typed rows via header alias matching ────────────────────────────
export function mapGridToRows(grid, kind) {
  const def = WORKSHEET_DEFS[kind];
  if (!def) throw new Error('Unknown worksheet kind: ' + kind);
  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9$()/ ]/g, '').replace(/\s+/g, ' ').trim();

  // Header row = the first row matching ≥2 column aliases.
  let headerIdx = -1;
  const colMap = {}; // grid column index → def column
  for (let i = 0; i < Math.min(grid.length, 30); i++) {
    const hits = {};
    (grid[i] || []).forEach((cell, ci) => {
      const h = norm(cell);
      if (!h) return;
      for (const col of def.columns) {
        if (col.aliases.some((a) => norm(a) === h)) { hits[ci] = col; break; }
      }
    });
    if (Object.keys(hits).length >= 2) {
      headerIdx = i;
      Object.assign(colMap, hits);
      break;
    }
  }
  if (headerIdx < 0) {
    return { rows: [], warnings: ['Could not find the header row — expected columns like "' +
      def.columns.slice(0, 3).map((c) => c.label).join('", "') + '". Use the SLA template, or add those headers.'] };
  }

  const warnings = [];
  const missing = def.columns.filter((c) => !c.derived && !c.optional &&
    !Object.values(colMap).some((m) => m.key === c.key));
  if (missing.length) warnings.push('Missing column(s): ' + missing.map((c) => c.label).join(', ') + ' — those fields import blank.');

  const rows = [];
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const g = grid[i] || [];
    const row = {};
    let any = false;
    for (const [ci, col] of Object.entries(colMap)) {
      if (col.derived) continue;
      const raw = g[+ci];
      if (raw === undefined || String(raw).trim() === '') continue;
      any = true;
      if (col.type === 'money') {
        const n = moneyNum(raw);
        if (n === null) warnings.push('Row ' + (i + 1) + ': "' + raw + '" is not a number for ' + col.label + ' — left blank.');
        else row[col.key] = n;
      } else if (col.type === 'date') {
        row[col.key] = coerceDate(raw);
      } else if (col.type === 'month') {           // 236.955
        row[col.key] = coerceMonth(raw);
      } else if (col.type === 'select') {          // 236.955
        const norm2 = coerceExit(raw);
        if (norm2) row[col.key] = norm2;
      } else {
        row[col.key] = String(raw).trim().slice(0, 200);
      }
    }
    // Skip totals-style footer rows: a single populated money cell under a mapped
    // money column with no text fields is a totals row, not a record.
    const keys = Object.keys(row);
    if (!any || !keys.length) continue;
    const onlyMoney = keys.every((k) => {
      const col = def.columns.find((c) => c.key === k);
      return col && col.type === 'money';
    });
    if (onlyMoney && keys.length === 1) continue;
    rows.push(row);
    if (rows.length >= 500) { warnings.push('Stopped at 500 rows.'); break; }
  }
  return { rows, warnings };
}

// ── derived values (single source for page + staff views) ──────────────────
export function trackGrossProfit(r) {
  const s = moneyNum(r.salePrice), p = moneyNum(r.purchasePrice), h = moneyNum(r.rehabCosts) || 0;
  if (s === null || p === null) return null;
  return Math.round((s - p - h) * 100) / 100;
}
export function sowTotal(items) {
  return Math.round((items || []).reduce((t, it) => t + (moneyNum(it.budget) || 0), 0) * 100) / 100;
}
export function trackAgeDays(rec) {
  if (!rec || !rec.updatedAt) return null;
  const ms = Date.now() - new Date(rec.updatedAt).getTime();
  return isFinite(ms) ? Math.floor(ms / 86400000) : null;
}
