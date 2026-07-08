/**
 * config.mjs — GET /api/config
 * Self-contained, no shared imports. Returns the public Maps API key
 * for runtime injection into HTML.
 */
export default async (req, context) => {
  if (req.method === 'OPTIONS') {
    return new Response('', {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    });
  }

  // Spike-branch addition: Supabase URL + publishable key. Both are
  // safe client-side by design (the publishable key can only do what
  // the Supabase project's RLS allows). Served from here rather than
  // baked into HTML so Netlify's secrets scanner doesn't flag the
  // matches against the env values.
  const body = JSON.stringify({
    googleMapsKey:           process.env.GOOGLE_MAPS_API_KEY || '',
    supabaseUrl:             process.env.SUPABASE_URL || '',
    supabasePublishableKey:  process.env.SUPABASE_ANON_KEY || '',
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=600',
    },
  });
};
