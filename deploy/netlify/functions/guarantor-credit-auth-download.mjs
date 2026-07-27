/**
 * guarantor-credit-auth-download.mjs — GET /api/guarantor-credit-auth-download?t=<token>
 *
 * Deploy 236.129 — public, token-keyed download of the signed
 * Credit Authorization PDF for an additional-guarantor sub-form.
 * Token is generated server-side when the guarantor's client
 * record is created (borrower-info-sign) and stored in the
 * guarantor-subform-token-idx. The signed PDF lives in the
 * guarantor-credit-auth-pdfs blob store keyed by the same token.
 *
 * Optional: ?download=1 forces attachment Content-Disposition,
 * otherwise it's inline (so a browser PDF viewer opens it).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, corsHeaders } from './_shared/auth.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('guarantor-credit-auth-download top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const _rl = await checkRateLimit(req, null, { bucket: 'gcredit-dl', max: 60, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  const url = new URL(req.url);
  const token = String(url.searchParams.get('t') || '').trim();
  const download = url.searchParams.get('download') === '1';
  if (!token) return json(400, { error: 'Missing token' });

  // Verify the token exists (rejects random guesses).
  const idxStore = getStore({ name: 'guarantor-subform-token-idx', consistency: 'strong' });
  let idx;
  try { idx = await idxStore.get(token, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read token index' }); }
  if (!idx) return json(404, { error: 'Invalid or expired link' });

  const pdfStore = getStore({ name: 'guarantor-credit-auth-pdfs', consistency: 'strong' });
  const buf = await pdfStore.get(token, { type: 'arrayBuffer' });
  if (!buf) return json(404, { error: 'No signed Credit Authorization on file yet' });

  const filename = 'credit-auth-' + idx.clientId.slice(0, 12) + '.pdf';
  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':   'application/pdf',
    'Content-Length': String(buf.byteLength),
    'Content-Disposition':
      (download ? 'attachment' : 'inline') + '; filename="' + filename + '"',
    'Cache-Control': 'private, max-age=0, must-revalidate',
  });
  return new Response(buf, { status: 200, headers });
}
