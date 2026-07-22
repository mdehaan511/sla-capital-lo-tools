#!/usr/bin/env node
/**
 * scripts/smoke.mjs — end-to-end smoke test for SLA Loan Tools.
 * Hardening Phase B4 (see PLATFORM_HARDENING.md).
 *
 * Exercises the read paths always, and (opt-in) the full write
 * lifecycle a loan goes through: sizer save → PG read-back →
 * search → quote sync → status advance → close → cleanup. Every
 * step asserts the exact response shapes the frontend depends on,
 * so a broken deploy fails HERE instead of in front of an LO.
 *
 * Usage:
 *   SMOKE_URL=https://staging--slaloantools.netlify.app \
 *   SMOKE_JWT=<jwt for an admin test user> \
 *   SMOKE_WRITES=1 node scripts/smoke.mjs
 *
 * Env:
 *   SMOKE_URL     Base URL. Default http://localhost:8888 (netlify dev).
 *   SMOKE_JWT     Bearer token. Grab one from the browser console on a
 *                 logged-in page:  await netlifyIdentity.currentUser().jwt()
 *                 Must be an ADMIN user — health-check and status moves
 *                 beyond 'approved' require it.
 *   SMOKE_WRITES  '1' enables the write-lifecycle suite. REFUSED against
 *                 production hostnames unless SMOKE_FORCE_PROD_WRITES=1
 *                 (the write suite creates + deletes a throwaway client;
 *                 safe in principle, but staging is what it's for).
 *
 * Exit code: 0 all green, 1 any failure. No dependencies; Node 18+.
 */

const BASE = (process.env.SMOKE_URL || 'http://localhost:8888').replace(/\/+$/, '');
const JWT = process.env.SMOKE_JWT || '';
const WRITES = process.env.SMOKE_WRITES === '1';
const PROD_HOSTS = ['slaloantools.netlify.app', 'portal.slacapital.ai'];

if (!JWT) {
  console.error('SMOKE_JWT is required. In a logged-in browser tab run:');
  console.error('  await netlifyIdentity.currentUser().jwt()');
  process.exit(1);
}
if (WRITES && PROD_HOSTS.some((h) => BASE.includes(h)) && process.env.SMOKE_FORCE_PROD_WRITES !== '1') {
  console.error('Refusing SMOKE_WRITES=1 against production (' + BASE + ').');
  console.error('Point SMOKE_URL at staging, or set SMOKE_FORCE_PROD_WRITES=1 if you really mean it.');
  process.exit(1);
}

// ── Tiny harness ────────────────────────────────────────────────────
let passed = 0, failed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else {
    failed++;
    failures.push(name + (detail ? ' — ' + detail : ''));
    console.log('  ✗ ' + name + (detail ? '\n      ' + detail : ''));
  }
  return !!cond;
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Bearer ' + JWT,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

function section(title) { console.log('\n' + title); }

// ── Read-only suite ─────────────────────────────────────────────────
async function readSuite() {
  section('READ PATHS  (' + BASE + ')');

  const health = await api('GET', '/api/health-check');
  ok('health-check returns 200', health.status === 200, 'got ' + health.status + ' ' + JSON.stringify(health.body));
  if (health.status === 401 || health.status === 403) {
    console.error('\nJWT rejected or not admin — remaining checks would all fail the same way. Aborting.');
    process.exit(1);
  }
  ok('health-check reports ok', health.body && health.body.ok === true,
    health.body && health.body.problems ? health.body.problems.join(' | ') : 'no report');

  const clients = await api('GET', '/api/clients-list-pg');
  ok('clients-list-pg returns 200 + clients[]',
    clients.status === 200 && clients.body && Array.isArray(clients.body.clients),
    'got ' + clients.status);
  ok('clients-list-pg served from postgres',
    !clients.body || clients.body._source !== 'blobs-fallback',
    'fell back to blob scan — PG likely unreachable');

  const quotes = await api('GET', '/api/quotes-list');
  ok('quotes-list returns 200 + quotes[]',
    quotes.status === 200 && quotes.body && Array.isArray(quotes.body.quotes),
    'got ' + quotes.status);

  const prospects = await api('GET', '/api/prospects-list');
  ok('prospects-list returns 200',
    prospects.status === 200 && !!prospects.body, 'got ' + prospects.status);

  const search = await api('GET', '/api/search-pg?q=test');
  ok('search-pg returns 200 with all five categories',
    search.status === 200 && search.body &&
    ['loans', 'clients', 'brokers', 'prospects', 'quotes'].every((k) => Array.isArray(search.body[k])),
    'got ' + search.status + ' keys=' + (search.body ? Object.keys(search.body).join(',') : 'none'));
  ok('search-pg served from postgres',
    !search.body || search.body._source === 'postgres',
    'source=' + (search.body && search.body._source));
}

