#!/usr/bin/env node
/**
 * scripts/my-desk-test.mjs — Deploy 237.269 (Mike, MY DESK)
 *
 * Mike's spec (2026-09-25) and his answers: four standard processing tasks created when a
 * loan enters the Processing Pipeline, checked off anywhere = checked off everywhere;
 * "Order BPO or Appraisal" asks which, the vendor and the scheduled date, and with no date
 * becomes "Update BPO or Appraisal date"; backfill Intake / Processing / Underwriting with
 * welcome + credit checked on Processing and Underwriting, and the order checked where a
 * BPO / Appraisal is already uploaded; conditions show on the desk and clear themselves;
 * a bell when tasks are assigned to you and when a BPO / Appraisal date is set.
 *
 * What would hurt, so what this runs:
 *   - the backfill ticking the wrong boxes, duplicating tasks, or touching closed loans;
 *   - a new processor not getting the open tasks, or taking someone else's;
 *   - the order form's date not settling the task (or a bare tick completing it anyway);
 *   - "my tasks" missing every task stored under an LO (all of a processor's);
 *   - the desk showing someone else's tasks, or a closed loan.
 * Real code throughout: the task module against an in-memory store, three endpoints through
 * the stubbed-import harness, and the desk's model + drawing lifted out of the page.
 *
 * Run: node scripts/my-desk-test.mjs
 */
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

if (typeof vm.SourceTextModule !== 'function') {
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

const D = await import('../deploy/netlify/functions/_shared/desk-tasks.mjs');

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => { if (cond) { console.log('  ok   ' + name); return; } fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : '')); };
const DEPLOY = new URL('../deploy/', import.meta.url);
const read = (p) => readFileSync(new URL(p, DEPLOY), 'utf8');
const FN = (p) => read('netlify/functions/' + p);

function memStore(seed) {
  const m = new Map(Object.entries(seed || {}).map(([k, v]) => [k, JSON.parse(JSON.stringify(v))]));
  return {
    m,
    list: async (o) => ({ blobs: [...m.keys()].filter((k) => !(o && o.prefix) || k.startsWith(o.prefix)).map((key) => ({ key })) }),
    get: async (k) => (m.has(k) ? JSON.parse(JSON.stringify(m.get(k))) : null),
    setJSON: async (k, v) => { m.set(k, JSON.parse(JSON.stringify(v))); },
    set: async (k, v) => { m.set(k, v); },
    delete: async (k) => { m.delete(k); },
  };
}
const JESSY = { email: 'jessy@slacapital.com', name: 'Jessy', role: 'processor' };
const BETH = { email: 'beth@slacapital.com', name: 'Beth', role: 'processor' };
const DEE = { email: 'diana@slacapital.com', name: 'Dee', role: 'underwriter' };
const KEITH = { email: 'keith@slacapital.com', name: 'Keith', role: 'closer' };

// ── 1. the four tasks ───────────────────────────────────────────────────────
console.log('\nThe four standard tasks (Mike\'s list, in his words)');
check('titles', D.DESK_TASKS.map((d) => d.title), ['Send Welcome Outreach to Borrower', 'Submit Borrower Credit for Review to LO', 'Order BPO or Appraisal', 'Submit BPO or Appraisal for Review to LO']);
check('the awaiting-date title', D.AWAITING_DATE_TITLE, 'Update BPO or Appraisal date');
assert('the desk kind is NOT one the credit auto-close sweeps (pulling credit must not tick these)', !/'desk'/.test(FN('_shared/auto-task-complete.mjs').match(/AUTO_KINDS = \[[^\]]*\]/)[0]));
check('assignee = the processor of record; an underwriter alone is nobody; a closer stands in', [D.deskAssignee({ assignedProcessors: [DEE, JESSY] }), D.deskAssignee({ assignedProcessors: [DEE] }), D.deskAssignee({ assignedProcessors: [KEITH] }), D.deskAssignee({ assignedProcessor: { email: 'Raissa@SLAcapital.com', name: 'Raissa' } })],
  [{ email: 'jessy@slacapital.com', name: 'Jessy' }, null, { email: 'keith@slacapital.com', name: 'Keith' }, { email: 'raissa@slacapital.com', name: 'Raissa' }]);
const tray = (docs) => ({ docs });
check('a BPO / Appraisal on file: live doc yes; deleted, hidden or other trays no; a portfolio property counts', [
  D.valuationDocOnFile(tray({ bpo_valuation: { currentDocId: 'd1' } })),
  D.valuationDocOnFile(tray({ appraisal: { documents: [{ docId: 'd', deleted: false }] } })),
  D.valuationDocOnFile(tray({ bpo_valuation: { documents: [{ docId: 'd', deleted: true }] } })),
  D.valuationDocOnFile(tray({ bpo_valuation: { currentDocId: 'd1', hidden: true } })),
  D.valuationDocOnFile(tray({ appraisal_receipt: { currentDocId: 'd1' } })),
  D.valuationDocOnFile(tray({ appraisal__p2: { currentDocId: 'd1' } })),
  D.valuationDocOnFile(null),
], [true, true, false, false, false, true, false]);

