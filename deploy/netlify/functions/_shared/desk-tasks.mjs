/**
 * _shared/desk-tasks.mjs — Deploy 237.269 (Mike, MY DESK)
 *
 * Mike (2026-09-25): "When a new loan is created they should get the following tasks,
 * these should show in the loan itself and in their to do list on this new individual
 * task dashboard until they're checked off somewhere. If they're checked off in one
 * location it should check off in all locations." Then: "only create when the loan is
 * approved and moved to the Processing pipeline."
 *
 * The four standard processing tasks. They are ordinary records in the `tasks` store
 * (the same store the loan's Tasks section and the Tasks page read), so a check-off
 * anywhere is a check-off everywhere -- there is only ever one record. What marks
 * them as the desk's own:
 *
 *   autoFromStage: 'desk'      (never in AUTO_KINDS -- pulling credit must NOT close
 *                               these; see auto-task-complete.mjs)
 *   deskKind:      welcome | credit | order_valuation | submit_valuation
 *
 * The fifth item on Mike's list, "any conditions that need clearing", is NOT a task:
 * conditions live on the document review and clear themselves there, so the desk reads
 * them live from /api/conditions-open instead of copying them somewhere they could rot.
 *
 * Who a task belongs to: the loan's PROCESSOR of record (team-roles primaryProcessor --
 * the processor, else a closer / manager, never an underwriter). A loan with nobody on
 * it yet gets unassigned tasks, and loan-assign-processor hands them over when someone
 * is assigned.
 *
 * Order BPO or Appraisal is special: completing it needs the order (BPO or Appraisal,
 * the vendor, the scheduled date) recorded on the loan, so it is completed by
 * loan-valuation-order.mjs, never by a bare checkbox. Ordered with no date yet, the same
 * record is retitled "Update BPO or Appraisal date" and stays open until the date is in.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { primaryProcessor } from './team-roles.mjs';

export const DESK_KIND = 'desk';

export const DESK_TASKS = [
  { kind: 'welcome',          title: 'Send Welcome Outreach to Borrower' },
  { kind: 'credit',           title: 'Submit Borrower Credit for Review to LO' },
  { kind: 'order_valuation',  title: 'Order BPO or Appraisal' },
  { kind: 'submit_valuation', title: 'Submit BPO or Appraisal for Review to LO' },
];
export const AWAITING_DATE_TITLE = 'Update BPO or Appraisal date';

// Backfill scope (Mike): "loans in Intake, Processing, or Underwriting Status".
export const BACKFILL_STAGES = ['new_loan', 'processing', 'underwriting'];
// "for Underwriting and Processing check off the Send Welcome Outreach and Submit
// Borrower Credit tasks automatically since those will already be done."
export const BACKFILL_DONE_BY_STAGE = { processing: ['welcome', 'credit'], underwriting: ['welcome', 'credit'] };
const STAGE_LABEL = { new_loan: 'Intake', processing: 'Processing', underwriting: 'Underwriting' };
const DEAD_STATUSES = ['closed', 'cancelled', 'denied', 'sold', 'liquidated'];

export function isDeskTask(t) { return !!(t && t.autoFromStage === DESK_KIND && t.deskKind); }

/** The loan's team as an array, legacy single assignee folded in. */
export function teamOf(loan) {
  if (!loan) return [];
  if (Array.isArray(loan.assignedProcessors) && loan.assignedProcessors.length) return loan.assignedProcessors;
  if (loan.assignedProcessor && loan.assignedProcessor.email) return [Object.assign({ role: 'processor' }, loan.assignedProcessor)];
  return [];
}

/** Who the desk tasks go to: { email, name } or null. */
export function deskAssignee(loan) {
  const p = primaryProcessor(teamOf(loan));
  return p ? { email: String(p.email).toLowerCase(), name: p.name || p.email } : null;
}

/** A BPO / Appraisal document is on the loan's review (any property of a portfolio). */
export function valuationDocOnFile(review) {
  const docs = (review && review.docs) || {};
  return Object.keys(docs).some((slug) => {
    if (!/^(bpo_valuation|appraisal)(__p\d+)?$/.test(slug)) return false;
    const t = docs[slug];
    if (!t || t.hidden) return false;
    if (t.currentDocId) return true;
    return (Array.isArray(t.documents) ? t.documents : []).some((d) => d && !d.deleted);
  });
}

