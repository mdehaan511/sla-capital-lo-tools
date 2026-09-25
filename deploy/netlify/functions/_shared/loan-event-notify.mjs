/**
 * _shared/loan-event-notify.mjs — Deploy 237.207 (Mike)
 *
 * Mike's revised notification list, the half that is made of EVENTS:
 *
 *   "When a condition is added."
 *   "When a loan is moved clear to close."
 *   "A Loan Rate Sheet or Loan App is signed and completed."
 *   "A new loan is assigned to you."
 *   "If a Task is assigned to you."
 *
 * All five happen at a MOMENT, which is why none of them belongs in the live alert list
 * (see the header of processing-alerts.mjs). A live alert is a condition true right now
 * that someone ends by doing something; these are things you want to be told once and
 * then be done with, which is exactly what a stored notification is.
 *
 * One module for all five so the parts that are easy to get subtly different stay the
 * same: who hears about it, how the sentence reads, where the link goes, and the promise
 * that a notification can never break the thing it is reporting on.
 *
 * ── Who hears about it ──
 * Two audiences, and the distinction matters:
 *
 *   THE TEAM — loanWatchers(): the LO who owns the loan plus everyone on its processing
 *     team, never the admins (237.195, Beth's rule). Used for things that happened TO a
 *     loan: a condition was added, it cleared to close, a document came back signed.
 *     The person who caused it is excluded — nobody wants to be told what they just did.
 *
 *   ONE PERSON — the assignee. "A new loan is assigned to you" and "if a Task is assigned
 *     to you" are addressed notifications: they go to the person named and to nobody
 *     else, and not at all when you assign something to yourself.
 *
 * ── Zero-throw, on purpose ──
 * Every sender swallows its own errors. A loan must still clear to close when the
 * notification store is having a bad day; the assignment must still save. Callers are
 * expected NOT to await these in a way that can fail their own response.
 */
import { normalizeEmail } from './auth.mjs';
import { pushUserNotification } from './user-notifications.mjs';
import { loanWatchers, streetOf } from './loan-watchers.mjs';
import { findCategory } from './loan-review-checklists.mjs';

/** Every kind this module can push. The bell and the notifications page map these to
 *  categories; a kind missing from that map still renders, but in "Other". */
export const LOAN_EVENT_KINDS = [
  'condition_added', 'clear_to_close', 'loan_assigned', 'doc_signed', 'task_assigned',
  'valuation_scheduled', // Deploy 237.269 (Mike): "when a BPO or Appraisal date is set on your loan"
];

/** Owner-scoped loan link, the same shape every other notification uses. */
export function loanHref(loanId, ownerEmail, hash) {
  if (!loanId) return '';
  return '/loan-details/' + encodeURIComponent(loanId) +
    (ownerEmail ? '?owner=' + encodeURIComponent(normalizeEmail(ownerEmail)) : '') +
    (hash || '');
}

/**
 * Which conditions did this patch ADD? Conditions carry a stable id (c_<ts>_<rand>,
 * minted by dr_addCond), so the answer is exact rather than inferred from a count --
 * which matters because the same patch shape is used to CLEAR and to REMOVE conditions,
 * and neither of those is news that a condition was added.
 *
 * A condition with no id is skipped. Refusing beats guessing: a notification about the
 * wrong thing costs more attention than the one it saved.
 *
 * @param existingDocs  review.docs BEFORE the patch
 * @param patchDocs     the docs patch as sent (its conditions array is the full new one)
 */
export function addedConditions(existingDocs, patchDocs) {
  const out = [];
  const ex = existingDocs || {};
  const pd = patchDocs || {};
  for (const slug of Object.keys(pd)) {
    const after = (pd[slug] && Array.isArray(pd[slug].conditions)) ? pd[slug].conditions : null;
    if (!after) continue;                      // this patch did not touch conditions at all
    const before = (ex[slug] && Array.isArray(ex[slug].conditions)) ? ex[slug].conditions : [];
    const had = new Set(before.map((c) => String((c && c.id) || '')));
    for (const c of after) {
      if (!c || !c.id || had.has(String(c.id))) continue;
      out.push({ slug, id: String(c.id), title: String(c.title || ''), by: String(c.createdBy || '') });
    }
  }
  return out;
}

