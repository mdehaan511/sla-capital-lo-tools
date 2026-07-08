/**
 * supabase-auth.mjs — Supabase JWT verification for Netlify Functions.
 *
 * Spike deliverable (spike/supabase-auth branch, Deploy N/A).
 *
 * Verifies a Supabase-issued HS256 JWT using SUPABASE_JWT_SECRET and
 * returns a user object shaped like Netlify Identity's
 * `context.clientContext.user` — so the rest of the codebase's
 * requireAuth flow can accept either token during a transition.
 *
 * Shape returned on success:
 *   {
 *     provider:      'supabase',
 *     sub:           <supabase user id>,
 *     email:         <email>,
 *     app_metadata:  { roles: [...], provider: 'email', ... },
 *     user_metadata: { full_name, ... },       // Supabase custom user_metadata
 *     exp:           <unix seconds>,
 *     iat:           <unix seconds>,
 *     raw:           <full decoded payload>,
 *   }
 *
 * Returns null on any failure (invalid signature, expired, malformed).
 * Callers should treat null as unauthenticated.
 *
 * Zero external dependencies — uses Node's built-in crypto only,
 * so it works in the existing Netlify Functions runtime with no
 * package.json changes.
 */
import crypto from 'node:crypto';

/**
 * Base64URL-decode into a UTF-8 string.
 */
function _b64uToString(s) {
  const norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (norm.length % 4)) % 4;
  const padded = norm + '='.repeat(padLen);
  return Buffer.from(padded, 'base64').toString('utf8');
}

/**
 * Base64URL-decode into a Buffer (for the signature bytes).
 */
function _b64uToBuffer(s) {
  const norm = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  const padLen = (4 - (norm.length % 4)) % 4;
  const padded = norm + '='.repeat(padLen);
  return Buffer.from(padded, 'base64');
}

/**
 * Verify an HS256 JWT against a shared secret. Returns the decoded
 * payload on success, null on any failure.
 *
 * Explicit: does NOT verify `iss` or `aud` — callers should check
 * those against expected values if they matter. Verifies `exp`.
 */
function _verifyHS256(token, secret) {
  if (!token || typeof token !== 'string' || !secret) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64u, payloadB64u, sigB64u] = parts;

  // Header must declare HS256. If Supabase ever moves us to RS256
  // (their edge is HS256 by default; a config switch changes this),
  // this returns null and the caller sees an unauth. That's the
  // safe failure mode — a signal to update the verifier.
  let header;
  try { header = JSON.parse(_b64uToString(headerB64u)); }
  catch (_) { return null; }
  if (!header || header.alg !== 'HS256' || (header.typ && header.typ !== 'JWT')) return null;

  // Recompute the HMAC over `<headerB64u>.<payloadB64u>`.
  const signingInput = headerB64u + '.' + payloadB64u;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  const actual = _b64uToBuffer(sigB64u);
  if (expected.length !== actual.length) return null;
  // Constant-time compare so a mismatched signature can't be probed by timing.
  if (!crypto.timingSafeEqual(expected, actual)) return null;

  let payload;
  try { payload = JSON.parse(_b64uToString(payloadB64u)); }
  catch (_) { return null; }

  // exp is unix seconds. Reject expired tokens with 30-second clock skew.
  const now = Math.floor(Date.now() / 1000);
  if (payload && typeof payload.exp === 'number' && payload.exp + 30 < now) return null;
  // Reject NBF-not-yet-valid too.
  if (payload && typeof payload.nbf === 'number' && payload.nbf > now + 30) return null;

  return payload;
}

/**
 * Extract a Bearer token from a Fetch API Request.
 */
function _bearerFromReq(req) {
  const h = req && req.headers && (typeof req.headers.get === 'function' ? req.headers.get('authorization') : req.headers.authorization);
  if (!h || typeof h !== 'string') return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/**
 * Verify a Supabase JWT and return a normalized user object.
 * Reads the secret from SUPABASE_JWT_SECRET (env). Returns null on
 * any failure (missing token, bad signature, expired, missing env).
 *
 * The caller decides what to do with a null return — typically
 *   `return json(401, { error: 'Not authenticated' });`
 */
export function verifySupabaseToken(token) {
  const secret = process.env.SUPABASE_JWT_SECRET;
  if (!secret) {
    console.warn('[supabase-auth] SUPABASE_JWT_SECRET not set — cannot verify tokens.');
    return null;
  }
  const payload = _verifyHS256(token, secret);
  if (!payload) return null;

  // Supabase JWT payload shape (as of 2026):
  //   {
  //     iss: 'https://<project>.supabase.co/auth/v1',
  //     sub: '<uuid>',
  //     aud: 'authenticated',        // or 'anon' pre-login
  //     email: 'user@example.com',
  //     phone: '',
  //     app_metadata: { provider: 'email', providers: ['email'], role: 'processor', ... },
  //     user_metadata: { full_name: 'Jane Doe', ... },
  //     role: 'authenticated',       // Postgres role; not the app role
  //     aal: 'aal1',
  //     amr: [{ method: 'otp', timestamp: 1234567890 }],
  //     session_id: '<uuid>',
  //     iat: 1234567890,
  //     exp: 1234571490,
  //   }
  //
  // Normalize so downstream code sees the same shape as Netlify Identity:
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
 * Returns the normalized user or null.
 */
export function requireSupabaseAuth(req) {
  const token = _bearerFromReq(req);
  if (!token) return null;
  return verifySupabaseToken(token);
}

/**
 * Extract application roles from a Supabase JWT payload.
 *
 * Supabase itself only writes ONE role — its Postgres role
 * ('authenticated' | 'anon' | 'service_role') — into the top-level
 * `role` field. That is NOT our application role. Application roles
 * live under `app_metadata.roles` (array) or `app_metadata.role`
 * (single string) — whichever the admin API call set when the user
 * was created or updated. Our invite endpoint (see users-invite for
 * the reference Netlify Identity implementation) will need to set
 * these when it moves to Supabase.
 *
 * Falls back to an empty array. Never throws.
 */
function _extractRoles(payload) {
  const am = (payload && payload.app_metadata) || {};
  if (Array.isArray(am.roles)) return am.roles.filter((r) => typeof r === 'string' && r.length);
  if (typeof am.role === 'string' && am.role) return [am.role];
  return [];
}

/**
 * True if the user has at least one of the required roles.
 */
export function hasAnyRole(user, wanted) {
  if (!user || !Array.isArray(wanted) || !wanted.length) return false;
  const roles = (user.app_metadata && user.app_metadata.roles) || [];
  return wanted.some((w) => roles.includes(w));
}

/**
 * Admin-only check aligned with existing auth.mjs:isAdmin.
 * Adjust the role name here (or centralize) to match production.
 */
export function isAdmin(user) {
  return hasAnyRole(user, ['admin', 'super_admin']);
}
