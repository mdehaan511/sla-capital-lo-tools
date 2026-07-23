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
import { supabaseBaseUrl } from './_shared/supabase-db.mjs'; // Deploy 236.398
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs';
// Deploy 236.384 — prospects + quotes searched via their materialized
// indexes (ONE blob read each) instead of walking every blob in every
// owner namespace. The all-LOs blob scan was multi-second at Mike's
// scale, which made the typeahead useless. Falls back to the legacy
// scan only when an index is missing.
import { prospectsIndex } from './_shared/prospects-index.mjs';
import { quotesIndex } from './_shared/quotes-index.mjs';

const PER_CATEGORY = 8;

// Zero-dep PostgREST GET. Same pattern as _shared/supabase-db.mjs but
// we build the querystring manually here because the shared helper
// doesn't have a way to express the `wfts(simple).<query>` operator
// without a raw-passthrough option.
async function _pgSelect(table, qs) {
  const url = supabaseBaseUrl(); // Deploy 236.398: strips /rest/v1 suffix
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
  // Deploy 236.383 (universal search) — loans are now their OWN result
  // category (each row deep-links to /loan-details/<id>, which loads by
  // loanId alone from PG regardless of any page filter — the "loan
  // disappeared but it's still in the system" recovery path). Clients
  // matching the query split into brokers vs clients on is_broker.
  const [clientHits, loanRows, loanIdRows, prospectsResult, quotesResult] = await Promise.all([
    _searchClientsPG(q, wantAll, selfEmail).catch((e) => {
      console.warn('search-pg: clients FTS failed:', e && e.message);
      return [];
    }),
    _searchLoansPG(q, wantAll, selfEmail).catch((e) => {
      console.warn('search-pg: loans FTS failed:', e && e.message);
      return [];
    }),
    _searchLoansByIdPG(q, wantAll, selfEmail).catch((e) => {
      console.warn('search-pg: loans id lookup failed:', e && e.message);
      return [];
    }),
    _searchProspectsIdx(q, wantAll, selfKey).catch((e) => {
      console.warn('search-pg: prospects search failed:', e && e.message);
      return [];
    }),
    _searchQuotesIdx(q, wantAll, selfKey).catch((e) => {
      console.warn('search-pg: quotes search failed:', e && e.message);
      return [];
    }),
  ]);

  // Loans: merge FTS + id-lookup hits, dedupe by loan id.
  const seenLoans = new Set();
  const loans = [];
  [].concat(loanIdRows, loanRows).forEach((l) => {
    if (!l || !l.id || seenLoans.has(l.id)) return;
    seenLoans.add(l.id);
    loans.push(l);
  });

  // Clients: split into brokers vs regular clients, dedupe by id.
  const seenClients = new Set();
  const clients = [];
  const brokers = [];
  clientHits.forEach((c) => {
    if (!c || !c.id || seenClients.has(c.id)) return;
    seenClients.add(c.id);
    (c.isBroker ? brokers : clients).push(c);
  });

  // Deploy 236.384 — cross-category dedupe. A worked prospect (one
  // that already produced a quote/loan) showing NEXT TO its own quote
  // reads as a duplicate to the user. Suppress:
  //   - quotes whose loanId already appears in the loans results
  //     (the loan row is strictly better — it deep-links to details)
  //   - prospects whose address matches a loan or quote in the results
  const _norm = (s) => String(s || '').trim().toLowerCase()
    .replace(/,\s*(usa|us|united states)\.?$/i, '').replace(/[.,]/g, '').replace(/\s+/g, ' ');
  const quotes = quotesResult.filter((qr) => !(qr.loanId && seenLoans.has(qr.loanId)));
  const coveredAddrs = new Set();
  loans.forEach((l) => { const a = _norm(l.address); if (a) coveredAddrs.add(a); });
  quotes.forEach((qr) => { const a = _norm(qr.address); if (a) coveredAddrs.add(a); });
  const prospects = prospectsResult.filter((p) => !coveredAddrs.has(_norm(p.address)));

  return json(200, {
    q,
    loans:     loans.slice(0, PER_CATEGORY),
    clients:   clients.slice(0, PER_CATEGORY),
    brokers:   brokers.slice(0, PER_CATEGORY),
    prospects: prospects.slice(0, PER_CATEGORY),
    quotes:    quotes.slice(0, PER_CATEGORY),
    _source:   'postgres',
  });
};

// ── Index-backed prospects + quotes search (Deploy 236.384) ──────
// One blob read each; in-memory substring filter. Falls back to the
// legacy per-blob scan only when the index doesn't exist yet.
function _matchQ(text, q) {
  return text && String(text).toLowerCase().indexOf(q.toLowerCase()) >= 0;
}

async function _searchProspectsIdx(q, wantAll, selfKey) {
  const { index, exists } = await prospectsIndex.readIndex();
  if (!exists || !index || !index.byOwner) {
    return _searchProspectsBlob(q, wantAll, selfKey);
  }
  const owners = wantAll ? Object.keys(index.byOwner) : [selfKey];
  const out = [];
  for (const o of owners) {
    for (const p of (index.byOwner[o] || [])) {
      if (!p) continue;
      const name = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
      if (!_matchQ(name, q) && !_matchQ(p.email, q) && !_matchQ(p.propAddress, q)) continue;
      out.push({
        id: p.id,
        ownerKey: o,
        name: name || p.email || 'Borrower',
        email: p.email || '',
        address: p.propAddress || '',
        date: p.submittedAt || '',
        link: 'pipeline.html',
      });
      if (out.length >= PER_CATEGORY * 2) return out;
    }
  }
  return out;
}

