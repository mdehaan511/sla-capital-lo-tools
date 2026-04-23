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

/** Returns the authenticated user object, or null if not signed in. */
export function requireAuth(context) {
  const user = context && context.clientContext && context.clientContext.user;
  return user || null;
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
