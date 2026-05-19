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

// Bump this version any time ANY consent/auth text changes. Existing
// signed records keep their original version stamp. The version stamp
// is on the whole package (ESIGN consent + loan ack + prequal auth +
// info release auth) — bump it on any change to any of them.
export const ESIGN_CONSENT_VERSION = 2;

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
  '7. ACKNOWLEDGEMENT. You acknowledge that you have read and understood this consent in its entirety before signing.',
].join('\n');

// Loan Application Acknowledgement & Agreement — the long 11-point
// representation and acknowledgement of the borrower (from the SLA
// Loan Application docx). Independent of the e-signature consent
// above. Each guarantor must agree to this when signing the
// application.
export const LOAN_ACKNOWLEDGEMENT_TEXT = [
  'ACKNOWLEDGEMENT AND AGREEMENT',
  '',
  'The Borrower (or Co-Borrower), and Guarantor (or Co-Guarantor) — each of the undersigned — represents to Sir Lends A Lot, LLC ("Sir Lends A Lot") and to Sir Lends A Lot\u2019s actual or potential agents, brokers, processors, attorneys, insurers, servicers, successors and assigns and agrees and acknowledges that:',
  '',
  '(1) neither Sir Lends A Lot nor its agents, brokers, insurers, servicers, successors or assigns has made any representation or warranty, express or implied, to me regarding the property or the condition or value of the property;',
  '',
  '(2) the loan requested pursuant to this application (the "Loan") will be secured by a mortgage or deed of trust on the property or properties described in this application;',
  '',
  '(3) the property will not be used for any illegal or prohibited purpose or use;',
  '',
  '(4) all statements made in this application are made for the purpose of obtaining a commercial mortgage loan;',
  '',
  '(5) the property will be occupied or not occupied as indicated in this application;',
  '',
  '(6) Sir Lends A Lot, its servicers, successors or assigns are given my (our) consent to retain the original and/or an electronic record of this application, whether or not the Loan is approved;',
  '',
  '(7) Sir Lends A Lot and its agents, brokers, insurers, servicers, successors, and assigns may continuously rely on the information contained in the application, and I am obligated to and agree to amend and/or supplement the information provided in this application if any of the material facts that I have represented herein should change prior to closing of the Loan;',
  '',
  '(8) I understand and acknowledge that, in the event that my payments on the Loan become delinquent, Sir Lends A Lot, its servicers, successors or assigns may, in addition to any other rights and remedies that it may have relating to such delinquency, report my name and account information to one or more consumer reporting agencies;',
  '',
  '(9) I understand and acknowledge that ownership of the Loan and/or administration or servicing of the Loan account may be transferred with such notice as may be required by law;',
  '',
  '(10) my transmission of this application as an "electronic record" containing my "electronic signature," as those terms are defined in applicable federal and/or state laws (excluding audio and video recordings), or my facsimile transmission of this application containing a facsimile of my signature, shall be as effective, enforceable and valid as if a paper version of this application were delivered containing my original written signature pursuant to applicable law; and',
  '',
  '(11) I further represent, covenant, and warrant that the information provided in this application is true and correct as of the date set forth opposite my signature and that any intentional or negligent misrepresentation of the information in this application may result in civil liability, including monetary damages, to any person who may suffer any loss due to reliance upon any misrepresentation that I have made on this application.',
  '',
  'The Borrower (or Co-Borrower) and Guarantor (or Co-Guarantor) acknowledges and agrees that Sir Lends A Lot may assign, transfer or hypothecate this Loan opportunity to another lender or funding source and to that end, share the information in this application with other lenders and investors in furtherance of closing the requested Loan. Each of the undersigned hereby acknowledges that any owner of the Loan, its servicers, successors and assigns, may verify or re-verify any information contained in this application or obtain any information or data relating to the Loan, for any legitimate business purpose through any source, including a source named in this application or a consumer reporting agency.',
  '',
  'Each of the undersigned understands that by signing this application, hereby authorizes Sir Lends A Lot, LLC, or its assigns on its own or through its service provider to conduct (1) a consumer credit report to verify other credit information, including past and present mortgage and landlord references; (2) a background investigation report and verify both criminal and civil records; and (3) order an appraisal to determine the property\u2019s value and charge you for this appraisal. It is understood that a copy of this application serves as authorization to conduct these checks and that the information gathered is in connection with a credit transaction involving myself and/or my company, as applicable. The information Sir Lends A Lot, LLC obtains is only to be used in conjunction with this application for the Loan, or for the collection of an account on a closed loan.',
  '',
  'I further understand that any expenses incurred by me or others in pursuit of this Loan, whether paid to Lender or a third party, is not refundable or reimbursable for any reason by Lender, including without limitation, appraisals, inspections, or any third-party review services. The closing of a Loan is subject to all applicable terms and conditions, and subject at all times to force majeure events.',
  '',
  'Appraisal Notice: We will promptly give you a copy of the appraisal utilized to evaluate the Application in accordance with 12 CFR Part 1002, even if your loan does not close. You may pay for an additional appraisal for your own use at your own cost.',
  '',
  'Privacy Act Notice: This request for personal identifying information and other required information is to be used and stored by Commercial Lender or its assignees in determining whether you qualify as a prospective mortgagor under its program and in order to verify identities as required by federal law. It will not be disclosed outside the agency except as required and permitted by law. You do not have to provide this information, but if you do not your application for approval as a prospective mortgagor or sponsor may be delayed or rejected.',
].join('\n');

