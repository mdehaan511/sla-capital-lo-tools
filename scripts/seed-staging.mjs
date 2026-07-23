#!/usr/bin/env node
/**
 * scripts/seed-staging.mjs — copy N sanitized clients + their loans
 * from the production Supabase project into the staging project.
 * Hardening Phase B3 (see PLATFORM_HARDENING.md).
 *
 * Staging needs realistic-shaped data (real statuses, broker loans,
 * guarantor arrays, form_data snapshots) for the smoke suite and
 * manual testing — but it must NOT hold live borrower PII. So we
 * copy structure and scrub identity:
 *
 *   clients: ssn_enc/ssn_last4/dob → null, phone masked, email →
 *            deterministic seed-<n>@staging.test (uniqueness kept so
 *            email-matching flows still work), home/mailing address →
 *            null, notes/notes_log/extra blanked.
 *   loans:   notes/notes_log/extra blanked; form_data kept (sizer
 *            fields drive pricing tests) but SSN-shaped strings and
 *            email addresses are pattern-scrubbed throughout.
 *
 * FK integrity: broker_id and guarantor_client_ids reference client
 * rows, so any referenced client outside the sample is pulled in too
 * (sanitized the same way).
 *
 * Usage:
 *   SOURCE_URL=https://<prod>.supabase.co  SOURCE_KEY=<prod service role> \
 *   TARGET_URL=https://<staging>.supabase.co TARGET_KEY=<staging service role> \
 *   SEED_LIMIT=25 node scripts/seed-staging.mjs
 *
 * Optional: SEED_OWNER=<lo email> to sample one LO's book only.
 * Idempotent — upserts by id, safe to re-run.
 */

// Accept both the bare project URL and the REST endpoint URL the
// dashboard shows in some places — we append /rest/v1 ourselves.
function _normUrl(u) {
  return String(u || '').replace(/\/+$/, '').replace(/\/rest\/v1$/i, '').replace(/\/+$/, '');
}
const SOURCE_URL = _normUrl(process.env.SOURCE_URL);
const SOURCE_KEY = process.env.SOURCE_KEY || '';
const TARGET_URL = _normUrl(process.env.TARGET_URL);
const TARGET_KEY = process.env.TARGET_KEY || '';
const LIMIT = Math.max(1, Number(process.env.SEED_LIMIT || 25));
const OWNER = (process.env.SEED_OWNER || '').trim().toLowerCase();

if (!SOURCE_URL || !SOURCE_KEY || !TARGET_URL || !TARGET_KEY) {
  console.error('Required env: SOURCE_URL, SOURCE_KEY, TARGET_URL, TARGET_KEY (service role keys).');
  process.exit(1);
}
if (SOURCE_URL.toLowerCase() === TARGET_URL.toLowerCase()) {
  console.error('TARGET_URL equals SOURCE_URL — refusing to write sanitized rows back into the source project.');
  process.exit(1);
}

function headers(key, extra) {
  return {
    apikey: key,
    Authorization: 'Bearer ' + key,
    'Content-Type': 'application/json',
    ...(extra || {}),
  };
}

async function pgGet(base, key, table, qs) {
  const res = await fetch(base + '/rest/v1/' + table + '?' + qs, { headers: headers(key) });
  if (!res.ok) throw new Error('GET ' + table + ' → HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  return res.json();
}

async function pgUpsert(base, key, table, rows) {
  // Chunked so a big sample doesn't blow request-size limits.
  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const slice = rows.slice(i, i + CHUNK);
    const res = await fetch(base + '/rest/v1/' + table + '?on_conflict=id', {
      method: 'POST',
      headers: headers(key, { Prefer: 'resolution=merge-duplicates,return=minimal' }),
      body: JSON.stringify(slice),
    });
    if (!res.ok) throw new Error('UPSERT ' + table + ' → HTTP ' + res.status + ': ' + (await res.text()).slice(0, 300));
  }
}

// ── Sanitizers ──────────────────────────────────────────────────────
let emailSeq = 0;
const emailMap = new Map(); // real email → stable fake, so cross-record matching survives
function fakeEmail(real) {
  const norm = String(real || '').trim().toLowerCase();
  if (!norm) return null;
  if (!emailMap.has(norm)) emailMap.set(norm, 'seed-' + (++emailSeq) + '@staging.test');
  return emailMap.get(norm);
}

