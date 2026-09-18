/**
 * _shared/loan-number.mjs — Deploy 237.157 (Mike)
 *
 * THE SLA loan number for a loan record.
 *
 * Only Baseline-imported loans carry a stored `slaDisplayId` (baseline-upsert
 * stamps it from the external id); a loan originated in the portal never gets
 * one, and every screen shows it a number DERIVED from its id + funding date
 * instead. That derived number is what the LO reads off Loan Details and types
 * onto the Sitewire property, so anything joining a loan to an outside system
 * by its number has to accept it too.
 *
 * NOTE this is deliberately NOT deriveBaselineLoanId() from baseline-sync.mjs.
 * That one exists to name a loan for the Baseline export and has a different
 * date rule (no createdAt fallback, no 10-char slice), so it can return a
 * DIFFERENT number for the same loan. The rule here is the one the browser
 * shows the LO, mirrored byte for byte from sla-api.js's deriveSlaLoanNumber
 * and loan-details.js's _deriveSlaLoanIdClient.
 *
 * Gate: scripts/sitewire-loan-number-test.mjs (all three must agree).
 */
export function deriveSlaLoanNumber(loan) {
  if (!loan) return '';
  const compact = (s) => String(s || '').slice(0, 10).replace(/-/g, '');
  let stamp = loan.fundingDate ? compact(loan.fundingDate) : (loan.createdAt ? compact(loan.createdAt) : '');
  if (!/^\d{8}$/.test(stamp)) {
    const d = new Date();
    stamp = d.getFullYear() + String(d.getMonth() + 1).padStart(2, '0') + String(d.getDate()).padStart(2, '0');
  }
  const s = String((loan && loan.id) || '');
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  return 'SLA-' + stamp + '-' + String(Math.abs(hash) % 10000).padStart(4, '0');
}

/** Stored number when the loan has one, else the derived one. Upper + trimmed. */
export function slaLoanNumber(loan) {
  const stored = String((loan && loan.slaDisplayId) || '').trim();
  return (stored || deriveSlaLoanNumber(loan)).toUpperCase();
}
