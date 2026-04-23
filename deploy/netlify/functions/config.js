/**
 * config.js — GET /api/config
 *
 * Serves public runtime configuration (currently just the Google Maps
 * browser API key). This replaces the build-time placeholder injection
 * in inject-env.js, so deploys can be done via drag-and-drop without
 * running a build command.
 *
 * The Maps key is a browser-side key restricted to your domain(s) in
 * Google Cloud Console — it is safe to serve publicly.
 */
import { handleOptions, corsHeaders } from './_shared/auth.js';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...corsHeaders(), 'Content-Type': 'application/json' },
    });
  }
  const body = {
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      ...corsHeaders(),
      'Content-Type': 'application/json',
      // Cache for 10 minutes on the edge so we don't hammer this endpoint
      'Cache-Control': 'public, max-age=600',
    },
  });
};
