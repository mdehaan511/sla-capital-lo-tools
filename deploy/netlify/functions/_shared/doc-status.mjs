/**
 * _shared/doc-status.mjs — Deploy 237.213 (Jessy, via Mike)
 *
 * Jessy: "can we request that anything Dee leaves/marks as a condition from Underwriting
 * stays in the Conditions tab? ... when Dee underwrites a file, and if she marks a file as
 * 'PTD' it goes to Conditions. Raissa then goes to Conditions Tab to resolve them and
 * changes status to 'Received' when she updated doc or resolve condition - which leads the
 * file back to Underwriting tab. If we could keep the file under Conditions or add a status
 * maybe like 'Condition Addressed'..."
 *
 * THE RULE: a tray the underwriter put under a condition stays a CONDITION until the
 * underwriter says otherwise. The processor's half of that conversation is a new status,
 * Condition Addressed — "I have dealt with it, it is yours again" — and it lives on the
 * Conditions tab, where the underwriter is already looking.
 *
 * This file is the SERVER half. Dan's rule (237.138) is that a tray turns Received the
 * moment a document is uploaded to it, and four upload paths do that by hand. On a tray
 * under condition that auto-Received was one of the two doors the tray fell out of the
 * Conditions tab through (the other is the processor picking Received — the page handles
 * that one). So an upload onto a conditioned tray is a condition being ADDRESSED, not a
 * fresh document being received, and those four paths ask this file which it is.
 *
 * Pure: no stores. Mirrored by _underCondition() in loan-doc-review.js; the gate
 * (scripts/doc-review-tabs-test.mjs) runs both against the same trays.
 */

/** The statuses that mean "the underwriter has a condition on this tray". */
export const CONDITION_STATUSES = ['ptd_condition', 'ptf_condition', 'condition_addressed'];

const openConditions = (d) =>
  (Array.isArray(d && d.conditions) ? d.conditions : []).filter((c) => c && c.status !== 'cleared').length;

/**
 * Is this tray under an underwriter's condition right now?
 *   - it holds one of the condition statuses, or
 *   - it has an open (uncleared) condition item, or
 *   - its legacy uwVerdict is still 'conditions' (uploads reset `status` but have never
 *     touched uwVerdict, so this is the marker that survives an earlier upload).
 * @param docState  review.docs[slug] as it stands BEFORE the change being made
 */
export function isUnderCondition(docState) {
  const d = docState || {};
  if (CONDITION_STATUSES.indexOf(String(d.status || '')) >= 0) return true;
  if (openConditions(d) > 0) return true;
  return d.uwVerdict === 'conditions';
}

/**
 * The status a tray takes when a document lands in it.
 * @param prior  the tray as it stood before this upload (may be undefined for a new tray)
 */
export function statusAfterUpload(prior) {
  return isUnderCondition(prior) ? 'condition_addressed' : 'received';
}
