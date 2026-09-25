/**
 * loan-valuation-order.mjs — POST /api/loan-valuation-order
 *
 * Deploy 237.269 (Mike, MY DESK): "When they click Order BPO or Appraisal bring up a
 * modal that asks when its scheduled to be completed. If they dont know yet, then keep
 * the task to 'update BPO or Appraisal Date' that stays there until they can provide it.
 * When that date is provided, add it to the main dashboard calendar." And: "it should
 * ask who it is and who the vendor was."
 *
 * Records the order on the LOAN (the calendars read it from there) and settles the desk
 * task in the same call, so the loan and the task can never disagree:
 *
 *   loan.valuationOrder = { kind: 'bpo'|'appraisal', vendor, scheduledDate: 'YYYY-MM-DD'|'',
 *                           orderedAt, orderedBy, orderedByName, updatedAt, updatedBy }
 *
 *   date given   → the open "Order BPO or Appraisal" task is completed
 *   no date yet  → the same task is retitled "Update BPO or Appraisal date" and stays open
 *
 * A later call with a date (or a changed date) completes it / moves the calendar event.
 * Every change is a notes-log line and a loan change-log entry; a NEW or CHANGED date
 * rings the bell for the people working the loan (Mike's alert #9), never the person
 * who set it.
 *
 * Body: { clientId, loanId, owner?, kind, vendor, scheduledDate?, taskId? }
 * Auth: requireAuth; another LO's loan needs admin / processor (canOverrideOwner) -- the
 * same rule as every other processing endpoint.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';
import { notifyValuationScheduled } from './_shared/loan-event-notify.mjs';
import { isDeskTask, tasksForLoan, AWAITING_DATE_TITLE } from './_shared/desk-tasks.mjs';

export const VALUATION_KINDS = { bpo: 'BPO', appraisal: 'Appraisal' };

/** 'YYYY-MM-DD' → 'Oct 2' (no Date parsing: a bare date must not shift a day by zone). */
export function shortYmd(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return '';
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return MON[Number(m[2]) - 1] + ' ' + Number(m[3]);
}

/** Validate + normalise the body. Returns { error } or { order fields }. Pure. */
export function readOrder(body) {
  const kind = String((body && body.kind) || '').toLowerCase();
  if (!VALUATION_KINDS[kind]) return { error: 'Choose BPO or Appraisal' };
  const vendor = String((body && body.vendor) || '').trim().slice(0, 120);
  if (!vendor) return { error: 'Who is the vendor?' };
  const date = String((body && body.scheduledDate) || '').trim();
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'The scheduled date must be a date' };
  return { kind, vendor, scheduledDate: date };
}

