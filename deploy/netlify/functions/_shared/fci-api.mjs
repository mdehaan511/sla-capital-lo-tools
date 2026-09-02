/**
 * fci-api.mjs — thin client for FCI Lender Services' GraphQL API.
 *
 * Deploy 236.802 (Mike) — FCI services most of our sold notes. Until now the
 * only way to reconcile their book against ours was a spreadsheet export pasted
 * into fci-reconcile-servicing.mjs by hand (236.720-728). This is the live feed.
 *
 * Docs live at https://integrate.myfci.com/ — a PUBLISHED POSTMAN COLLECTION, so
 * the page renders empty to a normal fetch. To read the real spec, pull
 *   https://integrate.myfci.com/api/collections/13291498/TzseH5wM?segregateAuth=true&versionTag=latest
 * and walk the `item` tree; every request carries its GraphQL query verbatim.
 * Introspection is DISABLED on the live endpoint, so that collection is the only
 * source of field names — a wrong field is a hard error, not a null.
 *
 * ── Shape ────────────────────────────────────────────────────────────
 * One endpoint, POST https://fapi.myfci.com/graphql, `Authorization: Bearer`.
 * (A few queries live on tapi.myfci.com — none we use yet.) No webhooks exist,
 * so everything here is poll-based; getUpdatedAccounts() is the only delta hook
 * FCI offers.
 *
 * ── Quirks this module normalizes, verified against the live book ────
 *  • Rates come back as DECIMALS: noteRate 0.105 means 10.5%. We store percent
 *    everywhere, so fciPct() scales — a missed conversion lands every rate 100x
 *    low, which looks plausible enough to ship unnoticed.
 *  • Dates are "MM/DD/YYYY" or the STRING "n/a" — not null. fciDate() maps both
 *    to '' so callers can use the usual falsy check. Other FCI queries use other
 *    formats (ISO on payments, "MM-DD-YYYY" args on some reports); do NOT assume
 *    one formatter across the API.
 *  • Errors arrive as prose, not codes: "You are not authorized to run this
 *    query" (bad/expired token) and "Empty Return values" (unknown loan).
 */

const FCI_URL = 'https://fapi.myfci.com/graphql';
const DEFAULT_TIMEOUT_MS = 25000;

export function fciConfigured() {
  return !!process.env.FCI_API_TOKEN;
}

/**
 * Run a GraphQL query. Returns the `data` object.
 * Throws Error with a readable message on transport, auth or GraphQL failure —
 * callers should let it surface as a 500 rather than writing partial data.
 */
export async function fciQuery(query, opts = {}) {
  const token = process.env.FCI_API_TOKEN;
  if (!token) throw new Error('FCI_API_TOKEN is not set (Netlify → Site settings → Environment variables)');

  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(FCI_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + token,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
      signal: ctl.signal,
    });
  } catch (e) {
    clearTimeout(t);
    if (e && e.name === 'AbortError') throw new Error('FCI request timed out');
    throw new Error('FCI request failed: ' + ((e && e.message) || 'network error'));
  }
  clearTimeout(t);

  const text = await resp.text();
  let body;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }

  if (!resp.ok) {
    throw new Error('FCI HTTP ' + resp.status + (text ? ': ' + text.slice(0, 200) : ''));
  }
  if (body && body.errors && body.errors.length) {
    const msg = body.errors.map((e) => e && e.message).filter(Boolean).join(' | ');
    // Surface the auth case unmistakably — it's the one an operator can fix.
    if (/not authorized/i.test(msg)) throw new Error('FCI rejected the token (check FCI_API_TOKEN): ' + msg.slice(0, 160));
    throw new Error('FCI GraphQL error: ' + msg.slice(0, 300));
  }
  return (body && body.data) || {};
}

// FCI decimal rate → our percent. 0.105 → 10.5. Values already >1 are passed
// through, so a future FCI change to percent-native doesn't double-scale.
export function fciPct(v) {
  if (v == null || v === '') return '';
  const n = Number(v);
  if (!isFinite(n) || n <= 0) return '';
  const pct = n <= 1 ? n * 100 : n;
  // Trim float noise: 0.08875*100 = 8.875000000000002
  return String(Math.round(pct * 100000) / 100000);
}

// "MM/DD/YYYY" | "n/a" | "" → "YYYY-MM-DD" | ''
export function fciDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /^n\/?a$/i.test(s)) return '';
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return m[3] + '-' + m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
  // Payment/activity queries return full ISO — keep just the date part.
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return iso ? iso[1] : '';
}

