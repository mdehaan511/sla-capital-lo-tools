/**
 * _shared/loan-watchers.mjs — Deploy 237.195 (Beth, via Mike)
 *
 * Beth: "is there a way for us to receive notifications when a borrower uploads or sends
 * new documents? ... Would it be possible for the notification bell to only show
 * notifications for the loans we're working on? That way, the notif would be specific to
 * each processor/loan officer."
 *
 * The second half is the whole requirement. A bell that tells every admin about every
 * borrower upload is a bell people stop looking at — which is what she was really saying
 * when she asked whether it "might get too busy". So a borrower upload goes to the people
 * WORKING that loan and nobody else:
 *
 *   - the loan officer who owns it, and
 *   - everyone on its processing team (loan.assignedProcessors[]).
 *
 * Deliberately NOT the admins. Full-file readiness broadcasts to them (review-full-file)
 * because that is a milestone; "a document arrived" is day-to-day work belonging to the
 * two or three people doing it.
 *
 * Pure and dependency-free so it can be tested without a network, and so the same
 * definition of "who is working this loan" can be reused by anything else that needs it.
 */
import { normalizeEmail } from './auth.mjs';

/**
 * Everyone who should hear about activity on this loan.
 * @param loan        the loan record (assignedProcessors[] / assignedProcessor)
 * @param ownerEmail  the LO who owns it (the blob owner key, an email)
 * @param opts.exclude  an email to leave out — usually whoever caused the event, so
 *                      nobody is notified about their own action
 * @returns string[] normalized emails, LO first, de-duplicated
 */
export function loanWatchers(loan, ownerEmail, opts) {
  const out = [];
  const seen = new Set();
  const skip = normalizeEmail((opts && opts.exclude) || '');
  const add = (raw) => {
    const e = normalizeEmail(raw || '');
    if (!e || !e.includes('@')) return;
    if (e === skip) return;
    if (seen.has(e)) return;
    seen.add(e);
    out.push(e);
  };

  add(ownerEmail);
  const l = loan || {};
  (Array.isArray(l.assignedProcessors) ? l.assignedProcessors : []).forEach((p) => add(p && p.email));
  // Pre-237.x loans carry only the single assignment.
  if (l.assignedProcessor && l.assignedProcessor.email) add(l.assignedProcessor.email);
  // A loan can also name its processor on the review; the caller passes it through.
  add(l.processorEmail);
  return out;
}

/** "5223 Ditman Street" from a full address — the bit that identifies a loan at a glance. */
export function streetOf(address) {
  return String(address || '').split(',')[0].trim();
}

/**
 * The line Beth asked for: "Mike/Borrower just uploaded PFS – Property Address".
 * @returns { title, text }
 */
export function uploadNotice({ who, docLabel, address }) {
  const person = String(who || '').trim() || 'The borrower';
  const doc = String(docLabel || '').trim() || 'a document';
  const where = streetOf(address);
  return {
    title: person + ' uploaded ' + doc,
    text: where ? where : 'Open the loan to review it',
  };
}
