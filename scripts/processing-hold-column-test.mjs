#!/usr/bin/env node
/**
 * scripts/processing-hold-column-test.mjs — Deploy 237.265 / 237.266
 *
 * Dee (2026-09-24): "Could you please add a dedicated ON-HOLD column in Camelot? ... strictly for
 * active files temporarily paused due to specific, actionable roadblocks — like waiting on a
 * specific document from a borrower, a third-party delay (title/appraisal), or an active
 * restructuring request." Mike: "I will ask that processing help monitor these ones that get
 * put in On Hold to ensure it doesn't become a graveyard again."
 *
 * What would hurt, so what this guards (the real functions are lifted / loaded and RUN):
 *   1. A hold going on without a reason, or the reason / note / resume date not landing on the
 *      loan (the tile, Loan Details and the bell all read them).
 *   2. Resume not restoring the prior status, not clearing the hold fields, or a drop onto a
 *      stage column not moving the file in the same write.
 *   3. A held file in processing not being collected for the On Hold VIEW (237.266, Mike:
 *      "make it a separate page like the Open Conditions at the top ... more like a stacked
 *      list" -- it started life as a fifth column in 237.265), or a held LEAD (no processing
 *      stage) being listed; the board growing a column again; the Closed Loans tab coming back.
 *   4. The graveyard check: no bell alert once a hold sits 14 days or passes its resume date;
 *      a held file being nagged as "stale" instead.
 *   5. The summary projections dropping the hold fields (the board would show "No reason").
 *
 * Run: node scripts/processing-hold-column-test.mjs
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
const DEPLOY = new URL('../deploy/', import.meta.url);
const FN = new URL('../deploy/netlify/functions/', import.meta.url);
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');
const readFn = (p) => readFileSync(new URL(p, FN), 'utf8');
const keySafe = (s) => String(s || '').replace(/[:/\\]/g, '_').replace(/^\.+/, '').slice(0, 128);
const normalizeEmail = (s) => String(s || '').trim().toLowerCase();
const jsonStub = (status, body) => ({ status, body, ok: status < 400, json: async () => body });

async function loadFunction(file, stubs, extraGlobals) {
  const src = readFn(file);
  const ctx = vm.createContext(Object.assign({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: {} }, URL, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, parseInt, parseFloat, isFinite, encodeURIComponent, NaN }, extraGlobals || {}));
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
const req = (method, url, headers, body) => ({ method, url, headers: { get: (k) => (headers || {})[String(k).toLowerCase()] || '' }, text: async () => (body == null ? '' : JSON.stringify(body)), body });
const storesFrom = (data) => ({ getStore: ({ name }) => {
  data[name] = data[name] || {};
  const s = data[name];
  return {
    get: async (k, o) => (k in s ? (o && o.type === 'json' && typeof s[k] === 'string' ? JSON.parse(s[k]) : s[k]) : null),
    setJSON: async (k, v) => { s[k] = JSON.parse(JSON.stringify(v)); },
    set: async (k, v) => { s[k] = v; },
    delete: async (k) => { delete s[k]; },
    list: async () => ({ blobs: Object.keys(s).map((key) => ({ key })) }),
  };
} });
const USER = { email: 'dee@slacapital.com', user_metadata: { full_name: 'Dee' }, app_metadata: { roles: ['processor'] } };
const AUTH = { handleOptions: () => null, json: jsonStub, readJsonBody: async (r) => { try { const t = await r.text(); return t ? JSON.parse(t) : {}; } catch (_) { return null; } }, keySafe, normalizeEmail, isAdmin: () => false, isProcessor: () => true, requireAuth: async () => USER };

console.log('\n/api/loan-set-hold: a hold carries why, what for and until when; resume restores and can move');
{
  const mk = (loan) => {
    const data = { clients: { 'chance@slacapital.com/c_1': { id: 'c_1', firstName: 'Mason', lastName: 'Clinger', loans: [loan] } } };
    const w = { data, writes: [], notes: [] };
    w.fn = loadFunction('loan-set-hold.mjs', {
      '@netlify/blobs': storesFrom(data),
      './_shared/auth.mjs': AUTH,
      './_shared/access.mjs': { canOverrideOwner: () => ({ ok: true }) },
      './_shared/client-write.mjs': { writeClient: async (o, c, opts) => { w.writes.push({ o, allowDemotion: !!(opts && opts.allowDemotion), loan: JSON.parse(JSON.stringify(c.loans[0])) }); } },
      './_shared/loan-change-log.mjs': { diffLoan: () => [], recordLoanChanges: async () => {} },
      './_shared/notes-log.mjs': { appendNoteEntry: (loan, e) => { w.notes.push(e); (loan.notesLog = loan.notesLog || []).push(e); return e; } },
    });
    return w;
  };
  const post = async (w, body) => (await w.fn).default(req('POST', 'https://portal.slacapital.ai/api/loan-set-hold', {}, body), {});
  const ACTIVE = { id: 'l_1', status: 'approved', processingStage: 'underwriting', address: '151 Foothill Blvd' };
  let w = mk(Object.assign({}, ACTIVE));
  let r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: true, reason: 'borrower_doc', note: '2024 K-1 from the CPA', resumeBy: '2026-10-03' });
  let L = w.writes[0] && w.writes[0].loan;
  check('hold with a reason: status on_hold, stage kept, the hold fields on the loan, prior status remembered', [r.status, L.status, L.processingStage, L._holdFromStatus, L._holdReason, L._holdReasonLabel, L._holdNote, L._holdResumeBy, !!L._heldAt, L._heldBy, w.writes[0].allowDemotion], [200, 'on_hold', 'underwriting', 'approved', 'borrower_doc', 'Waiting on a borrower document', '2024 K-1 from the CPA', '2026-10-03', true, 'dee@slacapital.com', true]);
  check('...the note says why, what for and until when', /^On Hold — Waiting on a borrower document: 2024 K-1 from the CPA · expected to resume by 2026-10-03 \(status approved → on_hold/.test(w.notes[0].text) && w.notes[0].meta.reason === 'borrower_doc' && w.notes[0].meta.resumeBy === '2026-10-03', true);
  check('...and the response hands the hold back', r.body.hold, { reason: 'borrower_doc', label: 'Waiting on a borrower document', note: '2024 K-1 from the CPA', resumeBy: '2026-10-03', heldAt: L._heldAt });
  w = mk(Object.assign({}, ACTIVE));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: true });
  check('a hold without a reason is refused, naming the choices', [r.status, /borrower_doc, third_party, restructure, other/.test(r.body.error), w.writes.length], [400, true, 0]);
  w = mk(Object.assign({}, ACTIVE));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: true, reason: 'vacation' });
  check('...and an unknown reason too', [r.status, w.writes.length], [400, 0]);
  w = mk(Object.assign({}, ACTIVE));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: true, reason: 'third_party', resumeBy: 'next tuesday' });
  check('a resume date that is not a date is dropped, the hold still goes on', [r.status, w.writes[0].loan._holdResumeBy, w.writes[0].loan._holdReason], [200, '', 'third_party']);

  const HELD = Object.assign({}, ACTIVE, { status: 'on_hold', _holdFromStatus: 'approved', _heldAt: new Date(Date.now() - 5 * 86400000).toISOString(), _heldBy: 'dee@slacapital.com', _holdReason: 'third_party', _holdReasonLabel: 'Third-party delay (title, appraisal, insurance)', _holdNote: 'appraisal', _holdResumeBy: '2026-10-01' });
  w = mk(Object.assign({}, HELD));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: false, newStage: 'pp_approved' });
  L = w.writes[0].loan;
  check('resume onto a stage column: prior status back, the hold fields gone, the stage moved in the same write', [r.status, L.status, L.processingStage, '_holdReason' in L, '_holdNote' in L, '_holdResumeBy' in L, '_holdFromStatus' in L, !!L._resumedAt, r.body.processingStage], [200, 'approved', 'pp_approved', false, false, false, false, true, 'pp_approved']);
  check('...the note says so, with the days held', /^Resumed from On Hold and moved to Cleared to Close after 5 days \(status on_hold → approved/.test(w.notes[0].text) && w.notes[0].meta.newStage === 'pp_approved', true);
  w = mk(Object.assign({}, HELD));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: false });
  check('resume with no stage (the tile button): back to the stage it was in', [r.status, w.writes[0].loan.status, w.writes[0].loan.processingStage, /^Resumed from On Hold after 5 days/.test(w.notes[0].text)], [200, 'approved', 'underwriting', true]);
  w = mk(Object.assign({}, HELD));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: false, newStage: 'pp_closed' });
  check('a resume cannot close a loan', [r.status, w.writes.length], [400, 0]);
  w = mk(Object.assign({}, HELD));
  r = await post(w, { clientId: 'c_1', loanId: 'l_1', owner: 'chance@slacapital.com', hold: true, reason: 'other' });
  check('holding an already-held loan changes nothing', [r.status, r.body.noChange, w.writes.length], [200, true, 0]);
  check('loan-set-hold exports the reasons the page offers', Object.keys((await mk(ACTIVE).fn).HOLD_REASONS), ['borrower_doc', 'third_party', 'restructure', 'other']);
}

console.log('\nThe board and the On Hold view: a held file in processing is collected for the list; a held lead is not');
{
  const PP = read('processing-pipeline.html');
  const lift = (start, end) => { const a = PP.indexOf(start); if (a < 0) throw new Error('not found: ' + start.slice(0, 50)); const z = PP.indexOf(end, a + start.length); return PP.slice(a, z + end.length); };
  const code = lift('function columnFor(loan) {', '\n}\n') + '\n' + lift('function _holdDays(loan) {', '\n}\n') + '\n' + lift('function _holdPillHtml(loan, it) {', '\n}\n');
  const c = { escH: (s) => String(s), escAttr: (s) => String(s), _canEdit: true, Date, Math, String, isFinite };
  vm.createContext(c); vm.runInContext(code, c);
  const col = (loan) => vm.runInContext('columnFor(' + JSON.stringify(loan) + ')', c);
  check('on hold + in underwriting -> the on_hold bucket (the list view)', col({ status: 'on_hold', processingStage: 'underwriting' }), 'on_hold');
  check('on hold + intake / processing / cleared to close -> the on_hold bucket', [col({ status: 'on_hold', processingStage: 'new_loan' }), col({ status: 'on_hold', processingStage: 'processing' }), col({ status: 'on_hold', processingStage: 'pp_approved' })], ['on_hold', 'on_hold', 'on_hold']);
  check('a held LEAD (no processing stage) stays off the board, as before', col({ status: 'on_hold', processingStage: '' }), null);
  check('denied / cancelled still leave; an approved file still sits in its stage', [col({ status: 'denied', processingStage: 'processing' }), col({ status: 'cancelled' }), col({ status: 'approved', processingStage: 'processing' })], [null, null, 'processing']);
  const days = (ago) => new Date(Date.now() - ago * 86400000).toISOString();
  const pill = (loan, canEdit) => { c._canEdit = canEdit !== false; return vm.runInContext('_holdPillHtml(' + JSON.stringify(loan) + ', ' + JSON.stringify({ client: { id: 'c_1' }, ownerKey: 'chance@slacapital.com' }) + ')', c); };
  let h = pill({ id: 'l_1', _heldAt: days(3), _holdReasonLabel: 'Waiting on a borrower document', _holdNote: '2024 K-1', _holdResumeBy: '2099-01-01', _heldBy: 'dee@slacapital.com' });
  check('the tile: days, the reason, the note, the resume date, a Resume button', [/class="card-hold"/.test(h), /⏸ 3d · Waiting on a borrower document/.test(h), /card-hold-note">2024 K-1</.test(h), /Resume by 2099-01-01/.test(h), /card-resume-btn" data-loan-key="c_1\|l_1\|chance@slacapital\.com"/.test(h)], [true, true, true, true, true]);
  check('...amber at 14 days, red at 30, red when past its resume date', [/card-hold warn"/.test(pill({ _heldAt: days(14) })), /card-hold late"/.test(pill({ _heldAt: days(30) })), /card-hold late"/.test(pill({ _heldAt: days(2), _holdResumeBy: '2020-01-01' })), /past its 2020-01-01/.test(pill({ _heldAt: days(2), _holdResumeBy: '2020-01-01' }))], [true, true, true, true]);
  check('...an LO-side hold with no reason recorded still shows, and a read-only viewer gets no Resume button', [/No reason recorded/.test(pill({ updatedAt: days(1) })), /card-resume-btn/.test(pill({ _heldAt: days(1) }, false))], [true, false]);
  // 237.266 -- a view, not a column
  assert('the board is four columns again: On Hold is a view, not a column', !/\{ key: 'on_hold',\s+label: 'On Hold' \}/.test(PP) && /<div class="board cols-4">/.test(PP) && !/staleHolds/.test(PP));
  assert('the On Hold tab sits beside Open Conditions with a count; the Closed Loans tab button is gone', /data-view="hold" onclick="setPipelineView\('hold'\)">On Hold<span class="pp-cond-count" id="ppHoldCount">/.test(PP) && !/data-view="closed"/.test(PP) && /view === 'hold'( \|\| \(view === 'desk' && _canEdit\))?\) \? view : 'active'/.test(PP) /* 237.269 added MY DESK after it */ && /if \(_view === 'hold'\) \{ renderHoldList\(visible\); return; \}/.test(PP));
  assert('no drop-into-column path is left behind; the drop-bar zone still parks a tile through the dialog', !/newStage === 'on_hold'/.test(PP) && /if \(!opts \|\| !opts\.reason\) \{ openHoldModal\(loanKey\); return; \}/.test(PP));
  const lcode = lift('function renderHoldList(visible) {', '\n}\n') + '\n' + lift('function _holdDays(loan) {', '\n}\n') + '\n' + lift('function _holdPillHtml(loan, it) {', '\n}\n');
  const wrap = { innerHTML: '' };
  const lc = {
    document: { getElementById: (id) => id === 'boardWrap' ? wrap : (id === 'searchBox' ? { value: '' } : null) },
    escH: (s) => String(s), escAttr: (s) => String(s), _canEdit: true, _loFilterValue: '', _myLoansOnly: false, _programFilter: 'all',
    STAGE_LABEL: { underwriting: 'Underwriting', processing: 'Processing' }, loDisplay: () => 'Chance Luce',
    fmtMoney: (n) => '$' + Math.round(Number(n) || 0).toLocaleString('en-US'), SLA: { urls: { loanDetails: (id) => '/loan-details/' + id } },
    Date, Math, String, Array, Number, isFinite,
    _items: { on_hold: [
      { ownerKey: 'chance@slacapital.com', client: { id: 'c_1', firstName: 'Mason', lastName: 'Clinger' }, loan: { id: 'l_1', address: '151 Foothill Blvd', loanAmt: '245125', toolType: 'rtl', processingStage: 'underwriting', _heldAt: days(3), _holdReasonLabel: 'Waiting on a borrower document', _holdNote: '2024 K-1', _holdResumeBy: '2099-01-01', assignedProcessor: { email: 'dee@slacapital.com', name: 'Dee' } } },
      { ownerKey: 'chance@slacapital.com', client: { id: 'c_2', firstName: 'Ada', lastName: 'Lovelace' }, loan: { id: 'l_2', address: '2 Analytical Way', loanAmt: '100000', toolType: 'dscr', processingStage: 'processing', _heldAt: days(20), _holdReasonLabel: 'Third-party delay (title, appraisal, insurance)' } },
    ] },
  };
  vm.createContext(lc); vm.runInContext(lcode + '\nrenderHoldList(function() { return true; });', lc);
  const html = wrap.innerHTML;
  check('the list, RUN: the longest hold first, one row each, with borrower / LO / processor / the stage it left, the reason pill, the note, the resume date, Resume, the amount and a link', [
    html.indexOf('2 Analytical Way') < html.indexOf('151 Foothill Blvd'),
    /<b>2<\/b> loans on hold · <b>1<\/b> over 14 days/.test(html),
    /Mason Clinger · Chance Luce · Dee · was in Underwriting/.test(html),
    /Ada Lovelace · Chance Luce · unassigned · was in Processing/.test(html),
    /⏸ 3d · Waiting on a borrower document/.test(html), /card-hold-note">2024 K-1</.test(html), /Resume by 2099-01-01/.test(html),
    (html.match(/card-resume-btn/g) || []).length, /\$245,125/.test(html), /href="\/loan-details\/l_1"/.test(html), /class="tag rtl">RTL</.test(html),
  ], [true, true, true, true, true, true, true, 2, true, true, true]);
  vm.runInContext('renderHoldList(function(it) { return it.loan.id === "l_2"; });', lc);
  check('...the board filters apply to the list too', [/2 Analytical Way/.test(wrap.innerHTML), /151 Foothill/.test(wrap.innerHTML)], [true, false]);
  lc._items.on_hold = []; vm.runInContext('renderHoldList(function() { return true; });', lc);
  check('empty: says how to park one', /Nothing is on hold\. Drag a tile onto/.test(wrap.innerHTML), true);
  assert('the drop-bar zone asks first too (no reason -> the dialog)', /if \(!opts \|\| !opts\.reason\) \{ openHoldModal\(loanKey\); return; \}/.test(PP));
  assert('the dialog posts reason, note and resume date; resume posts hold:false with the stage', /body = \{ clientId: p\.clientId, loanId: p\.loanId, hold: true, reason: opts\.reason, note: opts\.note \|\| '', resumeBy: opts\.resumeBy \|\| '' \}/.test(PP) && /var body = \{ clientId: p\.clientId, loanId: p\.loanId, hold: false \};\s*if \(newStage && STAGE_ORDER\.indexOf\(newStage\) >= 0 && newStage !== 'pp_closed'\) body\.newStage = newStage;/.test(PP));
  assert('the dialog is on the page with the four reasons', /id="holdReason"/.test(PP) && /value="borrower_doc"/.test(PP) && /value="third_party"/.test(PP) && /value="restructure"/.test(PP) && /value="other"/.test(PP) && /id="holdResumeBy"/.test(PP));
  assert('the buckets and the substatus map know the column', /_items = \{ new_loan: \[\], processing: \[\], underwriting: \[\], pp_approved: \[\], pp_closed: \[\], on_hold: \[\] \}/.test(PP) && /var _substatuses = \{[^}]*on_hold: \[\]/.test(PP));
  assert('the On Hold tile shows the reason pill instead of a substatus picker', /if \(col === 'on_hold'\) \{\s*substatusHtml = _holdPillHtml\(loan, it\);/.test(PP));
}