function _newId(i) { return 't_' + Date.now() + '_' + (i || 0) + Math.random().toString(36).slice(2, 6); }

/**
 * One task record. `doneReason` non-empty = created already completed (backfill), which
 * keeps the history honest: the record says the platform checked it and why.
 */
export function buildDeskTask({ def, ownerKey, clientId, loanId, assignee, now, doneReason, actor, seq }) {
  const at = now || new Date().toISOString();
  const done = !!doneReason;
  return {
    id: _newId(seq),
    clientId, loanId, ownerKey,
    title: def.title,
    dueDate: '',
    assignedTo: assignee ? assignee.email : '',
    assignedToName: assignee ? (assignee.name || '') : '',
    description: 'Standard processing task, created when the loan entered the Processing Pipeline. It shows on the loan and on MY DESK; checking it off in either place checks it off in both.',
    completed: done,
    completedAt: done ? at : '',
    completedBy: done ? 'system@slacapital.com' : '',
    completedByName: done ? 'SLA Platform (auto-complete)' : '',
    autoCompletedReason: done ? String(doneReason) : '',
    createdAt: at,
    createdBy: 'system@slacapital.com',
    createdByName: 'SLA Platform (desk task)',
    updatedAt: at,
    updatedBy: actor || 'system@slacapital.com',
    autoFromStage: DESK_KIND,
    deskKind: def.kind,
  };
}

/**
 * Pure: the desk tasks a loan is missing. `existingKinds` = kinds already on file for it
 * (so a re-run never duplicates), `doneKinds` = { kind: reason } to create completed.
 */
export function missingDeskTasks({ ownerKey, clientId, loanId, assignee, existingKinds, doneKinds, now, actor }) {
  const have = existingKinds || {};
  const done = doneKinds || {};
  const out = [];
  DESK_TASKS.forEach((def, i) => {
    if (have[def.kind]) return;
    out.push(buildDeskTask({ def, ownerKey, clientId, loanId, assignee, now, doneReason: done[def.kind] || '', actor, seq: i }));
  });
  return out;
}

/**
 * Pure backfill plan (Mike's rules), over plain rows so the endpoint (PG loans) and a
 * one-off runner (blob loans) plan identically.
 *   loans:   [{ id, clientId, ownerKey, status, processingStage, assignedProcessors?,
 *              assignedProcessor?, valuationOrder? }]
 *   reviewsByLoan: { loanId: review }
 *   existing: { loanId: { kind: true } }   -- desk tasks already on file
 * Returns { tasks: [...], loans: [{ loanId, stage, created, completed, assignee }] }.
 */
export function planDeskBackfill({ loans, reviewsByLoan, existing, now }) {
  const at = now || new Date().toISOString();
  const tasks = [], rows = [], planned = {};
  (loans || []).forEach((l) => {
    if (!l || !l.id || !l.ownerKey || !l.clientId) return;
    // Deploy 237.271 -- one loan id can sit on two client records (a broker copy and the
    // borrower's, 1518 E 28th St): it still gets ONE set of tasks.
    if (planned[l.id]) return;
    const stage = String(l.processingStage || '');
    if (BACKFILL_STAGES.indexOf(stage) < 0) return;
    if (DEAD_STATUSES.indexOf(String(l.status || '').toLowerCase()) >= 0) return;
    const doneKinds = {};
    (BACKFILL_DONE_BY_STAGE[stage] || []).forEach((k) => { doneKinds[k] = 'Backfill: the loan was already in ' + STAGE_LABEL[stage]; });
    const vo = l.valuationOrder || null;
    if (valuationDocOnFile(reviewsByLoan && reviewsByLoan[l.id])) doneKinds.order_valuation = 'Backfill: a BPO / Appraisal is already on file';
    else if (vo && vo.scheduledDate) doneKinds.order_valuation = 'Backfill: already ordered';
    const assignee = deskAssignee(l);
    const made = missingDeskTasks({ ownerKey: l.ownerKey, clientId: l.clientId, loanId: l.id, assignee, existingKinds: (existing && existing[l.id]) || {}, doneKinds, now: at });
    planned[l.id] = true;
    if (!made.length) return;
    tasks.push(...made);
    rows.push({ loanId: l.id, stage, created: made.length, completed: made.filter((t) => t.completed).length, assignee: assignee ? assignee.email : '' });
  });
  return { tasks, loans: rows };
}

