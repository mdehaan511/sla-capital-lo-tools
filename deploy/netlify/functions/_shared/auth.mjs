/**
 * _shared/auth.js — Auth & response helpers for Netlify functions
 *
 * Usage from a function (modern Request/Response style):
 *   import { requireAuth, json, getRoles, isAdmin } from './_shared/auth.js';
 *   export default async (req, context) => {
 *     const user = await requireAuth(context, req); // async since Deploy 236.433
 *     if (!user) return json(401, { error: 'Not authenticated' });
 *     ...
 *   };
 */

// Deploy 236.433 (Hardening Phase E, step 1): Supabase JWT verification.
// requireAuth now cryptographically verifies Supabase tokens instead of
// trusting a decoded payload. See the requireAuth body for the full
// rationale.
import { verifySupabaseToken } from './supabase-auth.mjs';

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

export function json(statusCode, body) {
  // Hardening Phase A1 (Deploy 236.388) — every 5xx response fires a
  // throttled Slack alert. json() is imported by every endpoint, so
  // this ONE hook gives full-fleet coverage: breakage announces itself
  // instead of hiding in function logs. Dynamic import keeps auth.mjs
  // dependency-light for the endpoints that never error; alerting is
  // fire-and-forget and can never affect the response.
  if (statusCode >= 500) {
    // Capture the stack SYNCHRONOUSLY — inside the import callback it
    // would point at the microtask, not the erroring endpoint.
    const _stack = String(new Error().stack || '');
    // Deploy 236.555 — forward the response's `reason` (and `detail`) into the
    // alert's extra line. Endpoints echo the underlying cause there (e.g.
    // quotes-list / brokers-list on a transient PG blip); without this the Slack
    // alert showed only the generic `error` ("Failed to load quotes"), so a
    // recurrence had to be diagnosed by inference. Now the real cause rides along.
    const _diag = body && (body.reason || body.detail);
    import('./error-alert.mjs').then((m) => {
      m.alertServerError({
        source: m.inferSourceFromStack(_stack) || 'unknown-endpoint',
        status: statusCode,
        message: (body && (body.error || body.message)) || 'unknown 5xx',
        extra: _diag ? ('reason: ' + String(_diag).slice(0, 240)) : undefined,
      });
    }).catch(() => {});
  }
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
  });
}

export function handleOptions(req) {
  if (req.method === 'OPTIONS') {
    return new Response('', { status: 204, headers: corsHeaders() });
  }
  return null;
}

/**
 * Returns the authenticated user object, or null if not signed in.
 *
 * Prefers context.clientContext.user (Netlify's automatic JWT decoding).
 * If that's missing (e.g. site-level config where clientContext isn't
 * populated), falls back to parsing the Authorization header's JWT
 * payload ourselves.
 */
export async function requireAuth(context, req) {
  // 1. Netlify Identity: context.clientContext.user is populated AND
  //    signature-validated by Netlify's edge. Trust it.
  const ccUser = context && context.clientContext && context.clientContext.user;
  if (ccUser) return ccUser;

  // 2. Bearer token in the Authorization header.
  if (!req) return null;
  const authHeader = req.headers.get
    ? (req.headers.get('authorization') || req.headers.get('Authorization'))
    : '';
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();

  // Deploy 236.433 (Hardening E, step 1): a token that CLAIMS to be from
  // Supabase (asymmetric alg or a supabase issuer) MUST pass real
  // cryptographic verification — no decode-only fallback. This closes
  // the signature-forgery hole: before today the backend base64-decoded
  // the payload and trusted it, so a forged JWT carrying admin claims
  // was accepted at all 175 endpoints. verifySupabaseToken checks the
  // ES256 signature against the project JWKS + exp/nbf and returns a
  // normalized (netlify-shaped) user, or null on any failure.
  if (_looksLikeSupabaseToken(token)) {
    return await verifySupabaseToken(token);
  }

  // Netlify Identity token presented in the header WITHOUT clientContext
  // (some site-config paths don't populate it). Decode-only, unchanged.
  // This is a KNOWN, deliberately-temporary gap: Netlify Identity is
  // retired in Phase E's final step, at which point this branch — the
  // last unverified path — is deleted. Netlify's HS256 secret is
  // Netlify-internal so we can't verify these here; legitimate Netlify
  // sessions are edge-verified via clientContext above, so this only
  // covers the header-only edge case.
  return decodeJwtPayload(token);
}

