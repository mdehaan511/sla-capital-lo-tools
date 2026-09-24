#!/usr/bin/env node
/**
 * scripts/pg-read-budget-test.mjs — Deploy 237.264
 *
 * The 2026-09-24 Supabase outage: every Postgres read hung until Netlify's 30 s gateway kill
 * ("Inactivity Timeout"), so Loan Details, the Leads page and the client list died at 30 s
 * while their blob fallbacks -- which only run once the read THROWS -- never got a chance.
 * Now a read has a total budget (12 s default, PG_READ_BUDGET_MS) and fails fast with a
 * recognisable error; the 5xx storm that follows folds into one Slack line.
 *
 * What would hurt, so what this guards (the real modules are loaded with their imports
 * stubbed and RUN, with a fetch that hangs until aborted):
 *   1. A hung read no longer giving up inside the budget, or giving up without the
 *      `pgDegraded` marker / message the pages and the alerter recognise.
 *   2. The budget eating the ordinary transient retry (a 503 then a 200 must still succeed).
 *   3. Writes being cut short -- a write keeps its full 22 s and is never replayed.
 *   4. The alert fold: a budget failure must post under ONE source/message; an ordinary 500
 *      must still post under its endpoint with its own message.
 *
 * Run: node scripts/pg-read-budget-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

let fail = 0;
const check = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok ? '' : '\n         got  ' + JSON.stringify(got) + '\n         want ' + JSON.stringify(want)));
  if (!ok) fail++;
};
const assert = (name, cond) => { console.log((cond ? '  ok   ' : '  FAIL ') + name); if (!cond) fail++; };
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const readFn = (p) => readFileSync(new URL(p, FN), 'utf8');

async function loadFunction(file, stubs, extraGlobals) {
  const src = readFn(file);
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, clearTimeout, URL, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, parseInt, parseFloat, isFinite, encodeURIComponent, AbortSignal, Response, Headers, process: { env: {} } }, extraGlobals || {}));
  const namesFor = (spec) => {
    const wanted = new Set();
    const esc = spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let m;
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + esc + '[\'"]', 'g');
    while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach((n) => wanted.add(n));
    const dre = new RegExp('const\\s*\\{([^}]*)\\}\\s*=\\s*await import\\([\'"]' + esc + '[\'"]\\)', 'g');
    while ((m = dre.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s*:\s*/)[0]).filter(Boolean).forEach((n) => wanted.add(n));
    Object.keys(stubs[spec] || {}).forEach((n) => wanted.add(n));
    return [...wanted];
  };
  const synth = (spec) => {
    const table = stubs[spec] || {};
    const names = namesFor(spec);
    return new vm.SyntheticModule(names, function () { names.forEach((n) => this.setExport(n, (n in table) ? table[n] : (() => undefined))); }, { context: ctx, identifier: spec });
  };
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file, importModuleDynamically: async (spec) => { const m = synth(spec); await m.link(() => {}); await m.evaluate(); return m; } });
  await mod.link(async (spec) => synth(spec));
  await mod.evaluate();
  return mod.namespace;
}

// a fetch that hangs until its signal aborts, or answers from a script of responses
const mkFetch = (script) => {
  const calls = [];
  const fetch = (url, o) => {
    calls.push({ url: String(url), method: o && o.method });
    const step = script.length ? script.shift() : 'hang';
    if (step === 'hang') return new Promise((_, reject) => { const s = o && o.signal; if (s) s.addEventListener('abort', () => reject(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }))); });
    return Promise.resolve({ ok: step.status < 400, status: step.status, text: async () => JSON.stringify(step.body === undefined ? [] : step.body), headers: new Headers() });
  };
  return { fetch, calls };
};
const timeouts = [];
const AS = { timeout: (ms) => { timeouts.push(ms); return AbortSignal.timeout(ms); } };
// AbortSignal.timeout's timer is unref'd, so a test that waits on a hung fetch would let the
// event loop drain and the process exit silently before the abort ever fires. Keep it alive.
const keepAlive = setInterval(() => {}, 500);
process.on('exit', () => clearInterval(keepAlive));
const loadDb = (fetch, budget) => loadFunction('_shared/supabase-db.mjs', {}, { fetch, AbortSignal: AS, process: { env: { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'k', PG_READ_BUDGET_MS: String(budget) } } });

