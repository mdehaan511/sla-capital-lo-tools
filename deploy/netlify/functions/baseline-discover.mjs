/**
 * baseline-discover.mjs — GET /api/baseline-discover
 *
 * Deploy 232 (Baseline Mirror Phase 1 — Step 1). Super-admin-only
 * diagnostic probe. We've only ever POSTed/PATCHed to Baseline; we
 * don't actually know what their list-style endpoint looks like for
 * loans. Rather than guess and ship a sync that 404s, hit a few of
 * the most likely candidates and report what each returns so we can
 * build the real mirror sync against confirmed shapes.
 *
 * Probes (each best-effort, all logged):
 *   1) GET /loan                        (REST list, singular)
 *   2) GET /loans                       (REST list, plural)
 *   3) GET /loan?limit=2                (REST list with query params)
 *   4) POST /api/graph  query { loans { Id Name Status Loan_Amount } }
 *   5) POST /api/graph  query { __schema { queryType { fields { name } } } }
 *      — introspects available top-level GraphQL types. Catches whether
 *        the loan list lives under a non-obvious name.
 *
 * Auth: super-admin only (this is internal API exploration; not
 * something LOs should run).
 *
 * Returns per probe: { probe, method, url, httpStatus, bodyPreview, error? }
 * — bodyPreview is the first ~600 chars so we can see schema shape
 * without dumping everything into the response.
 */
import {
  handleOptions, json, requireAuth, isSuperAdmin,
} from './_shared/auth.mjs';

const BASE_URL_DEFAULT = 'https://production.baselinesoftware.com/production/api';
function baseUrl() {
  return (process.env.BASELINE_BASE_URL || BASE_URL_DEFAULT).replace(/\/+$/, '');
}

async function probe(label, method, path, body) {
  const url = baseUrl() + (path.startsWith('/') ? path : '/' + path);
  const startedAt = Date.now();
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        'Authorization': 'Token ' + process.env.BASELINE_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text().catch(() => '');
    let parsed; let parseOk = true;
    try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = null; parseOk = false; }
    // Shape hint: if response is an array, report array+length;
    // if object with one of the expected list keys, report it; etc.
    let shape = 'unknown';
    let count = null;
    if (Array.isArray(parsed)) {
      shape = 'array'; count = parsed.length;
    } else if (parsed && typeof parsed === 'object') {
      const keys = Object.keys(parsed);
      if (Array.isArray(parsed.loans))       { shape = 'object.loans[]';       count = parsed.loans.length; }
      else if (Array.isArray(parsed.data))   { shape = 'object.data[]';        count = parsed.data.length; }
      else if (Array.isArray(parsed.results)){ shape = 'object.results[]';     count = parsed.results.length; }
      else if (parsed.data && typeof parsed.data === 'object') { shape = 'graphql.data';
        const dataKeys = Object.keys(parsed.data);
        if (dataKeys.length) {
          const firstKey = dataKeys[0];
          if (Array.isArray(parsed.data[firstKey])) { shape = 'graphql.data.' + firstKey + '[]'; count = parsed.data[firstKey].length; }
          else { shape = 'graphql.data.' + firstKey; }
        }
      }
      else                                    { shape = 'object(' + keys.slice(0, 6).join(',') + ')'; }
    }
    return {
      probe: label,
      method, url,
      httpStatus: resp.status,
      ok: resp.ok,
      shape,
      count,
      bodyPreview: parseOk
        ? JSON.stringify(parsed).slice(0, 600)
        : ('NON-JSON: ' + text.slice(0, 600)),
      durationMs: Date.now() - startedAt,
    };
  } catch (e) {
    return {
      probe: label,
      method, url,
      httpStatus: 0,
      ok: false,
      shape: 'error',
      error: e && e.message,
      durationMs: Date.now() - startedAt,
    };
  }
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-discover error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  if (!process.env.BASELINE_API_KEY) {
    return json(400, { error: 'BASELINE_API_KEY not configured' });
  }

  // Five probes — see file header. Run sequentially so the audit log is
  // readable; concurrency would save ~2s but the request order matters
  // when one probe's response can hint at the next one's shape.
  const probes = [];
  probes.push(await probe('rest_get_loan_singular',     'GET',  '/loan'));
  probes.push(await probe('rest_get_loans_plural',      'GET',  '/loans'));
  probes.push(await probe('rest_get_loan_with_limit',   'GET',  '/loan?limit=2'));
  probes.push(await probe('graphql_query_loans',        'POST', '/api/graph',
    { query: '{ loans(limit: 2) { Id Name Status Loan_Amount } }' }));
  probes.push(await probe('graphql_introspect_queries', 'POST', '/api/graph',
    { query: '{ __schema { queryType { fields { name type { name kind } } } } }' }));

  return json(200, {
    ok: true,
    baseUrl: baseUrl(),
    probes,
  });
}
