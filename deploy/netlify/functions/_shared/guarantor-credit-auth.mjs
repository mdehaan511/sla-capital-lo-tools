/**
 * guarantor-credit-auth.mjs — Deploy 236.129
 *
 * Helpers for the additional-guarantor sub-form Credit Authorization
 * signing step. Generates a one-page Credit Authorization PDF when
 * the guarantor submits the sub-form, with their typed signature +
 * audit metadata stamped on the page. Storage in the new
 * `guarantor-credit-auth-pdfs` blob store keyed by sub-form token.
 *
 * Mirrors the structure / brand styling of native-esign.mjs so the
 * resulting PDFs feel consistent with the term-sheet + loan-app
 * signed docs already in production.
 */
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import crypto from 'node:crypto';

export const CREDIT_AUTH_CONSENT_VERSION = 1;

export const CREDIT_AUTH_CONSENT_TEXT = [
  'GUARANTOR CREDIT AUTHORIZATION AND ESIGN CONSENT',
  '',
  'I, the undersigned guarantor, hereby authorize SLA Capital, its assigns, ' +
    'and any third-party service providers acting on its behalf (collectively, ' +
    '"Lender"), to obtain consumer credit reports, business credit reports, ' +
    'background checks, OFAC/SDN screening reports, and verifications of ' +
    'employment, income, mortgages, deposits, and identity in connection with ' +
    'the loan application identified below. Lender may obtain these reports ' +
    'from any consumer reporting agency, employer, financial institution, or ' +
    'other third party at any time prior to, during, or for a reasonable period ' +
    'after the closing of the loan.',
  '',
  'I understand that:',
  '',
  '  (a) The information obtained will be used to evaluate my creditworthiness ' +
    'as a guarantor of the loan;',
  '  (b) A consumer credit report may be obtained from Equifax, Experian, ' +
    'TransUnion, or any other consumer reporting agency;',
  '  (c) I have the right under the Fair Credit Reporting Act (FCRA, 15 U.S.C. ' +
    'Section 1681) to know whether a consumer report was obtained, the name of ' +
    'the reporting agency, and the information contained in it;',
  '  (d) This authorization remains in effect for the duration of the loan ' +
    'application process and any related underwriting review;',
  '  (e) A photocopy, facsimile, or electronic copy of this authorization is as ' +
    'valid as the original.',
  '',
  'I further consent to the use of electronic signatures and electronic records ' +
    'under the federal ESIGN Act (15 U.S.C. Section 7001 et seq.) and the Uniform ' +
    'Electronic Transactions Act (UETA) as adopted in my state. My electronic ' +
    'signature below has the same legal effect as a handwritten signature.',
].join('\n');

export const CREDIT_AUTH_CONSENT_LABEL =
  'I have read the Credit Authorization above, authorize the credit and background ' +
  'checks described, and intend to sign electronically.';

// Brand colors (mirror native-esign)
const PLUM  = rgb(0.149, 0.102, 0.212);
const GOLD  = rgb(0.784, 0.506, 0.227);
const TEXT  = rgb(0.102, 0.082, 0.125);
const MUTED = rgb(0.478, 0.455, 0.533);

/**
 * generateCreditAuthPdf — build the signed Credit Auth PDF.
 *
 * @param {object} args
 * @param {object} args.guarantor      Client record with firstName/lastName/email/dob etc.
 * @param {object} args.primary        Primary borrower client (for context).
 * @param {object} args.loan           Loan record (for address + id).
 * @param {object} args.audit          { signerName, signedAt, ipAddress, userAgent,
 *                                       consentVersion, geolocation, token, seal }
 * @returns {Promise<Buffer>}          PDF byte buffer.
 */
