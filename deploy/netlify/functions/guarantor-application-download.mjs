/**
 * guarantor-application-download.mjs — GET /api/guarantor-application-download
 *
 * Deploy 236.147 — per-guarantor "Full Application" PDF download
 * that uses the SAME renderer + visual format as the main signed
 * loan application (renderSignedApplicationPDF from the long-app
 * pipeline). Replaces the 236.146 one-page custom layout per Mike.
 *
 * Output PDF:
 *   - Full loan-application format (sections A-G: loan terms,
 *     property details, this guarantor positioned as Guarantor 1
 *     so all their fields populate, vesting entity with their
 *     ownership %, declarations, lender-attestation block).
 *   - Rendered in unsigned mode — the guarantor signed their
 *     Credit Authorization, NOT the loan application itself.
 *   - The guarantor's signed Credit Authorization PDF pages
 *     are stitched on at the end as additional pages.
 *
 * Auth: requireAuth (LO/admin owner-override). SSN is decrypted
 * by the renderer's resolveSSN() helper and printed on the PDF.
 *
 * Query: ?clientId=PRIMARY&loanId=X&guarantorClientId=G&owner=Y
 * Response: application/pdf
 */
import { getStore } from '@netlify/blobs';
import { PDFDocument } from 'pdf-lib';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail, corsHeaders,
} from './_shared/auth.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';
import { synthRecordForGuarantor } from './_shared/guarantor-synth.mjs';

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
  const primaryClientId   = String(url.searchParams.get('clientId')          || '').trim();
  const loanId            = String(url.searchParams.get('loanId')            || '').trim();
  const guarantorClientId = String(url.searchParams.get('guarantorClientId') || '').trim();
  const ownerP            = String(url.searchParams.get('owner')             || '').trim();
  if (!primaryClientId)   return json(400, { error: 'clientId required' });
  if (!loanId)            return json(400, { error: 'loanId required' });
  if (!guarantorClientId) return json(400, { error: 'guarantorClientId required' });

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

  // Refuse the primary — they don't have their own sub-application,
  // their data is in the main signed loan app already.
  if (guarantorClientId === primaryClientId) {
    return json(400, { error: 'Primary borrower has no separate guarantor application. Use the main "Download Signed Application" button.' });
  }

  const guarantor = await clientsStore.get(ownerKey + '/' + keySafe(guarantorClientId), { type: 'json' });
  if (!guarantor) return json(404, { error: 'Guarantor client record not found' });

  // Build the loan-app-format PDF for this guarantor.
  const record = synthRecordForGuarantor({
    guarantor, loan, primary, ownerKey, asGuarantorIndex: 0,
  });
  let appPdfBytes;
  try {
    appPdfBytes = await renderSignedApplicationPDF({
      record,
      client: primary,
      signers: [],
      status: 'unsigned',
      unsigned: true,
      enteredBy: {
        name:  ((guarantor.firstName || '') + ' ' + (guarantor.lastName || '')).trim(),
        email: guarantor.email || '',
        at:    new Date().toISOString(),
      },
    });
  } catch (e) {
    console.error('guarantor-application-download: app render failed:', e);
    return json(500, { error: 'Failed to render application: ' + (e.message || 'unknown') });
  }

  // Stitch the signed Credit Authorization PDF on the end (when
  // the guarantor has completed their sub-form).
  const subState = (guarantor._subFormTokensByLoan && guarantor._subFormTokensByLoan[loanId]) || {};
  let credAuthBytes = null;
  if (subState.status === 'completed' && subState.token) {
    try {
      const buf = await credAuthStore.get(subState.token, { type: 'arrayBuffer' });
      if (buf) credAuthBytes = Buffer.from(buf);
    } catch (e) {
      console.warn('guarantor-application-download: credit auth fetch failed:', e && e.message);
    }
  }

  const outBytes = credAuthBytes
    ? await _concatPdfs([appPdfBytes, credAuthBytes])
    : appPdfBytes;

  const nameSlug = ((guarantor.firstName || '') + '-' + (guarantor.lastName || '')).toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || guarantorClientId.slice(-8);
  const filename = 'guarantor-application-' + nameSlug + '-' + (loan.slaDisplayId || loanId) + '.pdf';
  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':        'application/pdf',
    'Content-Length':      String(outBytes.length),
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control':       'private, no-store',
  });
  return new Response(outBytes, { status: 200, headers });
}

// Concatenate multiple PDF byte-buffers into a single PDF using
// pdf-lib's copyPages. Used to glue the Credit Auth onto the end
// of the loan-app render.
async function _concatPdfs(buffers) {
  const out = await PDFDocument.create();
  for (const b of buffers) {
    if (!b) continue;
    try {
      const src = await PDFDocument.load(b, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } catch (e) {
      console.warn('guarantor-application-download: concat skipped a malformed PDF:', e && e.message);
    }
  }
  return Buffer.from(await out.save());
}
