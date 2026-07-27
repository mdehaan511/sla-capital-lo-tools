/**
 * _shared/rate-limit.mjs — lightweight per-IP rate limiting for the
 * PUBLIC (unauthenticated / token-gated) endpoints. Hardening Phase F1.
 *
 * WHY: the borrower-facing surface (apply form, borrower-info save/sign,
 * guarantor sub-forms, eSign) takes input with no LO session. Before we
 * email invite links to borrowers, these need an abuse ceiling: spam
 * submissions on the open apply form, repeated hits on token endpoints,
 * resource exhaustion. Borrower tokens are already 128-bit random with
 * expiry, so this is abuse/spam defense + defense-in-depth, not the
 * primary guard against token guessing.
 *
 * DESIGN: fixed-window counter in a Netlify Blob store keyed by
 * bucket + client IP. Approximate by nature (the read-modify-write
 * isn't atomic, so a burst of truly-simultaneous requests can slip a
 * few past the ceiling) — fine for abuse throttling, which doesn't need
 * to be exact. Strong consistency so sequential retries see the live
 * count. Never throws: a Blob hiccup fails OPEN (allowed) so a storage
 * blip can never lock real borrowers out.
 *
 * USAGE (at the top of a public endpoint, after handleOptions):
 *   import { checkRateLimit } from './_shared/rate-limit.mjs';
 *   const rl = await checkRateLimit(req, context, { bucket: 'apply', max: 10, windowSec: 60 });
 *   if (!rl.allowed) return json(429, { error: 'Too many requests. Please wait a moment and try again.', retryAfterSec: rl.retryAfterSec });
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';

// Pull the real client IP. Netlify sets x-nf-client-connection-ip to the
// true edge client IP; x-forwarded-for's first hop is the fallback;
// context.ip covers the newer runtime. '_noip' groups everything that
// slips all three into one shared bucket (still throttled, just coarse).
export function clientIp(req, context) {
  try {
    const h = req && req.headers && req.headers.get ? req.headers : null;
    if (h) {
      const nf = h.get('x-nf-client-connection-ip');
      if (nf) return nf.trim();
      const xff = h.get('x-forwarded-for');
      if (xff) return String(xff).split(',')[0].trim();
      const xr = h.get('x-real-ip');
      if (xr) return xr.trim();
    }
    if (context && context.ip) return String(context.ip);
  } catch (_) { /* fall through */ }
  return '_noip';
}

/**
 * @param {Request} req
 * @param {object}  context   Netlify function context
 * @param {object}  opts      { bucket, max, windowSec, key? }
 *   bucket    — logical limiter name (e.g. 'apply', 'borrower-save')
 *   max       — allowed hits per window
 *   windowSec — window length in seconds
 *   key       — optional explicit key suffix (e.g. a token) instead of IP
 * @returns {Promise<{allowed:boolean, remaining:number, retryAfterSec:number, count:number}>}
 */
export async function checkRateLimit(req, context, opts) {
  opts = opts || {};
  const bucket = opts.bucket || 'default';
  const max = Math.max(1, opts.max || 30);
  const windowSec = Math.max(1, opts.windowSec || 60);
  const windowMs = windowSec * 1000;

  const idPart = opts.key ? keySafe(String(opts.key)) : keySafe(clientIp(req, context));
  const storeKey = bucket + '/' + idPart;

  try {
    const store = getStore({ name: 'rate-limits', consistency: 'strong' });
    const now = Date.now();
    const rec = await store.get(storeKey, { type: 'json' }).catch(() => null);

    let count, windowStart;
    if (rec && typeof rec.w === 'number' && (now - rec.w) < windowMs) {
      count = (rec.c || 0) + 1;
      windowStart = rec.w;
    } else {
      count = 1;
      windowStart = now;
    }

    await store.setJSON(storeKey, { c: count, w: windowStart });

    const allowed = count <= max;
    const retryAfterSec = allowed ? 0 : Math.max(1, Math.ceil((windowStart + windowMs - now) / 1000));
    return { allowed, remaining: Math.max(0, max - count), retryAfterSec, count };
  } catch (e) {
    // Fail OPEN — never let a storage blip block a legitimate borrower.
    console.warn('[rate-limit] check failed (allowing):', e && e.message);
    return { allowed: true, remaining: max, retryAfterSec: 0, count: 0 };
  }
}
