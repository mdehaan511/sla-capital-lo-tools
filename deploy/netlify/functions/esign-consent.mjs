/**
 * esign-consent.mjs — GET /api/esign-consent
 *
 * Deploy 179. Public, no auth required. Returns the current ESIGN/UETA
 * consent text + version + checkbox label so the borrower-side signing
 * page renders whatever the server considers authoritative. This means
 * changing consent text only requires a backend deploy — the frontend
 * always renders the current version and the server validates the
 * version stamped on each signature event.
 */
import { handleOptions, json } from './_shared/auth.mjs';
import {
  ESIGN_CONSENT_VERSION, ESIGN_CONSENT_TEXT, ESIGN_CHECKBOX_LABEL,
  LOAN_ACKNOWLEDGEMENT_TEXT, LOAN_ACK_CHECKBOX_LABEL,
  PREQUAL_CREDIT_AUTH_TEXT, PREQUAL_CHECKBOX_LABEL,
  INFO_RELEASE_AUTH_TEXT, INFO_RELEASE_CHECKBOX_LABEL,
} from './_shared/esign.mjs';

export default async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  return json(200, {
    version: ESIGN_CONSENT_VERSION,
    // Backwards-compat fields used by borrower-info.html\u2019s Deploy 179 UI
    text: ESIGN_CONSENT_TEXT,
    checkboxLabel: ESIGN_CHECKBOX_LABEL,
    // Full multi-form set (Deploy 180): each form has text + label
    esignText: ESIGN_CONSENT_TEXT,
    esignLabel: ESIGN_CHECKBOX_LABEL,
    loanAckText: LOAN_ACKNOWLEDGEMENT_TEXT,
    loanAckLabel: LOAN_ACK_CHECKBOX_LABEL,
    prequalText: PREQUAL_CREDIT_AUTH_TEXT,
    prequalLabel: PREQUAL_CHECKBOX_LABEL,
    infoReleaseText: INFO_RELEASE_AUTH_TEXT,
    infoReleaseLabel: INFO_RELEASE_CHECKBOX_LABEL,
  });
};
