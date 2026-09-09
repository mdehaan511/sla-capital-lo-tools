/**
 * _shared/auto-task-complete.mjs — Deploy 236.930
 *
 * Carl: "[the portal] notifies me for processing tasks. not a huge deal but
 * sometimes makes me think there is an action item on my end when there is
 * not in fact."
 *
 * Every open task in the company (23 of 23 on 2026-09-09) was the auto-task
 * processing-welcome creates when a loan enters the Processing Pipeline —
 * "Run credit + submit loan to DIYA / the investor", assigned to the LO, due
 * the next day. Nothing ever closed them, so the Processing badge kept
 * counting loans whose credit had long since been pulled.
 *
 * This is the one place that decides when such a task is DONE, and closes it:
 *   - credit pulled on the loan (Xactus stamp, or a Credit Report on the
 *     Doc Review)
 *   - the loan moved past Processing (Underwriting or later)
 *   - the loan ended (cancelled / denied / closed)
 * "Submitted to the investor" is not tracked anywhere on a loan, so it can't
 * be a signal; credit-pulled is the tracked half of the task.
 *
 * completeAutoTasks() is called best-effort from the endpoints where those
 * signals happen (xactus-credit-order, loan-review-doc-upload,
 * loan-processing-stage, loan-cancel, loan-advance-status) and by the admin
 * sweep (tasks-auto-sweep) that clears the backlog.
 */
import { getStore } from '@netlify/blobs';

export const AUTO_KINDS = ['processing_entry'];
const PAST_PROCESSING = ['underwriting', 'pp_approved', 'pp_closed'];
const ENDED = ['cancelled', 'denied', 'closed'];

function _hasDoc(tray) {
  if (!tray || typeof tray !== 'object') return false;
  if (tray.currentDocId) return true;
  return (Array.isArray(tray.documents) ? tray.documents : []).some((d) => d && !d.deleted);
}

/** Why an LO's "run credit + submit" task counts as done — '' when it doesn't. Pure. */
export function autoCompleteReason(loan, review) {
  if (!loan || typeof loan !== 'object') return '';
  if (loan.creditPulledAt || loan.creditReportId || loan.creditMidScore) return 'credit pulled';
  const docs = (review && review.docs) || {};
  for (const slug of Object.keys(docs)) {
    if (/^credit_report(__p\d+)?$/.test(slug) && _hasDoc(docs[slug])) return 'credit report on file';
  }
  const stage = String(loan.processingStage || '').toLowerCase();
  if (PAST_PROCESSING.includes(stage)) return 'loan moved to ' + stage;
  const status = String(loan.status || '').toLowerCase();
  if (ENDED.includes(status)) return 'loan ' + status;
  if (loan.cancelled || loan.cancelledAt) return 'loan cancelled';
  return '';
}

/** Mutates a task record the way tasks-save does on a manual complete. Pure. */
export function markCompleted(task, reason, by = 'system@slacapital.com', byName = 'SLA Platform (auto-complete)', now = new Date().toISOString()) {
  task.completed = true;
  task.completedAt = now;
  task.completedBy = by;
  task.completedByName = byName;
  task.autoCompletedReason = String(reason || '');
  task.updatedAt = now;
  task.updatedBy = by;
  return task;
}

/**
 * Close every open auto-task of the given kinds on ONE loan. Best-effort:
 * never throws. Returns { scanned, completed: [task ids] }.
 */
export async function completeAutoTasks({ ownerKey, loanId, reason, kinds = AUTO_KINDS, by, byName, tasksStore } = {}) {
  const out = { scanned: 0, completed: [] };
  if (!ownerKey || !loanId) return out;
  try {
    const store = tasksStore || getStore({ name: 'tasks', consistency: 'strong' });
    const { blobs } = await store.list({ prefix: ownerKey + '/' });
    const now = new Date().toISOString();
    await Promise.all((blobs || []).map(async ({ key }) => {
      const t = await store.get(key, { type: 'json' }).catch(() => null);
      if (!t) return;
      out.scanned++;
      if (String(t.loanId || '') !== String(loanId)) return;
      if (t.completed) return;
      if (!t.autoFromStage || kinds.indexOf(t.autoFromStage) < 0) return;
      markCompleted(t, reason, by, byName, now);
      await store.setJSON(key, t);
      out.completed.push(t.id);
    }));
  } catch (e) {
    console.warn('auto-task-complete: failed (non-fatal):', e && e.message);
  }
  return out;
}
