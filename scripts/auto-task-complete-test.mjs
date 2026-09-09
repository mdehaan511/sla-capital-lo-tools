/**
 * scripts/auto-task-complete-test.mjs — Deploy 236.930
 *
 * Gate for _shared/auto-task-complete.mjs: when the LO's auto-created
 * "Run credit + submit loan" task counts as done, and that closing it touches
 * only that task.
 *
 * Run: node scripts/auto-task-complete-test.mjs
 */
import { autoCompleteReason, markCompleted, completeAutoTasks } from '../deploy/netlify/functions/_shared/auto-task-complete.mjs';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

console.log('auto-task-complete gate\n');

// -- The rule ---------------------------------------------------------------
{
  const fresh = { status: 'approved', processingStage: 'new_loan' };
  check('a loan with nothing done keeps its task', autoCompleteReason(fresh), '');
  check('Xactus stamp = credit pulled', autoCompleteReason({ ...fresh, creditPulledAt: '2026-09-01T00:00:00Z' }), 'credit pulled');
  check('report id alone counts', autoCompleteReason({ ...fresh, creditReportId: 'abc' }), 'credit pulled');
  check('mid score alone counts', autoCompleteReason({ ...fresh, creditMidScore: 712 }), 'credit pulled');
  check('credit report on the Doc Review counts', autoCompleteReason(fresh, { docs: { credit_report: { currentDocId: 'd1' } } }), 'credit report on file');
  check('  a live document without currentDocId still counts', autoCompleteReason(fresh, { docs: { credit_report: { documents: [{ docId: 'd1' }] } } }), 'credit report on file');
  check('  a deleted document does not', autoCompleteReason(fresh, { docs: { credit_report: { documents: [{ docId: 'd1', deleted: true }] } } }), '');
  check('  an empty credit tray does not', autoCompleteReason(fresh, { docs: { credit_report: { currentDocId: '' } } }), '');
  check('  credit AUTHORIZATION is not a credit report', autoCompleteReason(fresh, { docs: { credit_authorization: { currentDocId: 'd1' } } }), '');
  check('moved to Underwriting', autoCompleteReason({ ...fresh, processingStage: 'underwriting' }), 'loan moved to underwriting');
  check('closed on the processing board', autoCompleteReason({ ...fresh, processingStage: 'pp_closed' }), 'loan moved to pp_closed');
  check('still in Processing stage keeps it', autoCompleteReason({ ...fresh, processingStage: 'processing' }), '');
  check('cancelled loan', autoCompleteReason({ status: 'cancelled' }), 'loan cancelled');
  check('denied loan', autoCompleteReason({ status: 'denied' }), 'loan denied');
  check('cancelled flag without status', autoCompleteReason({ status: 'approved', cancelledAt: '2026-09-01' }), 'loan cancelled');
  check('null loan never throws', autoCompleteReason(null), '');
}

// -- markCompleted mirrors a manual complete --------------------------------
{
  const t = markCompleted({ id: 't1', completed: false }, 'credit pulled', 'system@slacapital.com', 'SLA Platform (auto-complete)', '2026-09-09T20:00:00.000Z');
  check('completion fields', [t.completed, t.completedAt, t.completedBy, t.completedByName, t.autoCompletedReason, t.updatedBy],
    [true, '2026-09-09T20:00:00.000Z', 'system@slacapital.com', 'SLA Platform (auto-complete)', 'credit pulled', 'system@slacapital.com']);
}

// -- completeAutoTasks touches only the right task --------------------------
{
  const rows = {
    'lo@x.com/t_auto_this':  { id: 't_auto_this',  loanId: 'L1', autoFromStage: 'processing_entry', completed: false },
    'lo@x.com/t_auto_other': { id: 't_auto_other', loanId: 'L2', autoFromStage: 'processing_entry', completed: false },
    'lo@x.com/t_manual':     { id: 't_manual',     loanId: 'L1', completed: false },                       // hand-made: never auto-closed
    'lo@x.com/t_done':       { id: 't_done',       loanId: 'L1', autoFromStage: 'processing_entry', completed: true, completedBy: 'lo@x.com' },
    'lo@x.com/t_stage':      { id: 't_stage',      loanId: 'L1', autoFromStage: 'underwriting', completed: false },   // a different kind
  };
  const writes = [];
  const fakeStore = {
    list: async ({ prefix }) => ({ blobs: Object.keys(rows).filter((k) => k.startsWith(prefix)).map((key) => ({ key })) }),
    get: async (key) => JSON.parse(JSON.stringify(rows[key] || null)),
    setJSON: async (key, v) => { writes.push(key); rows[key] = v; },
  };
  const r = await completeAutoTasks({ ownerKey: 'lo@x.com', loanId: 'L1', reason: 'credit pulled', tasksStore: fakeStore });
  check('closes exactly the open auto-task on that loan', [r.scanned, r.completed], [5, ['t_auto_this']]);
  check('  written with the reason', [rows['lo@x.com/t_auto_this'].completed, rows['lo@x.com/t_auto_this'].autoCompletedReason], [true, 'credit pulled']);
  check('  the other loan, the manual task, the other kind: untouched', writes, ['lo@x.com/t_auto_this']);
  check('  an already-completed task keeps its original completer', rows['lo@x.com/t_done'].completedBy, 'lo@x.com');

  const again = await completeAutoTasks({ ownerKey: 'lo@x.com', loanId: 'L1', reason: 'x', tasksStore: fakeStore });
  check('second pass finds nothing', again.completed, []);
  check('missing ids are a no-op', (await completeAutoTasks({ ownerKey: '', loanId: 'L1', tasksStore: fakeStore })).scanned, 0);
  const broken = { list: async () => { throw new Error('boom'); } };
  check('a store failure never throws', (await completeAutoTasks({ ownerKey: 'lo@x.com', loanId: 'L1', tasksStore: broken })).completed, []);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