console.log('\nThe graveyard check: processing-alerts');
{
  const mk = (rows, me, admin) => loadFunction('processing-alerts.mjs', {
    './_shared/auth.mjs': Object.assign({}, AUTH, { isAdmin: () => !!admin, requireAuth: async () => ({ email: me, app_metadata: { roles: [admin ? 'admin' : 'processor'] } }) }),
    './_shared/supabase-db.mjs': { db: { select: async () => rows } },
  });
  const get = async (M) => (await M).default(req('GET', 'https://portal.slacapital.ai/api/processing-alerts', {}, null), {});
  const ago = (d) => new Date(Date.now() - d * 86400000).toISOString();
  const row = (id, extra, over) => Object.assign({ id, client_id: 'c_1', owner_email: 'chance@slacapital.com', address: id + ' Main St', status: 'on_hold', processing_stage: 'underwriting', updated_at: ago(20), extra: Object.assign({ assignedProcessor: { email: 'dee@slacapital.com' } }, extra || {}) }, over || {});
  const rows = [
    row('l_20d', { _heldAt: ago(20), _holdReasonLabel: 'Third-party delay (title, appraisal, insurance)' }),
    row('l_35d', { _heldAt: ago(35), _holdReasonLabel: 'Waiting on a borrower document', _holdResumeBy: '2099-01-01' }),
    row('l_overdue', { _heldAt: ago(3), _holdReasonLabel: 'Restructure requested', _holdResumeBy: '2020-01-01' }, { updated_at: ago(3) }),
    row('l_fresh', { _heldAt: ago(3) }, { updated_at: ago(3) }),
    row('l_lead', { _heldAt: ago(40) }, { processing_stage: '' }),
    row('l_someone_elses', { _heldAt: ago(20), assignedProcessor: { email: 'keith@slacapital.com' } }),
  ];
  let r = await get(mk(rows, 'dee@slacapital.com', false));
  const mine = r.body.alerts.filter((a) => a.kind === 'on_hold').map((a) => [a.loanId, a.severity]);
  check('the assignee: 20 days = normal; 35 days = high; past its resume date = high (even at 3 days); 3 days = nothing; a held lead = nothing; not mine = nothing', mine.sort(), [['l_20d', 'normal'], ['l_35d', 'high'], ['l_overdue', 'high']]);
  check('...a held file is never "stale"', r.body.alerts.filter((a) => a.kind === 'stale').length, 0);
  const sub = r.body.alerts.find((a) => a.loanId === 'l_overdue').subtitle;
  check('...the line says how long, why, and that it is past its date', /^On hold 3 days · Restructure requested · past its 2020-01-01 resume date$/.test(sub), true);
  r = await get(mk(rows, 'mike@slacapital.com', true));
  check('an admin sees every stale hold, whoever it belongs to', r.body.alerts.filter((a) => a.kind === 'on_hold').map((a) => a.loanId).sort(), ['l_20d', 'l_35d', 'l_overdue', 'l_someone_elses']);
}

console.log('\nThe projections and Loan Details');
{
  const BL = readFn('clients-list.mjs'), PG = readFn('clients-list-pg.mjs');
  const keys = ['_heldAt', '_heldBy', '_holdFromStatus', '_holdReason', '_holdReasonLabel', '_holdNote', '_holdResumeBy'];
  check('both summary projections carry every hold field (the board reads the summary)', keys.map((k) => [BL.indexOf("'" + k + "'") >= 0, PG.indexOf("'" + k + "'") >= 0]), keys.map(() => [true, true]));
  const LD = read('loan-details.js');
  assert('Loan Details shows why, since when and until when beside the On Hold badge', /status === 'on_hold' && \(l\._holdReasonLabel \|\| l\._heldAt\)/.test(LD) && /escH\(l\._holdReasonLabel \|\| 'On hold'\)/.test(LD) && /resume by ' \+ escH\(l\._holdResumeBy\)/.test(LD));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
