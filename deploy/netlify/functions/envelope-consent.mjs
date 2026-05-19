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

export default async (req) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  return json(200, {
    version: TERMSHEET_CONSENT_VERSION,
    text: TERMSHEET_CONSENT_TEXT,
    checkboxLabel: TERMSHEET_CONSENT_LABEL,
  });
};
