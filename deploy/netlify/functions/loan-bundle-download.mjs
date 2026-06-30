/**
 * loan-bundle-download.mjs — GET /api/loan-bundle-download
 *
 * Deploy 236.144 — single-click bundle download for a loan.
 * Packages the signed loan application PDF + each additional
 * guarantor's signed Credit Authorization PDF + a per-guarantor
 * sub-form data summary PDF into a ZIP that the LO can hand off
 * to the investor / store in the LOS without chasing each
 * download individually.
 *
 * Query: ?clientId=...&loanId=...&owner=...
 * Response: application/zip
 *
 * ZIP contents (each PDF is included only when it exists):
 *   loan-application-signed.pdf            ← the main signed app
 *   guarantor-<name>-credit-auth.pdf       ← per completed guarantor
 *   guarantor-<name>-subform-data.pdf      ← per completed guarantor
 *   bundle-manifest.txt                    ← what's in the ZIP + when
 */
import { getStore } from '@netlify/blobs';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail, corsHeaders,
} from './_shared/auth.mjs';

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

  const clientsStore  = getStore({ name: 'clients',                       consistency: 'strong' });
  const signedAppStore = getStore({ name: 'signed_applications',          consistency: 'strong' });
  const credAuthStore = getStore({ name: 'guarantor-credit-auth-pdfs',    consistency: 'strong' });

  // Resolve primary + loan.
  const primaryKey = ownerKey + '/' + keySafe(clientId);
  const primary = await clientsStore.get(primaryKey, { type: 'json' });
  if (!primary) return json(404, { error: 'Primary client not found' });
  const loan = Array.isArray(primary.loans)
    ? primary.loans.find((l) => l && l.id === loanId)
    : null;
  if (!loan) return json(404, { error: 'Loan not found on primary client' });

  const zip = new JSZip();
  const manifestLines = [];
  const stamp = new Date().toISOString();
  manifestLines.push('SLA Capital — Loan Application Bundle');
  manifestLines.push('Generated ' + stamp);
  manifestLines.push('Loan: ' + (loan.slaDisplayId || loan.id));
  manifestLines.push('Address: ' + (loan.address || '(no address)'));
  manifestLines.push('Primary: ' + (((primary.firstName || '') + ' ' + (primary.lastName || '')).trim() || primary.email));
  manifestLines.push('');
  manifestLines.push('Contents:');

  // ── 1. Signed loan application PDF ──────────────────────────
  try {
    const signedKey = ownerKey + '/' + keySafe(clientId) + '/' + keySafe(loanId);
    const signedRec = await signedAppStore.get(signedKey, { type: 'json' });
    if (signedRec && signedRec.pdfBase64) {
      const bytes = Buffer.from(signedRec.pdfBase64, 'base64');
      zip.file('loan-application-signed.pdf', bytes);
      manifestLines.push('  · loan-application-signed.pdf  (' + bytes.length + ' bytes, signed ' + (signedRec.createdAt || '?') + ')');
    } else {
      manifestLines.push('  · loan-application-signed.pdf  — NOT FOUND (long app may not have been signed yet)');
    }
  } catch (e) {
    manifestLines.push('  · loan-application-signed.pdf  — ERROR: ' + (e && e.message || 'unknown'));
  }

  // ── 2. Each additional guarantor: Credit Auth + sub-form summary ──
  const guarantorClientIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
  for (const gid of guarantorClientIds) {
    let guarantor;
    try {
      // Guarantors may live under a different ownerKey if this loan
      // was a cross-LO admin scenario, but the standard flow keeps
      // them under the same owner as the primary.
      guarantor = await clientsStore.get(ownerKey + '/' + keySafe(gid), { type: 'json' });
    } catch (_) {}
    if (!guarantor) {
      manifestLines.push('  · guarantor ' + gid + ' — client record not found');
      continue;
    }
    const nameSlug = ((guarantor.firstName || '') + '-' + (guarantor.lastName || '')).toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || gid.slice(-8);
    const displayName = ((guarantor.firstName || '') + ' ' + (guarantor.lastName || '')).trim() || guarantor.email || gid;

    // Per-loan sub-form state (token + status).
    const subState = (guarantor._subFormTokensByLoan && guarantor._subFormTokensByLoan[loanId]) || {};

    // 2a. Signed Credit Auth (only when status === 'completed').
    if (subState.status === 'completed' && subState.token) {
      try {
        const buf = await credAuthStore.get(subState.token, { type: 'arrayBuffer' });
        if (buf) {
          zip.file('guarantor-' + nameSlug + '-credit-auth.pdf', Buffer.from(buf));
          manifestLines.push('  · guarantor-' + nameSlug + '-credit-auth.pdf  (signed ' + (subState.completedAt || '?') + ')');
        } else {
          manifestLines.push('  · ' + displayName + ' — Credit Auth blob missing for token ' + subState.token.slice(0, 12) + '…');
        }
      } catch (e) {
        manifestLines.push('  · ' + displayName + ' — Credit Auth fetch error: ' + (e.message || 'unknown'));
      }
    } else {
      manifestLines.push('  · ' + displayName + ' — Credit Auth not yet signed (sub-form status: ' + (subState.status || 'pending') + ')');
    }

    // 2b. Sub-form data summary PDF (one page, what they entered).
    try {
      const summaryBytes = await _renderGuarantorSubformSummaryPdf({ guarantor, loan, primary, subState });
      zip.file('guarantor-' + nameSlug + '-subform-data.pdf', summaryBytes);
      manifestLines.push('  · guarantor-' + nameSlug + '-subform-data.pdf  (data captured ' + (guarantor.updatedAt || '?') + ')');
    } catch (e) {
      manifestLines.push('  · ' + displayName + ' — sub-form summary PDF render error: ' + (e.message || 'unknown'));
    }
  }

  if (!guarantorClientIds.length) {
    manifestLines.push('  (no additional guarantors on this loan)');
  }

  zip.file('bundle-manifest.txt', manifestLines.join('\n'));

  // Stream the ZIP back.
  const zipBytes = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const filename = 'loan-bundle-' + (loan.slaDisplayId || loanId) + '.zip';
  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':        'application/zip',
    'Content-Length':      String(zipBytes.length),
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control':       'private, no-store',
  });
  return new Response(zipBytes, { status: 200, headers });
}

