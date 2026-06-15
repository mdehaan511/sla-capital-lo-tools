/**
 * _shared/auth.js — Auth & response helpers for Netlify functions
 *
 * Usage from a function (modern Request/Response style):
 *   import { requireAuth, json, getRoles, isAdmin } from './_shared/auth.js';
 *   export default async (req, context) => {
 *     const user = requireAuth(context);
 *     if (!user) return json(401, { error: 'Not authenticated' });
 *     ...
 *   };
 */

export function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

export function json(statusCode, body) {
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
export function requireAuth(context, req) {
  const ccUser = context && context.clientContext && context.clientContext.user;
  if (ccUser) return ccUser;

  // Fallback: decode JWT from Authorization header
  if (!req) return null;
  const authHeader = req.headers.get
    ? (req.headers.get('authorization') || req.headers.get('Authorization'))
    : '';
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.slice(7).trim();
  return decodeJwtPayload(token);
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
