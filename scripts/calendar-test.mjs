#!/usr/bin/env node
/**
 * scripts/calendar-test.mjs — Deploy 237.271 (Mike, MY DESK step 2)
 *
 * The key-dates calendars: closings, BPO / Appraisal inspections, DSCR rate-lock
 * expirations (Mike: "you dont need to add maturity dates"), the whole month, each day's
 * items previewed in the cell and listed in a day panel, every event a link to the loan,
 * person toggles that are SAVED ("so it doesnt default to just them every time").
 *
 * Runs: the event rules (_shared/calendar-events.mjs), both endpoints through the stubbed-
 * import harness, and the real sla-calendar.js against a fake page (mount, clicks, saved
 * prefs, month change). Plus the backfill's one-loan-id-twice fix.
 *
 * Run: node scripts/calendar-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}
const C = await import('../deploy/netlify/functions/_shared/calendar-events.mjs');
const D = await import('../deploy/netlify/functions/_shared/desk-tasks.mjs');

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };
const read = (p) => readFileSync(new URL('../deploy/' + p, import.meta.url), 'utf8');
const JESSY = { email: 'Jessy@SLAcapital.com', name: 'Jessy', role: 'processor' };
const BETH = { email: 'beth@slacapital.com', name: 'Beth', role: 'processor' };
const DEE = { email: 'diana@slacapital.com', name: 'Dee', role: 'underwriter' };

// ── 1. what a loan puts on the calendar ─────────────────────────────────────
console.log('\nWhat each loan contributes');
const row = (id, x) => Object.assign({ id, clientId: 'c_' + id, owner: 'Carl.Davis@slacapital.com', address: id + ' Oak St, Macon, GA', status: 'active', processingStage: 'processing', loanAmt: '250000', toolType: 'rtl', assignedProcessors: [JESSY] }, x || {});
{
  const F = '2026-08-30', T = '2026-10-10';
  let e = C.eventsForLoan(row('a', { fundingDate: '2026-09-30' }), F, T);
  check('a closing date inside the window is a closing', e.map((x) => [x.type, x.date, x.closed, x.program, x.amount]), [['closing', '2026-09-30', false, 'RTL', 250000]]);
  check('...belonging to the LO and the team, lower-cased, once each', e[0].people, ['carl.davis@slacapital.com', 'jessy@slacapital.com']);
  check('outside the window: nothing', C.eventsForLoan(row('a', { fundingDate: '2026-10-11' }), F, T).length, 0);
  check('a closed loan keeps its closing, marked closed', C.eventsForLoan(row('a', { fundingDate: '2026-09-02', processingStage: 'pp_closed', status: 'closed' }), F, T).map((x) => x.closed), [true]);
  // Deploy 237.273 -- only loans on the pipeline board (or closed) have a closing on the calendar
  check('a lead or a quote with a planned close date is NOT a closing (73 of September\'s 121 were)', [C.eventsForLoan(row('a', { fundingDate: '2026-09-30', processingStage: '' }), F, T).length, C.eventsForLoan(row('a', { fundingDate: '2026-09-30', processingStage: '', status: 'awaiting_app' }), F, T).length], [0, 0]);
  check('...nor is a loan on hold', C.eventsForLoan(row('a', { fundingDate: '2026-09-30', status: 'on_hold' }), F, T).length, 0);
  check('...but every board stage is, and an approved loan with no stage yet (Intake)', ['new_loan', 'processing', 'underwriting', 'pp_approved'].map((s) => C.eventsForLoan(row('a', { fundingDate: '2026-09-30', processingStage: s, status: 'approved' }), F, T).length).concat(C.eventsForLoan(row('a', { fundingDate: '2026-09-30', processingStage: '', status: 'approved' }), F, T).length), [1, 1, 1, 1, 1]);
  check('cancelled / denied loans have no events at all', [C.eventsForLoan(row('a', { fundingDate: '2026-09-30', status: 'cancelled' }), F, T).length, C.eventsForLoan(row('a', { fundingDate: '2026-09-30', status: 'denied' }), F, T).length], [0, 0]);
  e = C.eventsForLoan(row('b', { valuationOrder: { kind: 'appraisal', vendor: 'Class Valuation', scheduledDate: '2026-09-28' } }), F, T);
  check('a scheduled BPO / Appraisal is an inspection, with what and who', e.map((x) => [x.type, x.date, x.kind, x.vendor]), [['inspection', '2026-09-28', 'Appraisal', 'Class Valuation']]);
  check('an order with no date yet is not on the calendar', C.eventsForLoan(row('b', { valuationOrder: { kind: 'bpo', vendor: 'X', scheduledDate: '' } }), F, T).length, 0);
  check('DSCR lock: 45 days from the lock start, as a Pacific date', C.rateLockExpiry({ toolType: 'dscr', rateLockStart: '2026-08-20T18:00:00Z' }), '2026-10-04');
  check('...a late-evening Pacific start is still that Pacific day', C.rateLockExpiry({ toolType: 'dscr', rateLockStart: '2026-08-21T04:30:00Z' }), '2026-10-04');
  check('...legacy loans fall back to the signing date (the Loan Details counter\'s rule)', C.rateLockExpiry({ toolType: 'DSCR', borrowerInfoCompletedAt: '2026-08-20T18:00:00Z' }), '2026-10-04');
  check('no lock for RTL, closed, sold, or a loan in the Closed stage', [C.rateLockExpiry({ toolType: 'rtl', rateLockStart: '2026-08-20T18:00:00Z' }), C.rateLockExpiry({ toolType: 'dscr', status: 'closed', rateLockStart: '2026-08-20T18:00:00Z' }), C.rateLockExpiry({ toolType: 'dscr', status: 'sold', rateLockStart: '2026-08-20T18:00:00Z' }), C.rateLockExpiry({ toolType: 'dscr', processingStage: 'pp_closed', rateLockStart: '2026-08-20T18:00:00Z' })], ['', '', '', '']);
  const ld = read('loan-details.js');
  assert('the 45 days and the dead-status list are the Loan Details counter\'s own', /t \+ 45 \* 86400000/.test(ld) && /\['closed', 'cancelled', 'denied', 'sold', 'liquidated', 'paid_off'\]/.test(ld) && C.LOCK_DAYS === 45);
  const all = C.eventsFor([
    row('z', { fundingDate: '2026-09-28' }),
    row('b', { valuationOrder: { kind: 'bpo', vendor: 'SL', scheduledDate: '2026-09-28' } }),
    row('c', { toolType: 'dscr', rateLockStart: '2026-08-14T18:00:00Z' }),
    row('a', { fundingDate: '2026-09-28' }),
  ], F, T);
  check('one day reads closings, then inspections, then locks; addresses in order', all.map((x) => x.type + ':' + x.loanId), ['closing:a', 'closing:z', 'inspection:b', 'rate_lock:c']);
  check('no maturity dates, ever', C.CAL_TYPES, ['closing', 'inspection', 'rate_lock']);
}

// ── 2. the backfill fix ─────────────────────────────────────────────────────
console.log('\nOne loan id on two client records gets ONE set of desk tasks');
{
  const L = (clientId) => ({ id: 'l_dup', clientId, ownerKey: 'carl.davis@slacapital.com', status: 'approved', processingStage: 'underwriting', assignedProcessors: [JESSY] });
  const plan = D.planDeskBackfill({ loans: [L('b_broker_copy'), L('c_lo_borrower')], reviewsByLoan: {}, existing: {} });
  check('four tasks, not eight (1518 E 28th St)', plan.tasks.length, 4);
}

// ── the harness ─────────────────────────────────────────────────────────────
async function loadModule(file, stubs) {
  const src = read('netlify/functions/' + file);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: {} }, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, isFinite, URL, Intl });
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const ex = {}; wanted.forEach((n) => { ex[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(ex), function () { Object.keys(ex).forEach((k) => this.setExport(k, ex[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  return mod.namespace;
}
const AUTH = (user) => ({
  handleOptions: () => null, json: (status, body) => ({ status, body }), requireAuth: async () => user,
  readJsonBody: async (req) => req.body, normalizeEmail: (s) => String(s || '').trim().toLowerCase(), keySafe: (s) => String(s || '').replace(/[:/\\]/g, '_'),
});

// ── 3. the feed ─────────────────────────────────────────────────────────────
console.log('\nGET /api/calendar-events');
{
  const pg = (id, x) => Object.assign({ id, client_id: 'c_' + id, owner_email: 'carl.davis@slacapital.com', address: id + ' Oak St', status: 'active', processing_stage: 'processing', loan_amt: '100000', tool_type: 'dscr', funding_date: '2026-09-30', assigned_processors: [BETH], clients: { first_name: 'Ann', last_name: 'Lee', entity_name: '' } }, x || {});
  const rows = [pg('mine', { owner_email: 'sara.s@slacapital.com', assigned_processors: [] }), pg('team', { assigned_processors: [JESSY] }), pg('other'), pg('llc', { clients: { first_name: 'Ann', last_name: 'Lee', entity_name: 'Oak Holdings LLC' }, rate_lock_start: '2026-08-20T18:00:00Z', funding_date: null })];
  const run = async (user, qs, staff) => {
    const selects = [];
    const ns = await loadModule('calendar-events.mjs', {
      './_shared/auth.mjs': AUTH(user),
      './_shared/access.mjs': { canListAllClients: () => ({ ok: !!staff }) },
      './_shared/supabase-db.mjs': { db: { select: async (t, o) => { selects.push(o.select); return o.offset ? [] : rows; } } },
      './_shared/calendar-events.mjs': C,
    });
    const r = await ns.default({ method: 'GET', url: 'https://x/api/calendar-events?' + qs, headers: { get: () => '' } }, {});
    return { r, selects, ns };
  };
  let x = await run({ email: 'jessy@slacapital.com' }, 'from=2026-08-30&to=2026-10-10', true);
  check('staff: every loan\'s events', [x.r.status, x.r.body.scope, x.r.body.events.map((e) => e.type + ':' + e.loanId)], [200, 'all', ['closing:mine', 'closing:other', 'closing:team', 'rate_lock:llc']]);
  check('...with the borrower (the entity when there is one) and the people list', [x.r.body.events[3].borrower, x.r.body.events[0].borrower, x.r.body.people.map((p) => p.email).sort()], ['Oak Holdings LLC', 'Ann Lee', ['beth@slacapital.com', 'carl.davis@slacapital.com', 'jessy@slacapital.com', 'sara.s@slacapital.com']]);
  assert('the read is lean: promoted columns, four JSON paths and the client name, not the whole extra blob', /valuation_order:extra->valuationOrder/.test(x.selects[0]) && /rate_lock_start:extra->>rateLockStart/.test(x.selects[0]) && /clients!client_id\(first_name,last_name,entity_name\)/.test(x.selects[0]) && !/,extra,|,extra$/.test(x.selects[0]));
  x = await run({ email: 'sara.s@slacapital.com' }, 'from=2026-08-30&to=2026-10-10', false);
  check('an LO: only loans they own', [x.r.body.scope, x.r.body.events.map((e) => e.loanId)], ['mine', ['mine']]);
  x = await run({ email: 'jessy@slacapital.com' }, 'from=2026-08-30&to=2026-10-10', false);
  check('...or are on the team of', x.r.body.events.map((e) => e.loanId), ['team']);
  x = await run({ email: 'jessy@slacapital.com' }, 'from=2026-10-10&to=2026-08-30', true);
  check('refused: backwards window, too long a window, not dates', [x.r.status, (await run({ email: 'j@x.com' }, 'from=2026-01-01&to=2026-06-01', true)).r.status, (await run({ email: 'j@x.com' }, 'from=9/1&to=9/30', true)).r.status], [400, 400, 400]);
}

// ── 4. saved toggles ────────────────────────────────────────────────────────
console.log('\n/api/user-prefs');
{
  const store = new Map();
  const mk = async (email) => (await loadModule('user-prefs.mjs', {
    '@netlify/blobs': { getStore: () => ({ get: async (k) => (store.has(k) ? JSON.parse(JSON.stringify(store.get(k))) : null), setJSON: async (k, v) => { store.set(k, JSON.parse(JSON.stringify(v))); } }) },
    './_shared/auth.mjs': AUTH({ email }),
  })).default;
  const h = await mk('Jessy@slacapital.com');
  let r = await h({ method: 'GET', headers: { get: () => '' } }, {});
  check('nothing saved yet', [r.status, r.body.prefs], [200, {}]);
  r = await h({ method: 'POST', headers: { get: () => '' }, body: { calendar: { desk: { people: ['Beth@slacapital.com', 'beth@slacapital.com', 'junk', 'raissa@slacapital.com'], types: { closing: true, rate_lock: false, maturity: true } }, bogus: { people: 'all' } } } }, {});
  check('the desk toggles are saved clean (lower-case, no junk, once each, known types only)', r.body.prefs.calendar, { desk: { people: ['beth@slacapital.com', 'raissa@slacapital.com'], types: { closing: true, rate_lock: false } } });
  r = await h({ method: 'POST', headers: { get: () => '' }, body: { calendar: { home: { people: 'all' } } } }, {});
  check('...the home calendar saves separately, and "Everyone" is a choice', [r.body.prefs.calendar.home, r.body.prefs.calendar.desk.people], [{ people: 'all' }, ['beth@slacapital.com', 'raissa@slacapital.com']]);
  check('...under the person\'s own key only', [...store.keys()], ['jessy@slacapital.com']);
}

// ── 5. the component ────────────────────────────────────────────────────────
console.log('\nsla-calendar.js on a page');
{
  const TODAY = new Date();
  const ym = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const dayIn = (n) => ym(TODAY) + '-' + String(n).padStart(2, '0');
  const rows = [
    row('a', { fundingDate: dayIn(20), assignedProcessors: [JESSY] }),
    row('b', { valuationOrder: { kind: 'bpo', vendor: 'ServiceLink', scheduledDate: dayIn(12) }, assignedProcessors: [BETH] }),
    row('c', { valuationOrder: { kind: 'appraisal', vendor: 'Class', scheduledDate: dayIn(20) }, assignedProcessors: [JESSY, DEE] }),
  ];
  function page(saved) {
    const calls = [];
    const w = { console, setTimeout, clearTimeout, Promise, Date, JSON, Math, Object, Array, String, Number, isFinite, encodeURIComponent };
    w.window = w;
    w.document = { createElement: () => ({ appendChild() {} }), createTextNode: (t) => t, head: { appendChild() {} }, body: { contains: () => true } };
    w.SLA = {
      urls: { loanDetails: (id, o) => '/loan-details/' + id + '?owner=' + o.owner },
      Users: { directory: () => Promise.resolve({ users: [{ email: 'beth@slacapital.com', name: 'Beth Ortiz' }] }) },
      api: (method, url, body) => {
        calls.push([method, url, body]);
        if (url === '/api/user-prefs' && method === 'GET') return Promise.resolve({ prefs: saved || {} });
        if (url === '/api/user-prefs') return Promise.resolve({ ok: true, prefs: {} });
        const m = /from=([\d-]+)&to=([\d-]+)/.exec(url);
        const ev = C.eventsFor(rows, m[1], m[2]);
        return Promise.resolve({ events: JSON.parse(JSON.stringify(ev)), people: [] });
      },
    };
    vm.createContext(w);
    vm.runInContext(read('sla-calendar.js'), w, { filename: 'sla-calendar.js' });
    return { w, calls };
  }
  const tick = () => new Promise((r) => setTimeout(r, 20));
  const el = () => { const e = { html: '', parentNode: {}, set innerHTML(v) { this.html = v; }, get innerHTML() { return this.html; } }; return e; };
  const target = (attrs, extra) => Object.assign({ getAttribute: (k) => (k in attrs ? attrs[k] : null), parentNode: null }, extra || {});

  let P = page(), E = el();
  P.w.SLA_CAL.mount(E, { surface: 'desk', me: 'jessy@slacapital.com', focus: 'jessy@slacapital.com', canSeeAll: true, defaultAll: false });
  await tick(); await tick();
  const fetches = P.calls.filter((c) => /calendar-events/.test(c[1]));
  check('the whole month (six weeks) is fetched once', [fetches.length, /from=\d{4}-\d{2}-\d{2}&to=\d{4}-\d{2}-\d{2}$/.test(fetches[0][1])], [1, true]);
  assert('the month grid: 42 days, today marked', (E.html.match(/class="scal-cell/g) || []).length === 42 && /scal-cell[^"]*today/.test(E.html));
  assert('Jessy\'s desk shows her loans\' events (a closing, the Appraisal on the same day), not Beth\'s BPO', /t-closing" href="\/loan-details\/a\?owner=carl\.davis@slacapital\.com"/.test(E.html) && /t-inspection" href="\/loan-details\/c/.test(E.html) && !/loan-details\/b\?/.test(E.html), E.html.slice(0, 200));
  assert('each pill previews the item and is a link to the loan', /title="Closing · a Oak St, Macon, GA · \$250,000">🏁 a Oak St</.test(E.html));
  // click the 20th → the day panel
  E.onclick({ target: target({ 'data-day': dayIn(20) }) });
  assert('clicking a day lists its items with their details, each a link', /scal-dayh">[A-Za-z]+day, [A-Za-z]+ 20 · 2 items/.test(E.html) && /class="scal-item t-closing" href="\/loan-details\/a/.test(E.html) && /Appraisal inspection/.test(E.html) && /Class · \$250,000 · RTL/.test(E.html) && /LO Carl · Proc\. Jessy/.test(E.html), (E.html.match(/scal-day">[\s\S]*$/) || [''])[0].slice(0, 400));
  // toggle Beth on
  E.onclick({ target: target({ 'data-people': 'toggle' }) });
  assert('the people panel offers Everyone and the team, the desk\'s person locked on', /data-all="1"/.test(E.html) && /data-person="jessy@slacapital.com" checked disabled/.test(E.html));
  E.onchange({ target: target({ 'data-person': 'beth@slacapital.com' }, { type: 'checkbox', checked: true }) });
  assert('switching Beth on adds her BPO', /t-inspection" href="\/loan-details\/b/.test(E.html));
  await new Promise((r) => setTimeout(r, 450));
  const saves = P.calls.filter((c) => c[0] === 'POST');
  check('...and the choice is saved for next time', saves.map((c) => c[2]), [{ calendar: { desk: { people: ['jessy@slacapital.com', 'beth@slacapital.com'], types: { closing: true, inspection: true, rate_lock: true } } } }]);
  E.onclick({ target: target({ 'data-type': 'closing' }) });
  assert('switching Closings off hides the closing, keeps the inspections', !/t-closing" href/.test(E.html) && /t-inspection" href/.test(E.html) && /scal-chip t-closing off/.test(E.html));
  // re-mount (the desk redraws around it): nothing refetched, choices kept
  const E2 = el();
  P.w.SLA_CAL.mount(E2, { surface: 'desk', me: 'jessy@slacapital.com', focus: 'jessy@slacapital.com', canSeeAll: true, defaultAll: false });
  await tick();
  check('a redraw of the page re-mounts without refetching and keeps the toggles', [P.calls.filter((c) => /calendar-events/.test(c[1])).length, /t-inspection" href="\/loan-details\/b/.test(E2.html), /t-closing" href/.test(E2.html)], [1, true, false]);
  E2.onclick({ target: target({ 'data-nav': '1' }) });
  await tick();
  check('next month fetches next month', P.calls.filter((c) => /calendar-events/.test(c[1])).length, 2);

  // a fresh page with SAVED prefs, and the admins' home calendar
  P = page({ calendar: { desk: { people: ['beth@slacapital.com'] } } }); E = el();
  P.w.SLA_CAL.mount(E, { surface: 'desk', me: 'jessy@slacapital.com', focus: 'jessy@slacapital.com', canSeeAll: true });
  await tick(); await tick();
  assert('saved toggles come back on the next visit (Beth\'s BPO shows, the desk\'s own loans too)', /loan-details\/b/.test(E.html) && /loan-details\/a/.test(E.html));
  P = page(); E = el();
  P.w.SLA_CAL.mount(E, { surface: 'home', me: 'mike@slacapital.com', canSeeAll: true, defaultAll: true });
  await tick(); await tick();
  assert('the admins\' home calendar starts on Everyone', /loan-details\/a/.test(E.html) && /loan-details\/b/.test(E.html) && /👤 Everyone/.test(E.html));
  P = page(); E = el();
  P.w.SLA_CAL.mount(E, { surface: 'home', me: 'carl.davis@slacapital.com', canSeeAll: false, defaultAll: true });
  await tick(); await tick();
  assert('an LO\'s home calendar is their own loans, and offers no Everyone', /loan-details\/a/.test(E.html) && /👤 Me/.test(E.html) && (E.onclick({ target: target({ 'data-people': 'toggle' }) }), !/data-all="1"/.test(E.html)));
  const hostile = read('sla-calendar.js');
  assert('everything printed goes through esc()', /esc\(street\(ev\.address\)\)/.test(hostile) && /esc\(ev\.address \|\| '\(no address\)'\)/.test(hostile) && /esc\(loanHref\(ev\)\)/.test(hostile));
  assert('ES5', !/^\s*(let|const)\s|=>/m.test(hostile.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
}

// ── 6. wiring ───────────────────────────────────────────────────────────────
console.log('\nWiring');
{
  const toml = read('netlify.toml');
  assert('both endpoints are routed', /from = "\/api\/calendar-events"\s*\n\s*to = "\/\.netlify\/functions\/calendar-events"/.test(toml) && /from = "\/api\/user-prefs"\s*\n\s*to = "\/\.netlify\/functions\/user-prefs"/.test(toml));
  const pp = read('processing-pipeline.html');
  assert('MY DESK loads the calendar (pinned)', /<script src="\/sla-calendar\.js\?v=[0-9A-Za-z]+"><\/script>/.test(pp));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
