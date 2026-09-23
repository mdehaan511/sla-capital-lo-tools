/**
 * envelope-consent.mjs — GET /api/envelope-consent
 *
 * Public, no auth. Returns the current term-sheet ESIGN/UETA consent
 * text + version + checkbox label for the term-sheet signing page.
 * Same pattern as /api/esign-consent (loan-app side).
 */
import { handleOptions, json } from './_shared/auth.mjs';
import {
  TERMSHEET_CONSENT_VERSION, TERMSHEET_CONSENT_TEXT, TERMSHEET_CONSENT_LABEL,
} from './_shared/native-esign.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';
// Deploy 237.256 -- the Loan Application's own consent package, shown on the signer page when
// the envelope carries the application (term-sheet-sign.html reads INFO.docs[].kind).
import {
  ESIGN_CONSENT_VERSION, ESIGN_CONSENT_TEXT, LOAN_ACKNOWLEDGEMENT_TEXT, PREQUAL_CREDIT_AUTH_TEXT, INFO_RELEASE_AUTH_TEXT,
  ESIGN_CHECKBOX_LABEL, LOAN_ACK_CHECKBOX_LABEL, PREQUAL_CHECKBOX_LABEL, INFO_RELEASE_CHECKBOX_LABEL,
} from './_shared/esign.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const _rl = await checkRateLimit(req, context, { bucket: 'env-consent', max: 60, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }
  return json(200, {
    version: TERMSHEET_CONSENT_VERSION,
    text: TERMSHEET_CONSENT_TEXT,
    checkboxLabel: TERMSHEET_CONSENT_LABEL,
    application: { // Deploy 237.256
      version: ESIGN_CONSENT_VERSION,
      sections: [
        { key: 'esign',   title: 'Loan Application \u2014 Electronic Signature Consent', text: ESIGN_CONSENT_TEXT,        checkboxLabel: ESIGN_CHECKBOX_LABEL },
        { key: 'ack',     title: 'Loan Application \u2014 Acknowledgement and Agreement', text: LOAN_ACKNOWLEDGEMENT_TEXT, checkboxLabel: LOAN_ACK_CHECKBOX_LABEL },
        { key: 'prequal', title: 'Credit Authorization',                              text: PREQUAL_CREDIT_AUTH_TEXT,   checkboxLabel: PREQUAL_CHECKBOX_LABEL },
        { key: 'release', title: 'Information Release Authorization',                 text: INFO_RELEASE_AUTH_TEXT,     checkboxLabel: INFO_RELEASE_CHECKBOX_LABEL },
      ],
    },
  });
};