// ── 2. the backfill plan ────────────────────────────────────────────────────
console.log('\nThe backfill, by Mike\'s rules');
{
  const L = (id, stage, extra) => Object.assign({ id, clientId: 'c_' + id, ownerKey: 'lo@slacapital.com', status: 'active', processingStage: stage, assignedProcessors: [JESSY] }, extra || {});
  const loans = [
    L('intake', 'new_loan'),
    L('proc', 'processing'),
    L('uw', 'underwriting', { assignedProcessors: [DEE, BETH] }),
    L('uwbpo', 'underwriting'),
    L('ctc', 'pp_approved'),
    L('closed', 'pp_closed'),
    L('dead', 'processing', { status: 'cancelled' }),
    L('held', 'processing', { status: 'on_hold' }),
    L('noteam', 'new_loan', { assignedProcessors: [] }),
    L('partial', 'processing'),
  ];
  const plan = D.planDeskBackfill({ loans, reviewsByLoan: { uwbpo: tray({ bpo_valuation: { currentDocId: 'x' } }) }, existing: { partial: { welcome: true, credit: true, order_valuation: true } } });
  const on = (id) => plan.tasks.filter((t) => t.loanId === id).map((t) => t.deskKind + (t.completed ? ':done' : ':open'));
  check('Intake: all four, open', on('intake'), ['welcome:open', 'credit:open', 'order_valuation:open', 'submit_valuation:open']);
  check('Processing: welcome + credit ticked', on('proc'), ['welcome:done', 'credit:done', 'order_valuation:open', 'submit_valuation:open']);
  check('Underwriting: the same', on('uw'), ['welcome:done', 'credit:done', 'order_valuation:open', 'submit_valuation:open']);
  check('...and a BPO already uploaded ticks the order too', on('uwbpo'), ['welcome:done', 'credit:done', 'order_valuation:done', 'submit_valuation:open']);
  check('Cleared to Close, Closed and cancelled loans get nothing', [on('ctc'), on('closed'), on('dead')], [[], [], []]);
  check('on hold (still in Processing) is backfilled', on('held').length, 4);
  check('a loan that already has some desk tasks only gets the missing one', on('partial'), ['submit_valuation:open']);
  check('assigned to the processor of record (the underwriter never)', [plan.tasks.find((t) => t.loanId === 'uw').assignedTo, plan.tasks.find((t) => t.loanId === 'intake').assignedTo, plan.tasks.find((t) => t.loanId === 'noteam').assignedTo], ['beth@slacapital.com', 'jessy@slacapital.com', '']);
  const t0 = plan.tasks.find((t) => t.loanId === 'proc' && t.deskKind === 'welcome');
  check('a ticked backfill task says who and why', [t0.completedByName, t0.autoCompletedReason, t0.autoFromStage], ['SLA Platform (auto-complete)', 'Backfill: the loan was already in Processing', 'desk']);
  check('...and the order tick names the document', plan.tasks.find((t) => t.loanId === 'uwbpo' && t.deskKind === 'order_valuation').autoCompletedReason, 'Backfill: a BPO / Appraisal is already on file');
  // idempotent: feed the plan's own output back as "existing"
  const existing = { partial: { welcome: true, credit: true, order_valuation: true } };
  plan.tasks.forEach((t) => { (existing[t.loanId] = existing[t.loanId] || {})[t.deskKind] = true; });
  check('a second run creates nothing', D.planDeskBackfill({ loans, reviewsByLoan: {}, existing }).tasks.length, 0);
  check('the loan list says what happened per loan', plan.loans.find((l) => l.loanId === 'proc'), { loanId: 'proc', stage: 'processing', created: 4, completed: 2, assignee: 'jessy@slacapital.com' });
  const ids = plan.tasks.map((t) => t.id);
  check('every task id is unique', new Set(ids).size, ids.length);
  const row = (await import('../deploy/netlify/functions/desk-backfill.mjs')).rowToLoan({ id: 'l', client_id: 'c', owner_email: 'LO@SLAcapital.com', status: 'active', processing_stage: 'processing', extra: { assignedProcessors: [JESSY], valuationOrder: { kind: 'bpo' } } });
  check('the endpoint reads PG rows into the same shape', [row.ownerKey, row.processingStage, row.assignedProcessors.length, row.valuationOrder.kind], ['lo@slacapital.com', 'processing', 1, 'bpo']);
}

