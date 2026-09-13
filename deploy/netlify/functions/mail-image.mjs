/**
 * mail-image.mjs — GET /api/mail-image?id=&kind=envelope|scan
 *
 * Deploy 236.995 (Mike, mail room). Serves OUR stored copy of a mail piece's
 * envelope image or content scan (Stable's own URLs are temporary). The page
 * fetches with the bearer token and renders via an object URL.
 *
 * Auth: mail-room access (office assistant / processor / admin).
 */
import { handleOptions, json, requireAuth, canWorkMail } from './_shared/auth.mjs';
import { mailStore, safeId } from './_shared/mail-store.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canWorkMail(user)) return json(403, { error: 'Mail room access required' });

  const url = new URL(req.url);
  const id = String(url.searchParams.get('id') || '');
  const kind = url.searchParams.get('kind') === 'scan' ? 'scan' : 'envelope';
  if (!id) return json(400, { error: 'id required' });

  try {
    const got = await mailStore().getWithMetadata('img/' + safeId(id) + '/' + kind, { type: 'arrayBuffer' });
    if (!got || !got.data) return json(404, { error: 'No ' + kind + ' image stored for this piece' });
    return new Response(Buffer.from(got.data), {
      status: 200,
      headers: {
        'Content-Type': (got.metadata && got.metadata.contentType) || 'application/octet-stream',
        'Cache-Control': 'private, max-age=300',
      },
    });
  } catch (e) {
    return json(500, { error: 'Image read failed: ' + ((e && e.message) || 'unknown') });
  }
};
