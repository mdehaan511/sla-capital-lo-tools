/**
 * _shared/supabase-db.mjs — thin PostgREST client for Netlify Functions.
 *
 * Phase 1 of the data migration. Every table Supabase creates in the
 * public schema is auto-exposed at https://<project>.supabase.co/rest/v1/<table>.
 * We use fetch() against that with the service-role key (bypasses RLS)
 * so backend endpoints can read/write freely. No SDK dependency —
 * same zero-dep philosophy as supabase-auth.mjs (Deploy 236.245+).
 *
 * Env vars (set in Netlify dashboard):
 *   SUPABASE_URL              — https://<project>.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY — service_role key (from Project Settings → API)
 *
 * Never expose SUPABASE_SERVICE_ROLE_KEY to the browser. It bypasses
 * RLS entirely.
 *
 * Usage:
 *   import { db } from './_shared/supabase-db.mjs';
 *   const loans = await db.select('loans', { eq: { owner_email: 'sara@…' }, limit: 50 });
 *   await db.upsert('clients', { id: 'c_123', first_name: 'Sara', ... });
 *   await db.delete('loans', { eq: { id: 'l_123' } });
 */

const REST_HEADERS_COMMON = {
  'Content-Type': 'application/json',
  Accept:         'application/json',
};

// Deploy 236.396/398: tolerate the REST-endpoint form of the URL
// (…supabase.co/rest/v1/) — the dashboard shows it in several places
// and the staging env var was first configured with it, which made
// every request hit /rest/v1/rest/v1/… (PGRST125). Exported because
// several endpoints build Supabase URLs from the env var directly
// (raw FTS queries, auth-admin API, client config) — they must all
// normalize identically or they break only on misconfigured envs,
// silently, one by one.
export function supabaseBaseUrl() {
  return (process.env.SUPABASE_URL || '')
    .replace(/\/+$/, '')
    .replace(/\/rest\/v1$/i, '')
    .replace(/\/+$/, '');
}

function _env() {
  const url = supabaseBaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  }
  return { url, key };
}

function _baseHeaders(apikey) {
  return {
    ...REST_HEADERS_COMMON,
    apikey,
    Authorization: 'Bearer ' + apikey,
  };
}

// Build the PostgREST querystring from a simple filter shape.
//   eq:      { column: value, ... }
//   in:      { column: [v1, v2] }
//   select:  '*' | 'id,name,...'
//   order:   { column: 'asc'|'desc' }
//   limit:   number
//   offset:  number
function _qs(opts) {
  opts = opts || {};
  const parts = [];
  if (opts.select) parts.push('select=' + encodeURIComponent(opts.select));
  if (opts.eq) {
    for (const [k, v] of Object.entries(opts.eq)) {
      // PostgREST filter: <col>=eq.<value>
      parts.push(encodeURIComponent(k) + '=eq.' + encodeURIComponent(v));
    }
  }
  if (opts.in) {
    for (const [k, arr] of Object.entries(opts.in)) {
      const list = (arr || []).map((v) => encodeURIComponent(v)).join(',');
      parts.push(encodeURIComponent(k) + '=in.(' + list + ')');
    }
  }
  if (opts.order) {
    for (const [k, dir] of Object.entries(opts.order)) {
      parts.push('order=' + encodeURIComponent(k) + '.' + (dir === 'desc' ? 'desc' : 'asc'));
    }
  }
  if (opts.limit  != null) parts.push('limit='  + Number(opts.limit));
  if (opts.offset != null) parts.push('offset=' + Number(opts.offset));
  return parts.length ? '?' + parts.join('&') : '';
}

async function _request(method, table, { qs = '', body, headers } = {}) {
  const { url, key } = _env();
  const endpoint = url + '/rest/v1/' + table + qs;
  const resp = await fetch(endpoint, {
    method,
    headers: { ..._baseHeaders(key), ...(headers || {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; }
  catch (_) { data = text; }
  if (!resp.ok) {
    const err = new Error(
      'PostgREST ' + method + ' ' + table + ' → HTTP ' + resp.status +
      (typeof data === 'string' ? ': ' + data.slice(0, 200) :
       (data && data.message ? ': ' + data.message : ''))
    );
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const db = {
  // SELECT — returns array of rows.
  select(table, opts) {
    return _request('GET', table, { qs: _qs(opts || { select: '*' }) });
  },

  // Single row shortcut. Returns null if no match.
  async first(table, opts) {
    const rows = await db.select(table, { ...(opts || {}), limit: 1 });
    return (rows && rows[0]) || null;
  },

  // INSERT — array or single object. Prefer-return=representation
  // gives us back the inserted row(s) with server-side defaults filled in.
  insert(table, rows) {
    return _request('POST', table, {
      body: Array.isArray(rows) ? rows : [rows],
      headers: { Prefer: 'return=representation' },
    });
  },

  // UPSERT — needs the conflict target so PostgREST knows which key
  // decides insert-vs-update. Almost always the primary key.
  upsert(table, rows, opts) {
    opts = opts || {};
    const onConflict = opts.onConflict || 'id';
    return _request('POST', table, {
      qs: '?on_conflict=' + encodeURIComponent(onConflict),
      body: Array.isArray(rows) ? rows : [rows],
      headers: { Prefer: 'resolution=merge-duplicates,return=representation' },
    });
  },

  // UPDATE — by `eq` filter. Prefer=representation returns the
  // updated rows.
  update(table, filter, patch) {
    return _request('PATCH', table, {
      qs: _qs({ eq: filter }),
      body: patch,
      headers: { Prefer: 'return=representation' },
    });
  },

  // DELETE — by `eq` filter. Prefer=return=representation returns the
  // deleted rows (helpful for audit/logging).
  del(table, filter) {
    return _request('DELETE', table, {
      qs: _qs({ eq: filter }),
      headers: { Prefer: 'return=representation' },
    });
  },

  // RPC — call a Postgres function (POST /rest/v1/rpc/<fn>). This is
  // how multi-statement writes become atomic: the function body runs
  // in one transaction server-side (Hardening Phase C1, Deploy
  // 236.393). args maps to the function's named parameters. A missing
  // function surfaces as HTTP 404 with PostgREST code PGRST202 —
  // callers that need deploy-order independence catch that and fall
  // back (see pg-mirror.mjs).
  rpc(fn, args) {
    return _request('POST', 'rpc/' + fn, { body: args || {} });
  },
};

// Convenience: quick health check the admin endpoints can call to
// confirm the env vars are set and the project is reachable before
// running expensive work.
export async function ping() {
  const { url, key } = _env();
  const resp = await fetch(url + '/rest/v1/', { headers: _baseHeaders(key) });
  return { ok: resp.ok, status: resp.status };
}
