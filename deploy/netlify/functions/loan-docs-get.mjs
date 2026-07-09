/**
 * loan-docs-get.mjs — GET /api/loan-docs-get?id=...&owner=...
 *
 * Deploy 236.119 — return the binary contents of a stored doc
 * along with the proper Content-Type + Content-Disposition for
 * inline view or download. The frontend can either show it in
 * the browser (PDFs) or trigger a download.
 *
 * Query: id, owner (admin override)
 * Optional: ?download=1 sets attachment disposition.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  keySafe, normalizeEmail, corsHeaders,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-docs-get top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const docId      = String(url.searchParams.get('id') || '').trim();
  const ownerParam = String(url.searchParams.get('owner') || '').trim();
  const download   = url.searchParams.get('download') === '1';
  if (!docId) return json(400, { error: 'id required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey = selfKey;
  if (ownerParam && ownerParam !== selfEmail && ownerParam !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
    ownerKey = keySafe(normalizeEmail(ownerParam));
  }

  const metaStore  = getStore({ name: 'loan-docs',       consistency: 'strong' });
  const bytesStore = getStore({ name: 'loan-docs-files', consistency: 'strong' });
  const baseKey = ownerKey + '/' + keySafe(docId);

  const meta = await metaStore.get(baseKey + '.json', { type: 'json' });
  if (!meta) return json(404, { error: 'Document not found' });

  // get() with { type: 'arrayBuffer' } returns raw bytes.
  const buf = await bytesStore.get(baseKey, { type: 'arrayBuffer' });
  if (!buf) return json(404, { error: 'Document bytes missing (metadata exists but file gone)' });

  const headers = Object.assign({}, corsHeaders(), {
    'Content-Type':   meta.mimeType || 'application/octet-stream',
    'Content-Length': String(buf.byteLength),
    'Content-Disposition':
      (download ? 'attachment' : 'inline') +
      '; filename="' + String(meta.filename || 'document').replace(/[^\w.\-]+/g, '_') + '"',
    'Cache-Control': 'private, max-age=0, must-revalidate',
  });
  return new Response(buf, { status: 200, headers });
}
