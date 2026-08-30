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
`;

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
  const acct = String(account || '').replace(/[^A-Za-z0-9_-]/g, '');
  if (!acct) return [];
  const d = await fciQuery(`{ getLoanProperties(account:"${acct}"){ street city state zipCode isPrimary propertyType } }`);
  return d.getLoanProperties || [];
}
