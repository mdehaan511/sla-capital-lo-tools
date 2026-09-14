/**
 * esign-sign-pdf.mjs — GET /api/esign-sign-pdf?t=<token>
 *
 * Deploy 237.022 (Mike): PUBLIC. Streams the ORIGINAL PDF to the signer page,
 * which renders it with pdf.js and overlays the fields. After completion the
 * same link streams the EXECUTED copy so a signer who re-opens their email
 * sees the finished document.
 */
import { json, handleOptions } from './_shared/auth.mjs';
import { checkRateLimit } from './_shared/rate-limit.mjs';
import { lookupByToken, docPdfStore, docFinalStore, docKey, safeFilename } from './_shared/esign-docs.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const rl = await checkRateLimit(req, context, { bucket: 'esign-sign-pdf', max: 60, windowSec: 300 });
    if (!rl.allowed) return json(429, { error: 'Too many requests' });
    const url = new URL(req.url);
    const found = await lookupByToken(url.searchParams.get('t') || '');
    if (!found) return json(404, { error: 'Signing link not found' });
    const { doc } = found;
    const key = docKey(doc.ownerKey, doc.id);
    let b64 = null;
    if (doc.status === 'completed') b64 = await docFinalStore().get(key, { type: 'text' }).catch(() => null);
    if (!b64) b64 = await docPdfStore().get(key, { type: 'text' }).catch(() => null);
    if (!b64) return json(404, { error: 'PDF not on file' });
    const bytes = Buffer.from(b64, 'base64');
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(bytes.length),
        'Content-Disposition': 'inline; filename="' + safeFilename(doc.title) + '.pdf"',
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (e) {
    console.error('esign-sign-pdf error:', e);
    return json(500, { error: 'Server error' });
  }
};
