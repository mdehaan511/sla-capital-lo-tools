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

  const body = JSON.stringify({
    googleMapsKey: process.env.GOOGLE_MAPS_API_KEY || '',
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