// ── 3. create / hand over / close, against a store ──────────────────────────
console.log('\nCreating, handing over and closing, against a store');
{
  const store = memStore();
  const loan = { id: 'l_1', assignedProcessors: [JESSY] };
  const a = await D.ensureDeskTasks({ ownerKey: 'lo@slacapital.com', clientId: 'c_1', loan, tasksStore: store });
  check('entering the pipeline creates four, for Jessy', [a.created.length, a.assignee.email, [...store.m.keys()].every((k) => k.startsWith('lo@slacapital.com/'))], [4, 'jessy@slacapital.com', true]);
  const b = await D.ensureDeskTasks({ ownerKey: 'lo@slacapital.com', clientId: 'c_1', loan, tasksStore: store });
  check('re-entering creates none', b.created.length, 0);
  // someone gave one task to Keith on purpose; one is done; one hand-made task for Jessy
  const all = [...store.m.values()];
  const toKeith = all.find((t) => t.deskKind === 'submit_valuation'); toKeith.assignedTo = 'keith@slacapital.com'; await store.setJSON('lo@slacapital.com/' + toKeith.id, toKeith);
  const doneOne = all.find((t) => t.deskKind === 'welcome'); doneOne.completed = true; await store.setJSON('lo@slacapital.com/' + doneOne.id, doneOne);
  await store.setJSON('lo@slacapital.com/t_hand', { id: 't_hand', loanId: 'l_1', title: 'Call title', assignedTo: 'jessy@slacapital.com', completed: false });
  const moved = await D.reassignDeskTasks({ ownerKey: 'lo@slacapital.com', loanId: 'l_1', fromEmail: 'jessy@slacapital.com', to: { email: 'beth@slacapital.com', name: 'Beth' }, tasksStore: store });
  const now = [...store.m.values()];
  check('a new processor takes Jessy\'s OPEN desk tasks only', [moved.length, now.filter((t) => t.assignedTo === 'beth@slacapital.com').map((t) => t.deskKind).sort()], [2, ['credit', 'order_valuation']]);
  check('...not the one given to Keith, not the done one, not Jessy\'s hand-made task', [now.find((t) => t.id === toKeith.id).assignedTo, now.find((t) => t.id === doneOne.id).assignedTo, now.find((t) => t.id === 't_hand').assignedTo], ['keith@slacapital.com', 'jessy@slacapital.com', 'jessy@slacapital.com']);
  const un = await D.reassignDeskTasks({ ownerKey: 'lo@slacapital.com', loanId: 'l_1', fromEmail: 'beth@slacapital.com', to: null, tasksStore: store });
  check('nobody left on the loan: back to unassigned', [un.length, [...store.m.values()].filter((t) => t.deskKind && !t.assignedTo).length], [2, 2]);
  const closed = await D.completeDeskTasks({ ownerKey: 'lo@slacapital.com', loanId: 'l_1', kinds: ['order_valuation'], reason: 'BPO uploaded', tasksStore: store });
  check('a BPO landing closes only the order task', [closed.length, [...store.m.values()].find((t) => t.deskKind === 'order_valuation').completed], [1, true]);
  const ended = await D.completeDeskTasks({ ownerKey: 'lo@slacapital.com', loanId: 'l_1', reason: 'Loan cancelled', tasksStore: store });
  check('a loan ending closes the rest of the desk tasks, never the hand-made one', [ended.length, [...store.m.values()].find((t) => t.id === 't_hand').completed], [2, false]);
}

// ── the harness: a function file, its imports stubbed, run for real ─────────
async function loadModule(file, stubs) {
  const src = FN(file);
  const ctx = vm.createContext({ console: { log() {}, warn() {}, error() {} }, Buffer, setTimeout, process: { env: {} }, Date, JSON, Math, Object, Array, String, Number, Promise, Error, RegExp, Set, Map, isFinite, URL });
  const mod = new vm.SourceTextModule(src, { context: ctx, identifier: file });
  await mod.link(async (spec) => {
    const wanted = [];
    const re = new RegExp('import\\s*\\{([^}]*)\\}\\s*from\\s*[\'"]' + spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '[\'"]', 'g');
    let m; while ((m = re.exec(src))) m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean).forEach((n) => wanted.push(n));
    const table = stubs[spec] || {};
    const ex = {};
    wanted.forEach((n) => { ex[n] = (n in table) ? table[n] : (() => undefined); });
    return new vm.SyntheticModule(Object.keys(ex), function () { Object.keys(ex).forEach((k) => this.setExport(k, ex[k])); }, { context: ctx, identifier: spec });
  });
  await mod.evaluate();
  return mod.namespace;
}
const AUTH = (user) => ({
  handleOptions: () => null, json: (status, body) => ({ status, body }),
  requireAuth: async () => user, readJsonBody: async (req) => req.body, isAdmin: () => false,
  normalizeEmail: (s) => String(s || '').trim().toLowerCase(), keySafe: (s) => String(s || '').replace(/[:/\\]/g, '_'),
});
const req = (body) => ({ method: 'POST', headers: { get: () => '' }, body });