function _store(s) { return s || getStore({ name: 'tasks', consistency: 'strong' }); }
function _key(ownerKey, id) { return keySafe(ownerKey) + '/' + keySafe(id); }

/** Every task on one loan (reads the loan owner's prefix -- where every task on it lives). */
export async function tasksForLoan({ ownerKey, loanId, tasksStore }) {
  const store = _store(tasksStore);
  const { blobs } = await store.list({ prefix: keySafe(ownerKey) + '/' });
  const recs = await Promise.all((blobs || []).map((b) => store.get(b.key, { type: 'json' }).catch(() => null)));
  return recs.filter((t) => t && String(t.loanId || '') === String(loanId));
}

/**
 * Create the loan's missing desk tasks (idempotent: a kind already on file is skipped).
 * Best-effort, never throws. Returns { created: [task], assignee }.
 */
export async function ensureDeskTasks({ ownerKey, clientId, loan, doneKinds, actor, tasksStore }) {
  const out = { created: [], assignee: null };
  try {
    if (!ownerKey || !clientId || !loan || !loan.id) return out;
    const store = _store(tasksStore);
    const onLoan = await tasksForLoan({ ownerKey, loanId: loan.id, tasksStore: store });
    const have = {};
    onLoan.forEach((t) => { if (isDeskTask(t)) have[t.deskKind] = true; });
    const assignee = deskAssignee(loan);
    out.assignee = assignee;
    const made = missingDeskTasks({ ownerKey, clientId, loanId: loan.id, assignee, existingKinds: have, doneKinds, actor });
    for (const t of made) { await store.setJSON(_key(ownerKey, t.id), t); out.created.push(t); }
  } catch (e) {
    console.warn('desk-tasks: ensure failed (non-fatal):', e && e.message);
  }
  return out;
}

/**
 * The processor of record changed: hand the OPEN desk tasks that were unassigned or
 * with the previous processor to the new one (to=null → unassigned). Hand-made tasks and
 * desk tasks someone deliberately gave to a third person are left alone.
 * Returns the moved task ids. Best-effort, never throws.
 */
export async function reassignDeskTasks({ ownerKey, loanId, fromEmail, to, actor, tasksStore }) {
  const moved = [];
  try {
    const store = _store(tasksStore);
    const from = String(fromEmail || '').toLowerCase();
    const now = new Date().toISOString();
    const onLoan = await tasksForLoan({ ownerKey, loanId, tasksStore: store });
    for (const t of onLoan) {
      if (!isDeskTask(t) || t.completed) continue;
      const cur = String(t.assignedTo || '').toLowerCase();
      if (cur && cur !== from) continue;
      const next = to ? String(to.email || '').toLowerCase() : '';
      if (cur === next) continue;
      t.assignedTo = next;
      t.assignedToName = to ? (to.name || '') : '';
      t.updatedAt = now;
      t.updatedBy = actor || 'system@slacapital.com';
      await store.setJSON(_key(ownerKey, t.id), t);
      moved.push(t.id);
    }
  } catch (e) {
    console.warn('desk-tasks: reassign failed (non-fatal):', e && e.message);
  }
  return moved;
}

/**
 * Close open desk tasks of the given kinds on one loan (all kinds when none given) --
 * a BPO landed on the review, or the loan ended. Best-effort, never throws.
 */
export async function completeDeskTasks({ ownerKey, loanId, kinds, reason, tasksStore }) {
  const done = [];
  try {
    const store = _store(tasksStore);
    const now = new Date().toISOString();
    const onLoan = await tasksForLoan({ ownerKey, loanId, tasksStore: store });
    for (const t of onLoan) {
      if (!isDeskTask(t) || t.completed) continue;
      if (kinds && kinds.length && kinds.indexOf(t.deskKind) < 0) continue;
      t.completed = true;
      t.completedAt = now;
      t.completedBy = 'system@slacapital.com';
      t.completedByName = 'SLA Platform (auto-complete)';
      t.autoCompletedReason = String(reason || '');
      t.updatedAt = now;
      t.updatedBy = 'system@slacapital.com';
      await store.setJSON(_key(ownerKey, t.id), t);
      done.push(t.id);
    }
  } catch (e) {
    console.warn('desk-tasks: complete failed (non-fatal):', e && e.message);
  }
  return done;
}