/** The notes-log sentence for a change. Pure. */
export function orderSentence(prior, next) {
  const label = VALUATION_KINDS[next.kind];
  const when = next.scheduledDate ? 'scheduled for ' + shortYmd(next.scheduledDate) : 'date not scheduled yet';
  if (!prior || !prior.kind) return 'Ordered ' + label + ' from ' + next.vendor + ' — ' + when + '.';
  if (prior.scheduledDate && next.scheduledDate && prior.scheduledDate !== next.scheduledDate) {
    return label + ' date moved from ' + shortYmd(prior.scheduledDate) + ' to ' + shortYmd(next.scheduledDate) + ' (' + next.vendor + ').';
  }
  if (!prior.scheduledDate && next.scheduledDate) return label + ' scheduled for ' + shortYmd(next.scheduledDate) + ' (' + next.vendor + ').';
  return label + ' order updated — ' + next.vendor + ', ' + when + '.';
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-valuation-order error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = String(body.clientId || ''), loanId = String(body.loanId || '');
  if (!clientId || !loanId) return json(400, { error: 'clientId and loanId required' });

  const order = readOrder(body);
  if (order.error) return json(400, { error: order.error });

  const selfEmail = normalizeEmail(user.email);
  let ownerKey = keySafe(selfEmail);
  if (body.owner && normalizeEmail(body.owner) !== selfEmail && body.owner !== ownerKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  }
  const meta = (user && user.user_metadata) || {};
  const actorName = meta.full_name || meta.fullName || user.email || '';

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
  if (!client || !Array.isArray(client.loans)) return json(404, { error: 'Client not found' });
  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = client.loans[idx];
  const before = Object.assign({}, loan);
  const prior = (loan.valuationOrder && typeof loan.valuationOrder === 'object') ? loan.valuationOrder : null;
  const now = new Date().toISOString();

  const next = {
    kind: order.kind,
    vendor: order.vendor,
    scheduledDate: order.scheduledDate,
    orderedAt: (prior && prior.orderedAt) || now,
    orderedBy: (prior && prior.orderedBy) || selfEmail,
    orderedByName: (prior && prior.orderedByName) || actorName,
    updatedAt: now,
    updatedBy: selfEmail,
  };
  const unchanged = prior && prior.kind === next.kind && prior.vendor === next.vendor && (prior.scheduledDate || '') === next.scheduledDate;
  loan.valuationOrder = next;
  if (!unchanged) {
    appendNoteEntry(loan, {
      kind: 'system', text: orderSentence(prior, next), author: actorName, authorEmail: selfEmail,
      meta: { via: 'valuation_order', kind: next.kind, vendor: next.vendor, scheduledDate: next.scheduledDate },
    });
  }
  loan.updatedAt = now;
  client.loans[idx] = loan;
  client.updatedAt = now;
  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  // The desk task: completed when the date is in, retitled and left open when it is not.
  // After the loan write -- the order is the fact, the task follows it.
  let task = null;
  try {
    const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });
    const onLoan = await tasksForLoan({ ownerKey, loanId, tasksStore });
    const want = String(body.taskId || '');
    task = onLoan.find((t) => want && t.id === want && isDeskTask(t) && t.deskKind === 'order_valuation')
      || onLoan.find((t) => isDeskTask(t) && t.deskKind === 'order_valuation' && !t.completed)
      || null;
    if (task && !task.completed) {
      if (next.scheduledDate) {
        task.completed = true;
        task.completedAt = now;
        task.completedBy = selfEmail;
        task.completedByName = actorName;
        task.autoCompletedReason = 'Ordered ' + VALUATION_KINDS[next.kind] + ' from ' + next.vendor + ', scheduled ' + shortYmd(next.scheduledDate);
      } else {
        task.title = AWAITING_DATE_TITLE;
        task.awaitingDate = true;
      }
      task.updatedAt = now;
      task.updatedBy = selfEmail;
      await tasksStore.setJSON(keySafe(ownerKey) + '/' + keySafe(task.id), task);
    }
  } catch (e) {
    console.warn('loan-valuation-order: task update failed (non-fatal):', e && e.message);
  }

  try {
    await recordLoanChanges({
      ownerKey, clientId, loanId, actor: selfEmail, actorName: actorName || selfEmail,
      source: 'MY DESK (BPO / Appraisal order)', changes: diffLoan(before, loan),
    });
  } catch (e) { console.warn('loan-valuation-order: change log failed (non-fatal):', e && e.message); }

  // Mike's alert: "when a BPO or Appraisal date is set on your loan" -- new or moved.
  if (next.scheduledDate && (!prior || prior.scheduledDate !== next.scheduledDate)) {
    await notifyValuationScheduled({
      loan, ownerEmail: ownerKey, loanId, clientId: client.id, address: loan.address || '',
      by: actorName, byEmail: selfEmail, kind: VALUATION_KINDS[next.kind], vendor: next.vendor,
      date: shortYmd(next.scheduledDate), movedFrom: prior && prior.scheduledDate ? shortYmd(prior.scheduledDate) : '',
    });
  }

  return json(200, { ok: true, valuationOrder: next, task });
}