// One-page PDF summarizing a guarantor's sub-form responses. Includes
// every field they filled out (contact, personal, addresses,
// declarations) so the LO has a static record alongside the signed
// Credit Auth. No signature line — this is a data summary, not a
// signed authorization.
async function _renderGuarantorSubformSummaryPdf({ guarantor, loan, primary, subState }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const PLUM  = rgb(0.149, 0.102, 0.212);
  const GOLD  = rgb(0.784, 0.506, 0.227);
  const TEXT  = rgb(0.102, 0.082, 0.125);
  const MUTED = rgb(0.478, 0.455, 0.533);

  let y = 750;
  page.drawText('SLA Capital', { x: 50, y: y, size: 13, font: helvB, color: PLUM });
  y -= 20;
  page.drawText('Guarantor Sub-Form Data Summary', { x: 50, y: y, size: 18, font: helvB, color: PLUM });
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: GOLD });
  y -= 18;

  // Loan + primary context.
  const ctxRows = [
    'Loan: ' + (loan && (loan.slaDisplayId || loan.id) || '(unknown)'),
    'Property: ' + (loan && loan.address || '(no address)'),
    'Primary Borrower: ' + (primary && (((primary.firstName || '') + ' ' + (primary.lastName || '')).trim() || primary.email) || '(unknown)'),
    'Sub-form status: ' + (subState && subState.status || 'pending') + (subState && subState.completedAt ? ' — completed ' + subState.completedAt : ''),
  ];
  ctxRows.forEach((line) => {
    page.drawText(line, { x: 50, y, size: 10, font: helv, color: MUTED });
    y -= 13;
  });
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
      // Out of room on page 1 — overflow not expected for normal
      // sub-forms but defensive: break with a note.
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

  // Footer.
  page.drawLine({ start: { x: 50, y: 60 }, end: { x: 562, y: 60 }, thickness: 0.4, color: MUTED });
  page.drawText('Data summary only — see signed Credit Authorization PDF for the e-signed legal artifact.',
    { x: 50, y: 46, size: 8, font: helv, color: MUTED });

  return Buffer.from(await pdf.save());
}
