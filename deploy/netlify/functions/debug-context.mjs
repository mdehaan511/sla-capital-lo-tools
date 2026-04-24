/**
 * debug-context.mjs — GET /api/debug-context
 *
 * Diagnostic. Reports exactly what's in context.clientContext when a
 * request with an Authorization header arrives.
 */
export default async (req, context) => {
  const authHeader = req.headers.get('authorization') || req.headers.get('Authorization') || '';
  const tokenPresent = authHeader.startsWith('Bearer ') && authHeader.length > 50;
  const tokenPreview = tokenPresent ? (authHeader.slice(0, 20) + '...' + authHeader.slice(-10)) : '(none)';

  const cc = context && context.clientContext;
  const out = {
    method: req.method,
    url: req.url,
    tokenPresent,
    tokenPreview,
    hasClientContext: !!cc,
    clientContextKeys: cc ? Object.keys(cc) : [],
    hasIdentity: !!(cc && cc.identity),
    identityKeys: (cc && cc.identity) ? Object.keys(cc.identity) : [],
    hasUser: !!(cc && cc.user),
    userKeys: (cc && cc.user) ? Object.keys(cc.user) : [],
    userEmail: (cc && cc.user && cc.user.email) || null,
    userRoles: (cc && cc.user && cc.user.app_metadata && cc.user.app_metadata.roles) || null,
  };

  return new Response(JSON.stringify(out, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
};
