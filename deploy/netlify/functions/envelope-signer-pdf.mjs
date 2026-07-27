/**
 * envelope-signer-pdf.mjs — GET /api/envelope-signer-pdf
 *
 * Public endpoint (token-based). Streams one of the envelope\u2019s PDFs
 * to the signer for review on the signing page (via iframe). Reads
 * from envelope-pdfs (pre-stamp) BEFORE all signers are done. Once
 * all signers have signed, the signing page no longer applies \u2014
 * signers get the final stamped copy via email.
 *
 * Query: ?t=TOKEN&doc=INDEX
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json } from './_shared/auth.mjs';
// Deploy 236.445 (Hardening F1) — abuse ceiling on this public endpoint.
import { checkRateLimit } from './_shared/rate-limit.mjs';
import { lookupEnvelopeByToken } from './envelope-signer-info.mjs';

export default async (req) => {
  try { return await handle(req); }
  catch (e) {
    console.error('envelope-signer-pdf error:', e);
    return json(500, { error: 'Server error' });
  }
};

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const _rl = await checkRateLimit(req, null, { bucket: 'env-pdf', max: 60, windowSec: 300 });
  if (!_rl.allowed) {
    return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: _rl.retryAfterSec });
  }

  const url = new URL(req.url);
  const token  = url.searchParams.get('t');
  const docIdx = parseInt(url.searchParams.get('doc') || '0', 10);
  if (!token) return json(400, { error: 'Missing token' });

  const found = await lookupEnvelopeByToken(token);
  if (!found) return json(404, { error: 'Signing link not found' });
  const { envelope } = found;

  if (!envelope.docs || !envelope.docs[docIdx]) {
    return json(404, { error: 'Document not found' });
  }

  const pdfStore = getStore({ name: 'envelope-pdfs', consistency: 'strong' });
  const pdfKey = `${envelope.ownerKey}/${envelope.id}/${docIdx}`;
  let b64;
  try { b64 = await pdfStore.get(pdfKey); }
  catch (_) { b64 = null; }
  if (!b64) return json(404, { error: 'PDF bytes not on file' });

  const pdfBytes = Buffer.from(b64, 'base64');
  const safeName = (envelope.docs[docIdx].name || 'document')
    .replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 80);
  return new Response(pdfBytes, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(pdfBytes.length),
      // inline so iframe renders it; signer can also download
      'Content-Disposition': `inline; filename="${safeName}.pdf"`,
      'Cache-Control': 'private, no-cache',
    },
  });
}
