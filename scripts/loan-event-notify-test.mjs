#!/usr/bin/env node
/**
 * scripts/loan-event-notify-test.mjs — Deploy 237.207
 *
 * Mike's five event notifications:
 *   "When a condition is added."
 *   "When a loan is moved clear to close."
 *   "A Loan Rate Sheet or Loan App is signed and completed."
 *   "A new loan is assigned to you."
 *   "If a Task is assigned to you."
 *
 * Three ways this goes wrong, in descending order of how annoying it is:
 *
 *   1. IT FIRES WHEN NOTHING HAPPENED. Every one of these rides on a save endpoint that
 *      gets called repeatedly — a review patch that CLEARS a condition has the same shape
 *      as one that adds one; a task save that changes a due date carries the assignee it
 *      already had. Get this wrong and the bell fills with events that did not occur,
 *      which is the 237.204 flood again with better manners.
 *
 *   2. IT TELLS YOU WHAT YOU JUST DID. You added the condition; you moved the card.
 *
 *   3. IT BREAKS THE THING IT REPORTS ON. A loan must clear to close whether or not the
 *      notification store answers.
 *
 * The diff and the wording are pure, so they are tested directly. The wiring is asserted
 * against the call sites, because a helper nobody calls is the 237.167 lesson.
 *
 * Run: node scripts/loan-event-notify-test.mjs
 */
import { readFileSync } from 'node:fs';
import {
  addedConditions, docLabelFor, LOAN_EVENT_KINDS, loanHref,
  conditionNotice, clearToCloseNotice, loanAssignedNotice, docSignedNotice, taskAssignedNotice,
} from '../deploy/netlify/functions/_shared/loan-event-notify.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};
const src = (p) => readFileSync(new URL('../deploy/netlify/functions/' + p, import.meta.url), 'utf8');

console.log('\nThe five kinds');
check('all five, named', LOAN_EVENT_KINDS,
  ['condition_added', 'clear_to_close', 'loan_assigned', 'doc_signed', 'task_assigned']);

// ── 1. conditions: added, not cleared and not removed ───────────────────────
console.log('\nWhich conditions were ADDED');
const c = (id, over) => Object.assign({ id, title: 'Need ' + id, status: 'outstanding', createdBy: 'uw@x.com' }, over || {});
const before = { pfs: { conditions: [c('c_1'), c('c_2')] } };

check('a brand-new condition on a tray that had none',
  addedConditions({}, { psa: { conditions: [c('c_9')] } }).map((x) => x.id), ['c_9']);
check('one added beside two that were there',
  addedConditions(before, { pfs: { conditions: [c('c_1'), c('c_2'), c('c_3')] } }).map((x) => x.id), ['c_3']);
// The three that must stay silent. Each is the SAME patch shape as an addition.
check('CLEARING a condition is not adding one',
  addedConditions(before, { pfs: { conditions: [c('c_1', { status: 'cleared' }), c('c_2')] } }), []);
check('REMOVING one is not adding one',
  addedConditions(before, { pfs: { conditions: [c('c_1')] } }), []);
check('re-saving the same list is not adding one',
  addedConditions(before, { pfs: { conditions: [c('c_1'), c('c_2')] } }), []);
check('a patch that never mentions conditions is not adding one',
  addedConditions(before, { pfs: { verdict: 'approved' } }), []);
check('two trays at once are both reported',
  addedConditions(before, { pfs: { conditions: [c('c_1'), c('c_2'), c('c_4')] }, psa: { conditions: [c('c_5')] } })
    .map((x) => x.slug + ':' + x.id), ['pfs:c_4', 'psa:c_5']);
// Refuse rather than guess: without an id there is no way to know it is new.
check('a condition with no id is skipped, not guessed at',
  addedConditions(before, { pfs: { conditions: [c('c_1'), c('c_2'), { title: 'no id' }] } }), []);
check('rubbish in', [addedConditions(null, null), addedConditions(undefined, {})], [[], []]);