/**
 * The tray's printed name. Per-guarantor and per-property trays carry a __g<i> / __p<i>
 * suffix that is not part of the checklist slug, so it comes off before the lookup and
 * goes back on as a number people recognise from the page.
 */
export function docLabelFor(slug) {
  const raw = String(slug || '');
  if (!raw) return '';
  const m = raw.match(/^(.*?)__([gp])(\d+)$/);
  const base = m ? m[1] : raw;
  const cat = findCategory(base);
  const label = (cat && cat.label) || base.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (!m) return label;
  return label + (m[2] === 'g' ? ' (guarantor ' : ' (property ') + (Number(m[3]) + 1) + ')';
}

// ── The sentences ───────────────────────────────────────────────────────────
// Pure, so the wording can be tested without a store. Each returns { title, text }.

export function conditionNotice({ by, docLabel, address, count }) {
  const who = String(by || '').trim() || 'Someone';
  const doc = String(docLabel || '').trim();
  const n = Number(count) || 1;
  return {
    title: who + ' added ' + (n > 1 ? n + ' conditions' : 'a condition') + (doc ? ' on ' + doc : ''),
    text: streetOf(address) || 'Open the loan to see it',
  };
}

export function clearToCloseNotice({ address, borrower, by }) {
  const who = String(by || '').trim();
  const where = streetOf(address) || String(borrower || '').trim() || 'A loan';
  return {
    title: where + ' is Cleared to Close',
    // The mover is worth naming: "cleared to close" is the one stage change people
    // double-check, and knowing who moved it saves the message asking.
    text: who ? ('Moved by ' + who) : 'Moved in the Processing Pipeline',
  };
}

export function loanAssignedNotice({ address, borrower, by, role }) {
  const who = String(by || '').trim();
  const where = streetOf(address) || String(borrower || '').trim() || 'A loan';
  const r = String(role || '').trim();
  return {
    title: 'New loan assigned to you: ' + where,
    text: [r ? 'As ' + r : '', who ? 'by ' + who : ''].filter(Boolean).join(' · ') || 'Open the loan',
  };
}

export function docSignedNotice({ docLabel, address, signer }) {
  const doc = String(docLabel || '').trim() || 'A document';
  const who = String(signer || '').trim();
  return {
    title: doc + ' is signed and complete',
    text: [streetOf(address), who ? 'signed by ' + who : ''].filter(Boolean).join(' · ')
      || 'Open the loan to see it',
  };
}

export function taskAssignedNotice({ title, dueDate, by, address }) {
  const t = String(title || '').trim() || 'A task';
  const who = String(by || '').trim();
  const due = String(dueDate || '').trim();
  return {
    title: 'Task assigned to you: ' + t,
    text: [streetOf(address), due ? 'due ' + due : '', who ? 'from ' + who : '']
      .filter(Boolean).join(' · ') || 'Open your tasks',
  };
}

// Deploy 237.269 -- "BPO scheduled: 123 Main St · Oct 2 · ServiceLink" (or "moved from").
export function valuationScheduledNotice({ kind, vendor, date, movedFrom, address, by }) {
  const what = String(kind || 'BPO / Appraisal');
  return {
    title: what + (movedFrom ? ' rescheduled' : ' scheduled') + (address ? ': ' + streetOf(address) : ''),
    text: [date ? (movedFrom ? movedFrom + ' → ' + date : date) : '', vendor, by ? 'set by ' + by : '']
      .filter(Boolean).join(' · '),
  };
}
// Deploy 237.269 -- the desk's four tasks arrive together; one line per loan, not four.
export function deskTasksNotice({ count, address, by }) {
  const n = Number(count) || 0;
  return {
    title: n + ' processing task' + (n === 1 ? '' : 's') + ' assigned to you',
    text: [streetOf(address), by ? 'from ' + by : ''].filter(Boolean).join(' · ') || 'Open MY DESK',
  };
}