console.log('\nA read gives up inside its budget and says why');
{
  timeouts.length = 0;
  const f = mkFetch([]); // every attempt hangs
  const M = await loadDb(f.fetch, 3000);
  const t0 = Date.now();
  let err = null;
  try { await M.db.select('clients', { select: 'id', limit: 1 }); } catch (e) { err = e; }
  const spent = Date.now() - t0;
  check('a hung read rejects inside the budget (3 s here), not at the 22 s socket timeout', [!!err, spent >= 2800 && spent < 5000], [true, true]);
  check('...with the marker and the message the pages and the alerter recognise', [err && err.pgDegraded, /PG read budget exhausted after \d+ms \(database slow or down\)/.test(err && err.message), (err && err.cause && err.cause.name)], [true, true, 'AbortError']);
  check('...one attempt, and its socket timeout was the budget, not 22 s', [f.calls.length, timeouts.length, timeouts[0] <= 3000 && timeouts[0] >= 1500], [1, 1, true]);
}

console.log('\nThe ordinary transient retry still works inside the budget');
{
  timeouts.length = 0;
  const f = mkFetch([{ status: 503, body: { message: 'upstream' } }, { status: 200, body: [{ id: 'c_1' }] }]);
  const M = await loadDb(f.fetch, 12000);
  const rows = await M.db.select('clients', { select: 'id' });
  check('a 503 then a 200: retried, rows returned, two attempts', [rows, f.calls.length], [[{ id: 'c_1' }], 2]);
  check('...each attempt bounded by what is left of the budget (never more than the budget, never below the floor)', timeouts.every((t) => t <= 12000 && t >= 1500) && timeouts[1] <= timeouts[0], true);
  const g = mkFetch([{ status: 400, body: { message: 'bad query' } }]);
  const N = await loadDb(g.fetch, 12000);
  let err = null; try { await N.db.select('clients', {}); } catch (e) { err = e; }
  check('a 4xx is still our own bug: no retry, no degraded marker', [g.calls.length, err && err.status, !!(err && err.pgDegraded)], [1, 400, false]);
}

console.log('\nWrites are untouched');
{
  timeouts.length = 0;
  const f = mkFetch([{ status: 201, body: [{ id: 'n' }] }]);
  const M = await loadDb(f.fetch, 3000);
  const out = await M.db.insert('notes', { id: 'n' });
  check('an insert runs once with the full 22 s socket timeout regardless of the read budget', [out, f.calls[0].method, timeouts[0]], [[{ id: 'n' }], 'POST', 22000]);
}

console.log('\nThe alert fold in json()');
{
  const alerts = [];
  const M = await loadFunction('_shared/auth.mjs', {
    './error-alert.mjs': { alertServerError: (p) => { alerts.push(p); }, inferSourceFromStack: () => 'clients-list-pg.mjs' },
  }, { Response, Headers });
  M.json(500, { error: 'Failed to load clients', reason: 'PG read budget exhausted after 12004ms (database slow or down): This operation was aborted' });
  M.json(500, { error: 'Failed to load quotes', reason: 'PostgREST GET quotes → HTTP 503: upstream' });
  M.json(200, { ok: true });
  await new Promise((r) => setTimeout(r, 30));
  check('a budget failure posts under ONE source and ONE message, naming the endpoint and the reason in the extra line', [alerts.length, alerts[0] && alerts[0].source, alerts[0] && alerts[0].message, /first seen from clients-list-pg\.mjs -- PG read budget exhausted/.test(alerts[0] && alerts[0].extra)], [2, 'postgres-degraded', 'Postgres reads are timing out; pages are falling back to blobs or failing fast', true]);
  check('an ordinary 500 still posts under its endpoint with its own message and reason', [alerts[1] && alerts[1].source, alerts[1] && alerts[1].message, alerts[1] && alerts[1].extra], ['clients-list-pg.mjs', 'Failed to load quotes', 'reason: PostgREST GET quotes → HTTP 503: upstream']);
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