console.log('\nTray names people recognise');
check('a checklist slug uses its real label', docLabelFor('operating_agreement'), 'Operating Agreement');
check('a per-guarantor tray says WHICH guarantor, 1-based', docLabelFor('credit_report__g1'), 'Credit Report (guarantor 2)');
check('...and a per-property one says which property', docLabelFor('psa__p0'), 'Purchase Agreement (property 1)');
check('an unknown slug is still readable', docLabelFor('some_new_tray'), 'Some New Tray');
check('nothing in, nothing out', docLabelFor(''), '');

console.log('\nThe sentences');
check('one condition', conditionNotice({ by: 'Dan Austin', docLabel: 'PFS', address: '123 Main St, Spokane, WA' }),
  { title: 'Dan Austin added a condition on PFS', text: '123 Main St' });
check('several at once are one sentence, not several notifications',
  conditionNotice({ by: 'Dan', docLabel: 'PFS', address: '', count: 3 }).title, 'Dan added 3 conditions on PFS');
check('cleared to close names the mover',
  clearToCloseNotice({ address: '9 Elm Ave, Troy, MI', by: 'Beth' }),
  { title: '9 Elm Ave is Cleared to Close', text: 'Moved by Beth' });
check('an assignment says what you are on it as',
  loanAssignedNotice({ address: '1 Oak St, Dallas, TX', by: 'Mike', role: 'processor' }),
  { title: 'New loan assigned to you: 1 Oak St', text: 'As processor · by Mike' });
check('a signed document says which one',
  docSignedNotice({ docLabel: 'Rate Sheet', address: '5 Pine Rd, Tampa, FL', signer: 'J. Wilson' }),
  { title: 'Rate Sheet is signed and complete', text: '5 Pine Rd · signed by J. Wilson' });
check('a task carries its due date',
  taskAssignedNotice({ title: 'Order the appraisal', dueDate: '2026-09-25', by: 'Jessy', address: '7 Ash Ln, Reno, NV' }),
  { title: 'Task assigned to you: Order the appraisal', text: '7 Ash Ln · due 2026-09-25 · from Jessy' });
// Every sentence has to survive an empty record rather than reading half-written.
[['condition', conditionNotice({})], ['ctc', clearToCloseNotice({})], ['assigned', loanAssignedNotice({})],
 ['signed', docSignedNotice({})], ['task', taskAssignedNotice({})]].forEach(([n, r]) => {
  assert('  ' + n + ' still reads as a sentence with nothing to say', !!r.title && !!r.text && !/undefined|null/.test(r.title + r.text), JSON.stringify(r));
});

console.log('\nLinks land in the right book');
check('owner-scoped, because a loan lives under its LO',
  loanHref('l_1', 'LO@Example.com '), '/loan-details/l_1?owner=lo%40example.com');
check('...with a tab when the notification is about a document',
  loanHref('l_1', 'lo@x.com', '#documents'), '/loan-details/l_1?owner=lo%40x.com#documents');
check('no loan, no link', loanHref('', 'lo@x.com'), '');