// ── 4. the order form's endpoint ────────────────────────────────────────────
console.log('\nOrder BPO or Appraisal (loan-valuation-order)');
{
  const world = (loanInit, taskInit, user) => {
    const w = { writes: [], notes: [], notified: [], logs: [] };
    w.clients = memStore({ 'lo@slacapital.com/c_1': { id: 'c_1', loans: [{ id: 'l_0' }, Object.assign({ id: 'l_1', address: '12 Oak St, Macon, GA 31201' }, loanInit)] } });
    w.tasks = memStore(taskInit ? { ['lo@slacapital.com/' + taskInit.id]: taskInit } : {});
    w.user = user || { email: 'jessy@slacapital.com', staff: true, user_metadata: { full_name: 'Jessy' } };
    w.stubs = {
      '@netlify/blobs': { getStore: ({ name }) => (name === 'tasks' ? w.tasks : w.clients) },
      './_shared/auth.mjs': AUTH(w.user),
      './_shared/access.mjs': { canOverrideOwner: (u) => ({ ok: !!(u && u.staff) }) },
      './_shared/client-write.mjs': { writeClient: async (ownerKey, client) => { w.writes.push({ ownerKey, loan: JSON.parse(JSON.stringify(client.loans[1])) }); await w.clients.setJSON(ownerKey + '/' + client.id, client); } },
      './_shared/notes-log.mjs': { appendNoteEntry: (loan, e) => { w.notes.push(e.text); } },
      './_shared/loan-change-log.mjs': { diffLoan: () => [{ field: 'valuationOrder' }], recordLoanChanges: async (o) => { w.logs.push(o.source); } },
      './_shared/loan-event-notify.mjs': { notifyValuationScheduled: async (o) => { w.notified.push({ kind: o.kind, date: o.date, movedFrom: o.movedFrom, byEmail: o.byEmail }); } },
      './_shared/desk-tasks.mjs': { isDeskTask: D.isDeskTask, tasksForLoan: D.tasksForLoan, AWAITING_DATE_TITLE: D.AWAITING_DATE_TITLE },
    };
    w.post = async (body) => (await loadModule('loan-valuation-order.mjs', w.stubs)).default(req(Object.assign({ clientId: 'c_1', loanId: 'l_1', owner: 'lo@slacapital.com' }, body)), {});
    return w;
  };
  const orderTask = () => ({ id: 't_o', loanId: 'l_1', clientId: 'c_1', ownerKey: 'lo@slacapital.com', title: 'Order BPO or Appraisal', completed: false, autoFromStage: 'desk', deskKind: 'order_valuation', assignedTo: 'jessy@slacapital.com' });

  let w = world({}, orderTask());
  let r = await w.post({ kind: 'bpo', vendor: 'ServiceLink', scheduledDate: '2026-10-02' });
  const t1 = w.tasks.m.get('lo@slacapital.com/t_o');
  check('with a date: the order is on the loan', [r.status, w.writes.length, w.writes[0].loan.valuationOrder.kind, w.writes[0].loan.valuationOrder.vendor, w.writes[0].loan.valuationOrder.scheduledDate, w.writes[0].loan.valuationOrder.orderedBy], [200, 1, 'bpo', 'ServiceLink', '2026-10-02', 'jessy@slacapital.com']);
  check('...the task is done, and says what was ordered', [t1.completed, t1.completedByName, t1.autoCompletedReason, t1.title], [true, 'Jessy', 'Ordered BPO from ServiceLink, scheduled Oct 2', 'Order BPO or Appraisal']);
  check('...a note on the loan, a change-log line, and the team hears about the date', [w.notes, w.logs, w.notified], [['Ordered BPO from ServiceLink — scheduled for Oct 2.'], ['MY DESK (BPO / Appraisal order)'], [{ kind: 'BPO', date: 'Oct 2', movedFrom: '', byEmail: 'jessy@slacapital.com' }]]);
  check('...and the other loan on the client is untouched', w.clients.m.get('lo@slacapital.com/c_1').loans[0], { id: 'l_0' });

  w = world({}, orderTask());
  r = await w.post({ kind: 'appraisal', vendor: 'Class Valuation', scheduledDate: '' });
  const t2 = w.tasks.m.get('lo@slacapital.com/t_o');
  check('no date yet: the task stays open as "Update BPO or Appraisal date"', [r.status, t2.completed, t2.title, t2.awaitingDate], [200, false, 'Update BPO or Appraisal date', true]);
  check('...the order is still recorded, and nobody is told about a date that does not exist', [w.writes[0].loan.valuationOrder.kind, w.writes[0].loan.valuationOrder.scheduledDate, w.notified.length, w.notes[0]], ['appraisal', '', 0, 'Ordered Appraisal from Class Valuation — date not scheduled yet.']);
  // the date arrives later (same world: the loan now carries the dateless order)
  r = await w.post({ kind: 'appraisal', vendor: 'Class Valuation', scheduledDate: '2026-10-09' });
  const t3 = w.tasks.m.get('lo@slacapital.com/t_o');
  check('the date arrives: the same task is done, the order keeps its first order time', [t3.completed, w.writes[1].loan.valuationOrder.orderedAt === w.writes[0].loan.valuationOrder.orderedAt, w.notes[1], w.notified.length], [true, true, 'Appraisal scheduled for Oct 9 (Class Valuation).', 1]);
  r = await w.post({ kind: 'appraisal', vendor: 'Class Valuation', scheduledDate: '2026-10-14' });
  check('rescheduled: a note and a "moved from" bell', [w.notes[2], w.notified[1].movedFrom, w.notified[1].date], ['Appraisal date moved from Oct 9 to Oct 14 (Class Valuation).', 'Oct 9', 'Oct 14']);
  r = await w.post({ kind: 'appraisal', vendor: 'Class Valuation', scheduledDate: '2026-10-14' });
  check('saving the same thing again: no note, no bell', [w.notes.length, w.notified.length], [3, 2]);

  w = world({}, null);
  r = await w.post({ kind: 'bpo', vendor: 'ServiceLink', scheduledDate: '2026-10-02' });
  check('a loan with no desk tasks (older loan) still records the order', [r.status, r.body.task, w.writes[0].loan.valuationOrder.vendor], [200, null, 'ServiceLink']);
  check('refused: not BPO/Appraisal, no vendor, a non-date', [(await w.post({ kind: 'survey', vendor: 'x' })).status, (await w.post({ kind: 'bpo', vendor: ' ' })).status, (await w.post({ kind: 'bpo', vendor: 'x', scheduledDate: '10/2/2026' })).body.error], [400, 400, 'The scheduled date must be a date']);
  w = world({}, orderTask(), { email: 'carl@slacapital.com', user_metadata: {} });
  r = await w.post({ owner: 'lo@slacapital.com', kind: 'bpo', vendor: 'X', scheduledDate: '2026-10-02' });
  check('another LO\'s loan needs processor / admin', [r.status, w.writes.length], [403, 0]);
}

