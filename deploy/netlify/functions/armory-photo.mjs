/**
 * armory-photo.mjs — GET /api/armory-photo?id=<pin>&e=<exp>&s=<sig>[&k=v]
 *
 * Deploy 237.191 — serves one cork-board photo. Deliberately NOT behind
 * requireAuth: an <img> tag cannot send a bearer token, so the URL itself is
 * the credential — an HMAC over the pin id and an expiry, signed with
 * ESIGN_SEAL_SECRET and minted fresh by armory-board on every read. An
 * unsigned or expired URL gets nothing.
 *
 * Deploy 237.195 — `k=v` serves the pin's CLIP instead, under its own HMAC
 * prefix so a photo URL can never be replayed as a video one. Video needs
 * byte ranges: Safari opens a clip with `Range: bytes=0-1` and refuses to
 * play anything that answers 200 with the whole file, so a ranged request is
 * answered 206 with a slice and Accept-Ranges is always advertised.
 */
import { handleOptions } from './_shared/auth.mjs';
import { verifyPhotoSig, verifyVideoSig, readPhoto, readVideo } from './_shared/corkboard.mjs';

export default async (req) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET' && req.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });

    const url = new URL(req.url);
    const id = String(url.searchParams.get('id') || '');
    const exp = url.searchParams.get('e');
    const sig = url.searchParams.get('s');
    const isVideo = String(url.searchParams.get('k') || '') === 'v';
    if (!id) return new Response('Not found', { status: 404 });
    if (!(isVideo ? verifyVideoSig(id, exp, sig) : verifyPhotoSig(id, exp, sig))) {
      return new Response('Not found', { status: 404 });
    }

    const media = await (isVideo ? readVideo(id) : readPhoto(id));
    if (!media) return new Response('Not found', { status: 404 });

    // A clip carries the container the browser recorded (Chrome webm, Safari
    // mp4); a photo is always the JPEG the client re-encoded.
    const bytes = Buffer.from(isVideo ? media.b64 : media, 'base64');
    const type = isVideo ? (media.type || 'video/mp4') : 'image/jpeg';
    const common = {
      'Content-Type': type,
      // The signature already expires; cache hard until it does, so a board
      // full of media is one round trip per item, once.
      'Cache-Control': 'private, max-age=86400',
      'Accept-Ranges': 'bytes',
    };

    const range = req.headers.get('range') || req.headers.get('Range');
    if (isVideo && range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range);
      if (m) {
        let start = m[1] === '' ? 0 : parseInt(m[1], 10);
        let end = m[2] === '' ? bytes.length - 1 : parseInt(m[2], 10);
        if (!isFinite(start) || start < 0) start = 0;
        if (!isFinite(end) || end >= bytes.length) end = bytes.length - 1;
        if (start > end) {
          return new Response(null, {
            status: 416,
            headers: Object.assign({}, common, { 'Content-Range': 'bytes */' + bytes.length }),
          });
        }
        const slice = bytes.subarray(start, end + 1);
        return new Response(req.method === 'HEAD' ? null : slice, {
          status: 206,
          headers: Object.assign({}, common, {
            'Content-Length': String(slice.length),
            'Content-Range': 'bytes ' + start + '-' + end + '/' + bytes.length,
          }),
        });
      }
    }

    return new Response(req.method === 'HEAD' ? null : bytes, {
      status: 200,
      headers: Object.assign({}, common, { 'Content-Length': String(bytes.length) }),
    });
  } catch (e) {
    console.error('armory-photo error:', (e && e.message) || e);
    return new Response('Server error', { status: 500 });
  }
};