// ── the wiring ──────────────────────────────────────────────────────────────
// Five helpers nobody calls would pass every check above. 237.167 shipped exactly that.
console.log('\nEach one is actually wired to where it happens');
const WIRED = [
  ['condition added',  'loan-reviews-save.mjs',        /addedConditions\(/,        /_notifyNewConditions\(/],
  ['cleared to close', 'loan-processing-stage.mjs',    /notifyClearToClose\(/,     /freshlyCTC/],
  ['assigned (proc)',  'loan-assign-processor.mjs',    /notifyLoanAssigned\(/,     /notifyPerson/],
  ['assigned (LO)',    'loan-assign-lo.mjs',           /notifyLoanAssigned\(/,     /newOwnerEmail/],
  ['task assigned',    'tasks-save.mjs',               /notifyTaskAssigned\(/,     /priorAssignee/],
  ['rate sheet',       'envelope-sign.mjs',            /notifyDocSignedByIds\(/,   /kind === 'rate_sheet'/],
  ['loan app (b1)',    'borrower-info-sign.mjs',       /notifyDocSignedByIds\(/,   /!hasB2/],
  ['loan app (b2)',    'borrower2-auth-sign.mjs',      /notifyDocSignedByIds\(/,   /b2Audit/],
];
WIRED.forEach(([label, file, callRe, guardRe]) => {
  const t = src(file);
  assert('  ' + label + ' → ' + file, callRe.test(t) && guardRe.test(t),
    callRe.test(t) ? 'called, but the guard is missing' : 'never called');
});

console.log('\nThe guards that stop it firing on a no-op');
const TASKS = src('tasks-save.mjs');
assert('a task only notifies when the ASSIGNEE changed',
  /if \(task\.assignedTo && task\.assignedTo !== priorAssignee\)/.test(TASKS),
  'editing a due date would otherwise re-notify the same person');
assert('...and priorAssignee is read BEFORE the patch is applied',
  TASKS.indexOf('priorAssignee = String(task.assignedTo') < TASKS.indexOf('if (body.assignedTo !== undefined)'),
  'reading it after the patch compares the new value with itself');
const STAGE = src('loan-processing-stage.mjs');
assert('cleared to close fires on ARRIVING at pp_approved, not on every save',
  /newStage === 'pp_approved' && priorStage !== 'pp_approved'/.test(STAGE));
const PROC = src('loan-assign-processor.mjs');
assert('an assignment notifies only a NEWLY added person',
  /loan\.assignedProcessors\.push\([\s\S]{0,120}notifyPerson = \{ email, name, role \}/.test(PROC),
  'a role edit on someone already on the team is not a new assignment');
const B1 = src('borrower-info-sign.mjs');
assert('the loan app stays quiet until it is COMPLETE (b1 defers when there is a b2)',
  /if \(!hasB2\) \{[\s\S]{0,600}notifyDocSignedByIds/.test(B1));
assert('...and respects the signing deadline like every other housekeeping step',
  /if \(_pastDeadline\(\)\) \{\s*_housekeepingSkipped\.push\('app-signed-bell'\)/.test(B1),
  'project_sign_handler_timeout: nothing after the signature may risk it');

console.log('\nNothing here can break what it reports on');
const MOD = readFileSync(new URL('../deploy/netlify/functions/_shared/loan-event-notify.mjs', import.meta.url), 'utf8');
check('every sender swallows its own errors',
  (MOD.match(/catch \(e\) \{/g) || []).length >= 5, true);
assert('the team audience excludes whoever caused it',
  /loanWatchers\(loan, ownerEmail, \{ exclude: by \}\)/.test(MOD),
  'nobody wants to be told what they just did');
assert('an addressed notification is never sent to yourself',
  (MOD.match(/if \(!to \|\| to === normalizeEmail\(byEmail \|\| ''\)\) return 0;/g) || []).length === 2,
  'assigning a loan or a task to yourself must be silent');

console.log('\nThe bell and the page know the new kinds');
const BELL = readFileSync(new URL('../deploy/sla-notifications.js', import.meta.url), 'utf8');
const PAGE = readFileSync(new URL('../deploy/notifications.html', import.meta.url), 'utf8');
LOAN_EVENT_KINDS.forEach((k) => {
  assert('  ' + k + ' has a category', new RegExp(k + ": '(Documents Uploaded|Loan Updates|Mail|Payments)'").test(BELL),
    'it would render under Other');
  assert('  ' + k + ' has a label on the page', new RegExp(k + ':\\s*\'').test(PAGE));
});
assert('the bell renders any titled kind generically, instead of calling it a mention',
  /if \(m\.kind && m\.kind !== 'mention' && m\.title\)/.test(BELL),
  'the fallback is the @-mention sentence, which is false for all five of these');

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