function scrubText(s) {
  // SSN-shaped digits and email addresses, wherever they hide.
  return String(s)
    .replace(/\b\d{3}-\d{2}-\d{4}\b/g, '000-00-0000')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => fakeEmail(m) || 'seed@staging.test');
}

function sanitizeClient(c) {
  return {
    ...c,
    email: fakeEmail(c.email),
    phone: c.phone ? '(555) 555-01' + String(emailSeq % 100).padStart(2, '0') : null,
    ssn_enc: null,
    ssn_last4: null,
    dob: null,
    home_address: null,
    mailing_address: null,
    notes: '',
    notes_log: [],
    extra: {},
    search_tsv: undefined, // generated column — must not be sent
  };
}

function sanitizeLoan(l) {
  let formData = l.form_data || {};
  try { formData = JSON.parse(scrubText(JSON.stringify(formData))); } catch (_) { formData = {}; }
  return {
    ...l,
    form_data: formData,
    notes: '',
    notes_log: [],
    extra: {},
    search_tsv: undefined,
  };
}

// ── Main ────────────────────────────────────────────────────────────
console.log('Seeding staging from ' + SOURCE_URL + ' → ' + TARGET_URL);
console.log('Sample: ' + LIMIT + ' most-recent clients' + (OWNER ? ' owned by ' + OWNER : '') + '\n');

const ownerFilter = OWNER ? '&owner_email=eq.' + encodeURIComponent(OWNER) : '';
const clients = await pgGet(SOURCE_URL, SOURCE_KEY, 'clients',
  'select=*&order=updated_at.desc&limit=' + LIMIT + ownerFilter);
if (!clients.length) { console.error('Source returned 0 clients — check keys/filter.'); process.exit(1); }

const ids = new Set(clients.map((c) => c.id));
const loans = [];
{
  // PostgREST in= lists cap out on URL length — chunk the id filter.
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 40) {
    const chunk = idList.slice(i, i + 40).map((id) => '"' + id + '"').join(',');
    loans.push(...await pgGet(SOURCE_URL, SOURCE_KEY, 'loans',
      'select=*&client_id=in.(' + chunk + ')'));
  }
}

// Pull in FK-referenced clients (brokers, guarantors) outside the sample.
const refIds = new Set();
for (const l of loans) {
  if (l.broker_id && !ids.has(l.broker_id)) refIds.add(l.broker_id);
  for (const g of (l.guarantor_client_ids || [])) if (g && !ids.has(g)) refIds.add(g);
}
if (refIds.size) {
  const refList = [...refIds];
  for (let i = 0; i < refList.length; i += 40) {
    const chunk = refList.slice(i, i + 40).map((id) => '"' + id + '"').join(',');
    const extra = await pgGet(SOURCE_URL, SOURCE_KEY, 'clients', 'select=*&id=in.(' + chunk + ')');
    for (const c of extra) { if (!ids.has(c.id)) { ids.add(c.id); clients.push(c); } }
  }
  // Anything STILL unresolved (dangling FK in source) gets nulled so the insert succeeds.
  for (const l of loans) {
    if (l.broker_id && !ids.has(l.broker_id)) l.broker_id = null;
    l.guarantor_client_ids = (l.guarantor_client_ids || []).filter((g) => ids.has(g));
  }
}

console.log('Copying ' + clients.length + ' clients (' + refIds.size + ' pulled in via FKs) + ' + loans.length + ' loans…');

const cleanClients = clients.map(sanitizeClient).map((c) => { delete c.search_tsv; return c; });
const cleanLoans = loans.map(sanitizeLoan).map((l) => { delete l.search_tsv; return l; });

await pgUpsert(TARGET_URL, TARGET_KEY, 'clients', cleanClients); // parents first (loans FK)
await pgUpsert(TARGET_URL, TARGET_KEY, 'loans', cleanLoans);

// Verify counts on the target.
const tc = await pgGet(TARGET_URL, TARGET_KEY, 'clients', 'select=id&limit=1000');
const tl = await pgGet(TARGET_URL, TARGET_KEY, 'loans', 'select=id&limit=1000');
console.log('\nDone. Staging now has ' + tc.length + (tc.length === 1000 ? '+' : '') + ' clients, '
  + tl.length + (tl.length === 1000 ? '+' : '') + ' loans.');
console.log('All SSNs, DOBs, personal addresses, phones, and emails were scrubbed.');
