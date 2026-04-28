/**
 * termsheet.mjs — POST /api/termsheet
 *
 * Generates a filled-in SLA term sheet (XLSX) for a saved quote.
 *
 * Body: { quoteId, ownerKey?, _owner? }
 *
 * Returns the XLSX as a binary download with the right Content-Type.
 *
 * Approach: load the matching template from disk, walk its XML, replace
 * placeholder cells with real values from the quote, and stream the
 * resulting XLSX back. The original Excel formulas re-evaluate when the
 * file opens (PI, total payment, DSCR, fees, cash to close).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import JSZip from 'jszip';

// Don't name this __dirname — Netlify's runtime injects its own __dirname
// shim, and a top-level const collision is a SyntaxError.
const _funcDir = dirname(fileURLToPath(import.meta.url));

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('termsheet top-level error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown'), stack: String(e.stack || '').slice(0, 800) });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || (!body.quoteId && !(body.clientId && body.loanId))) {
    return json(400, { error: 'quoteId OR (clientId + loanId) required' });
  }

  // Look up the quote
  let owner = normalizeEmail(user.email);
  if (body.ownerKey && isAdmin(user)) owner = normalizeEmail(body.ownerKey);
  if (body._owner   && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });

  let quote = null;
  if (body.quoteId) {
    try {
      quote = await quotesStore.get(`${ownerKey}/${keySafe(body.quoteId)}`, { type: 'json' });
    } catch (e) {
      return json(500, { error: 'Failed to load quote' });
    }
  } else {
    // Look up the client/loan first to get the address, then find a matching quote
    try {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const clientKey = `${ownerKey}/${keySafe(body.clientId)}`;
      const c = await clientsStore.get(clientKey, { type: 'json' });
      if (!c) return json(404, { error: 'Client not found' });
      const targetLoan = (c.loans || []).find((l) => l.id === body.loanId);
      if (!targetLoan) return json(404, { error: 'Loan not found' });
      // Find a quote with the matching address under this owner's quotes
      const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
      const target = norm(targetLoan.address);
      const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
      for (const { key } of blobs) {
        const q = await quotesStore.get(key, { type: 'json' });
        if (!q) continue;
        if (norm(q.address) === target) { quote = q; break; }
      }
      // If no quote exists yet, build a synthetic one from the loan record
      if (!quote && targetLoan) {
        quote = {
          address: targetLoan.address,
          borrower: ((c.firstName||'') + ' ' + (c.lastName||'')).trim(),
          toolType: targetLoan.toolType || 'dscr',
          formData: targetLoan,
        };
      }
    } catch (e) {
      console.error('termsheet lookup error:', e);
      return json(500, { error: 'Failed to look up loan' });
    }
  }
  if (!quote) return json(404, { error: 'Quote not found' });

  // Find the matching client (for borrower info)
  let client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const target = norm(quote.address);
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' });
      if (!c) continue;
      const hit = (c.loans || []).some((l) => norm(l.address) === target);
      if (hit) { client = c; break; }
    }
  } catch (e) { /* non-fatal */ }

  // Find the LO's profile (for contact info on the term sheet)
  let loProfile = null;
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
    loProfile = await profilesStore.get(ownerKey, { type: 'json' });
  } catch (e) { /* non-fatal */ }

  // Determine which template to load
  const tool = (quote.toolType === 'rtl') ? 'rtl' : 'dscr';
  const tplName = (tool === 'rtl') ? 'SLA_Term_Sheet_RTL.xlsx' : 'SLA_Term_Sheet_DSCR.xlsx';

  // Netlify deploys the function from a different directory layout than local.
  // Try several candidate paths and report exactly which ones we tried.
  const candidates = [
    join(_funcDir, '_templates', tplName),
    join(_funcDir, '..', '_templates', tplName),
    join(process.cwd(), 'netlify', 'functions', '_templates', tplName),
    join(process.cwd(), '_templates', tplName),
  ];
  let tplBuffer = null;
  let triedPaths = [];
  for (const p of candidates) {
    triedPaths.push(p);
    try {
      tplBuffer = readFileSync(p);
      break;
    } catch (e) { /* try next */ }
  }
  if (!tplBuffer) {
    console.error('termsheet: template not found. Tried:', triedPaths);
    return json(500, {
      error: 'Template not found on server',
      tried: triedPaths,
      cwd: process.cwd(),
      _funcDir,
      // Also expose Netlify's injected __dirname for comparison
      runtimeDirname: typeof __dirname !== 'undefined' ? __dirname : null,
    });
  }

  // Build the value map from quote + client + LO profile
  const ctx = buildContext(quote, client, loProfile);

  // Populate the XLSX
  let outBuffer;
  try {
    outBuffer = (tool === 'rtl')
      ? await populateRTL(tplBuffer, ctx)
      : await populateDSCR(tplBuffer, ctx);
  } catch (e) {
    console.error('termsheet populate error:', e);
    return json(500, { error: 'Failed to populate template: ' + (e.message || 'unknown') });
  }

  // Build a sensible filename
  const safeAddr = String(quote.address || quote.borrower || 'Term_Sheet')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  const filename = `SLA_${tool.toUpperCase()}_TermSheet_${safeAddr || 'loan'}.xlsx`;

  return new Response(outBuffer, {
    status: 200,
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  });
}

