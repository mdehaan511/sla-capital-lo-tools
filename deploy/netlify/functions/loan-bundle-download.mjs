/**
 * loan-bundle-download.mjs — GET /api/loan-bundle-download
 *
 * Deploy 236.145 — combined-PDF bundle for a loan. Replaces the
 * 236.144 ZIP output per Mike's preference. Single PDF containing:
 *
 *   - Cover page (manifest + what's included + generated-at)
 *   - The signed loan application PDF (every page)
 *   - For each completed additional guarantor:
 *       - Divider page ("Guarantor N — Name")
 *       - One-page sub-form data summary
 *       - The signed Credit Authorization PDF (every page)
 *
 * Query: ?clientId=...&loanId=...&owner=...
 * Response: application/pdf  attachment; filename=loan-bundle-<id>.pdf
 *
 * Tolerant of missing pieces — if the borrower hasn't signed the
 * main app yet, the cover page notes it and the bundle proceeds
 * with whatever IS available.
 */
import { getStore } from '@netlify/blobs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail, corsHeaders,
} from './_shared/auth.mjs';

const PLUM  = rgb(0.149, 0.102, 0.212);
const GOLD  = rgb(0.784, 0.506, 0.227);
const TEXT  = rgb(0.102, 0.082, 0.125);
const MUTED = rgb(0.478, 0.455, 0.533);

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-bundle-download top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const clientId = String(url.searchParams.get('clientId') || '').trim();
  const loanId   = String(url.searchParams.get('loanId')   || '').trim();
  const ownerP   = String(url.searchParams.get('owner')    || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (ownerP && ownerP !== selfEmail && ownerP !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(ownerP));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore   = getStore({ name: 'clients',                       consistency: 'strong' });
  const signedAppStore = getStore({ name: 'signed_applications',           consistency: 'strong' });
  const credAuthStore  = getStore({ name: 'guarantor-credit-auth-pdfs',    consistency: 'strong' });

  // Resolve primary + loan.
  const primaryKey = ownerKey + '/' + keySafe(clientId);
  const primary = await clientsStore.get(primaryKey, { type: 'json' });
  if (!primary) return json(404, { error: 'Primary client not found' });
  const loan = Array.isArray(primary.loans)
    ? primary.loans.find((l) => l && l.id === loanId)
    : null;
  if (!loan) return json(404, { error: 'Loan not found on primary client' });

  // ── Gather source PDFs ────────────────────────────────────
  const manifest = [];
  manifest.push({ label: 'Loan: ' + (loan.slaDisplayId || loan.id) });
  manifest.push({ label: 'Address: ' + (loan.address || '(no address)') });
  manifest.push({ label: 'Primary: ' + (((primary.firstName || '') + ' ' + (primary.lastName || '')).trim() || primary.email) });
  manifest.push({ spacer: true });
  manifest.push({ heading: 'Contents' });

  let signedAppBytes = null;
  let signedAppMeta = null;
  try {
    const signedKey = ownerKey + '/' + keySafe(clientId) + '/' + keySafe(loanId);
    const rec = await signedAppStore.get(signedKey, { type: 'json' });
    if (rec && rec.pdfBase64) {
      signedAppBytes = Buffer.from(rec.pdfBase64, 'base64');
      signedAppMeta = rec;
      manifest.push({ line: '✓ Signed Loan Application — ' + (rec.createdAt || '?') });
    } else {
      manifest.push({ line: '— Signed Loan Application: not on file yet (borrower has not signed the long app)' });
    }
  } catch (e) {
    manifest.push({ line: '! Signed Loan Application: read failed (' + (e.message || 'unknown') + ')' });
  }

  const guarantorClientIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
  const guarantorEntries = []; // { displayName, subState, summaryBytes, credAuthBytes }
  for (let i = 0; i < guarantorClientIds.length; i++) {
    const gid = guarantorClientIds[i];
    let guarantor;
    try { guarantor = await clientsStore.get(ownerKey + '/' + keySafe(gid), { type: 'json' }); } catch (_) {}
    if (!guarantor) {
      manifest.push({ line: '! Guarantor ' + (i + 2) + ' (id ' + gid + '): client record not found' });
      continue;
    }
    const displayName = ((guarantor.firstName || '') + ' ' + (guarantor.lastName || '')).trim() || guarantor.email || gid;
    const subState = (guarantor._subFormTokensByLoan && guarantor._subFormTokensByLoan[loanId]) || {};

    let credAuthBytes = null;
    if (subState.status === 'completed' && subState.token) {
      try {
        const buf = await credAuthStore.get(subState.token, { type: 'arrayBuffer' });
        if (buf) credAuthBytes = Buffer.from(buf);
      } catch (_) {}
    }

    // Always render the data summary — even for not-yet-signed
    // guarantors. The LO benefits from seeing what was captured
    // so far on the bundle even if Credit Auth isn't on file.
    let summaryBytes = null;
    try {
      summaryBytes = await _renderSubformSummaryPdf({ guarantor, loan, primary, subState });
    } catch (e) {
      console.warn('loan-bundle-download: summary render failed for', gid, ':', e && e.message);
    }

    guarantorEntries.push({ displayName, subState, summaryBytes, credAuthBytes });
    manifest.push({
      line: (credAuthBytes ? '✓ ' : '— ') + 'Guarantor ' + (i + 2) + ': ' + displayName +
        ' — sub-form ' + (subState.status || 'pending') +
        (credAuthBytes ? ', Credit Auth signed ' + (subState.completedAt || '?') : ', Credit Auth NOT on file'),
    });
  }
  if (!guarantorClientIds.length) {
    manifest.push({ line: '(no additional guarantors on this loan)' });
  }

  // ── Build the combined PDF ────────────────────────────────
  const out = await PDFDocument.create();

  // Cover page
  await _drawCoverPage(out, {
    title: 'Loan Application Bundle',
    subtitle: loan.address || '(no address)',
    manifest,
    primary,
    loan,
  });

  // Signed loan app — copy every page.
  if (signedAppBytes) {
    await _appendPdfBytes(out, signedAppBytes);
  }

  // Each guarantor section
  for (let i = 0; i < guarantorEntries.length; i++) {
    const g = guarantorEntries[i];
    await _drawDividerPage(out, {
      title: 'Guarantor ' + (i + 2),
      subtitle: g.displayName,
      lines: [
        'Sub-form status: ' + (g.subState.status || 'pending'),
        g.credAuthBytes
          ? 'Credit Authorization signed ' + (g.subState.completedAt || '')
          : 'Credit Authorization NOT on file',
      ],
    });
    if (g.summaryBytes) await _appendPdfBytes(out, g.summaryBytes);
    if (g.credAuthBytes) await _appendPdfBytes(out, g.credAuthBytes);
  }

  const outBytes = await out.save();
  const filename = 'loan-bundle-' + (loan.slaDisplayId || loanId) + '.pdf';
  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':        'application/pdf',
    'Content-Length':      String(outBytes.length),
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control':       'private, no-store',
  });
  return new Response(Buffer.from(outBytes), { status: 200, headers });
}

