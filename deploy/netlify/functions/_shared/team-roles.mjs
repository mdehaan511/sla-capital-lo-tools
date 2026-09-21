/**
 * _shared/team-roles.mjs — Deploy 237.216 (Raissa, via Mike)
 *
 * Raissa: "is it also possible to add an underwriter option in the dropdown here, so Dee
 * can filter loans already assigned to her"  (the Processing Team picker on Loan Details:
 * Processor / Closer / Processing Manager).
 *
 * Mike guessed this needs an Underwriting role. It does — but a TEAM role on the loan, not
 * a new login role. `loan.assignedProcessors[]` is a list of {email, name, role}, and both
 * filters on the Processing Pipeline ("My Loans" and the team-member dropdown) match on
 * EMAIL across every role. So the moment Dee is on a loan as Underwriter, both filters
 * already find it. Permissions are untouched: any processor-tier user may still
 * UW-approve (Mike's 237.070 decision — there is no underwriter login role, by design).
 *
 * What adding the role DOES need is for the places that pick a PERSON off the team to
 * know an underwriter is not a processor:
 *
 *   - the legacy single `loan.assignedProcessor` ("who is processing this") fell back to
 *     "the first person on the team". With only an underwriter on a loan that made her the
 *     processor of record: the pipeline card would show her as Processor and the admins'
 *     24-hour "nobody assigned" alert (237.206) would go quiet on a loan nobody is
 *     processing.
 *   - borrower-form-submit hands a VOM follow-up TASK to the first team member.
 *   - the borrower portal lists "Your SLA Team" with names and emails. A borrower should
 *     not be writing to their underwriter.
 *
 * One definition of all of that lives here. Pure: no stores.
 */

/** Every role a person can hold on a loan's processing team, in picker order. */
export const TEAM_ROLES = [
  { value: 'processor',   label: 'Processor' },
  { value: 'closer',      label: 'Closer' },
  { value: 'manager',     label: 'Processing Manager' },
  { value: 'underwriter', label: 'Underwriter' },
];

export function isTeamRole(role) {
  const r = String(role || '').toLowerCase();
  return TEAM_ROLES.some((t) => t.value === r);
}

/** Roles that review the file rather than work it. Never the processor of record,
 *  never handed processing tasks, never shown to the borrower. */
const REVIEW_ONLY = { underwriter: 1 };
export function isReviewOnlyRole(role) {
  return !!REVIEW_ONLY[String(role || '').toLowerCase()];
}

/**
 * Who is PROCESSING this loan: the role='processor' member, else the first member who is
 * not review-only (a closer or manager standing in — the pre-237.216 behaviour), else
 * nobody. An underwriter alone on a loan means nobody is processing it yet.
 */
export function primaryProcessor(team) {
  const arr = (Array.isArray(team) ? team : []).filter((p) => p && p.email);
  return arr.find((p) => (p.role || 'processor') === 'processor')
    || arr.find((p) => !isReviewOnlyRole(p.role))
    || null;
}

/** The team members a BORROWER is shown. Review-only roles are left out. */
export function borrowerFacingTeam(team) {
  return (Array.isArray(team) ? team : []).filter((p) => p && p.email && !isReviewOnlyRole(p.role));
}

/** "for processing" / "for underwriting" / "for closing" — the assignment email. */
export function roleWorkPhrase(role) {
  const r = String(role || '').toLowerCase();
  if (r === 'underwriter') return 'for underwriting';
  if (r === 'closer') return 'for closing';
  return 'for processing';
}