// ── The senders ─────────────────────────────────────────────────────────────

/** Push to a list of addresses. Never throws, never rejects. Returns how many landed. */
async function _push(recipients, payload, label) {
  const list = (Array.isArray(recipients) ? recipients : [recipients])
    .map((e) => normalizeEmail(e || ''))
    .filter((e) => e && e.includes('@'));
  if (!list.length) return 0;
  let n = 0;
  await Promise.all(list.map(async (email) => {
    try { await pushUserNotification(email, payload); n++; }
    catch (e) { console.warn('[loan-event-notify] ' + label + ' push failed for', email, e && e.message); }
  }));
  return n;
}

/** Everything that happened TO a loan goes to the people working it. */
async function _toTeam({ loan, ownerEmail, by }, payload, label) {
  try {
    const recipients = loanWatchers(loan, ownerEmail, { exclude: by });
    return await _push(recipients, payload, label);
  } catch (e) {
    console.warn('[loan-event-notify] ' + label + ' failed (non-fatal):', e && e.message);
    return 0;
  }
}

/** Mike: "When a condition is added." */
export async function notifyConditionAdded({ loan, ownerEmail, loanId, clientId, address, by, byEmail, docLabel, count }) {
  const notice = conditionNotice({ by, docLabel, address, count });
  return _toTeam({ loan, ownerEmail, by: byEmail }, {
    kind: 'condition_added',
    title: notice.title, text: notice.text,
    href: loanHref(loanId, ownerEmail, '#documents'),
    loanId: loanId || '', clientId: clientId || '', owner: normalizeEmail(ownerEmail || ''),
    address: address || '', docLabel: String(docLabel || ''),
  }, 'condition_added');
}

/** Mike: "When a loan is moved clear to close." */
export async function notifyClearToClose({ loan, ownerEmail, loanId, clientId, address, borrower, by, byEmail }) {
  const notice = clearToCloseNotice({ address, borrower, by });
  return _toTeam({ loan, ownerEmail, by: byEmail }, {
    kind: 'clear_to_close',
    title: notice.title, text: notice.text,
    href: loanHref(loanId, ownerEmail),
    loanId: loanId || '', clientId: clientId || '', owner: normalizeEmail(ownerEmail || ''),
    address: address || '',
  }, 'clear_to_close');
}

/** Mike: "A Loan Rate Sheet or Loan App is signed and completed." */
export async function notifyDocSigned({ loan, ownerEmail, loanId, clientId, address, docLabel, signer }) {
  const notice = docSignedNotice({ docLabel, address, signer });
  // No exclude: the signer is a borrower, not somebody on this bell.
  return _toTeam({ loan, ownerEmail, by: '' }, {
    kind: 'doc_signed',
    title: notice.title, text: notice.text,
    href: loanHref(loanId, ownerEmail, '#documents'),
    loanId: loanId || '', clientId: clientId || '', owner: normalizeEmail(ownerEmail || ''),
    address: address || '', docLabel: String(docLabel || ''),
  }, 'doc_signed');
}

/**
 * The same thing, for callers that hold ids but not the loan record. Reads the client so
 * the processing team is included (loanWatchers needs assignedProcessors[]); if that read
 * fails, it still notifies the LO rather than nobody, because a half answer beats silence
 * for something the whole team is waiting on. Never throws.
 */
export async function notifyDocSignedByIds({ ownerKey, clientId, loanId, address, docLabel, signer, getStore }) {
  let loan = null;
  let addr = address || '';
  try {
    if (getStore && ownerKey && clientId && loanId) {
      const store = getStore({ name: 'clients', consistency: 'strong' });
      const client = await store.get(ownerKey + '/' + clientId, { type: 'json' });
      loan = (client && Array.isArray(client.loans))
        ? client.loans.find((l) => l && l.id === loanId) : null;
      if (!addr && loan) addr = loan.address || '';
    }
  } catch (e) {
    console.warn('[loan-event-notify] doc_signed client read failed, notifying the LO only:', e && e.message);
  }
  return notifyDocSigned({
    loan, ownerEmail: ownerKey, loanId, clientId, address: addr, docLabel, signer,
  });
}