// Copy every page from a source PDF byte-buffer into the output PDF.
async function _appendPdfBytes(out, bytes) {
  try {
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((p) => out.addPage(p));
  } catch (e) {
    // Source PDF may be malformed — drop a stub page noting the
    // failure instead of aborting the whole bundle.
    const page = out.addPage([612, 792]);
    const helv = await out.embedFont(StandardFonts.Helvetica);
    page.drawText('— PDF could not be merged: ' + (e && e.message || 'unknown') + ' —',
      { x: 50, y: 750, size: 12, font: helv, color: rgb(0.7, 0.1, 0.1) });
  }
}

async function _drawCoverPage(out, args) {
  const page = out.addPage([612, 792]);
  const helv  = await out.embedFont(StandardFonts.Helvetica);
  const helvB = await out.embedFont(StandardFonts.HelveticaBold);
  let y = 730;
  page.drawText('SLA Capital', { x: 50, y, size: 13, font: helvB, color: PLUM });
  y -= 22;
  page.drawText(args.title, { x: 50, y, size: 22, font: helvB, color: PLUM });
  y -= 8;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: GOLD });
  y -= 24;
  page.drawText(args.subtitle, { x: 50, y, size: 12, font: helv, color: MUTED });
  y -= 22;
  page.drawText('Generated ' + new Date().toISOString(), { x: 50, y, size: 9, font: helv, color: MUTED });
  y -= 28;

  for (const item of args.manifest) {
    if (y < 60) break;
    if (item.spacer) { y -= 10; continue; }
    if (item.heading) {
      page.drawText(item.heading.toUpperCase(), { x: 50, y, size: 10, font: helvB, color: GOLD });
      y -= 16;
      continue;
    }
    if (item.label) {
      page.drawText(item.label, { x: 50, y, size: 10, font: helv, color: TEXT });
      y -= 13;
      continue;
    }
    if (item.line) {
      // Wrap long lines at ~95 chars.
      const wrapped = _wrap(item.line, 95);
      for (const w of wrapped) {
        if (y < 60) break;
        page.drawText(w, { x: 50, y, size: 9.5, font: helv, color: TEXT });
        y -= 12;
      }
    }
  }
}

async function _drawDividerPage(out, args) {
  const page = out.addPage([612, 792]);
  const helv  = await out.embedFont(StandardFonts.Helvetica);
  const helvB = await out.embedFont(StandardFonts.HelveticaBold);
  let y = 400;
  page.drawText(args.title.toUpperCase(), { x: 50, y, size: 12, font: helvB, color: GOLD });
  y -= 26;
  page.drawText(args.subtitle, { x: 50, y, size: 26, font: helvB, color: PLUM });
  y -= 18;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: GOLD });
  y -= 22;
  (args.lines || []).forEach((l) => {
    page.drawText(l, { x: 50, y, size: 11, font: helv, color: TEXT });
    y -= 16;
  });
}

