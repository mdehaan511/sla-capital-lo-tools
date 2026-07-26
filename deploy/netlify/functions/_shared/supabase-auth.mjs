/**
 * supabase-auth.mjs — Supabase JWT verification for Netlify Functions.
 *
 * Spike deliverable (spike/supabase-auth branch).
 *
 * Verifies a Supabase-issued JWT and returns a user object shaped
 * like Netlify Identity's context.clientContext.user, so the rest
 * of the codebase's requireAuth flow can accept either token during
 * a migration.
 *
 * Supports three signing algorithms — routed on the JWT header's
 * `alg` field:
 *
 *   ES256  (asymmetric, ECDSA over P-256, Supabase's modern default)
 *   RS256  (asymmetric, RSA-SHA256, alternative Supabase asymmetric)
 *   HS256  (symmetric, legacy Supabase JWT Secret)
 *
 * For the asymmetric algorithms we fetch Supabase's JWKS
 * (JSON Web Key Set) once per Netlify Function instance and cache
 * the keys in a module-scoped Map. On a `kid` cache miss we refetch
 * once (handles key rotation without a redeploy). On a signature
 * mismatch we fail closed — return null, no partial info leaked.
 *
 * For HS256 we use SUPABASE_JWT_SECRET (legacy env var). This path
 * exists so a same-project mixed-alg rollout works during Supabase's
 * own migration, and so a caller can force HS256 by omitting the
 * JWKS URL. Recommend removing this branch once your project has
 * fully rotated away from HS256.
 *
 * Zero external dependencies — uses Node's built-in `crypto`
 * (verify, createPublicKey, timingSafeEqual, createHmac) and
 * `fetch` for the JWKS pull.
 */
import crypto from 'node:crypto';
import { supabaseBaseUrl } from './supabase-db.mjs'; // Deploy 236.398

// ── Module-level JWKS cache ────────────────────────────────────
// Keyed by JWKS URL so a Netlify Function instance can, in theory,
// verify tokens from more than one Supabase project simultaneously.
// Each entry: { keys: Map<kid, publicKey>, fetchedAt: unixMs }.
const _jwksCache = new Map();

// Cache TTL: 1 hour. Supabase rotates keys rarely; a per-instance
// cache with 1h TTL is cheap and safe.
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000;

// Fetch timeout for the JWKS endpoint. Verification is on the hot
// path — we do not want a slow JWKS host to hang every request.
const JWKS_FETCH_TIMEOUT_MS = 3000;

// ── Base64URL helpers ──────────────────────────────────────────

function _b64uToString(s) {
  const norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (norm.length % 4)) % 4;
  const padded = norm + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function _b64uToBuffer(s) {
  const norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (norm.length % 4)) % 4;
  const padded = norm + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

// ── Bearer extraction from a Fetch API Request ─────────────────

function _bearerFromReq(req) {
  const h = req && req.headers && (typeof req.headers.get === 'function' ? req.headers.get('authorization') : req.headers.authorization);
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

// ── JWKS fetching + caching ────────────────────────────────────

/**
 * Resolve the JWKS URL from a Supabase project URL.
 * Supabase (GoTrue) publishes public keys at:
 *   `${SUPABASE_URL}/auth/v1/.well-known/jwks.json`
 */
function _jwksUrlFromSupabase(supabaseUrl) {
  if (!supabaseUrl) return null;
  const base = String(supabaseUrl).replace(/\/+$/, '');
  return base + '/auth/v1/.well-known/jwks.json';
}

/**
 * Fetch the JWKS document, parse each key into a Node
 * crypto.KeyObject, and stash them in the cache keyed by `kid`.
 * Returns the fresh cache entry, or null on failure.
 */
async function _refreshJwksCache(jwksUrl) {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), JWKS_FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(jwksUrl, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
    if (!res || !res.ok) {
      console.warn('[supabase-auth] JWKS fetch failed:', jwksUrl, res && res.status);
      return null;
    }
    const doc = await res.json();
    const keys = new Map();
    for (const jwk of (doc && Array.isArray(doc.keys) ? doc.keys : [])) {
      if (!jwk || !jwk.kid) continue;
      try {
        // createPublicKey accepts JWK directly since Node 15+.
        const keyObj = crypto.createPublicKey({ format: 'jwk', key: jwk });
        keys.set(jwk.kid, { key: keyObj, alg: jwk.alg || null, kty: jwk.kty || null });
      } catch (e) {
        console.warn('[supabase-auth] failed to parse JWK kid=%s:', jwk.kid, e && e.message);
      }
    }
    const entry = { keys, fetchedAt: Date.now() };
    _jwksCache.set(jwksUrl, entry);
    return entry;
  } catch (e) {
    console.warn('[supabase-auth] JWKS fetch error:', jwksUrl, e && e.message);
    return null;
  }
}