export function fciNum(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Fields we read off the portfolio. Deliberately EXCLUDES borrowerTIN and the
// other TIN variants available on getLoanDetails — we have no use for a
// servicer-side SSN and no reason to move one across the wire.
const PORTFOLIO_FIELDS = `
  loanAccount lenderAccount lenderName originatorLoanNumber prevServiceAccount
  name city state loanStatus
  originationDate boardingDate closedDate closedReason paidOffDate maturityDate
  originalBalance currentBalance noteRate investorRate
  daysLate nextDueDate paidToDate totalPayment
  drawStatus maximumDraw fundedAmount drawAvailableBalance
  propertyType lastModifiedAt
  borrowerFullName borrowerEmail borrowerMobilePhone
`;
// NOTE on the borrower fields above (Deploy 236.808): FCI has a borrower email
// and name for ALL 41 performing loans; our Baseline-imported client records
// have NEITHER (name, email and company are all blank on those). Without this
// the maturity notice had nobody to write to on most of the serviced book.
// Still no TIN — see the comment above.

/** Every loan FCI services for us, active and inactive. ~95 rows today. */
export async function fciPortfolio() {
  const d = await fciQuery(`{ getLoanPortfolio(includeInactive:true){ ${PORTFOLIO_FIELDS} } }`, { timeoutMs: 60000 });
  return d.getLoanPortfolio || [];
}

/**
 * Accounts FCI touched in the last N hours — the ONLY delta primitive the API
 * offers (no webhooks). Returns bare account numbers; pair with fciPortfolio()
 * to decide what actually needs re-reading.
 */
export async function fciUpdatedAccounts(hoursAgo) {
  const h = Math.max(1, Math.floor(Number(hoursAgo) || 26));
  const d = await fciQuery(`{ getUpdatedLoanList(hoursago:${h}){ loanAccount } }`);
  return (d.getUpdatedLoanList || []).map((r) => r && r.loanAccount).filter(Boolean);
}

/**
 * Street address for one account. The portfolio only carries city/state, so this
 * is the second call needed to match a loan we haven't linked yet. Use sparingly
 * — it's one request per account and the rate limit is unpublished ("set
 * depending on the user of the API").
 */
export async function fciProperties(account) {
  const acct = fciAccount(account);
  if (!acct) return [];
  const d = await fciQuery(`{ getLoanProperties(account:"${acct}"){ street city state zipCode isPrimary propertyType } }`);
  return d.getLoanProperties || [];
}

// ─────────────────────────────────────────────────────────────────────
// Payoffs (Deploy 236.803)
// ─────────────────────────────────────────────────────────────────────

// FCI account numbers are digits in practice; strip anything else rather than
// trying to escape it into a GraphQL literal.
export function fciAccount(v) {
  return String(v == null ? '' : v).replace(/[^A-Za-z0-9_-]/g, '');
}

// GraphQL string literals follow JSON string syntax, so JSON.stringify produces
// a correctly-escaped literal (quotes, backslashes, newlines) — which is what
// keeps borrower-supplied text from breaking out of the query. We also cap
// length and strip control characters first.
function gqlStr(v, max) {
  // Strip control characters (newlines included) before quoting — they have no
  // place in these fields and only complicate the literal. Written as \u escapes
  // on purpose: an earlier revision embedded the raw bytes, which made the file
  // read as binary to grep and came back mangled through a shell round-trip.
  const s = String(v == null ? '' : v)
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 200);
  return JSON.stringify(s);
}

// FCI wants MM/DD/YYYY on payoffDate but MM-DD-YYYY on dateReceived, in the same
// mutation. That is their spec, not a typo on our side.
function usDate(iso, sep) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || '').trim());
  if (!m) return '';
  return m[2] + (sep || '/') + m[3] + (sep || '/') + m[1];
}

/** Live payoff figure for one loan. Null when FCI has nothing (e.g. paid off). */
export async function fciPayoffValue(account) {
  const acct = fciAccount(account);
  if (!acct) return null;
  const d = await fciQuery(`{ getPayoffValuetoDate(account:"${acct}"){
    payoffDate maturityDate interestPaidToDate nextPaymentDue
    unpaidPrincipal unpaidInterest unpaidFees unpaidLateCharges unpaidCharges
    interestRate currentRate dailyInterest prepaymentPenalty lenderExitFee
    escrowBalance suspenseBalance otherPayments otherEstimatedFees fullyPayoff
  } }`);
  const v = d.getPayoffValuetoDate;
  return Array.isArray(v) ? (v[0] || null) : (v || null);
}

