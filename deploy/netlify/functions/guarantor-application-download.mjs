/**
 * guarantor-application-download.mjs — GET /api/guarantor-application-download
 *
 * Deploy 236.146 — per-guarantor "Full Application" PDF download.
 * Lives in each guarantor's box on Loan Details (Contacts tab).
 * Differs from the loan-bundle-download endpoint in TWO ways:
 *
 *   1) Single-guarantor scope — only the requested guarantor's
 *      profile + signed Credit Auth (if on file), not every
 *      guarantor + the main signed loan application.
 *   2) DECRYPTS the SSN. Per Mike, the LO needs to see the
 *      actual digits for this download (vs the bundle PDF which
 *      masks it). Requires LO/admin auth.
 *
 * Query: ?clientId=PRIMARY&loanId=X&guarantorClientId=G&owner=Y
 * Response: application/pdf
 */
import { getStore } from '@netlify/blobs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail, corsHeaders,
} from './_shared/auth.mjs';
import { decryptField } from './_shared/crypto.mjs';

const PLUM  = rgb(0.149, 0.102, 0.212);
const GOLD  = rgb(0.784, 0.506, 0.227);
const TEXT  = rgb(0.102, 0.082, 0.125);
const MUTED = rgb(0.478, 0.455, 0.533);

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('guarantor-application-download top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const primaryClientId    = String(url.searchParams.get('clientId')         || '').trim();
  const loanId             = String(url.searchParams.get('loanId')           || '').trim();
  const guarantorClientId  = String(url.searchParams.get('guarantorClientId') || '').trim() || primaryClientId;
  const ownerP             = String(url.searchParams.get('owner')            || '').trim();
  if (!primaryClientId)   return json(400, { error: 'clientId required' });
  if (!loanId)            return json(400, { error: 'loanId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (ownerP && ownerP !== selfEmail && ownerP !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(ownerP));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore  = getStore({ name: 'clients',                    consistency: 'strong' });
  const credAuthStore = getStore({ name: 'guarantor-credit-auth-pdfs', consistency: 'strong' });

  const primary = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
  if (!primary) return json(404, { error: 'Primary client not found' });
  const loan = Array.isArray(primary.loans) ? primary.loans.find((l) => l && l.id === loanId) : null;
  if (!loan) return json(404, { error: 'Loan not found on primary client' });

  let guarantor;
  if (guarantorClientId === primaryClientId) {
    guarantor = primary;
  } else {
    guarantor = await clientsStore.get(ownerKey + '/' + keySafe(guarantorClientId), { type: 'json' });
    if (!guarantor) return json(404, { error: 'Guarantor client record not found' });
  }

  // Decrypt SSN for display in this PDF (LO/admin auth gates the
  // endpoint — same trust level as Client Details page).
  const ssnPlain = guarantor.ssn_enc ? (decryptField(guarantor.ssn_enc) || '') : '';
  const ssnFormatted = _formatSsn(ssnPlain);

  // Pull the per-loan sub-form state for the divider text + Credit
  // Auth attach decision.
  const subState = (guarantor._subFormTokensByLoan && guarantor._subFormTokensByLoan[loanId]) || {};

  // Build the PDF.
  const out = await PDFDocument.create();
  await _drawProfilePage(out, { guarantor, loan, primary, subState, ssnFormatted });

  if (subState.status === 'completed' && subState.token) {
    try {
      const buf = await credAuthStore.get(subState.token, { type: 'arrayBuffer' });
      if (buf) {
        const src = await PDFDocument.load(buf, { ignoreEncryption: true });
        const pages = await out.copyPages(src, src.getPageIndices());
        pages.forEach((p) => out.addPage(p));
      }
    } catch (e) {
      console.warn('guarantor-application-download: credit auth attach failed:', e && e.message);
    }
  }

  const outBytes = await out.save();
  const nameSlug = ((guarantor.firstName || '') + '-' + (guarantor.lastName || '')).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || guarantorClientId.slice(-8);
  const filename = 'guarantor-application-' + nameSlug + '-' + (loan.slaDisplayId || loanId) + '.pdf';
  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':        'application/pdf',
    'Content-Length':      String(outBytes.length),
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control':       'private, no-store',
  });
  return new Response(Buffer.from(outBytes), { status: 200, headers });
}