// ── Build context object from quote + client + LO ─────────────
function buildContext(quote, client, loProfile) {
  const fd = quote.formData || {};
  const num = (v) => {
    if (v === null || v === undefined || v === '') return null;
    const n = parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? n : null;
  };

  // Borrower display name
  let borrower = '';
  if (client) {
    borrower = ((client.firstName || '') + ' ' + (client.lastName || '')).trim();
  }
  if (!borrower) borrower = quote.borrower || fd.borrower || fd.borrowerName || '';

  // LO contact (fallback to template defaults if profile missing)
  const loName  = (loProfile && loProfile.fullName) || '';
  const loEmail = (loProfile && loProfile.email)    || '';
  const loPhone = (loProfile && loProfile.user_metadata && loProfile.user_metadata.phone) || '';

  // Today as M/D/YYYY for the signature block
  const d = new Date();
  const today = (d.getMonth()+1) + '/' + d.getDate() + '/' + d.getFullYear();

  // Common fields
  const ctx = {
    address: quote.address || fd.address || '',
    borrower,
    entity: '', // not captured today, leave blank
    loName, loEmail, loPhone, today,

    // Loan basics
    loanAmt:   num(fd.loanAmt || fd.purchasePrice || quote.loanAmt),
    rate:      num(fd._finalRate || fd.rate),
    points:    num(fd._points || fd.points || fd.buydown),
    fico:      fd.fico || '',

    // DSCR-specific
    propValue:    num(fd.propValue),
    existingLoan: num(fd.existingLoanAmt),
    annualTaxes:  num(fd.taxes) !== null ? num(fd.taxes) * 12 : null,
    annualIns:    num(fd.insurance) !== null ? num(fd.insurance) * 12 : null,
    monthlyRent:  num(fd.rent),
    loanType:     friendlyLoanType(fd, 'dscr'),
    loanTermLbl:  friendlyLoanTerm(fd),
    isIO:         (fd.isIO === 'yes') ? 'Yes' : 'No',
    propType:     friendlyPropType(fd.propType),
    prepay:       friendlyPrepay(fd.prepay),

    // RTL-specific
    purchasePrice: num(fd.purchasePrice),
    rehabBudget:   num(fd.rehabBudget),
    arv:           num(fd.arv),
    experience:    fd.experience || '',
    loanTypeRTL:   friendlyLoanType(fd, 'rtl'),
    loanTermRTLLbl: friendlyRTLTerm(fd),
    useOfFunds:    friendlyUseOfFunds(fd),
    propTypeRTL:   friendlyPropType(fd.propType),
  };
  return ctx;
}

