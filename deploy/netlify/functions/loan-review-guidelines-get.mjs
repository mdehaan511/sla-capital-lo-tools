/**
 * loan-review-guidelines-get.mjs — GET /api/loan-review-guidelines-get?investor=diya
 *
 * Super-admin only download — useful so the admin page can show
 * "preview / verify" of what's currently stored. Streams the raw PDF
 * inline so the browser renders it.
 *
 * NOTE: this is NOT how the AI helper accesses the bytes. The AI
 * upload handler uses _shared/investor-guidelines.mjs which reads
 * directly from the blob store via getStore() — no HTTP round-trip.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isSuperAdmin, corsHeaders,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });
  const investor = new URL(req.url).searchParams.get('investor');
  if (!investor) return json(400, { error: 'investor required' });
  const store = getStore({ name: 'loan-review-guidelines', consistency: 'strong' });
  const r = await store.getWithMetadata(String(investor).toLowerCase().trim(), { type: 'arrayBuffer' });
  if (!r || !r.data) return json(404, { error: 'Not found' });
  const meta = r.metadata || {};
  return new Response(r.data, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type':        'application/pdf',
      'Content-Disposition': 'inline; filename="' + String(meta.filename || investor + '.pdf').replace(/"/g, "'") + '"',
      'Cache-Control':       'private, no-cache',
    },
  });
}