function _formatSsn(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length !== 9) return d;
  return d.slice(0, 3) + '-' + d.slice(3, 5) + '-' + d.slice(5);
}

function _ascii(s) {
  return String(s == null ? '' : s)
    .replace(/[‘’‚]/g, "'").replace(/[“”„]/g, '"')
    .replace(/[–—]/g, '-').replace(/[•·]/g, '*')
    .replace(/[✓✔]/g, '[OK]').replace(/[✗✘]/g, '[X]')
    .replace(/[…]/g, '...').replace(/[ ]/g, ' ')
    .replace(/[^\x00-\xFF]/g, '?');
}

async function _drawProfilePage(out, { guarantor, loan, primary, subState, ssnFormatted }) {
  const page = out.addPage([612, 792]);
  const helv  = await out.embedFont(StandardFonts.Helvetica);
  const helvB = await out.embedFont(StandardFonts.HelveticaBold);

  let y = 750;
  page.drawText('SLA Capital', { x: 50, y, size: 13, font: helvB, color: PLUM });
  y -= 22;
  page.drawText('Guarantor Application', { x: 50, y, size: 22, font: helvB, color: PLUM });
  y -= 8;
  page.drawLine({ start: { x: 50, y }, end: { x: 562, y }, thickness: 1, color: GOLD });
  y -= 20;

  // Context block — loan / property / primary.
  [
    'Loan: ' + _ascii(loan.slaDisplayId || loan.id),
    'Property: ' + _ascii(loan.address || '(no address)'),
    'Primary Borrower: ' + _ascii(((primary.firstName || '') + ' ' + (primary.lastName || '')).trim() || primary.email || '(unknown)'),
    'Sub-form status: ' + (subState.status || 'pending') + (subState.completedAt ? ' - completed ' + subState.completedAt : ''),
  ].forEach((line) => {
    page.drawText(_ascii(line), { x: 50, y, size: 10, font: helv, color: MUTED });
    y -= 13;
  });
  y -= 14;

  const ha   = guarantor.homeAddress    || {};
  const pa   = guarantor.prevAddress    || {};
  const ma   = guarantor.mailingAddress || {};
  const decl = guarantor.declarations   || {};
  const ownership = (loan.guarantorOwnership && loan.guarantorOwnership[guarantor.id]);
  const sections = [
    ['CONTACT', [
      ['Name',         ((guarantor.firstName || '') + ' ' + (guarantor.lastName || '')).trim()],
      ['Email',        guarantor.email || ''],
      ['Phone',        guarantor.phone || ''],
      ['% Ownership',  (ownership != null && ownership !== '') ? String(ownership) + '%' : ''],
    ]],
    ['PERSONAL', [
      ['Date of birth',         guarantor.dob || ''],
      ['Estimated credit',      guarantor.fico || ''],
      // Deploy 236.146 — actual SSN digits (decrypted server-side).
      // This endpoint is LO/admin-auth-gated; SSN is acceptable in
      // the downloaded artifact for LOS / investor packages.
      ['SSN',                   ssnFormatted || (guarantor.ssn_enc ? '(could not decrypt)' : '(not on file)')],
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
      page.drawText('(continued - see additional pages)', { x: 50, y, size: 9, font: helv, color: MUTED });
      break;
    }
    page.drawText(_ascii(heading), { x: 50, y, size: 10, font: helvB, color: GOLD });
    y -= 14;
    for (const [k, v] of rows) {
      if (y < 80) break;
      page.drawText(_ascii(k), { x: 50, y, size: 9, font: helv, color: MUTED });
      page.drawText(_ascii(v || '-'), { x: 200, y, size: 10, font: helv, color: TEXT });
      y -= 12;
    }
    y -= 6;
  }

  page.drawLine({ start: { x: 50, y: 60 }, end: { x: 562, y: 60 }, thickness: 0.4, color: MUTED });
  page.drawText('Generated ' + new Date().toISOString() + ' - Includes decrypted SSN for LOS / investor package use.',
    { x: 50, y: 46, size: 8, font: helv, color: MUTED });
}
