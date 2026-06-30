/**
 * loan-bundle-download.mjs — GET /api/loan-bundle-download
 *
 * Deploy 236.147 — bundled loan application PDF for a loan.
 * Replaces the 236.145 ZIP / cover-page version per Mike.
 *
 * Output PDF structure (no cover page):
 *   1. Original signed loan application PDF (preserves the
 *      e-signed legal artifact for the primary borrower and
 *      anyone who signed via the long-app flow).
 *   2. For each ADDITIONAL guarantor (slot 2, 3, 4...):
 *        a. A loan-application-format PDF rendered with this
 *           guarantor positioned as Guarantor 1 — same renderer
 *           and visual format as the original signed app.
 *           Includes their Guarantor Info (incl. decrypted SSN),
 *           Entity Information (vesting LLC + their ownership %),
 *           Declarations, and the lender-attestation block.
 *           Rendered in `unsigned` mode (these guarantors signed
 *           their Credit Authorization, not the loan app itself).
 *        b. Their signed Credit Authorization PDF pages.
 *
 * Primary guarantor (Guarantor 1) is intentionally skipped in the
 * per-guarantor loop — their data already lives in the original
 * signed PDF.
 *
 * Query: ?clientId=...&loanId=...&owner=...
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

  const primary = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' });
  if (!primary) return json(404, { error: 'Primary client not found' });
  const loan = Array.isArray(primary.loans) ? primary.loans.find((l) => l && l.id === loanId) : null;
  if (!loan) return json(404, { error: 'Loan not found on primary client' });

  const segments = []; // PDF byte-buffers in order

  // ── 1. Original signed loan application ──────────────────
  try {
    const signedKey = ownerKey + '/' + keySafe(clientId) + '/' + keySafe(loanId);
    const rec = await signedAppStore.get(signedKey, { type: 'json' });
    if (rec && rec.pdfBase64) {
      segments.push(Buffer.from(rec.pdfBase64, 'base64'));
    } else {
      // Borrower has not signed the long app yet — fall back to
      // a freshly rendered unsigned version of the primary's data
      // so the bundle still leads with a loan-app PDF.
      try {
        const primaryRecord = synthRecordForGuarantor({
          guarantor: primary, loan, primary, ownerKey, asGuarantorIndex: 0,
        });
        const pdf = await renderSignedApplicationPDF({
          record: primaryRecord,
          client: primary,
          signers: [],
          status: 'unsigned',
          unsigned: true,
          enteredBy: {
            name:  (user.user_metadata && user.user_metadata.full_name) || selfEmail,
            email: selfEmail,
            at:    new Date().toISOString(),
          },
        });
        segments.push(pdf);
      } catch (e) {
        console.warn('loan-bundle-download: primary-fallback render failed:', e && e.message);
      }
    }
  } catch (e) {
    console.warn('loan-bundle-download: signed-app read failed:', e && e.message);
  }

  // ── 2. Each additional guarantor (skip the primary) ──────
  const guarantorClientIds = (Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [])
    .filter((gid) => gid && gid !== clientId);

  for (const gid of guarantorClientIds) {
    let guarantor;
    try { guarantor = await clientsStore.get(ownerKey + '/' + keySafe(gid), { type: 'json' }); }
    catch (_) {}
    if (!guarantor) continue;

    // 2a. Loan-app format for this guarantor.
    try {
      const gRecord = synthRecordForGuarantor({
        guarantor, loan, primary, ownerKey, asGuarantorIndex: 0,
      });
      const gPdf = await renderSignedApplicationPDF({
        record: gRecord,
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
      segments.push(gPdf);
    } catch (e) {
      console.warn('loan-bundle-download: guarantor render failed for ' + gid + ':', e && e.message);
    }

    // 2b. Their signed Credit Authorization PDF (when on file).
    const subState = (guarantor._subFormTokensByLoan && guarantor._subFormTokensByLoan[loanId]) || {};
    if (subState.status === 'completed' && subState.token) {
      try {
        const buf = await credAuthStore.get(subState.token, { type: 'arrayBuffer' });
        if (buf) segments.push(Buffer.from(buf));
      } catch (e) {
        console.warn('loan-bundle-download: credit auth fetch failed for ' + gid + ':', e && e.message);
      }
    }
  }

  const outBytes = await _concatPdfs(segments);
  const filename = 'loan-bundle-' + (loan.slaDisplayId || loanId) + '.pdf';
  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':        'application/pdf',
    'Content-Length':      String(outBytes.length),
    'Content-Disposition': 'attachment; filename="' + filename + '"',
    'Cache-Control':       'private, no-store',
  });
  return new Response(outBytes, { status: 200, headers });
}

async function _concatPdfs(buffers) {
  const out = await PDFDocument.create();
  for (const b of buffers) {
    if (!b) continue;
    try {
      const src = await PDFDocument.load(b, { ignoreEncryption: true });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } catch (e) {
      console.warn('loan-bundle-download: skipped malformed PDF segment:', e && e.message);
    }
  }
  return Buffer.from(await out.save());
}