function friendlyLoanType(fd, tool) {
  if (tool === 'rtl') {
    if (fd.loanType === 'light')  return 'Fix and Flip - Light';
    if (fd.loanType === 'heavy')  return 'Fix and Flip - Heavy';
    if (fd.loanType === 'bridge') return 'Bridge';
    if (fd.loanType === 'construction') return 'Construction';
    return 'Fix and Flip';
  }
  // DSCR
  const purpose = fd.loanPurpose || 'purchase';
  if (purpose === 'refi_co') return 'DSCR - Cashout';
  if (purpose === 'refi_rt') return 'DSCR - Rate/Term Refi';
  return 'DSCR - Purchase';
}
function friendlyLoanTerm(fd) {
  // Only DSCR options
  return fd.loanType || '30 Year Fixed';
}
function friendlyRTLTerm(fd) {
  return (fd.loanTerm ? fd.loanTerm + ' Months' : '12 Months');
}
function friendlyPropType(t) {
  if (!t) return 'Single Family';
  const map = { sfr: 'Single Family', '2-4': '2-4 Unit', condo: 'Condo', nw_condo: 'Non-Warrantable Condo', townhome: 'Townhome', portfolio: 'Portfolio', mfr: 'Multi-Family' };
  return map[t] || t;
}
function friendlyPrepay(p) {
  if (!p) return '5-4-3-2-1';
  return p === '54321' ? '5-4-3-2-1'
       : p === '321'   ? '3-2-1'
       : p === '320'   ? '3-2-0'
       : p === '300'   ? '3-0-0'
       : String(p);
}
function friendlyUseOfFunds(fd) {
  if (fd.loanPurpose === 'refi_rt' || fd.loanPurpose === 'refi_co') return 'Refinance';
  if (fd.purchasePrice && fd.rehabBudget) return 'Purchase + Rehab';
  return 'Purchase Only';
}

