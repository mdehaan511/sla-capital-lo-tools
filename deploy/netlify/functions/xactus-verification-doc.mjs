/**
 * xactus-verification-doc.mjs — GET /api/xactus-verification-doc
 *
 * Deploy 236.779 — download the stored PDF for a verification record
 * (credit report / flood cert). Used by the Client page for pulls with
 * no loan (loan-context PDFs also live in the loan's Doc Review tray).
 *
 * Query: ?id=v_...&owner=...
 * Auth: processor/admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('xactus-verification-doc error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const url = new URL(req.url);
  const id = url.searchParams.get('id') || '';
  const owner = url.searchParams.get('owner') || '';
  if (!/^v_[a-z0-9_]+$/i.test(id)) return json(400, { error: 'valid id required' });

  const ownerKey = owner ? keySafe(normalizeEmail(owner)) : keySafe(normalizeEmail(user.email));
  const store = getStore({ name: 'verification-docs', consistency: 'strong' });
  const r = await store.getWithMetadata(ownerKey + '/' + id, { type: 'arrayBuffer' });
  if (!r || !r.data) return json(404, { error: 'Document not found' });
  const filename = (r.metadata && r.metadata.filename) || (id + '.pdf');
  return new Response(Buffer.from(r.data), {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="' + String(filename).replace(/"/g, '') + '"',
    },
  });
}
