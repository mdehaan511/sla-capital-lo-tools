/**
 * _shared/funding-log.mjs — Deploy 237.157 (Mike)
 *
 * "On the Funding Plan we need to keep a log of the chain of when and where the
 * loan is moved between funders and investors."
 *
 * The Funding Plan's four movement fields are:
 *   fundingSource   who put up the money at closing (SLA / KAF / Stride / …)
 *   companyOnDocs   which of our entities is on the note (Sir Lends A Lot /
 *                   King Arthur Fund 1)
 *   investorName    who the loan is ASSIGNED to (the investors book)
 *   assignedDate    when that assignment happened
 *
 * Every write path that can move a loan appends here, so the chain survives no
 * matter where the change came from: the Funding Plan box (loan-fields-save),
 * a sizer save that sets the investor / TPO (sizer-save-loan) and the closed-
 * loan servicing + Close Out screens (loan-servicing-update).
 *
 * Stored on the loan as `fundingLog`, newest first, capped at MAX entries.
 * This is a HISTORY, not state: nothing reads it back to decide anything, so a
 * failure here must never cost the caller their save (hence the try/catch and
 * the "never throw" contract).
 */

export const MAX_FUNDING_LOG = 50;

// Field -> how the history line reads. Order matters: a single save that moves
// both the funder and the investor logs them in this order.
export const FUNDING_LOG_FIELDS = [
  ['fundingSource',  'Funding source'],
  ['companyOnDocs',  'Company on docs'],
  ['investorName',   'Assigned to'],
  ['assignedDate',   'Assigned date'],
];

const SOURCE_LABELS = {
  stride: 'Stride',
  king_arthur: 'King Arthur Fund',
  sla_capital: 'SLA Capital',
  correspondent: 'Correspondent',
  other: 'Other',
};
const clean = (v) => String(v == null ? '' : v).trim();
/** The funding-source select stores codes; the history should read in English. */
export const prettyFundingValue = (field, v) =>
  field === 'fundingSource' ? (SOURCE_LABELS[clean(v)] || clean(v)) : clean(v);

/**
 * Diff the movement fields and append one entry per real change.
 *   loan    the loan AFTER the mutation (mutated in place)
 *   before  a shallow snapshot taken BEFORE it
 *   opts    { actor, source, note }
 * Returns the entries added (empty array when nothing moved). Never throws.
 */
export function appendFundingLog(loan, before, opts) {
  try {
    if (!loan || !before) return [];
    const o = opts || {};
    const at = new Date().toISOString();
    const added = [];
    for (const [field, label] of FUNDING_LOG_FIELDS) {
      const from = clean(before[field]);
      const to = clean(loan[field]);
      if (from === to) continue;
      // A blank arriving over a real value is almost always a form that does
      // not carry the field, not an intentional clear -- skip it so the
      // history does not fill with phantom "removed" lines.
      if (to === '' && from !== '') continue;
      added.push({
        at,
        by: clean(o.actor),
        source: clean(o.source) || 'Funding Plan',
        field,
        label,
        from: prettyFundingValue(field, from),
        to: prettyFundingValue(field, to),
        note: clean(o.note).slice(0, 200),
      });
    }
    if (!added.length) return [];
    const prior = Array.isArray(loan.fundingLog) ? loan.fundingLog : [];
    loan.fundingLog = added.concat(prior).slice(0, MAX_FUNDING_LOG);
    return added;
  } catch (e) {
    console.warn('[funding-log] append failed (non-fatal):', e && e.message);
    return [];
  }
}
