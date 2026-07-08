/**
 * spike-supabase-echo.mjs — GET/POST /api/spike-supabase-echo
 *
 * Spike endpoint on the spike/supabase-auth branch. Verifies a
 * Supabase JWT from the Authorization header and echoes back what
 * the server saw. Not for production — this is here to prove the
 * verifier works end-to-end from the test HTML page.
 *
 * Response on success (200):
 *   {
 *     ok: true,
 *     user: { provider, sub, email, app_metadata, user_metadata, exp, iat },
 *     runtime: {
 *       node_version: process.version,
 *       has_secret:   <bool — was SUPABASE_JWT_SECRET set>,
 *     }
 *   }
 *
 * Response on failure (401):
 *   { ok: false, error: '<reason>' }
 */
import { requireSupabaseAuth } from './_shared/supabase-auth.mjs';

function _cors(req) {
  return {
    'Access-Control-Allow-Origin':  req.headers.get('origin') || '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type',
    'Access-Control-Max-Age':       '600',
    'Vary':                         'Origin',
  };
}

function _json(status, body, headers) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: Object.assign({ 'content-type': 'application/json' }, headers || {}),
  });
}

export default async (req) => {
  const cors = _cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const hasSecret = !!process.env.SUPABASE_JWT_SECRET;
  const user = requireSupabaseAuth(req);

  if (!user) {
    return _json(401, {
      ok: false,
      error: hasSecret
        ? 'Invalid or missing Supabase JWT. Confirm Authorization: Bearer <token> is set and the token was issued by this Supabase project.'
        : 'SUPABASE_JWT_SECRET env var is not set on Netlify. The verifier cannot check signatures until it is.',
      runtime: {
        node_version: process.version,
        has_secret:   hasSecret,
      },
    }, cors);
  }

  return _json(200, {
    ok: true,
    user: {
      provider:      user.provider,
      sub:           user.sub,
      email:         user.email,
      app_metadata:  user.app_metadata,
      user_metadata: user.user_metadata,
      exp:           user.exp,
      iat:           user.iat,
    },
    runtime: {
      node_version: process.version,
      has_secret:   true,
    },
  }, cors);
};