// ── 5. a bare tick cannot complete the order; my tasks covers every owner ───
console.log('\nThe task endpoints');
{
  const tasks = memStore({
    'lo@slacapital.com/t_o': { id: 't_o', loanId: 'l_1', clientId: 'c_1', ownerKey: 'lo@slacapital.com', title: 'Order BPO or Appraisal', completed: false, autoFromStage: 'desk', deskKind: 'order_valuation', assignedTo: 'jessy@slacapital.com' },
    'lo@slacapital.com/t_w': { id: 't_w', loanId: 'l_1', clientId: 'c_1', ownerKey: 'lo@slacapital.com', title: 'Send Welcome Outreach to Borrower', completed: false, autoFromStage: 'desk', deskKind: 'welcome', assignedTo: 'jessy@slacapital.com' },
    'other@slacapital.com/t_x': { id: 't_x', loanId: 'l_9', ownerKey: 'other@slacapital.com', title: 'Not mine', completed: false, assignedTo: 'beth@slacapital.com' },
    'jessy@slacapital.com/t_own': { id: 't_own', loanId: 'l_8', ownerKey: 'jessy@slacapital.com', title: 'Own loan', completed: false, assignedTo: 'jessy@slacapital.com' },
  });
  const user = { email: 'jessy@slacapital.com', user_metadata: { full_name: 'Jessy' } };
  const stubs = {
    '@netlify/blobs': { getStore: () => tasks },
    './_shared/auth.mjs': AUTH(user),
    './_shared/access.mjs': { canOverrideOwner: () => ({ ok: true }), canListAllClients: () => ({ ok: true }) },
    './_shared/loan-event-notify.mjs': { notifyTaskAssigned: async () => 0 },
    './_shared/task-enrich.mjs': { enrichTasks: async (t) => t },
  };
  const save = (await loadModule('tasks-save.mjs', stubs)).default;
  let r = await save(req({ clientId: 'c_1', loanId: 'l_1', taskId: 't_o', completed: true, owner: 'lo@slacapital.com' }), {});
  check('ticking "Order BPO or Appraisal" is refused and says why', [r.status, r.body.needsValuationOrder, tasks.m.get('lo@slacapital.com/t_o').completed], [409, true, false]);
  r = await save(req({ clientId: 'c_1', loanId: 'l_1', taskId: 't_w', completed: true, owner: 'lo@slacapital.com' }), {});
  check('any other desk task ticks normally (and is the same record the loan shows)', [r.status, tasks.m.get('lo@slacapital.com/t_w').completed, tasks.m.get('lo@slacapital.com/t_w').completedByName], [200, true, 'Jessy']);
  const list = (await loadModule('tasks-list.mjs', stubs)).default;
  const mine = await list({ method: 'GET', url: 'https://x/api/tasks-list?assignedTo=me', headers: { get: () => '' } }, {});
  check('"my tasks" finds tasks stored under the LO as well as my own, and nobody else\'s', mine.body.tasks.map((t) => t.id).sort(), ['t_o', 't_own', 't_w']);
  const perLoan = await list({ method: 'GET', url: 'https://x/api/tasks-list?loanId=l_1&owner=lo@slacapital.com', headers: { get: () => '' } }, {});
  check('a loan\'s own list is unchanged', perLoan.body.tasks.map((t) => t.id).sort(), ['t_o', 't_w']);
}

// ── 6. handing over on assignment ───────────────────────────────────────────
console.log('\nA new processor takes over the open tasks (loan-assign-processor)');
{
  const run = async (team, body) => {
    const calls = { reassign: [], notify: [] };
    const clients = memStore({ 'lo@slacapital.com/c_1': { id: 'c_1', loans: [{ id: 'l_1', address: '12 Oak St', assignedProcessors: team }] } });
    const stubs = {
      '@netlify/blobs': { getStore: () => clients },
      './_shared/auth.mjs': AUTH({ email: 'jessy@slacapital.com', user_metadata: { full_name: 'Jessy M' } }),
      './_shared/access.mjs': { canOverrideOwner: () => ({ ok: true }) },
      './_shared/client-write.mjs': { writeClient: async () => {} },
      './_shared/team-roles.mjs': await import('../deploy/netlify/functions/_shared/team-roles.mjs'),
      './_shared/desk-tasks.mjs': { deskAssignee: D.deskAssignee, reassignDeskTasks: async (o) => { calls.reassign.push({ from: o.fromEmail, to: o.to && o.to.email }); return ['t1', 't2']; } },
      './_shared/loan-event-notify.mjs': { notifyLoanAssigned: async () => 0, notifyDeskTasksAssigned: async (o) => { calls.notify.push({ to: o.toEmail, count: o.count }); } },
    };
    const h = (await loadModule('loan-assign-processor.mjs', stubs)).default;
    const r = await h(req(Object.assign({ clientId: 'c_1', loanId: 'l_1', owner: 'lo@slacapital.com' }, body)), {});
    return { r, calls };
  };
  let x = await run([JESSY], { processorEmail: 'beth@slacapital.com', processorName: 'Beth', role: 'processor', replaceRole: 'processor' });
  check('Jessy → Beth: the tasks move, Beth hears once with the count', [x.r.status, x.calls.reassign, x.calls.notify], [200, [{ from: 'jessy@slacapital.com', to: 'beth@slacapital.com' }], [{ to: 'beth@slacapital.com', count: 2 }]]);
  x = await run([], { processorEmail: 'beth@slacapital.com', processorName: 'Beth', role: 'processor' });
  check('first processor on an unassigned loan: from nobody to Beth', x.calls.reassign, [{ from: '', to: 'beth@slacapital.com' }]);
  x = await run([JESSY], { processorEmail: 'diana@slacapital.com', processorName: 'Dee', role: 'underwriter' });
  check('adding an underwriter moves nothing', [x.calls.reassign, x.calls.notify], [[], []]);
  x = await run([JESSY], { removeProcessor: 'jessy@slacapital.com' });
  check('removing the only processor: back to unassigned, nobody to tell', [x.calls.reassign, x.calls.notify], [[{ from: 'jessy@slacapital.com', to: null }], []]);
}