// ── DSCR template populator ──────────────────────────────────
async function populateDSCR(tplBuffer, ctx) {
  const zip = await JSZip.loadAsync(tplBuffer);
  let ssXml    = await zip.file('xl/sharedStrings.xml').async('string');
  let sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');

  // 1) Replace shared-string placeholder TEXT (for the contact block at the
  //    top of the sheet). Cells reference these by index, which doesn't change.
  ssXml = swapText(ssXml, 'Chance Luce',          ctx.loName  || 'Chance Luce');
  ssXml = swapText(ssXml, 'chance@slacapital.com', ctx.loEmail || 'chance@slacapital.com');
  ssXml = swapText(ssXml, '503-490-1493',         ctx.loPhone || '503-490-1493');

  // The static labels (Loan Type / Loan Term / Property Type / Prepayment / IO)
  // also live in shared strings. Swap them so the sheet reflects the actual loan.
  ssXml = swapText(ssXml, 'DSCR - Cashout',  ctx.loanType   || 'DSCR - Cashout');
  ssXml = swapText(ssXml, 'Single Family',   ctx.propType   || 'Single Family');
  ssXml = swapText(ssXml, '5-4-3-2-1',       ctx.prepay     || '5-4-3-2-1');

  // For "30 Year Fixed" and "No" we use a more targeted swap so we don't
  // accidentally hit other "No" instances. Both appear as exact cell text.
  ssXml = swapSharedStringExact(ssXml, '30 Year Fixed', ctx.loanTermLbl || '30 Year Fixed');
  ssXml = swapSharedStringExact(ssXml, 'No', ctx.isIO || 'No');

  // Today's date placeholder — pure text
  ssXml = swapText(ssXml, "[Short today's date (datetime today_short)]", ctx.today);

  // The address and borrower name are also pure text (display only, no math)
  ssXml = swapText(ssXml, '[Deal title (deal title)]',           ctx.address  || '');
  ssXml = swapText(ssXml, '[Person full name (person name)]',    ctx.borrower || '');
  ssXml = swapText(ssXml, '[Organization name (organization name)]', ctx.entity || '');
  ssXml = swapText(ssXml, '[Person Estimated Credit Score (person custom)]', ctx.fico || '');

  // 2) Numeric input cells — rewrite the cell entirely so formulas evaluate.
  //
  // Cell map (DSCR template):
  //   D22 = Property Value           ← propValue
  //   D23 = Requested Loan Amount    ← loanAmt
  //   D24 = Existing Loan Amount     ← existingLoan (or blank)
  //   G10 = Loan Amount (mirror)     ← loanAmt   (used in PMT formula)
  //   G11 = Interest Rate            ← rate / 100  (template stores % display)
  //   G13 = Property Taxes (annual)  ← annualTaxes
  //   G14 = Property Insurance       ← annualIns
  //   H17 = Rent                     ← monthlyRent
  //   G20 = Origination Fee %        ← points
  //
  // The interest-rate cell in the template displays "[xxx]%" — Excel formats
  // a 0.075 number as "7.5%". So we store the rate as a fraction (rate/100).
  sheetXml = setNumberCell(sheetXml, 'D22', ctx.propValue);
  sheetXml = setNumberCell(sheetXml, 'D23', ctx.loanAmt);
  sheetXml = setNumberCell(sheetXml, 'D24', ctx.existingLoan); // null → blank
  sheetXml = setNumberCell(sheetXml, 'G10', ctx.loanAmt);
  sheetXml = setNumberCell(sheetXml, 'G11', ctx.rate !== null ? ctx.rate / 100 : null);
  sheetXml = setNumberCell(sheetXml, 'G13', ctx.annualTaxes);
  sheetXml = setNumberCell(sheetXml, 'G14', ctx.annualIns);
  sheetXml = setNumberCell(sheetXml, 'H17', ctx.monthlyRent);
  sheetXml = setNumberCell(sheetXml, 'G20', ctx.points);

  zip.file('xl/sharedStrings.xml', ssXml);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── RTL template populator ───────────────────────────────────
async function populateRTL(tplBuffer, ctx) {
  const zip = await JSZip.loadAsync(tplBuffer);
  let ssXml    = await zip.file('xl/sharedStrings.xml').async('string');
  let sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');

  ssXml = swapText(ssXml, 'Chance Luce',          ctx.loName  || 'Chance Luce');
  ssXml = swapText(ssXml, 'chance@slacapital.com', ctx.loEmail || 'chance@slacapital.com');
  ssXml = swapText(ssXml, '503-490-1493',         ctx.loPhone || '503-490-1493');

  // Static labels — use exact match so we don't accidentally hit other strings
  ssXml = swapSharedStringExact(ssXml, 'Fix and Flip', ctx.loanTypeRTL || 'Fix and Flip');
  ssXml = swapSharedStringExact(ssXml, '12 Months',    ctx.loanTermRTLLbl || '12 Months');
  ssXml = swapSharedStringExact(ssXml, 'Purchase Only', ctx.useOfFunds || 'Purchase Only');
  ssXml = swapSharedStringExact(ssXml, 'Single Family', ctx.propTypeRTL || 'Single Family');
  ssXml = swapSharedStringExact(ssXml, '10+',           ctx.experience || '10+');

  // Display-only placeholders
  ssXml = swapText(ssXml, "[Short today's date (datetime today_short)]", ctx.today);
  ssXml = swapText(ssXml, '[Deal title (deal title)]',                      ctx.address  || '');
  ssXml = swapText(ssXml, '[Person full name (person name)]',               ctx.borrower || '');
  ssXml = swapText(ssXml, '[Organization name (organization name)]',        ctx.entity   || '');
  ssXml = swapText(ssXml, '[Person Estimated Credit Score (person custom)]', ctx.fico || '');

  // RTL numeric cells. Inspect the RTL template to verify these locations.
  // Based on extract-text output, the RTL template uses similar layout:
  //   Loan Amount cell (formula-driven from purchase + rehab) — leave alone
  //   Interest Rate, Loan Points, Purchase Price, Renovation Budget, ARV, Down Payment %
  // We populate the inputs; Excel formulas compute Monthly Payment, Cash Reserves, Cash to Close.
  //
  // To find exact cell addresses we look for the placeholder strings in the
  // sheet XML. Use the helper to locate them.
  sheetXml = setNumberCellByPlaceholder(sheetXml, ssXml,
    '[Deal Loan Interest % (deal custom)]%',
    ctx.rate !== null ? ctx.rate / 100 : null);
  sheetXml = setNumberCellByPlaceholder(sheetXml, ssXml,
    '[Deal Loan Points (deal custom)]', ctx.points);
  sheetXml = setNumberCellByPlaceholder(sheetXml, ssXml,
    '[Deal Purchase Price - F&F (deal custom)]', ctx.purchasePrice);
  sheetXml = setNumberCellByPlaceholder(sheetXml, ssXml,
    '[Deal Amount of Rehab Funds F&F (deal custom)]', ctx.rehabBudget);
  sheetXml = setNumberCellByPlaceholder(sheetXml, ssXml,
    '[Deal Property ARV F&F (deal custom)]', ctx.arv);

  zip.file('xl/sharedStrings.xml', ssXml);
  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

// ── XML helpers ──────────────────────────────────────────────

// Swap one occurrence of `find` (literal string) with XML-escaped `replace`.
// Only swaps if the find string is present.
function swapText(xml, find, replace) {
  if (!xml.includes(find)) return xml;
  return xml.replace(find, xmlEsc(String(replace == null ? '' : replace)));
}

// Swap a shared-string entry whose text is EXACTLY `find` (matching only at
// <si><t>find</t></si> boundaries) with `replace`. Use for short strings like
// "No" that could appear inside longer strings.
function swapSharedStringExact(xml, find, replace) {
  const escFind = xmlEsc(find);
  const target = '<si><t>' + escFind + '</t></si>';
  if (!xml.includes(target)) return xml;
  const repl = '<si><t>' + xmlEsc(String(replace == null ? '' : replace)) + '</t></si>';
  return xml.replace(target, repl);
}

// Replace a cell's content with a numeric value. If `value` is null/undefined,
// leave the cell as-is (the template's placeholder text remains, which is fine).
//
// Matches and rewrites <c r="XX" ...>...</c> for the given address. The
// resulting cell becomes a plain numeric cell: <c r="XX" s="STYLE"><v>NUM</v></c>
function setNumberCell(xml, addr, value) {
  if (value === null || value === undefined) return xml;
  // Match the <c> element for this address (with or without trailing slash close)
  const re = new RegExp('<c\\s+r="' + addr + '"([^/>]*)(?:/>|>[\\s\\S]*?</c>)', 'i');
  return xml.replace(re, function(match, attrs) {
    // Strip any t="..." attribute and rebuild
    const cleanAttrs = attrs.replace(/\s+t="[^"]*"/g, '');
    return `<c r="${addr}"${cleanAttrs}><v>${value}</v></c>`;
  });
}

// Helper: find which cell address holds a given placeholder string and rewrite it.
// We look up the index of the string in sharedStrings, then find the cell that
// has <v>idx</v> with t="s".
function setNumberCellByPlaceholder(sheetXml, ssXml, placeholder, value) {
  if (value === null || value === undefined) return sheetXml;
  // Find the index of this string in sharedStrings
  // Build a quick parse: count <si> entries until we hit the matching <t>
  const escPlaceholder = xmlEsc(placeholder);
  const reSI = /<si>([\s\S]*?)<\/si>/g;
  let idx = -1;
  let i = 0;
  let m;
  while ((m = reSI.exec(ssXml)) !== null) {
    if (m[1].includes(escPlaceholder) || m[1].includes(placeholder)) {
      idx = i;
      break;
    }
    i++;
  }
  if (idx < 0) return sheetXml;

  // Find the cell that has t="s"><v>idx</v>
  const cellRe = new RegExp('<c\\s+r="([A-Z]+\\d+)"([^/>]*)t="s"([^/>]*)><v>' + idx + '</v></c>', 'i');
  return sheetXml.replace(cellRe, function(match, addr, before, after) {
    return `<c r="${addr}"${before}${after}><v>${value}</v></c>`;
  });
}

function xmlEsc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