/**
 * Get a public key for `kid` from the cache, refreshing on miss or
 * TTL expiry. On a still-missing `kid` after refresh (key rotation
 * hasn't propagated yet? attacker-forged `kid`?), returns null.
 */
async function _getKeyForKid(jwksUrl, kid) {
  if (!jwksUrl || !kid) return null;
  let entry = _jwksCache.get(jwksUrl);
  const now = Date.now();
  const stale = !entry || (now - entry.fetchedAt) > JWKS_CACHE_TTL_MS;
  const miss  = entry && !entry.keys.has(kid);

  if (stale || miss) {
    entry = await _refreshJwksCache(jwksUrl) || entry;
  }
  if (!entry) return null;
  const rec = entry.keys.get(kid);
  return rec || null;
}

// ── Signature verification ─────────────────────────────────────

/**
 * ES256/RS256 signature verify. Accepts JWT-format signature
 * (raw R||S for ECDSA — NOT DER). Node's crypto.verify handles
 * ES256 with `dsaEncoding: 'ieee-p1363'` (raw R||S) and RS256
 * with a plain KeyObject.
 */
function _verifyAsymmetricSignature(alg, signingInput, sigBuf, keyRec) {
  if (!keyRec || !keyRec.key) return false;
  try {
    if (alg === 'ES256') {
      return crypto.verify(
        'sha256',
        Buffer.from(signingInput),
        { key: keyRec.key, dsaEncoding: 'ieee-p1363' },
        sigBuf,
      );
    }
    if (alg === 'RS256') {
      return crypto.verify(
        'sha256',
        Buffer.from(signingInput),
        keyRec.key,
        sigBuf,
      );
    }
    return false;
  } catch (e) {
    console.warn('[supabase-auth] verify error alg=%s:', alg, e && e.message);
    return false;
  }
}

/**
 * HS256 legacy path. Kept for projects still on symmetric secrets.
 */
function _verifyHS256Signature(signingInput, sigBuf, secret) {
  if (!secret) return false;
  try {
    const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
    if (expected.length !== sigBuf.length) return false;
    return crypto.timingSafeEqual(expected, sigBuf);
  } catch (_) {
    return false;
  }
}

// ── Payload checks (exp, nbf) ──────────────────────────────────

// Allow 30s of clock skew — Netlify Functions run on many hosts,
// and Supabase's clock is not synchronized with ours.
const CLOCK_SKEW_S = 30;

function _payloadTimingOk(payload) {
  const now = Math.floor(Date.now() / 1000);
  if (payload && typeof payload.exp === 'number' && payload.exp + CLOCK_SKEW_S < now) return false;
  if (payload && typeof payload.nbf === 'number' && payload.nbf > now + CLOCK_SKEW_S) return false;
  return true;
}

// ── Main verify entrypoint ─────────────────────────────────────

/**
 * Verify a Supabase JWT and return a normalized user object.
 *
 * Env vars honored:
 *   SUPABASE_URL         — required for ES256/RS256 (JWKS URL derived)
 *   SUPABASE_JWT_SECRET  — used only for HS256 tokens
 *
 * Return: normalized user, or null on any failure.
 */
