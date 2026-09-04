/**
 * _shared/broker-assets.mjs — Deploy 236.872
 *
 * A Preferred Partner's own logo, for the brand-agnostic rate sheet.
 *
 * Mike: brokers don't want to show SLA to their borrowers. So the sheet
 * carries THEIR mark if they've uploaded one, and a neutral
 * "Loan Quote — <address>" title if they haven't. Either way nothing on
 * that document says SLA Capital.
 *
 * PNG and JPEG only, because those are the two formats pdf-lib can embed
 * natively (embedPng / embedJpg). SVG would need rasterizing and a
 * pipeline we don't have; a broker with only an SVG gets the text title,
 * which is a fine outcome rather than a broken PDF.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

const STORE = 'broker_assets';

// 500 KB of base64 ≈ 375 KB of image. Comfortably more than any logo
// needs at print resolution, and far under the 6 MB gateway body cap.
export const MAX_LOGO_B64 = 500 * 1024;
export const ALLOWED_MIME = ['image/png', 'image/jpeg'];

function _store() {
  return getStore({ name: STORE, consistency: 'strong' });
}

function key(email) {
  return keySafe(normalizeEmail(email || '')) + '/logo';
}

/**
 * Sniff the real format from the bytes rather than trusting the mime the
 * browser reported — a file renamed .png is still a JPEG, and pdf-lib
 * throws on a mismatch, which would surface as "couldn't make your PDF"
 * long after the upload appeared to succeed.
 */
export function sniffImage(b64) {
  const head = String(b64 || '').slice(0, 24);
  // PNG:  \x89PNG  -> base64 begins iVBORw0KGgo
  if (head.startsWith('iVBORw0KGgo')) return 'image/png';
  // JPEG: \xFF\xD8\xFF -> base64 begins /9j/
  if (head.startsWith('/9j/')) return 'image/jpeg';
  return '';
}

/** The stored logo, or null. Never throws. */
export async function getLogo(email) {
  if (!email) return null;
  try {
    return await _store().get(key(email), { type: 'json' });
  } catch (e) {
    console.warn('[broker-assets] read failed:', e && e.message);
    return null;
  }
}

/**
 * Store a logo. Throws with a message meant for the broker to read.
 * @param b64 raw base64 (no data: prefix)
 */
export async function saveLogo(email, b64, reportedMime) {
  const clean = String(b64 || '').replace(/^data:[^,]+,/, '').trim();
  if (!clean) throw new Error('No image data received.');
  if (clean.length > MAX_LOGO_B64) {
    throw new Error('That image is too large — please use one under 375 KB.');
  }
  const mime = sniffImage(clean);
  if (!mime) {
    throw new Error('Please upload a PNG or JPEG. Other formats (including SVG) can\'t be placed on the PDF.');
  }
  const rec = {
    mime,
    reportedMime: String(reportedMime || ''),
    dataB64: clean,
    bytes: Math.round(clean.length * 0.75),
    uploadedAt: new Date().toISOString(),
  };
  await _store().setJSON(key(email), rec);
  return rec;
}

export async function deleteLogo(email) {
  try { await _store().delete(key(email)); return true; }
  catch (e) { console.warn('[broker-assets] delete failed:', e && e.message); return false; }
}
