/**
 * search-pg.mjs — GET /api/search-pg?q=...
 *
 * Phase 4c of the data migration. Postgres FTS-backed drop-in for
 * /api/search. The clients + loans categories use the GIN-indexed
 * search_tsv columns (see 001_initial_schema.sql):
 *
 *   clients.search_tsv = to_tsvector('simple',
 *     first_name || last_name || email || phone || entity_name)
 *   loans.search_tsv   = to_tsvector('simple', address || notes)
 *
 * Prospects + quotes aren't in Postgres yet — those categories still
 * come from blob scans (same code path as search.mjs). That's fine:
 * both stores are small, and cutting the clients scan (2 800+ blobs)
 * over to a millisecond index lookup is the whole point of this phase.
 *
 * Response shape matches search.mjs exactly:
 *   { q, prospects, quotes, clients }
 * So sla-search.js only needs a URL swap.
 *
 * Query syntax: uses PostgREST's `wfts` operator (websearch_to_tsquery)
 * with the 'simple' config to match the stored tsvector's dictionary.
 * websearch_to_tsquery handles free-form user input safely — quoted
 * phrases, -excludes, whitespace — no need to sanitize.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs';

const PER_CATEGORY = 8;

// Zero-dep PostgREST GET. Same pattern as _shared/supabase-db.mjs but
// we build the querystring manually here because the shared helper
// doesn't have a way to express the `wfts(simple).<query>` operator
// without a raw-passthrough option.
async function _pgSelect(table, qs) {
  const url = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  const resp = await fetch(url + '/rest/v1/' + table + '?' + qs, {
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      Accept: 'application/json',
    },
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : []; }
  catch (_) { data = []; }
  if (!resp.ok) {
    const err = new Error('PostgREST GET ' + table + ' → HTTP ' + resp.status +
      (data && data.message ? ': ' + data.message : ''));
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data || [];
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim();
  const wantAll = url.searchParams.get('all') === '1' && canListAllClients(user).ok;

  if (q.length < 2) {
    return json(200, { prospects: [], quotes: [], clients: [], q });
  }

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);

  // ── Parallel: PG FTS on clients + loans, blob scan on prospects + quotes ──
  const [clientHits, loanHits, prospectsResult, quotesResult] = await Promise.all([
    _searchClientsPG(q, wantAll, selfEmail).catch((e) => {
      console.warn('search-pg: clients FTS failed:', e && e.message);
      return [];
    }),
    _searchLoansPG(q, wantAll, selfEmail).catch((e) => {
      console.warn('search-pg: loans FTS failed:', e && e.message);
      return [];
    }),
    _searchProspectsBlob(q, wantAll, selfKey).catch((e) => {
      console.warn('search-pg: prospects blob scan failed:', e && e.message);
      return [];
    }),
    _searchQuotesBlob(q, wantAll, selfKey).catch((e) => {
      console.warn('search-pg: quotes blob scan failed:', e && e.message);
      return [];
    }),
  ]);

  // Merge client + loan hits into a single clients list, deduping by
  // client id (a client that matches by name AND has a loan matching
  // the address should still be one entry).
  const seen = new Set();
  const clients = [];
  function pushClient(c) {
    if (!c || !c.id || seen.has(c.id)) return;
    seen.add(c.id);
    clients.push(c);
  }
  clientHits.forEach(pushClient);
  loanHits.forEach(pushClient);

  // Category names + sort order preserved from search.mjs so
  // sla-search.js render() works unchanged.
  return json(200, {
    q,
    prospects: prospectsResult.slice(0, PER_CATEGORY),
    quotes:    quotesResult.slice(0, PER_CATEGORY),
    clients:   clients.slice(0, PER_CATEGORY),
    _source:   'postgres',
  });
};

async function _searchClientsPG(q, wantAll, selfEmail) {
  const parts = [
    'select=' + encodeURIComponent(
      'id,owner_email,first_name,last_name,email,is_broker,loans!client_id(id,address)'
    ),
    'search_tsv=wfts(simple).' + encodeURIComponent(q),
    'limit=' + (PER_CATEGORY * 2),
    'order=updated_at.desc',
  ];
  if (!wantAll) parts.push('owner_email=eq.' + encodeURIComponent(selfEmail));
  const rows = await _pgSelect('clients', parts.join('&'));
  return rows.map((c) => _rowToClientResult(c, selfEmail));
}

async function _searchLoansPG(q, wantAll, selfEmail) {
  // Loan address/notes FTS → surface the loan's parent client so it
  // shows up in the same category as a name-matched client.
  // Embed the client via the client_id fk so we get the fields the
  // result-row builder needs without a second round trip.
  const parts = [
    'select=' + encodeURIComponent(
      'id,client_id,address,owner_email,' +
      'clients!client_id(id,owner_email,first_name,last_name,email,is_broker,loans!client_id(id,address))'
    ),
    'search_tsv=wfts(simple).' + encodeURIComponent(q),
    'limit=' + (PER_CATEGORY * 2),
    'order=updated_at.desc',
  ];
  if (!wantAll) parts.push('owner_email=eq.' + encodeURIComponent(selfEmail));
  const rows = await _pgSelect('loans', parts.join('&'));
  const out = [];
  for (const l of rows) {
    // PostgREST returns the embedded row as `clients` (the fk source
    // table). Skip if the join was orphaned somehow.
    const c = l.clients;
    if (!c) continue;
    out.push(_rowToClientResult(c, selfEmail));
  }
  return out;
}

function _rowToClientResult(c, selfEmail) {
  const name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  const ownerKey = keySafe(c.owner_email || '');
  const loanCount = Array.isArray(c.loans) ? c.loans.length : 0;
  const isSelf = normalizeEmail(c.owner_email) === selfEmail;
  return {
    id:        c.id,
    ownerKey,
    name:      name || c.email || 'Client',
    email:     c.email || '',
    loanCount,
    link: 'client-details.html?clientId=' + encodeURIComponent(c.id) +
          (isSelf ? '' : '&owner=' + encodeURIComponent(c.owner_email || '')),
  };
}

// ── Blob-scan helpers (unchanged shape from search.mjs) ──
// prospects + quotes tables aren't in PG yet; keep the existing scan
// path so parity is preserved. Both stores are small enough that the
// scan is fast in practice.

function _matches(text, q) {
  if (!text) return false;
  return String(text).toLowerCase().includes(q.toLowerCase());
}

async function _searchProspectsBlob(q, wantAll, selfKey) {
  const store = getStore({ name: 'prospects', consistency: 'strong' });
  const prefixes = wantAll
    ? await _collectAllPrefixes(store)
    : [selfKey];
  const out = [];
  for (const prefix of prefixes) {
    let listing;
    try { listing = await store.list({ prefix: prefix + '/' }); }
    catch (_) { continue; }
    for (const { key } of listing.blobs) {
      const p = await store.get(key, { type: 'json' }).catch(() => null);
      if (!p) continue;
      const name = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
      if (_matches(name, q) || _matches(p.email, q) || _matches(p.propAddress, q)) {
        out.push({
          id: p.id,
          ownerKey: prefix,
          name: name || p.email || 'Borrower',
          email: p.email || '',
          address: p.propAddress || '',
          date: p.submittedAt || '',
          link: 'pipeline.html',
        });
      }
      if (out.length >= PER_CATEGORY * 2) break;
    }
    if (out.length >= PER_CATEGORY * 2) break;
  }
  out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return out;
}

async function _searchQuotesBlob(q, wantAll, selfKey) {
  const store = getStore({ name: 'quotes', consistency: 'strong' });
  const prefixes = wantAll
    ? await _collectAllPrefixes(store)
    : [selfKey];
  const out = [];
  for (const prefix of prefixes) {
    let listing;
    try { listing = await store.list({ prefix: prefix + '/' }); }
    catch (_) { continue; }
    for (const { key } of listing.blobs) {
      const qr = await store.get(key, { type: 'json' }).catch(() => null);
      if (!qr) continue;
      const fd = qr.formData || {};
      const name = qr.borrower || fd.borrower || '';
      if (_matches(name, q) || _matches(qr.address, q) || _matches(fd.address, q)) {
        out.push({
          id: qr.id,
          ownerKey: prefix,
          name: name || qr.address || 'Quote',
          address: qr.address || fd.address || '',
          status: qr.status || 'active',
          toolType: qr.toolType || 'dscr',
          date: qr.updatedAt || qr.savedAt || '',
          link: _linkForQuote(qr),
        });
      }
      if (out.length >= PER_CATEGORY * 2) break;
    }
    if (out.length >= PER_CATEGORY * 2) break;
  }
  out.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));
  return out;
}

async function _collectAllPrefixes(store) {
  const prefixes = new Set();
  try {
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      const idx = key.indexOf('/');
      if (idx > 0) prefixes.add(key.slice(0, idx));
    }
  } catch (_) { /* empty */ }
  return Array.from(prefixes);
}

function _linkForQuote(qr) {
  const status = qr.status || 'active';
  if (status === 'on_hold' || status === 'denied') return 'decisions.html';
  if (status === 'closed') return 'closed.html';
  return 'pipeline.html';
}