export async function verifySupabaseToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64u, payloadB64u, sigB64u] = parts;

  let header;
  try { header = JSON.parse(_b64uToString(headerB64u)); }
  catch (_) { return null; }
  if (!header || (header.typ && header.typ !== 'JWT')) return null;
  const alg = header.alg;
  if (!alg) return null;

  const signingInput = headerB64u + '.' + payloadB64u;
  const sigBuf = _b64uToBuffer(sigB64u);

  let sigOk = false;
  if (alg === 'ES256' || alg === 'RS256') {
    const jwksUrl = _jwksUrlFromSupabase(supabaseBaseUrl()); // Deploy 236.398
    if (!jwksUrl) {
      console.warn('[supabase-auth] Asymmetric JWT received but SUPABASE_URL is not set — cannot fetch JWKS.');
      return null;
    }
    if (!header.kid) {
      // Asymmetric tokens without a kid are ambiguous; refuse.
      return null;
    }
    const keyRec = await _getKeyForKid(jwksUrl, header.kid);
    if (!keyRec) return null;
    // Optional: if the JWK declared its own `alg`, cross-check.
    if (keyRec.alg && keyRec.alg !== alg) return null;
    sigOk = _verifyAsymmetricSignature(alg, signingInput, sigBuf, keyRec);
  } else if (alg === 'HS256') {
    const secret = process.env.SUPABASE_JWT_SECRET;
    if (!secret) {
      console.warn('[supabase-auth] HS256 JWT received but SUPABASE_JWT_SECRET is not set.');
      return null;
    }
    sigOk = _verifyHS256Signature(signingInput, sigBuf, secret);
  } else {
    // Unknown algorithm.
    return null;
  }

  if (!sigOk) return null;

  let payload;
  try { payload = JSON.parse(_b64uToString(payloadB64u)); }
  catch (_) { return null; }

  if (!_payloadTimingOk(payload)) return null;

  // Normalize.
  const roles = _extractRoles(payload);
  return {
    provider:      'supabase',
    sub:           payload.sub || '',
    email:         String(payload.email || '').toLowerCase().trim(),
    app_metadata:  Object.assign({}, payload.app_metadata || {}, { roles }),
    user_metadata: payload.user_metadata || {},
    exp:           payload.exp || 0,
    iat:           payload.iat || 0,
    raw:           payload,
  };
}

/**
 * Convenience: verify from a Fetch API Request's Authorization header.
 * Now async — callers must `await` (the JWKS fetch may need to run).
 */
export async function requireSupabaseAuth(req) {
  const token = _bearerFromReq(req);
  if (!token) return null;
  return verifySupabaseToken(token);
}

// ── Role extraction (Supabase app_metadata → array) ───────────

function _extractRoles(payload) {
  // Deploy 236.434 (Hardening E): the custom_access_token_hook
  // (db/migrations/004) stamps roles as a top-level `sla_roles` array
  // claim from the sla_user_roles source-of-truth table. Read it FIRST
  // so authorization is driven by that one list, independent of however
  // the Supabase account was created (Google-linked, fresh, magic-link).
  // Falls back to app_metadata.roles/role for tokens minted before the
  // hook was enabled — purely additive, nothing pre-existing changes.
  if (payload && Array.isArray(payload.sla_roles)) {
    const r = payload.sla_roles.filter((x) => typeof x === 'string' && x.length);
    if (r.length) return r;
  }
  const am = (payload && payload.app_metadata) || {};
  if (Array.isArray(am.roles)) return am.roles.filter((r) => typeof r === 'string' && r.length);
  if (typeof am.role === 'string' && am.role) return [am.role];
  return [];
}

export function hasAnyRole(user, wanted) {
  if (!user || !Array.isArray(wanted) || !wanted.length) return false;
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  return wanted.some((w) => roles.includes(w));
}

export function isAdmin(user) {
  return hasAnyRole(user, ['admin', 'super_admin']);
}
