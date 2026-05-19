/**
 * _shared/native-esign.mjs — Native term-sheet eSign helper.
 *
 * Replaces the PandaDoc integration with our own in-house e-signature
 * flow for term sheets / rate sheets. Mirrors the loan-application
 * native eSign (see esign.mjs + loan-application-pdf.mjs) but adapted
 * for the term-sheet use case:
 *
 *   - We do NOT generate the signing document. The LO (via the
 *     DSCR/RTL sizer in the browser) generates the rate-sheet PDF and
 *     uploads its bytes. We append a "Signed By" page to the END of
 *     each PDF when all signers have completed.
 *
 *   - Multiple signers supported (1-6). Each signer signs independently
 *     via a unique tokenized link. When ALL signers have signed, the
 *     envelope flips to 'completed' and stamped PDFs are emailed to
 *     everyone.
 *
 *   - We support 1-N signers (PandaDoc was effectively 1 signer + CC).
 *
 * Public API:
 *   generateSignerToken()                                    \u2192 32-hex
 *   sealSignature({ recordId, signerName, signerEmail, ... }) \u2192 hex seal
 *   verifySignature(sig)                                     \u2192 boolean
 *   getClientIp(req) / getUserAgent(req)                     \u2192 string
 *   appendSignaturePageToPdf({ pdfBase64, envelope, doc })   \u2192 base64 of stamped PDF
 *
 * Storage:
 *   envelopes blob store           keyed `{ownerKey}/{envelopeId}` — envelope JSON
 *   envelope-pdfs blob store       keyed `{ownerKey}/{envelopeId}/{docIdx}` — original PDF base64
 *   envelope-final-pdfs blob store keyed `{ownerKey}/{envelopeId}/{docIdx}` — stamped final PDF base64
 *   envelope-signer-idx blob store keyed by signer token — `{envelopeKey, signerIndex}` for O(1) lookup
 */
import crypto from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

export const TERMSHEET_CONSENT_VERSION = 1;

// Plain-English ESIGN/UETA consent shown to term-sheet signers. Less
// elaborate than the loan-app version because they\u2019re signing a single
// rate sheet, not a full FCRA-regulated application. Same legal basis.
export const TERMSHEET_CONSENT_TEXT = [
  'CONSENT TO USE ELECTRONIC SIGNATURES',
  '',
  'By checking the box below and typing your full legal name, you agree:',
  '',
  '1. ELECTRONIC SIGNATURES. You consent to use electronic signatures to sign the document(s) presented in this signing session. Your electronic signature has the same legal effect as a handwritten signature under the federal Electronic Signatures in Global and National Commerce Act (ESIGN, 15 U.S.C. \u00A7 7001 et seq.) and the Uniform Electronic Transactions Act (UETA) as adopted in your state.',
  '',
  '2. ELECTRONIC RECORDS. You consent to receive the signed document(s) and related notices in electronic form by email at the address provided. You may request paper copies at any time by contacting your loan officer at SLA Capital.',
  '',
  '3. SYSTEM REQUIREMENTS. To receive and view these records you must have a current web browser, a personal email account, and the ability to display or print PDF files.',
  '',
  '4. WITHDRAWING CONSENT. You may withdraw consent at any time by contacting SLA Capital. Withdrawing consent will not affect the validity of records already signed.',
  '',
  '5. ACKNOWLEDGEMENT. You acknowledge that you have read and reviewed each document linked in this signing session before signing.',
].join('\n');

export const TERMSHEET_CONSENT_LABEL =
  'I have reviewed each document above, agree to the ESIGN/UETA Consent, and intend to sign electronically.';

// Generate a cryptographically random URL-safe token. Same shape as
// the borrower-info and borrower-2 tokens (32 hex chars).
export function generateSignerToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getSealSecret() {
  return process.env.ESIGN_SEAL_SECRET || '';
}

