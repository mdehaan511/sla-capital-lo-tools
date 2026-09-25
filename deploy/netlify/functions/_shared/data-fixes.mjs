/**
 * _shared/data-fixes.mjs — Deploy 237.281
 *
 * One-off corrections to a loan field, requested by name, checked in, applied ONCE.
 *
 * Why this exists: some fixes are one field on one loan ("Change that Flora one that you
 * noticed", Mike 2026-09-25) and the person asking should not have to go click it. Writing the
 * data by hand from outside the app skips the app's own write path (Postgres first, then the
 * blob mirror) and leaves no audit trail. This list goes through that path instead:
 * data-fixes-cron applies each entry through writeClient, logs it in the loan's Audit Log
 * and Notes & Activity, and records it as applied so it never runs twice.
 *
 * GUARDED: an entry names the value it expects to find (`from`). If the loan no longer holds
 * that value, somebody has since changed it on purpose, and the fix is skipped, not forced.
 * The runner may only touch the fields in FIXABLE_FIELDS.
 *
 * To add one: append an entry with a new id. Never edit or reuse an applied entry.
 */
export const FIXABLE_FIELDS = { soldDate: 'Sold Date', fundingDate: 'Closing Date', maturityDate: 'Maturity Date', soldRate: 'Sold Rate' };

export const DATA_FIXES = [
  {
    id: 'fix-2026-09-25-flora-solddate',
    requestedBy: 'Mike',
    reason: 'The sold date read 12/8/2026, a year in the future, on a DSCR loan that closed 12/8/2025; a DSCR sale is dated at closing (237.014), so the year was a typo. It would have shown as a trade in the Town Crier for the first week of December 2026.',
    ownerKey: 'chance@slacapital.com',
    clientId: 'c_bl_mr8mdovy_ellvgk',
    loanId: 'l_baseline_SLA-3472',   // 2231 Flora St, Cincinnati, OH 45219
    field: 'soldDate',
    from: '2026-12-08',
    to: '2025-12-08',
  },
];

const norm = (v) => String(v == null ? '' : v).trim();

/**
 * Apply one fix to a client record in memory. Pure (mutates `client`).
 * → { result: 'applied' | 'already' | 'skipped', note, before, loan }
 */
export function applyFix(client, fix) {
  if (!FIXABLE_FIELDS[fix.field]) return { result: 'skipped', note: 'field ' + fix.field + ' is not fixable here' };
  const loans = (client && Array.isArray(client.loans)) ? client.loans : [];
  const idx = loans.findIndex((l) => l && l.id === fix.loanId);
  if (idx < 0) return { result: 'skipped', note: 'loan not found on the client' };
  const loan = loans[idx];
  const cur = norm(loan[fix.field]);
  if (cur === norm(fix.to)) return { result: 'already', note: 'already ' + fix.to, loan };
  if (cur !== norm(fix.from)) return { result: 'skipped', note: 'expected ' + fix.from + ', found ' + (cur || '(blank)') + ' — left alone' };
  const before = Object.assign({}, loan);
  loan[fix.field] = fix.to;
  loan.updatedAt = new Date().toISOString();
  client.loans[idx] = loan;
  return { result: 'applied', note: FIXABLE_FIELDS[fix.field] + ' ' + (fix.from || '(blank)') + ' → ' + fix.to, before, loan };
}