export async function generateCreditAuthPdf(args) {
  const { guarantor, primary, loan, audit } = args;
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]); // US Letter
  const helv = await pdf.embedFont(StandardFonts.Helvetica);
  const helvB = await pdf.embedFont(StandardFonts.HelveticaBold);
  const script = await pdf.embedFont(StandardFonts.TimesRomanItalic);

  // ─── Header ───
  page.drawText('SLA Capital', { x: 50, y: 750, size: 13, font: helvB, color: PLUM });
  page.drawText('Guarantor Credit Authorization', { x: 50, y: 730, size: 18, font: helvB, color: PLUM });
  page.drawLine({ start: { x: 50, y: 722 }, end: { x: 562, y: 722 }, thickness: 1, color: GOLD });

  // ─── Loan context ───
  let y = 700;
  const ctxLines = [
    'Loan Address: ' + (loan && loan.address ? loan.address : '(not on file)'),
    'Loan ID: ' + (loan && loan.id ? loan.id : '(unknown)'),
    'Primary Borrower: ' + ((primary && (primary.firstName || '') + ' ' + (primary.lastName || '')).trim() || (primary && primary.email) || '(unknown)'),
  ];
  ctxLines.forEach((line) => {
    page.drawText(line, { x: 50, y, size: 10, font: helv, color: MUTED });
    y -= 13;
  });
  y -= 10;

  // ─── Authorization body ───
  // Word-wrap the consent text to fit ~95 chars per line at 10pt.
  const wrapped = _wrapForPage(CREDIT_AUTH_CONSENT_TEXT, 95);
  wrapped.forEach((line) => {
    if (y < 200) return; // leave room for the signature block
    const isHeading = /^[A-Z ]+$/.test(line.trim()) && line.trim().length > 4;
    page.drawText(line, {
      x: 50, y,
      size: isHeading ? 10.5 : 9,
      font: isHeading ? helvB : helv,
      color: isHeading ? PLUM : TEXT,
    });
    y -= isHeading ? 14 : 12;
  });

  // ─── Signature block ───
  // Sits at a fixed band near the bottom so the layout is predictable
  // regardless of consent text length.
  const sigY = 170;
  page.drawLine({ start: { x: 50, y: sigY + 2 }, end: { x: 562, y: sigY + 2 }, thickness: 0.5, color: MUTED });
  page.drawText('SIGNED', { x: 50, y: sigY - 12, size: 9, font: helvB, color: GOLD });

  // Typed signature (script font, larger).
  page.drawText(audit.signerName || '', {
    x: 50, y: sigY - 38,
    size: 22, font: script, color: PLUM,
  });
  page.drawLine({ start: { x: 50, y: sigY - 42 }, end: { x: 320, y: sigY - 42 }, thickness: 0.4, color: MUTED });
  page.drawText('Guarantor signature', { x: 50, y: sigY - 54, size: 8, font: helv, color: MUTED });

  // Name printed + email + DOB column.
  const gName = ((guarantor && guarantor.firstName) || '') + ' ' + ((guarantor && guarantor.lastName) || '');
  page.drawText(gName.trim() || '(name on file)', { x: 360, y: sigY - 18, size: 10, font: helvB, color: TEXT });
  page.drawText('Printed name', { x: 360, y: sigY - 30, size: 8, font: helv, color: MUTED });
  page.drawText(guarantor && guarantor.email || '', { x: 360, y: sigY - 46, size: 9, font: helv, color: TEXT });
  page.drawText('Email', { x: 360, y: sigY - 58, size: 8, font: helv, color: MUTED });

  // Audit footer.
  let footY = 80;
  page.drawLine({ start: { x: 50, y: footY + 22 }, end: { x: 562, y: footY + 22 }, thickness: 0.4, color: MUTED });
  page.drawText('AUDIT', { x: 50, y: footY + 10, size: 8, font: helvB, color: GOLD });
  const footLines = [
    'Signed: ' + (audit.signedAt || '') + (audit.ipAddress ? '  ·  IP: ' + audit.ipAddress : ''),
    'Consent v' + (audit.consentVersion || CREDIT_AUTH_CONSENT_VERSION) + (audit.userAgent ? '  ·  UA: ' + audit.userAgent.slice(0, 80) : ''),
    'Token: ' + (audit.token ? audit.token.slice(0, 16) + '…' : '(none)') + (audit.seal ? '  ·  Seal: ' + audit.seal.slice(0, 16) + '…' : ''),
  ];
  footLines.forEach((line, i) => {
    page.drawText(line, { x: 50, y: footY - (i * 11), size: 8, font: helv, color: MUTED });
  });

  return Buffer.from(await pdf.save());
}

// Naive word wrap that preserves paragraph breaks (empty lines).
function _wrapForPage(text, maxChars) {
  const out = [];
  String(text || '').split('\n').forEach((para) => {
    if (!para.trim()) { out.push(''); return; }
    const words = para.split(/\s+/);
    let line = '';
    words.forEach((w) => {
      if (!line) { line = w; return; }
      if ((line + ' ' + w).length > maxChars) {
        out.push(line);
        line = w;
      } else {
        line += ' ' + w;
      }
    });
    if (line) out.push(line);
  });
  return out;
}

// HMAC-seal the audit so it can't be silently tampered with.
export function sealCreditAuthAudit(audit) {
  const secret = process.env.ESIGN_SEAL_SECRET || '';
  if (!secret) return null;
  const canonical = [
    audit.token || '',
    audit.guarantorClientId || '',
    audit.loanId || '',
    audit.signerName || '',
    audit.signedAt || '',
    audit.consentVersion || '',
    audit.ipAddress || '',
    audit.userAgent || '',
  ].join('|');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}
