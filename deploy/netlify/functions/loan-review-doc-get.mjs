/**
 * loan-review-doc-get.mjs — GET /api/loan-review-doc-get?reviewId=...&docId=...
 *
 * Streams the raw document bytes back to the browser so the processor
 * can re-view what they uploaded earlier (e.g. when continuing a
 * review after a few days). The browser will render the PDF inline
 * via the native viewer when Content-Disposition is inline.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, keySafe, corsHeaders,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-review-doc-get error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const url = new URL(req.url);
  const reviewId = url.searchParams.get('reviewId');
  const docId = url.searchParams.get('docId');
  if (!reviewId || !docId) return json(400, { error: 'reviewId and docId required' });

  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  const key = keySafe(reviewId) + '/' + keySafe(docId);
  const result = await docsStore.getWithMetadata(key, { type: 'arrayBuffer' });
  if (!result || !result.data) return json(404, { error: 'Doc not found' });

  const meta = result.metadata || {};
  const mimeType = meta.mimeType || 'application/pdf';
  const filename = meta.filename || (docId + '.pdf');

  return new Response(result.data, {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': mimeType,
      'Content-Disposition': 'inline; filename="' + filename.replace(/"/g, "'") + '"',
      'Cache-Control': 'private, no-cache',
    },
  });
}
