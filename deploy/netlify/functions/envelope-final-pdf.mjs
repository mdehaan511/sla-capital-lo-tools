/**
 * envelope-final-pdf.mjs — GET /api/envelope-final-pdf
 *
 * NATIVE eSIGN \u2014 Deploy 185. LO-authed endpoint to download a stamped
 * final PDF from a completed envelope.
 *
 * Query: ?envelopeId=...&doc=INDEX&owner=...
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    const url = new URL(req.url);
    const envelopeId = url.searchParams.get('envelopeId');
    const docIdx = parseInt(url.searchParams.get('doc') || '0', 10);
    const ownerOverride = url.searchParams.get('owner');

    if (!envelopeId) return json(400, { error: 'envelopeId required' });

    let owner = normalizeEmail(user.email);
    if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
    const ownerKey = keySafe(owner);

    const envStore = getStore({ name: 'envelopes', consistency: 'strong' });
    let env;
    try { env = await envStore.get(`${ownerKey}/${envelopeId}`, { type: 'json' }); }
    catch (_) { env = null; }
    if (!env) return json(404, { error: 'Envelope not found' });
    if (env.requesterEmail !== normalizeEmail(user.email) && !isAdmin(user)) {
      return json(403, { error: 'Not authorized' });
    }
    if (env.status !== 'completed') {
      return json(400, { error: 'Envelope is not completed yet (status: ' + env.status + ')' });
    }
    if (!env.docs || !env.docs[docIdx]) return json(404, { error: 'Doc index out of range' });

    const finalStore = getStore({ name: 'envelope-final-pdfs', consistency: 'strong' });
    const b64 = await finalStore.get(`${ownerKey}/${envelopeId}/${docIdx}`);
    if (!b64) return json(404, { error: 'Final PDF not on file' });

    const pdfBytes = Buffer.from(b64, 'base64');
    const safeName = (env.docs[docIdx].name || 'document')
      .replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 80);
    return new Response(pdfBytes, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': String(pdfBytes.length),
        'Content-Disposition': `attachment; filename="${safeName}_Signed.pdf"`,
        'Cache-Control': 'private, no-cache',
      },
    });
  } catch (e) {
    console.error('envelope-final-pdf error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};
