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
} from './_shared/esign.mjs';

export default async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  return json(200, {
    version: ESIGN_CONSENT_VERSION,
    text: ESIGN_CONSENT_TEXT,
    checkboxLabel: ESIGN_CHECKBOX_LABEL,
  });
};