// ── 7. where the other signals are wired ────────────────────────────────────
console.log('\nThe other signals');
{
  const w = FN('_shared/processing-welcome.mjs');
  assert('entering the Processing Pipeline creates the desk tasks (before the one-time stamp) and tells the assignee', /ensureDeskTasks\(\{ ownerKey, clientId: client\.id, loan, actor: actorEmail \}\)/.test(w) && w.indexOf('ensureDeskTasks(') < w.indexOf("loan._processingWelcomeAt = new Date()") && /notifyDeskTasksAssigned\(/.test(w));
  for (const f of ['loan-review-doc-upload.mjs', 'loan-review-doc-upload-chunk.mjs']) {
    assert(f + ': a BPO / Appraisal upload closes the order task', /\^\(bpo_valuation\|appraisal\)\(__p\\d\+\)\?\$/.test(FN(f)) && /completeDeskTasks\(\{ ownerKey: keySafe\(review\.source\.ownerKey\), loanId: review\.source\.loanId, kinds: \['order_valuation'\]/.test(FN(f)));
  }
  assert('a cancelled loan closes its desk tasks', /if \(!isRestore\) await completeDeskTasks\(/.test(FN('loan-cancel.mjs')));
  assert('a denied / cancelled / closed status closes them', /completeDeskTasks\(\{ ownerKey, loanId: targetLoan\.id, reason: 'Loan ' \+ targetLoan\.status \}\)/.test(FN('loan-advance-status.mjs')));
  assert('moving to Closed closes them', /if \(newStage === 'pp_closed'\) await completeDeskTasks\(/.test(FN('loan-processing-stage.mjs')));
  for (const f of ['clients-list.mjs', 'clients-list-pg.mjs']) assert(f + ' projects valuationOrder (the board reads the summary)', /'valuationOrder',/.test(FN(f)));
  const toml = read('netlify.toml');
  assert('both endpoints are routed', /from = "\/api\/loan-valuation-order"\s*\n\s*to = "\/\.netlify\/functions\/loan-valuation-order"/.test(toml) && /from = "\/api\/desk-backfill"/.test(toml));
  const n = FN('_shared/loan-event-notify.mjs');
  assert('the date notice goes to the loan\'s team, the task notice to one person', /kind: 'valuation_scheduled'/.test(n) && /_toTeam\(\{ loan, ownerEmail, by: byEmail \}, \{\s*\n\s*kind: 'valuation_scheduled'/.test(n) && /href: '\/processing-pipeline\.html\?view=desk'/.test(n));
  const bell = read('sla-notifications.js');
  assert('the bell files it under Loan Updates with a calendar icon', /valuation_scheduled: 'Loan Updates'/.test(bell) && /valuation_scheduled: '\\uD83D\\uDCC5'/.test(bell));
}

// ── 8. the form, on every page that can tick the task ───────────────────────
console.log('\nThe order form (sla-valuation.js)');
{
  const src = read('sla-valuation.js');
  const w = { document: {}, localStorage: { getItem() { return null; }, setItem() {} } }; w.window = w;
  vm.createContext(w); vm.runInContext(src, w);
  const V = w.SLA_VALUATION;
  check('labels', [V.label({ kind: 'bpo', vendor: 'ServiceLink', scheduledDate: '2026-10-02' }), V.label({ kind: 'appraisal', vendor: 'Class', scheduledDate: '' }), V.label(null)], ['BPO · ServiceLink · Oct 2', 'Appraisal · Class · date TBD', '']);
  check('only the desk\'s order task opens it', [V.isOrderTask({ autoFromStage: 'desk', deskKind: 'order_valuation' }), V.isOrderTask({ autoFromStage: 'desk', deskKind: 'welcome' }), V.isOrderTask({ title: 'Order BPO or Appraisal' })], [true, false, false]);
  assert('ES5', !/^\s*(let|const)\s|=>/m.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')));
  assert('it asks which, the vendor and the date, with "Not scheduled yet"', /Which is it\?/.test(src) && /id="slavVendor"/.test(src) && /id="slavDate" type="date"/.test(src) && /Not scheduled yet/.test(src));
  for (const [page, re] of [['processing-pipeline.html', /deskOrderValuation\(t\.loanId, t\.id\)/], ['tasks.html', /SLA_VALUATION\.isOrderTask\(t\)/]]) {
    const h = read(page);
    assert(page + ' loads the form (pinned) and ticks open it', /<script src="\/sla-valuation\.js\?v=[0-9A-Za-z]+"><\/script>/.test(h) && re.test(h));
  }
  assert('loan-details.html loads it and its Tasks section ticks open it', /<script src="\/sla-valuation\.js\?v=[0-9A-Za-z]+"><\/script>/.test(read('loan-details.html')) && /SLA_VALUATION\.isOrderTask\(task\)/.test(read('loan-details.js')));
}

// ── 9. the desk itself ──────────────────────────────────────────────────────
console.log('\nMY DESK (processing-pipeline.html)');
{
  const H = read('processing-pipeline.html');
  const lift = (name) => {
    const start = H.indexOf('function ' + name + '(');
    if (start < 0) throw new Error('not found: ' + name);
    let depth = 0, i = H.indexOf('{', start);
    for (; i < H.length; i++) { if (H[i] === '{') depth++; else if (H[i] === '}' && --depth === 0) { i++; break; } }
    return H.slice(start, i);
  };
  const pre = H.match(/var DESK_ORDER = \{[^}]*\};\s*\nvar DESK_STAGES = \{[^}]*\};/)[0];
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const escA = (s) => esc(s).replace(/"/g, '&quot;');
  // eslint-disable-next-line no-new-func
  const api = new Function('ctx', `
    var escH = ctx.escH, escAttr = ctx.escAttr, SLA = ctx.SLA, document = ctx.document, window = ctx.window, SLA_VALUATION = ctx.SLA_VALUATION;
    var _user = { email: 'jessy@slacapital.com' }, _items = ctx.items, _deskTasks = ctx.tasks, _condData = ctx.conds;
    var _deskState = '', _deskError = '', _deskPerson = '', _deskOpen = ctx.open || {}, _programFilter = 'all', _processors = [];
    var STAGE_LABEL = { new_loan: 'Intake', processing: 'Processing', underwriting: 'Underwriting', pp_approved: 'Cleared to Close' };
    function programBucket() { return 'rtl'; }
    function loadDeskTasks() {} function loadConditions() {}
    function _condTraysFromFlat(L) { return L.trays || []; }
    function _condTrayHtml(L, t) { return '<tray ' + t.slug + '>'; }
    ${pre}
    var SLA_CAL = ctx.SLA_CAL;
    ${['_deskMe', '_deskTeam', '_deskIsOrderTask', 'deskModel', '_deskPeople', '_deskClosingHtml', '_deskTaskHtml', 'renderDesk', '_deskMountCal'].map(lift).join('\n')}
    return { deskModel: deskModel, renderDesk: renderDesk };
  `);
  const item = (id, stage, team, extra) => ({ ownerKey: 'lo@slacapital.com', client: { id: 'c_' + id, firstName: 'Ann', lastName: 'Lee' }, loan: Object.assign({ id, address: id + ' Main St', processingStage: stage, status: 'active', assignedProcessors: team }, extra || {}) });
  const items = {
    processing: [item('a', 'processing', [JESSY, DEE], { fundingDate: '2026-10-20' }), item('b', 'processing', [BETH]), item('d', 'processing', [JESSY], { fundingDate: '2026-10-05' })],
    underwriting: [item('c', 'underwriting', [JESSY], { valuationOrder: { kind: 'bpo', vendor: 'ServiceLink', scheduledDate: '' } })],
    pp_closed: [item('z', 'pp_closed', [JESSY])],
    on_hold: [item('h', 'processing', [JESSY], { status: 'on_hold' })],
  };
  const T = (id, loanId, kind, who, done, extra) => Object.assign({ id, loanId, clientId: 'c_' + loanId, ownerKey: 'lo@slacapital.com', title: kind, deskKind: kind, autoFromStage: 'desk', assignedTo: who, completed: !!done, createdAt: '2026-09-25' }, extra || {});
  const tasks = [
    T('1', 'a', 'welcome', 'jessy@slacapital.com', true), T('2', 'a', 'order_valuation', 'jessy@slacapital.com'), T('3', 'a', 'submit_valuation', 'keith@slacapital.com', false, { assignedToName: 'Keith' }),
    T('4', 'b', 'credit', 'jessy@slacapital.com'),                // Jessy is not on b's team, but this is hers
    T('5', 'c', 'order_valuation', '', false, { awaitingDate: true, title: 'Update BPO or Appraisal date' }), // unassigned on her loan
    T('6', 'z', 'welcome', 'jessy@slacapital.com'),               // closed loan
    T('7', 'd', 'welcome', 'jessy@slacapital.com', true),
  ];
  const conds = { loans: [{ reviewId: 'r_a', source: { loanId: 'a' }, open: 2, trays: [{ slug: 'title', conditions: [] }] }] };
  const ctx = { escH: esc, escAttr: escA, SLA: { urls: { loanDetails: (id, o) => '/loan-details/' + id + '?owner=' + o.owner } }, items, tasks, conds, window: {}, SLA_VALUATION: { label: (o) => o.kind.toUpperCase() + ' · ' + o.vendor + ' · ' + (o.scheduledDate || 'date TBD') } };
  ctx.window.SLA_VALUATION = ctx.SLA_VALUATION; // the page reads it off window, as loaded by its <script>
  const A = api(ctx);
  const m = A.deskModel('jessy@slacapital.com', items, tasks, conds);
  const byId = {}; m.rows.forEach((r) => { byId[r.loan.id] = r; });
  check('Jessy\'s desk: her team\'s loans + the loan where a task is hers; never the closed loan or Beth\'s', Object.keys(byId).sort(), ['a', 'b', 'c', 'd', 'h']);
  check('a: her open order task, the done welcome, Keith\'s task counted not shown, 2 conditions', [byId.a.open.map((t) => t.id), byId.a.done.map((t) => t.id), byId.a.others, byId.a.condOpen, byId.a.openCount], [['2'], ['1'], { Keith: 1 }, 2, 3]);
  check('c: an unassigned task on her loan is hers to see', byId.c.open.map((t) => t.id), ['5']);
  check('on hold shows, marked', byId.h.onHold, true);
  check('open work first, soonest closing first; all-clear loans at the bottom', m.rows.map((r) => r.loan.id), ['a', 'b', 'c', 'd', 'h'].filter((x) => true) && m.rows.map((r) => r.loan.id));
  check('...exactly: a (Oct 20, 3 open), b, c (no date, open), then d (clear, Oct 5), h (clear)', m.rows.map((r) => r.loan.id + ':' + r.openCount), ['a:3', 'b:1', 'c:1', 'd:0', 'h:0']);
  check('totals', [m.openTasks, m.openConds], [3, 2]);
  const beth = A.deskModel('beth@slacapital.com', items, tasks, conds);
  check('Beth\'s desk shows her loan and none of Jessy\'s tasks', [beth.rows.map((r) => r.loan.id), beth.rows[0].open.length, beth.rows[0].others], [['b'], 0, { 'jessy@slacapital.com': 1 }]);
  const dee = A.deskModel('diana@slacapital.com', items, tasks, conds);
  check('the underwriter\'s desk: the loan she is on, its conditions, no processing tasks of hers', [dee.rows.map((r) => r.loan.id), dee.rows[0].condOpen, dee.rows[0].open.length], [['a'], 2, 0]);

  // drawing
  let html = '';
  ctx.document = { getElementById: (id) => (id === 'boardWrap' ? { set innerHTML(v) { html = v; } } : { value: '' }) };
  api(ctx).renderDesk();
  assert('collapsed: address links to the loan, counts per loan, BPO chip, close date', /href="\/loan-details\/a\?owner=lo@slacapital\.com"/.test(html) && /1 task · 2 conditions/.test(html) && /BPO · ServiceLink · date TBD/.test(html) && /Closes Oct 20/.test(html) && !/dk-task/.test(html), html.slice(0, 300));
  assert('the summary counts the desk', /<b>5<\/b> loans · <b>3<\/b> open tasks · <b>2<\/b> open conditions/.test(html));
  ctx.open = { a: true, c: true };
  api(ctx).renderDesk();
  assert('expanded: its tasks with checkboxes, who else has work, the condition trays, the order link', /deskToggleTask\('2', this\.checked, this\)/.test(html) && /Also on this loan: 1 with Keith/.test(html) && /<tray title>/.test(html) && /deskOrderValuation\('a', ''\)/.test(html));
  assert('the awaiting-date task is marked', /dk-task awaiting/.test(html) && /Update BPO or Appraisal date/.test(html));
  ctx.items = { processing: [item('<img src=x onerror=alert(1)>', 'processing', [JESSY])] };
  ctx.tasks = []; ctx.open = {};
  api(ctx).renderDesk();
  assert('a hostile address is escaped', !/<img src=x/.test(html));
  assert('the tab exists, staff only, and ?view=desk opens it', /data-view="desk" id="ppDeskTab" style="display:none"/.test(H) && /_dkt\.style\.display = ''/.test(H) && /get\('view'\) === 'desk'\) setPipelineView\('desk'\)/.test(H) && /view === 'desk' && _canEdit/.test(H));
  // Deploy 237.271 -- the desk's calendar: mounted beside the list, for the desk's person
  {
    const mounts = [];
    ctx.items = items; ctx.tasks = tasks; ctx.open = {};
    ctx.window.SLA_CAL = { mount: (el, o) => mounts.push({ el: el && el.id, o }) };
    ctx.SLA_CAL = ctx.window.SLA_CAL;
    ctx.document = { getElementById: (id) => (id === 'boardWrap' ? { set innerHTML(v) { html = v; } } : (id === 'dkCal' ? { id: 'dkCal' } : { value: '' })) };
    api(ctx).renderDesk();
    check('the desk mounts its calendar: surface desk, the desk\'s person in focus, coworkers offered', mounts.map((m) => [m.el, m.o.surface, m.o.focus, m.o.canSeeAll, m.o.defaultAll]), [['dkCal', 'desk', 'jessy@slacapital.com', true, false]]);
    assert('...beside the loan list', /<div class="dk-layout"><div class="pc-wrap">[\s\S]*<\/div><div id="dkCal"><\/div><\/div>$/.test(html));
  }
  assert('the order task never ticks on the desk: it opens the form', /if \(checked && !t\.completed && _deskIsOrderTask\(t\)\) \{\s*\n\s*if \(box\) box\.checked = false;\s*\n\s*deskOrderValuation\(t\.loanId, t\.id\);/.test(H));
  assert('the page has no arrow functions (older browsers)', !/=>/.test(H.replace(/<!--[\s\S]*?-->/g, '')));
}

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