// FCRA Prequal Credit & Background Check Authorization. Each
// guarantor signs this individually — borrower 2 cannot be authorized
// by borrower 1 (FCRA requires the consumer\u2019s own affirmative
// consent to pull their report).
export const PREQUAL_CREDIT_AUTH_TEXT = [
  'AUTHORIZATION TO CONDUCT PREQUAL CREDIT & BACKGROUND CHECKS',
  '',
  'By signing this form, you are providing \u2018written instructions\u2019 to Sir Lends A Lot LLC, affiliates and other loan participants, collectively referred to as "Lender," under the Fair Credit Reporting Act authorizing Lender to obtain from your personal credit profile or other information. You authorize Lender to obtain such information solely to conduct a pre-qualification for credit.',
  '',
  'I acknowledge that as an individual there are various Federal and/or State laws such as the "Fair Credit Reporting Act" that control the issuance or use of "consumer reports" and/or "investigative consumer reports" by Lender. I understand that I am not obligated to provide creditor this authorization to review such "consumer reports" and/or "investigative consumer reports". However, I have voluntarily agreed that such reports can be released to Lender.',
  '',
  'The undersigned hereby authorizes Lender to procure an investigation, or cause an investigation to be procured, whether or not subject to the Fair Credit Reporting Act. I authorize, without reservation, any person or entity contacted by creditor or anyone acting on its behalf, to furnish information regarding verification of my social security number, education, military record, motor vehicle reports, credit history, financial account balance and history, professional licensures, public records, criminal record and/or employment references.',
  '',
  'I understand that it is a federal crime, punishable by fine, imprisonment, or both, to knowingly make any false statements when applying for this commercial business purpose mortgage, as applicable under the provisions of title 18, United States code, 1014. I also understand that Lender intends to use data obtained through other parties except as otherwise authorized above.',
].join('\n');

// Authorization to Release Information — used to obtain underwriting
// docs (insurance, tax, deposit verifications, etc.) from third
// parties. Each guarantor signs this individually.
export const INFO_RELEASE_AUTH_TEXT = [
  'AUTHORIZATION TO RELEASE INFORMATION',
  '',
  'To Whom It May Concern:',
  '',
  '1. I/We have applied for a mortgage loan from Sir Lends A Lot LLC DBA SLA Capital ("Lender"). As part of the application process, we agree to release any and all information the Lender and/or Investors connected to the Lender may request in order to verify information contained in my/our loan application.',
  '',
  'I/We agree to allow the release of any documents required in connection with the loan, either before the loan is closed or as part of its quality control program, including but not limited to mortgage/loan information, insurance information, tax information, verification of sources for large deposits, and any information to bring clarity to legal, financial, or personal inquiries that may appear on my credit and background checks.',
  '',
  '2. I/We understand and agree that the Lender reserves the right to change the mortgage loan review process and documentation required at any time. This may include verifying additional information provided on the application and/or uncovered upon reviewing documentation submitted during the loan process.',
  '',
  '3. The Lender or any investor that purchases the mortgage may use this authorization to request additional information throughout the loan application process as well as the lifetime of the loan.',
  '',
  '4. A copy of this authorization may be accepted as an original.',
  '',
  '5. Your prompt reply to the lender or the investor that purchased the mortgage is appreciated.',
].join('\n');

// Labels for the individual consent checkboxes. The borrower must
// affirmatively check each one. We use per-form checkboxes (not a
// single combined "I agree to everything" box) because that\u2019s the
// safer pattern for multi-document consent — each form has its own
// scope and the borrower\u2019s acknowledgement of each is independently
// auditable.
export const ESIGN_CHECKBOX_LABEL =
  'I have read and agree to the ESIGN/UETA Consent to Use Electronic Signatures and Records above.';
export const LOAN_ACK_CHECKBOX_LABEL =
  'I have read and agree to the Loan Application Acknowledgement and Agreement above, and certify that all information in this Loan Application is true and accurate to the best of my knowledge.';
export const PREQUAL_CHECKBOX_LABEL =
  'I authorize Sir Lends A Lot LLC to obtain my consumer credit report and conduct background checks for the purpose of this loan application.';
export const INFO_RELEASE_CHECKBOX_LABEL =
  'I authorize Sir Lends A Lot LLC to obtain and release information necessary to verify my loan application throughout the loan process.';

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
// signer\u2019s typed name, the data hash, the timestamp, the consent
// version, IP, user-agent, and the list of auths the signer agreed
// to so tampering with any of those fields after the fact will be
// detectable.
export function sealAudit(audit) {
  const secret = getSealSecret();
  if (!secret) return null;
  // signedAuths is sorted before being added to the canonical string
  // so reordering can\u2019t be used to change the seal scope.
  const auths = Array.isArray(audit.signedAuths)
    ? audit.signedAuths.slice().sort().join(',')
    : '';
  const canonical = [
    audit.recordId || '',
    audit.signerName || '',
    audit.signerEmail || '',
    audit.dataHash || '',
    audit.signedAt || '',
    audit.consentVersion || '',
    audit.ipAddress || '',
    audit.userAgent || '',
    auths,
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

// Generate a cryptographically random URL-safe token for the
// borrower-2 signing flow. Same shape as the borrower-info tokens
// (32 hex chars) to keep the URL pattern consistent. Stored in the
// signed_applications record + indexed in borrower2_token_idx for
// O(1) lookups.
export function generateBorrower2Token() {
  return crypto.randomBytes(16).toString('hex');
}
