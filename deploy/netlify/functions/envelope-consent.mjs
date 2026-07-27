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
  });
};