// Deploy 236.433 — peek (WITHOUT verifying) at a JWT to decide whether
// it must go through Supabase verification. Discriminating on CLAIMED
// identity (not on verification success) is what makes the gate real:
// a forged Supabase token cannot dodge verification by also looking
// like a Netlify token, because a supabase issuer or an asymmetric alg
// forces the Supabase path where the bad signature is rejected.
function _looksLikeSupabaseToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return false;
  try {
    const header = JSON.parse(_b64uDecode(parts[0]));
    if (header && (header.alg === 'ES256' || header.alg === 'RS256')) return true;
    const payload = JSON.parse(_b64uDecode(parts[1]));
    const iss = String((payload && payload.iss) || '');
    if (/supabase|\/auth\/v1(\/|$)/i.test(iss)) return true;
  } catch (_) { /* malformed → not a recognizable Supabase token */ }
  return false;
}

function _b64uDecode(b64u) {
  let b64 = String(b64u || '').replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return typeof atob === 'function' ? atob(b64) : Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Decode (not verify) the middle segment of a JWT. Safe here because:
 *  - The request already passed through Netlify's edge which validates tokens
 *  - We only read identity claims; signature tampering can only corrupt data
 *
 * Returns a user-shaped object, or null if the token is malformed.
 */
function decodeJwtPayload(token) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    // Base64-url decode the payload
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const jsonStr = typeof atob === 'function'
      ? atob(b64)
      : Buffer.from(b64, 'base64').toString('utf8');
    const payload = JSON.parse(jsonStr);

    // Basic expiry check
    if (payload.exp && Date.now() / 1000 > payload.exp) return null;

    // Shape match to what Netlify Identity normally populates
    return {
      sub: payload.sub,
      email: payload.email,
      app_metadata: payload.app_metadata || {},
      user_metadata: payload.user_metadata || {},
      confirmed_at: payload.confirmed_at || null,
    };
  } catch (e) {
    return null;
  }
}

/** Returns the user's roles array (from app_metadata). */
export function getRoles(user) {
  if (!user) return [];
  const meta = user.app_metadata || {};
  if (Array.isArray(meta.roles)) return meta.roles;
  if (typeof meta.roles === 'string') return [meta.roles];
  return [];
}

export function isAdmin(user) {
  return getRoles(user).some((r) => r === 'admin' || r === 'super_admin');
}

export function isSuperAdmin(user) {
  return getRoles(user).some((r) => r === 'super_admin');
}

/**
 * Deploy 236.71 — Loan Doc Review tool.
 * A "processor" is a user with extra access to the Loan Doc Review
 * pages and the loan-reviews-* endpoints. Admins implicitly count as
 * processors (admins can do anything a processor can do).
 */
export function isProcessor(user) {
  return getRoles(user).some((r) => r === 'processor' || r === 'admin' || r === 'super_admin');
}

/**
 * Parse a JSON body from a Request, returning {} on failure.
 */
export async function readJsonBody(req) {
  try {
    const text = await req.text();
    if (!text) return {};
    return JSON.parse(text);
  } catch (e) {
    return null; // signals parse error (vs empty body → {})
  }
}

/**
 * Normalize an email for use in keys (lowercased, trimmed).
 */
export function normalizeEmail(s) {
  return String(s || '').trim().toLowerCase();
}

/**
 * Sanitize a string for use inside a blob key path segment.
 * Blob keys allow Unicode but can't start with /. We also strip ':' and '/'
 * to keep key shapes predictable.
 */
export function keySafe(s) {
  return String(s || '')
    .replace(/[:/\\]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 128);
}
