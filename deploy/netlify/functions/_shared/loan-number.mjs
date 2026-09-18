/**
 * _shared/loan-number.mjs — Deploy 237.158 (Mike)
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

// ── Deploy 237.164 (Mike: "freeze the loan numbers after closing") ──────────
//
// A derived number is a MOVING TARGET: it is built from the funding date, so
// correcting that date after someone has copied the number onto a Sitewire
// property (or anywhere else outside this app) silently breaks the join. Once
// a loan closes its funding date is settled, so that is the moment to write
// the number down and stop computing it.
//
// Freezing means stamping the number the app is ALREADY showing, so nothing
// visibly changes and every existing outside link keeps matching. A stored
// number is never overwritten — a Baseline id and a hand edit (237.102) both
// outrank this.

const _norm = (v) => String(v == null ? '' : v).toLowerCase().replace(/[_\s]+/g, ' ').trim();
const CLOSED_DISPOSITIONS = new Set(['sold', 'servicing', 'pending sale', 'paid off', 'post close']);
const CLOSED_STATUSES     = new Set(['closed', 'sold', 'liquidated']);
const CLOSED_BASELINE     = new Set(['sold', 'in servicing', 'servicing', 'liquidated', 'paid off', 'closed']);

/**
 * Is this loan closed? Mirrors closed-loans.html's isClosedLoan so a loan is
 * frozen exactly when it lands on the Closed Loans page. Keep the two in step.
 */
export function isClosedLoanRecord(loan) {
  if (!loan) return false;
  if (CLOSED_DISPOSITIONS.has(_norm(loan.disposition))) return true;
  if (CLOSED_STATUSES.has(String(loan.status || '').toLowerCase().trim())) return true;
  if (String(loan.processingStage || '').toLowerCase().trim() === 'pp_closed') return true;
  return CLOSED_BASELINE.has(_norm(loan.baselineStatus));
}

/**
 * A number this app computed and froze, as opposed to an authoritative one
 * from Baseline or a person. The Baseline tooling matches loans BY number and
 * can merge or skip records on a hit, so it has to be able to tell a frozen
 * number (which could coincide with a Baseline id by chance) from a real one.
 */
export function isFrozenLoanNumber(loan) {
  return !!loan && String(loan.slaDisplayIdSource || '') === 'derived';
}

/**
 * Stamp the displayed number onto a closed loan that has none. Mutates the
 * loan. Returns the number written, or '' when nothing was done (not closed,
 * or it already has one). Idempotent, and never overwrites.
 */
export function freezeLoanNumber(loan) {
  if (!loan || !loan.id) return '';
  if (String(loan.slaDisplayId || '').trim()) return '';
  if (!isClosedLoanRecord(loan)) return '';
  const num = deriveSlaLoanNumber(loan);
  if (!/^SLA-\d{8}-\d{4}$/.test(num)) return '';
  loan.slaDisplayId = num;
  loan.slaDisplayIdSource = 'derived';   // breadcrumb — see isFrozenLoanNumber
  loan.slaDisplayIdFrozenAt = new Date().toISOString();
  return num;
}

/**
 * Sweep a whole client record. Returns [{ loanId, slaDisplayId }] for the loans
 * it stamped (empty when there was nothing to do, which is the common case).
 */
export function freezeClientLoanNumbers(client) {
  const out = [];
  const loans = (client && Array.isArray(client.loans)) ? client.loans : [];
  for (const loan of loans) {
    const num = freezeLoanNumber(loan);
    if (num) out.push({ loanId: loan.id, slaDisplayId: num });
  }
  return out;
}
