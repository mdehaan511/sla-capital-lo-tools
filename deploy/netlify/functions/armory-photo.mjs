/**
 * armory-photo.mjs — GET /api/armory-photo?id=<pin>&e=<exp>&s=<sig>
 *
 * Deploy 237.191 — serves one cork-board photo. Deliberately NOT behind
 * requireAuth: an <img> tag cannot send a bearer token, so the URL itself is
 * the credential — an HMAC over the pin id and an expiry, signed with
 * ESIGN_SEAL_SECRET and minted fresh by armory-board on every read. An
 * unsigned or expired URL gets nothing.
 */
import { handleOptions } from './_shared/auth.mjs';
import { verifyPhotoSig, readPhoto } from './_shared/corkboard.mjs';

export default async (req) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return new Response('Method not allowed', { status: 405 });

    const url = new URL(req.url);
    const id = String(url.searchParams.get('id') || '');
    const exp = url.searchParams.get('e');
    const sig = url.searchParams.get('s');
    if (!id || !verifyPhotoSig(id, exp, sig)) return new Response('Not found', { status: 404 });

    const b64 = await readPhoto(id);
    if (!b64) return new Response('Not found', { status: 404 });

    const bytes = Buffer.from(b64, 'base64');
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bytes.length),
        // The signature already expires; cache hard until it does so a board
        // full of photos is one round trip per photo, once.
        'Cache-Control': 'private, max-age=86400',
      },
    });
  } catch (e) {
    console.error('armory-photo error:', (e && e.message) || e);
    return new Response('Server error', { status: 500 });
  }
};
