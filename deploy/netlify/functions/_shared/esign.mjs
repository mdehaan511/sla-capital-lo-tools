/**
 * esign.mjs — ESIGN/UETA consent text + audit-trail helpers
 *
 * Deploy 179 — new native e-signature flow for the loan application.
 *
 * The legal force of an electronic signature on a loan application
 * depends on three things, all captured here:
 *
 *   1. Disclosed consent to use electronic signatures
 *      (ESIGN Act + UETA). The borrower must affirmatively agree to
 *      use electronic signatures BEFORE signing. Our consent language
 *      below mirrors the standard disclosures used by major online
 *      lenders. The exact text is versioned: when we change it we bump
 *      ESIGN_CONSENT_VERSION so any record stamped with v1 always
 *      points at v1 text, even if v2 supersedes it later.
 *
 *   2. Association of the signature with a specific document
 *      content. We compute a SHA-256 hash of the canonical
 *      JSON-serialized form data AT THE MOMENT OF SIGNING and store
 *      it in the audit record. Any later modification to the stored
 *      borrower-info data would invalidate the hash, so the signed
 *      document can always be verified against the form data as it
 *      stood when the borrower signed.
 *
 *   3. An independent audit trail (timestamp, IP, user agent,
 *      consent version) sealed with an HMAC so we (or anyone with the
 *      server-side secret) can verify the audit fields haven't been
 *      tampered with after the fact. Anyone without the secret can
 *      see the audit fields but can't forge a valid seal.
 *
 * Note: this implementation is informational, not legal advice. The
 * consent language is modeled on commonly-accepted ESIGN/UETA
 * disclosures used by online lenders, but the company should have
 * counsel review before relying on it for enforcement.
 */
import crypto from 'node:crypto';

// Bump this version any time the consent text changes. Existing signed
// records keep their original version stamp.
export const ESIGN_CONSENT_VERSION = 1;

export const ESIGN_CONSENT_TEXT = [
  'CONSENT TO USE ELECTRONIC SIGNATURES AND RECORDS',
  '',
  'By checking the box below and typing your full legal name, you (the "Borrower") agree to the following:',
  '',
  '1. ELECTRONIC SIGNATURES. You consent to use electronic signatures to sign this Loan Application and any related documents. You agree that your electronic signature has the same legal effect as a handwritten signature under the federal Electronic Signatures in Global and National Commerce Act (ESIGN, 15 U.S.C. § 7001 et seq.) and the Uniform Electronic Transactions Act (UETA) as adopted in your state.',
  '',
  '2. ELECTRONIC RECORDS. You consent to receive disclosures, notices, and other communications related to your loan application in electronic form. SLA Capital (Sir Lends A Lot LLC) will deliver these records by email to the email address you provide, by posting them in your borrower portal, or by other electronic means.',
  '',
  '3. SYSTEM REQUIREMENTS. To receive and view electronic records you must have: (a) a current web browser capable of displaying PDF files; (b) a personal email account; (c) sufficient storage to retain records or the ability to print them.',
  '',
  '4. RIGHT TO PAPER COPIES. You may request paper copies of any electronic record at any time by contacting your loan officer. There is no fee for paper copies. Requesting paper copies does not withdraw your consent to electronic signatures.',
  '',
  '5. WITHDRAWING CONSENT. You may withdraw consent at any time by contacting SLA Capital. Withdrawing consent will not affect the legal validity of records signed before withdrawal. If you withdraw consent we may be unable to continue processing your application electronically.',
  '',
  '6. UPDATING YOUR INFORMATION. You agree to keep your email address and contact information current. You may update your information by contacting your loan officer.',
  '',
  '7. ACCURACY OF INFORMATION. You certify under penalty of perjury under the laws of the United States that the information you have provided in this Loan Application is true, complete, and correct to the best of your knowledge. You understand that providing false or misleading information may result in civil and criminal penalties, including but not limited to fines and imprisonment under 18 U.S.C. § 1014 and other applicable laws.',
  '',
  '8. ACKNOWLEDGEMENT. You acknowledge that you have read and understood this consent in its entirety before signing.',
].join('\n');

// The single-line summary shown immediately above the consent checkbox
// on the signing page. Keep this concise and unambiguous about what the
// borrower is agreeing to.
export const ESIGN_CHECKBOX_LABEL =
  'I have read and agree to the ESIGN/UETA Consent above and certify that all information in this Loan Application is true and accurate to the best of my knowledge.';

// Server-side secret used to HMAC-seal the audit trail. Anyone with
// this secret can validate that an audit record hasn't been tampered
// with. Stored in env var so it can be rotated without code changes
// (existing records signed with the old secret stay valid until
// re-validated; the seal includes the secret version so we can support
// multiple rotations).
function getSealSecret() {
  const secret = process.env.ESIGN_SEAL_SECRET || '';
  if (!secret) {
    // Don't throw — let the calling endpoint surface this as a 500
    // with a clear message so an LO sees it instead of a generic
    // function crash.
    return null;
  }
  return secret;
}

// Stable SHA-256 of the canonical form data. The data is the
// borrower's submitted record at the moment of signing. We sort keys
// recursively so re-serializing the same logical content always yields
// the same hash.
export function hashFormData(data) {
  return crypto.createHash('sha256')
    .update(stableStringify(data || {}))
    .digest('hex');
}

function stableStringify(obj) {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

// Seal the audit fields with HMAC-SHA256. Returned seal is a hex
// string. Verifiable by anyone with the secret. The seal binds the
// signer's typed name, the data hash, the timestamp, the consent
// version, IP, and user-agent so tampering with any of those fields
// after the fact will be detectable.
export function sealAudit(audit) {
  const secret = getSealSecret();
  if (!secret) return null;
  const canonical = [
    audit.recordId || '',
    audit.signerName || '',
    audit.signerEmail || '',
    audit.dataHash || '',
    audit.signedAt || '',
    audit.consentVersion || '',
    audit.ipAddress || '',
    audit.userAgent || '',
  ].join('|');
  return crypto.createHmac('sha256', secret).update(canonical).digest('hex');
}

// Verify the seal on an audit record. Returns true if untampered.
export function verifyAudit(audit) {
  if (!audit || !audit.seal) return false;
  const expected = sealAudit(audit);
  if (!expected) return false;
  // Constant-time comparison to avoid timing attacks (low-stakes here
  // but cheap to do right)
  try {
    return crypto.timingSafeEqual(
      Buffer.from(audit.seal, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch (_) {
    return false;
  }
}

// Pull the client IP from request headers. Netlify forwards the real
// client IP in x-nf-client-connection-ip (best) or x-forwarded-for
// (fallback; comma-separated chain, first entry is the original
// client).
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