/** Mike: "A new loan is assigned to you." One person, and never yourself. */
export async function notifyLoanAssigned({ toEmail, byEmail, by, role, loanId, clientId, ownerEmail, address, borrower }) {
  const to = normalizeEmail(toEmail || '');
  if (!to || to === normalizeEmail(byEmail || '')) return 0;
  const notice = loanAssignedNotice({ address, borrower, by, role });
  try {
    return await _push([to], {
      kind: 'loan_assigned',
      title: notice.title, text: notice.text,
      href: loanHref(loanId, ownerEmail),
      loanId: loanId || '', clientId: clientId || '', owner: normalizeEmail(ownerEmail || ''),
      address: address || '', role: String(role || ''),
    }, 'loan_assigned');
  } catch (e) {
    console.warn('[loan-event-notify] loan_assigned failed (non-fatal):', e && e.message);
    return 0;
  }
}

/** Mike: "If a Task is assigned to you." One person, and never yourself. */
/** Deploy 237.269 (Mike): "when a BPO or Appraisal date is set on your loan" -- the team. */
export async function notifyValuationScheduled({ loan, ownerEmail, loanId, clientId, address, by, byEmail, kind, vendor, date, movedFrom }) {
  const notice = valuationScheduledNotice({ kind, vendor, date, movedFrom, address, by });
  return _toTeam({ loan, ownerEmail, by: byEmail }, {
    kind: 'valuation_scheduled',
    title: notice.title, text: notice.text,
    href: loanHref(loanId, ownerEmail),
    loanId: loanId || '', clientId: clientId || '', owner: normalizeEmail(ownerEmail || ''),
    address: address || '', date: String(date || ''),
  }, 'valuation_scheduled');
}

/** Deploy 237.269 -- the desk tasks on a loan were given to someone (entry or handover). */
export async function notifyDeskTasksAssigned({ toEmail, byEmail, by, count, loanId, clientId, ownerEmail, address }) {
  const to = normalizeEmail(toEmail || '');
  if (!to || !count || to === normalizeEmail(byEmail || '')) return 0;
  const notice = deskTasksNotice({ count, address, by });
  try {
    return await _push([to], {
      kind: 'task_assigned', title: notice.title, text: notice.text,
      href: '/processing-pipeline.html?view=desk',
      loanId: loanId || '', clientId: clientId || '', owner: normalizeEmail(ownerEmail || ''), address: address || '',
    }, 'desk_tasks');
  } catch (e) {
    console.warn('[loan-event-notify] desk_tasks failed (non-fatal):', e && e.message);
    return 0;
  }
}

export async function notifyTaskAssigned({ toEmail, byEmail, by, task, ownerEmail, address }) {
  const to = normalizeEmail(toEmail || '');
  if (!to || to === normalizeEmail(byEmail || '')) return 0;
  const t = task || {};
  const notice = taskAssignedNotice({ title: t.title, dueDate: t.dueDate, by, address });
  try {
    return await _push([to], {
      kind: 'task_assigned',
      title: notice.title, text: notice.text,
      // A task on a loan opens the loan; a standalone one opens the task list.
      href: t.loanId ? loanHref(t.loanId, ownerEmail) : '/tasks.html',
      loanId: t.loanId || '', clientId: t.clientId || '', owner: normalizeEmail(ownerEmail || ''),
      address: address || '', taskId: t.id || '', dueDate: t.dueDate || '',
    }, 'task_assigned');
  } catch (e) {
    console.warn('[loan-event-notify] task_assigned failed (non-fatal):', e && e.message);
    return 0;
  }
}
