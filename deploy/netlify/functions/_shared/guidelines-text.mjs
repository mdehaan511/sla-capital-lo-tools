/**
 * _shared/guidelines-text.mjs — Deploy 237.096 (Mike: spend)
 *
 * The investor / program guidelines used to ride along on EVERY document review
 * as a PDF. A PDF is tokenised as page images PLUS text, so the one Colchis RTL
 * guidelines file was the single largest block in every RTL review even after
 * the 1-hour cache (237.093). This module hands the review the guidelines as
 * extracted TEXT instead (~60% fewer tokens, same 1h cache breakpoint):
 *
 *   guidelinesTextFor(key, pdfBytes) — the transcription stored under
 *     loan-review-guidelines-text/<key> when it exists AND was made from the
 *     PDF currently on file (sourceSize match); otherwise queues the one-time
 *     extraction (loan-review-guidelines-extract-background, internal HMAC,
 *     deduped by a 30-minute marker) and returns null so the caller sends the
 *     PDF just this once.
 *   queueGuidelinesExtraction(key) — the kick; also used by the upload endpoint
 *     after a new PDF lands (which first deletes the stale text).
 */
import { getStore } from '@netlify/blobs';
import { internalBgSig } from './review-truth.mjs';

export const GUIDELINES_TEXT_STORE = 'loan-review-guidelines-text';
const MARKER_TTL_MS = 30 * 60 * 1000;

function _store() { return getStore({ name: GUIDELINES_TEXT_STORE, consistency: 'strong' }); }

export async function queueGuidelinesExtraction(key) {
  try {
    if (!key) return { ok: false, reason: 'no key' };
    const store = _store();
    const marker = await store.get(key + '.extracting', { type: 'json' }).catch(() => null);
    if (marker && marker.at && (Date.now() - new Date(marker.at).getTime()) < MARKER_TTL_MS) {
      return { ok: true, queued: false, reason: 'already extracting' };
    }
    const sig = internalBgSig('guidelines', key);
    if (!sig) return { ok: false, reason: 'no secret configured' };
    await store.setJSON(key + '.extracting', { at: new Date().toISOString() });
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
    const r = await fetch(base + '/.netlify/functions/loan-review-guidelines-extract-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sla-internal': sig },
      body: JSON.stringify({ key }),
    });
    console.log('[guidelines-text] extraction queued for', key, 'HTTP', r.status);
    return { ok: r.status === 202 || r.ok, queued: true, status: r.status };
  } catch (e) {
    console.warn('[guidelines-text] queue failed (non-fatal):', e && e.message);
    return { ok: false, reason: e && e.message };
  }
}

export async function guidelinesTextFor(key, pdfBytes) {
  try {
    if (!key) return null;
    const rec = await _store().get(key, { type: 'json' }).catch(() => null);
    const size = pdfBytes ? pdfBytes.length : 0;
    if (rec && rec.text && (!size || !rec.sourceSize || rec.sourceSize === size)) {
      return { key, text: String(rec.text), pages: rec.pages || 0, extractedAt: rec.extractedAt || '' };
    }
    if (size) await queueGuidelinesExtraction(key);
    return null;
  } catch (e) {
    console.warn('[guidelines-text] lookup failed (non-fatal):', e && e.message);
    return null;
  }
}