// One-page summary of a guarantor's sub-form responses (same data
// as 236.144 ZIP per-guarantor-subform-data.pdf, just inlined so
// the bundle endpoint owns the layout end-to-end).
async function _renderSubformSummaryPdf({ guarantor, loan, primary, subState }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const helv  = await pdf.embedFont(StandardFonts.Helvetica);
  const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);

  let y = 750;
  page.drawText('SLA Capital', { x: 50, y, size: 13, font: helvB, color: PLUM });
  y -= 20;
  page.drawText('Guarantor Sub-Form Data Summary', { x: 50, y, size: 18, font: helvB, color: PLUM });
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: GOLD });
  y -= 18;

  [
    'Loan: ' + (loan && (loan.slaDisplayId || loan.id) || '(unknown)'),
    'Property: ' + (loan && loan.address || '(no address)'),
    'Primary Borrower: ' + (primary && (((primary.firstName || '') + ' ' + (primary.lastName || '')).trim() || primary.email) || '(unknown)'),
    'Sub-form status: ' + (subState && subState.status || 'pending') + (subState && subState.completedAt ? ' — completed ' + subState.completedAt : ''),
  ].forEach((line) => { page.drawText(line, { x: 50, y, size: 10, font: helv, color: MUTED }); y -= 13; });
  y -= 10;

  const ha = guarantor.homeAddress    || {};
  const pa = guarantor.prevAddress    || {};
  const ma = guarantor.mailingAddress || {};
  const decl = guarantor.declarations || {};
  const sections = [
    ['CONTACT', [
      ['Name',     ((guarantor.firstName || '') + ' ' + (guarantor.lastName || '')).trim()],
      ['Email',    guarantor.email || ''],
      ['Phone',    guarantor.phone || ''],
    ]],
    ['PERSONAL', [
      ['Date of birth',         guarantor.dob || ''],
      ['Estimated credit',      guarantor.fico || ''],
      ['SSN',                   guarantor.ssn_enc ? '(encrypted on file)' : ''],
      ['Marital status',        guarantor.maritalStatus || ''],
      ['US Citizen',            guarantor.usCitizen || ''],
    ]],
    ['HOME ADDRESS', [
      ['Street',                ha.street || ''],
      ['City / State / ZIP',    [ha.city, ha.state, ha.zip].filter(Boolean).join(', ')],
      ['Lived 2+ years',        guarantor.twoYearAddress || ''],
    ]],
  ];
  if ((guarantor.twoYearAddress === 'no') && (pa.street || pa.city)) {
    sections.push(['PREVIOUS ADDRESS', [
      ['Street',                pa.street || ''],
      ['City / State / ZIP',    [pa.city, pa.state, pa.zip].filter(Boolean).join(', ')],
    ]]);
  }
  if ((guarantor.mailingSameAsHome === 'no') && (ma.street || ma.city)) {
    sections.push(['MAILING ADDRESS', [
      ['Street',                ma.street || ''],
      ['City / State / ZIP',    [ma.city, ma.state, ma.zip].filter(Boolean).join(', ')],
    ]]);
  }
  sections.push(['EXPERIENCE', [
    ['# Flips (last 36mo)',   String(guarantor.flips || '')],
    ['# Rental properties',   String(guarantor.rentals || '')],
  ]]);
  sections.push(['DECLARATIONS', [
    ['Bankrupt last 7 yrs',          decl.bankruptcy7yr         || ''],
    ['Foreclosed last 7 yrs',        decl.foreclosure7yr        || ''],
    ['Party to a lawsuit',           decl.partyToLawsuit        || ''],
    ['Delinquent Federal debt',      decl.delinquentFederalDebt || ''],
    ['Obligated on foreclosed loan', decl.obligatedToForeclosed || ''],
    ['Outstanding judgments',        decl.outstandingJudgments  || ''],
    ['Intend to occupy',             decl.intendToOccupy        || ''],
  ]]);

  for (const [heading, rows] of sections) {
    if (y < 110) {
      page.drawText('(continued — see additional pages)', { x: 50, y, size: 9, font: helv, color: MUTED });
      break;
    }
    page.drawText(heading, { x: 50, y, size: 10, font: helvB, color: GOLD });
    y -= 14;
    for (const [k, v] of rows) {
      if (y < 80) break;
      page.drawText(k, { x: 50, y, size: 9, font: helv, color: MUTED });
      page.drawText(String(v || '—'), { x: 200, y, size: 10, font: helv, color: TEXT });
      y -= 12;
    }
    y -= 6;
  }

  page.drawLine({ start: { x: 50, y: 60 }, end: { x: 562, y: 60 }, thickness: 0.4, color: MUTED });
  page.drawText('Data summary only — see signed Credit Authorization for the e-signed legal artifact.',
    { x: 50, y: 46, size: 8, font: helv, color: MUTED });

  return Buffer.from(await pdf.save());
}

function _wrap(text, max) {
  const out = [];
  const words = String(text || '').split(/\s+/);
  let line = '';
  for (const w of words) {
    if (!line) { line = w; continue; }
    if ((line + ' ' + w).length > max) { out.push(line); line = w; }
    else line += ' ' + w;
  }
  if (line) out.push(line);
  return out;
}