// HMAC-seal the signer\u2019s audit fields so they can\u2019t be silently
// tampered with after the fact. Same scheme used by the loan-app eSign
// (esign.mjs). Returns null if no secret configured (caller should
// refuse to sign with a clear 500).
export function sealSignature(audit) {
  const secret = getSealSecret();
  if (!secret) return null;
  const canonical = [
    audit.envelopeId || '',
    audit.signerIndex == null ? '' : String(audit.signerIndex),
    audit.signerName || '',
    audit.signerEmail || '',
    audit.signedAt || '',
    audit.consentVersion || '',
    audit.ipAddress || '',
    audit.userAgent || '',
    audit.docHashes ? audit.docHashes.join(',') : '',
  ].join('|');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

export function verifySignature(audit) {
  if (!audit || !audit.seal) return false;
  const expected = sealSignature(audit);
  if (!expected) return false;
  try {
    return crypto.timingSafeEqual(
      Buffer.from(audit.seal, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (_) { return false; }
}

export function hashPdf(base64) {
  if (!base64) return '';
  return crypto.createHash('sha256').update(base64, 'base64').digest('hex');
}

export function getClientIp(req) {
  if (!req || !req.headers) return '';
  const get = (k) => {
    if (typeof req.headers.get === 'function') return req.headers.get(k) || '';
    return req.headers[k] || req.headers[k.toLowerCase()] || '';
  };
  const nf = get('x-nf-client-connection-ip');
  if (nf) return nf;
  const xff = get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();
  return '';
}

export function getUserAgent(req) {
  if (!req || !req.headers) return '';
  if (typeof req.headers.get === 'function') return req.headers.get('user-agent') || '';
  return req.headers['user-agent'] || '';
}

// SLA brand colors (RGB 0-1 for pdf-lib)
const PLUM       = rgb(0.149, 0.102, 0.212);  // #261A36
const GOLD       = rgb(0.784, 0.506, 0.227);  // #C8813A
const TEXT       = rgb(0.102, 0.082, 0.125);  // #1A1520
const MUTED      = rgb(0.478, 0.455, 0.533);  // #7A7488
const GOLD_LIGHT = rgb(0.961, 0.914, 0.847);  // #F5E9D8

/**
 * Append a "Signatures" page to an existing PDF.
 *
 * Loads the input PDF, adds a new last page containing each signer\u2019s
 * typed signature in script font, name, signed-at, IP, UA, consent
 * version, and audit seal. Returns the new PDF as a base64 string.
 *
 * Used when all signers have completed: we stamp each document in the
 * envelope and store the result as the "final" signed PDF.
 *
 * @param {object} opts
 * @param {string} opts.pdfBase64       Original PDF bytes (no data URI prefix)
 * @param {object} opts.envelope         The envelope record
 * @param {object} opts.doc              The doc within the envelope (for name display)
 * @returns {Promise<string>}            base64 of the stamped PDF
 */
export async function appendSignaturePageToPdf({ pdfBase64, envelope, doc }) {
  const inputBytes = Buffer.from(pdfBase64, 'base64');
  const pdf = await PDFDocument.load(inputBytes, { ignoreEncryption: true });

  const PAGE_W = 612;  // US Letter
  const PAGE_H = 792;
  const MARGIN = 54;

  const helv     = await pdf.embedFont(StandardFonts.Helvetica);
  const helvBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helvObl  = await pdf.embedFont(StandardFonts.HelveticaOblique);
  // pdf-lib\u2019s 14 base fonts don\u2019t include a script. Times-Italic is the
  // best stand-in for a "typed signature" feel without embedding a
  // custom font file (which would bloat the function bundle).
  const timesItalic = await pdf.embedFont(StandardFonts.TimesRomanItalic);
  const times       = await pdf.embedFont(StandardFonts.TimesRoman);

  // Deploy 186: stamp typed signatures onto the original rate sheet\u2019s
  // visible "Borrower Signature: ___ Date: ___" line, using the
  // sigCoords captured by the sizer at PDF-generation time. Without
  // these coordinates the audit page at the end is the only place the
  // signature appears, which surprised LOs ("the signature line is
  // still blank"). We stamp every signer that has signed; for
  // multi-signer envelopes signers stack vertically beneath the line.
  const sigCoords = doc && doc.sigCoords;
  if (sigCoords && sigCoords.pageNumber && sigCoords.pageHeight) {
    const pageIdx = sigCoords.pageNumber - 1;
    const allPages = pdf.getPages();
    const targetPage = allPages[pageIdx] || allPages[allPages.length - 1];
    if (targetPage) {
      const targetHeight = targetPage.getHeight();
      // Convert jsPDF top-left y to pdf-lib bottom-left y.
      const sigYTop  = targetHeight - sigCoords.sigYFromTop;
      const dateYTop = targetHeight - sigCoords.dateYFromTop;

      const signedSigners = (envelope.signers || []).filter(
        (s) => s && s.audit && s.audit.signedAt
      );
      // Render signer 1 on the line (the canonical "Borrower Signature").
      // Additional signers stack BELOW the line so they\u2019re still visible.
      const lineGap = 22;
      signedSigners.forEach((s, idx) => {
        const offset = idx * lineGap;
        const fullName = (s.firstName || '') + ' ' + (s.lastName || '');
        const dateStr = s.audit.signedAt
          ? new Date(s.audit.signedAt).toLocaleDateString('en-US', {
              year: 'numeric', month: 'short', day: 'numeric',
            })
          : '';
        // The typed signature in italic Times (script-like), sized to
        // fit the underline (~14pt looks right for a 188pt line).
        targetPage.drawText(fullName.trim(), {
          x: sigCoords.sigX,
          y: sigYTop - offset,
          size: 14,
          font: timesItalic,
          color: PLUM,
        });
        // Date in Helvetica, smaller, on the date line.
        targetPage.drawText(dateStr, {
          x: sigCoords.dateX,
          y: dateYTop - offset,
          size: 11,
          font: helv,
          color: TEXT,
        });
        // For signers 2+, also label which signer this is so it\u2019s clear
        // when looking at the page that multiple people signed.
        if (idx > 0) {
          targetPage.drawText('Co-Signer ' + (idx + 1) + ':', {
            x: sigCoords.sigX - 92,
            y: sigYTop - offset,
            size: 8,
            font: helv,
            color: MUTED,
          });
        }
      });
    }
  }

  const page = pdf.addPage([PAGE_W, PAGE_H]);

  // Header band
  page.drawRectangle({ x: 0, y: PAGE_H - 70, width: PAGE_W, height: 70, color: PLUM });
  page.drawText('Sir Lends A Lot LLC', {
    x: MARGIN, y: PAGE_H - 42, size: 20, font: times, color: GOLD,
  });
  page.drawText('SLA CAPITAL  \u00B7  ELECTRONIC SIGNATURE PAGE', {
    x: MARGIN, y: PAGE_H - 60, size: 8, font: helv, color: GOLD_LIGHT,
  });
  page.drawRectangle({ x: 0, y: PAGE_H - 72, width: PAGE_W, height: 2, color: GOLD });

  let cursorY = PAGE_H - 100;

  // Title
  const title = 'SIGNED ELECTRONICALLY';
  const titleWidth = times.widthOfTextAtSize(title, 16);
  page.drawText(title, {
    x: (PAGE_W - titleWidth) / 2, y: cursorY,
    size: 16, font: times, color: PLUM,
  });
  cursorY -= 22;
  const subtitle = (doc && doc.name ? doc.name + '  \u00B7  ' : '') +
    'Sir Lends A Lot LLC dba SLA Capital';
  const subWidth = helv.widthOfTextAtSize(subtitle, 9);
  page.drawText(subtitle, {
    x: (PAGE_W - subWidth) / 2, y: cursorY,
    size: 9, font: helv, color: MUTED,
  });
  cursorY -= 30;

  // For each signer, render a signature block
  const signers = (envelope.signers || []).filter((s) => s && s.audit && s.audit.signedAt);
  for (const s of signers) {
    // Sub-header
    page.drawText((s.role === 'borrower' ? 'Borrower' : 'Co-Signer') + ' \u2014 ' + s.firstName + ' ' + s.lastName, {
      x: MARGIN, y: cursorY,
      size: 10, font: helvBold, color: GOLD,
    });
    page.drawLine({
      start: { x: MARGIN, y: cursorY - 4 },
      end: { x: PAGE_W - MARGIN, y: cursorY - 4 },
      thickness: 0.5, color: GOLD,
    });
    cursorY -= 18;

    // Signature box (boxed area with the typed signature in italic Times)
    const sigBoxH = 46;
    page.drawRectangle({
      x: MARGIN, y: cursorY - sigBoxH,
      width: PAGE_W - 2 * MARGIN, height: sigBoxH,
      borderColor: MUTED, borderWidth: 0.7,
    });
    const signatureText = s.firstName + ' ' + s.lastName;
    page.drawText(signatureText, {
      x: MARGIN + 12, y: cursorY - 32,
      size: 22, font: timesItalic, color: PLUM,
    });
    cursorY -= sigBoxH + 6;

    // Caption: typed by ... on ...
    const signedDate = s.audit.signedAt
      ? new Date(s.audit.signedAt).toLocaleString('en-US', {
          year: 'numeric', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
        })
      : 'unknown';
    page.drawText('Typed by ' + signatureText + ' on ' + signedDate, {
      x: MARGIN, y: cursorY,
      size: 8, font: helv, color: MUTED,
    });
    cursorY -= 12;

    // Audit rows
    const auditRows = [
      ['Email',             s.email || ''],
      ['IP address',        s.audit.ipAddress || 'unavailable'],
      ['User agent',        (s.audit.userAgent || '').slice(0, 100)],
      ...(s.audit.geolocation ? [['Geolocation', s.audit.geolocation]] : []),
      ['Consent version',   'v' + s.audit.consentVersion],
      ['Audit seal',        (s.audit.seal || '').slice(0, 32) + '\u2026'],
    ];
    for (const [label, value] of auditRows) {
      page.drawText(label, {
        x: MARGIN, y: cursorY,
        size: 8, font: helv, color: MUTED,
      });
      page.drawText(value, {
        x: MARGIN + 90, y: cursorY,
        size: 8, font: helvBold, color: TEXT,
        maxWidth: PAGE_W - 2 * MARGIN - 95,
      });
      cursorY -= 11;
    }

    cursorY -= 14; // gap between signers
  }

  // Footer disclaimer
  if (cursorY < 100) cursorY = 100; // pin to avoid running off
  const footer =
    'This document was electronically signed in accordance with the federal ESIGN Act ' +
    '(15 U.S.C. \u00A7 7001 et seq.) and applicable state UETA statutes. The audit trail above ' +
    'provides evidence of each signing event. The HMAC seal (computed with a server-side ' +
    'secret) provides tamper-evidence for the audit fields.';
  page.drawText(footer, {
    x: MARGIN, y: 70,
    size: 7.5, font: helvObl, color: MUTED,
    maxWidth: PAGE_W - 2 * MARGIN, lineHeight: 10,
  });

  const out = await pdf.save();
  return Buffer.from(out).toString('base64');
}