async function _searchQuotesIdx(q, wantAll, selfKey) {
  const { index, exists } = await quotesIndex.readIndex();
  if (!exists || !index || !index.byOwner) {
    return _searchQuotesBlob(q, wantAll, selfKey);
  }
  const owners = wantAll ? Object.keys(index.byOwner) : [selfKey];
  const out = [];
  for (const o of owners) {
    for (const qr of (index.byOwner[o] || [])) {
      if (!qr) continue;
      const fd = qr.formData || {};
      const name = qr.borrower || fd.borrower || '';
      if (!_matchQ(name, q) && !_matchQ(qr.address, q) && !_matchQ(qr.borrowerEmail, q)) continue;
      out.push({
        id: qr.id,
        ownerKey: o,
        loanId: qr.loanId || '',
        name: name || qr.address || 'Quote',
        address: qr.address || '',
        status: qr.status || 'active',
        toolType: qr.toolType || 'dscr',
        date: qr.updatedAt || qr.savedAt || '',
        link: _linkForQuote(qr),
      });
      if (out.length >= PER_CATEGORY * 2) return out;
    }
  }
  return out;
}

async function _searchClientsPG(q, wantAll, selfEmail) {
  const parts = [
    'select=' + encodeURIComponent(
      'id,owner_email,first_name,last_name,email,entity_name,is_broker,loans!client_id(id,address)'
    ),
    'search_tsv=wfts(simple).' + encodeURIComponent(q),
    'limit=' + (PER_CATEGORY * 2),
    'order=updated_at.desc',
  ];
  if (!wantAll) parts.push('owner_email=eq.' + encodeURIComponent(selfEmail));
  const rows = await _pgSelect('clients', parts.join('&'));
  return rows.map((c) => _rowToClientResult(c, selfEmail));
}

const LOAN_SELECT = 'id,client_id,address,status,sla_display_id,tool_type,loan_amt,owner_email,updated_at,' +
  'clients!client_id(id,first_name,last_name,email,entity_name)';

function _rowToLoanResult(l, selfEmail) {
  const c = l.clients || {};
  const borrower = ((c.first_name || '') + ' ' + (c.last_name || '')).trim()
    || c.entity_name || c.email || '';
  return {
    id:           l.id,
    clientId:     l.client_id,
    ownerKey:     normalizeEmail(l.owner_email || ''),
    isSelf:       normalizeEmail(l.owner_email) === selfEmail,
    address:      l.address || '',
    status:       l.status || 'active',
    slaDisplayId: l.sla_display_id || '',
    toolType:     l.tool_type || '',
    loanAmt:      l.loan_amt || null,
    borrower,
    date:         l.updated_at || '',
  };
}

async function _searchLoansPG(q, wantAll, selfEmail) {
  // Loan address/notes FTS → first-class loan results. Each deep-links
  // to /loan-details/<id> client-side.
  const parts = [
    'select=' + encodeURIComponent(LOAN_SELECT),
    'search_tsv=wfts(simple).' + encodeURIComponent(q),
    'limit=' + (PER_CATEGORY * 2),
    'order=updated_at.desc',
  ];
  if (!wantAll) parts.push('owner_email=eq.' + encodeURIComponent(selfEmail));
  const rows = await _pgSelect('loans', parts.join('&'));
  return rows.map((l) => _rowToLoanResult(l, selfEmail));
}

// Deploy 236.383 — direct id / SLA-display-id lookup. The FTS tsv only
// covers address + notes, so searching "SLA-20260710-7065" or a loan id
// fragment found nothing. Case-insensitive substring match on both
// columns; only fires at 3+ chars to keep the ilike cheap.
async function _searchLoansByIdPG(q, wantAll, selfEmail) {
  if (q.length < 3) return [];
  const frag = q.replace(/[(),]/g, ''); // strip PostgREST syntax chars
  const parts = [
    'select=' + encodeURIComponent(LOAN_SELECT),
    'or=' + encodeURIComponent('(id.ilike.*' + frag + '*,sla_display_id.ilike.*' + frag + '*)'),
    'limit=' + PER_CATEGORY,
    'order=updated_at.desc',
  ];
  if (!wantAll) parts.push('owner_email=eq.' + encodeURIComponent(selfEmail));
  const rows = await _pgSelect('loans', parts.join('&'));
  return rows.map((l) => _rowToLoanResult(l, selfEmail));
}

function _rowToClientResult(c, selfEmail) {
  const name = ((c.first_name || '') + ' ' + (c.last_name || '')).trim();
  const ownerKey = keySafe(c.owner_email || '');
  const loanCount = Array.isArray(c.loans) ? c.loans.length : 0;
  const isSelf = normalizeEmail(c.owner_email) === selfEmail;
  return {
    id:        c.id,
    ownerKey,
    isBroker:  !!c.is_broker,
    name:      name || c.entity_name || c.email || 'Client',
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