/** Demand history + tracking for one loan. */
export async function fciPayoffRequests(account) {
  const acct = fciAccount(account);
  if (!acct) return null;
  const d = await fciQuery(`{ getPayoffRequests(account:"${acct}"){
    account payoffStatus fundsReleaseDate
    latestRequest { dateReceived expirationDate payoffDate trackingStatus trackingFailedStatus requestedBy signatureFor activities { date description } }
    requests { dateReceived expirationDate payoffDate trackingStatus trackingFailedStatus requestedBy signatureFor activities { date description } }
  } }`);
  const v = d.getPayoffRequests;
  return Array.isArray(v) ? (v[0] || null) : (v || null);
}

/** Demands waiting on OUR approval. `approveUrl` is FCI's approval link. */
export async function fciPendingPayoffDemands() {
  const d = await fciQuery(`{ getPendingPayoffDemands{
    account borrowerName payoffTotal dateReceived daysPending urgency
    approvals { lenderAccount approveUrl }
  } }`);
  return d.getPendingPayoffDemands || [];
}

/** Issued demands. wasPaid:false = still outstanding. dateFrom is MM-DD-YYYY. */
export async function fciPayoffDemandStatus({ wasPaid = false, dateFrom } = {}) {
  const from = /^\d{2}-\d{2}-\d{4}$/.test(String(dateFrom || '')) ? dateFrom : usDate(new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10), '-');
  const d = await fciQuery(`{ getPayOffDemandStatus(wasPaid:${wasPaid ? 'true' : 'false'} dateFrom:"${from}"){
    account borrowerName upb interestRate paidToDate nextDueDate maturityDate
    paidOffDate closedDate loanStatus propertyCity propertyState propertyZip
    datePayoffDemandQuoteIssued expiresOnDate wasPaid forwardToLender demandStatus
  } }`);
  return d.getPayOffDemandStatus || [];
}

// reason codes, per FCI's "Payoff Fields" doc
export const PAYOFF_REASONS = { payoff: 0, litigation: 1, inquiry: 2, other: 3 };

/**
 * File a payoff demand with FCI. THIS IS A REAL, OUTWARD-FACING WRITE — it
 * creates a demand on the servicer's system. Callers must gate it behind an
 * explicit user action.
 *
 * `insertPayoff`'s return type is undocumented and introspection is disabled, so
 * we do not know whether it is a scalar or an object. We attempt the bare form
 * first; if GraphQL rejects it as "an object ... Leaf selections ... disallowed"
 * that is a VALIDATION error, which happens before execution — no demand was
 * created — so retrying once with `{ __typename }` (valid on every object type)
 * is safe and cannot double-file.
 */
export async function fciInsertPayoff({
  loanNumber, payoffDate, reason = 0, reqCompany, reqContact, reqEmail,
  reqMailing, reqPhone, description, dateReceived, requestedBy = 'Lender',
}) {
  const acct = fciAccount(loanNumber);
  if (!acct) throw new Error('loanNumber required');
  const pd = usDate(payoffDate, '/');
  if (!pd) throw new Error('payoffDate must be YYYY-MM-DD');
  const dr = usDate(dateReceived || new Date().toISOString().slice(0, 10), '-');
  const rc = Number(reason);

  const args = [
    `loanNumber:"${acct}"`,
    `payoffDate:"${pd}"`,
    `reason:${isFinite(rc) ? rc : 0}`,
    `reqCompany:${gqlStr(reqCompany, 120)}`,
    `reqContact:${gqlStr(reqContact, 120)}`,
    `reqEmail:${gqlStr(reqEmail, 160)}`,
    `reqMailing:${gqlStr(reqMailing, 200)}`,
    `reqPhone:${gqlStr(reqPhone, 40)}`,
    `description:${gqlStr(description, 500)}`,
    `dateReceived:"${dr}"`,
    `requestedBy:${gqlStr(requestedBy, 60)}`,
  ].join(' ');

  const bare = `mutation{ insertPayoff(payoff:{ ${args} }) }`;
  try {
    return await fciQuery(bare, { timeoutMs: 30000 });
  } catch (e) {
    const msg = (e && e.message) || '';
    if (/Leaf selections|is an object, interface or union/i.test(msg)) {
      // Validation failed → nothing executed → safe to send the object form.
      return await fciQuery(`mutation{ insertPayoff(payoff:{ ${args} }){ __typename } }`, { timeoutMs: 30000 });
    }
    throw e;
  }
}