// ── Write-lifecycle suite ───────────────────────────────────────────
// Full journey of one throwaway loan. The unique street name makes the
// search assertion unambiguous and the cleanup verifiable.
async function writeSuite() {
  const stamp = Date.now();
  const marker = 'Smoketest' + stamp;
  const address = '123 ' + marker + ' St, Spokane, WA 99208';
  let clientId = null, loanId = null, ownerKey = null, quoteId = null;

  section('WRITE LIFECYCLE  (throwaway loan: ' + address + ')');

  // 1. Sizer save — creates client + loan + synced quote in one call.
  const save = await api('POST', '/api/sizer-save-loan', {
    toolType: 'dscr',
    borrower: { firstName: 'Smoke', lastName: 'Test', email: 'smoke-' + stamp + '@example.com' },
    loan: {
      address,
      loanAmt: 100000,
      loanPurpose: 'purchase',
      rate: 7.5,
      ltv: 70,
    },
  });
  const saved = ok('sizer-save-loan creates client + loan',
    save.status === 200 && save.body && save.body.ok === true && !!save.body.clientId && !!save.body.loanId,
    'got ' + save.status + ' ' + JSON.stringify(save.body));
  if (!saved) return; // everything downstream depends on this
  clientId = save.body.clientId;
  loanId = save.body.loanId;
  ownerKey = save.body.ownerKey;

  // 2. PG read-back — the write→read consistency that silently broke
  //    for weeks pre-strict-writes. THE regression this suite exists for.
  const get1 = await api('GET', '/api/client-get-pg?clientId=' + encodeURIComponent(clientId));
  const loan1 = get1.body && get1.body.client && (get1.body.client.loans || []).find((l) => l.id === loanId);
  ok('client-get-pg sees the new loan immediately', get1.status === 200 && !!loan1,
    'got ' + get1.status + (get1.body && get1.body.client ? ' loans=' + JSON.stringify((get1.body.client.loans || []).map((l) => l.id)) : ' ' + JSON.stringify(get1.body)));

  // 3. Search consistency — the unique marker must surface the loan.
  const search = await api('GET', '/api/search-pg?q=' + encodeURIComponent(marker));
  ok('search-pg finds the new loan',
    search.status === 200 && search.body && (search.body.loans || []).some((l) => l.id === loanId || l.loanId === loanId),
    'loans=' + JSON.stringify(search.body && search.body.loans));

  // 4. Quote sync — the sizer save must have mirrored into the quotes store.
  const quotes = await api('GET', '/api/quotes-list');
  const syncedQuote = quotes.body && (quotes.body.quotes || []).find((q) => q.loanId === loanId);
  ok('quote store received the synced quote', !!syncedQuote,
    'no quote with loanId=' + loanId);
  quoteId = syncedQuote && syncedQuote.id;

  // 5. Status advance (admin path).
  const adv = await api('POST', '/api/loan-advance-status', {
    clientId, loanId, newStatus: 'approved',
  });
  ok('loan-advance-status → approved', adv.status === 200,
    'got ' + adv.status + ' ' + JSON.stringify(adv.body));

  // 6. Close via quotes-close (the Leads "Mark Closed" path) — must
  //    update the quote AND flip the loan (loansUpdated ≥ 1: the
  //    Trevor St bug class).
  if (quoteId) {
    const close = await api('POST', '/api/quotes-close', {
      ownerKey, quoteId, finalLoanAmount: 100000, commissionRate: 50,
    });
    ok('quotes-close succeeds and updates the loan',
      close.status === 200 && close.body && (close.body.loansUpdated || 0) >= 1,
      'got ' + close.status + ' loansUpdated=' + (close.body && close.body.loansUpdated) + ' loanSyncError=' + (close.body && close.body.loanSyncError));

    const get2 = await api('GET', '/api/client-get-pg?clientId=' + encodeURIComponent(clientId));
    const loan2 = get2.body && get2.body.client && (get2.body.client.loans || []).find((l) => l.id === loanId);
    ok('loan status is closed after quotes-close', !!loan2 && loan2.status === 'closed',
      'status=' + (loan2 && loan2.status));
  }

  // 7. Cleanup — delete the throwaway records, then verify they're gone
  //    from PG (delete-path strict-write check).
  section('CLEANUP');
  if (quoteId) {
    const dq = await api('POST', '/api/quotes-delete', { quoteId });
    ok('quotes-delete', dq.status === 200, 'got ' + dq.status + ' ' + JSON.stringify(dq.body));
  }
  const dc = await api('POST', '/api/clients-delete', { clientId });
  ok('clients-delete', dc.status === 200, 'got ' + dc.status + ' ' + JSON.stringify(dc.body));

  const get3 = await api('GET', '/api/client-get-pg?clientId=' + encodeURIComponent(clientId));
  ok('client gone from PG after delete', get3.status === 404 || !(get3.body && get3.body.client),
    'got ' + get3.status);
}

// ── Run ─────────────────────────────────────────────────────────────
console.log('SLA smoke test — ' + new Date().toISOString());
await readSuite();
if (WRITES) await writeSuite();
else console.log('\n(write lifecycle skipped — set SMOKE_WRITES=1 to enable)');

console.log('\n────────────────────────────────');
console.log('PASS ' + passed + '  FAIL ' + failed);
if (failed) {
  console.log('\nFailures:');
  failures.forEach((f) => console.log('  • ' + f));
  process.exit(1);
}
