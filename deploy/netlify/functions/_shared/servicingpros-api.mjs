/**
 * servicingpros-api.mjs — Servicing Pros (my.servicingpros.com) read client.
 *
 * Deploy 236.983 (Mike: "Lets make it so it syncs up similar to the FCI stuff.")
 *
 * What we learned probing their API (see memory reference_servicingpros_api):
 *   • The "Direct API Key" from Settings → Integrations is a long-lived JWT and
 *     works as `Authorization: Bearer <key>` on /api/v2/*. Sending it as
 *     X-Api-Key gets a 401 there (that header is only for their inbound webhook).
 *   • One key = ONE lender account. SLA has two: the SLA book and the King
 *     Arthur Fund 1 book (SLA-KAF). Env vars:
 *         SERVICINGPROS_API_KEY_SLA
 *         SERVICINGPROS_API_KEY_SLA_KAF
 *   • Reads that work (undocumented, but stable in shape):
 *         GET /api/v2/lender                    lender profile
 *         GET /api/v2/lender/loans              every loan on the account
 *         GET /api/v2/lender/loans?account=X    one loan by LoanAccount
 *         GET /api/v2/lender/payments           every payment on the account
 *     Their router answers 200 with an EMPTY text/html body for any unknown
 *     path, so "200 + empty" means "not an endpoint", never "no data".
 *   • The loan feed has the BORROWER's mailing address, not the property, so
 *     the only reliable link to our loans is their LoanAccount ("26-0079-SL"),
 *     which the portal already stores in loan.servicerLoanNumber.
 *
 * The parsing helpers are pure (no env, no fetch) so scripts/servicingpros-sync-
 * test.mjs can pin them.
 */

export const SERVICER = 'Servicing Pros';
export const BASE_URL = 'https://my.servicingpros.com';

// Investor per Servicing Pros account — name (servicing view) + id (Funding
// Plan dropdown). Same pair the 236.734 spreadsheet reconcile stamped.
export const ACCOUNTS = {
  SLA:     { key: 'SLA',     envVar: 'SERVICINGPROS_API_KEY_SLA',     label: 'SLA',     investorName: 'Sir Lends A Lot LLC',    investorId: 'inv_1787696616415_nqc9' },
  SLA_KAF: { key: 'SLA_KAF', envVar: 'SERVICINGPROS_API_KEY_SLA_KAF', label: 'SLA-KAF', investorName: 'King Arthur Fund 1 LLC', investorId: 'inv_1785352851496_76w1' },
};

// Deploy 236.984 — the key is a JWT whose payload names the lender account it
// was issued for (data.account: 'SLA-KAF' | 'SLA' …). Read (not verified —
// their server verifies) so the sync can say which book a key really opens:
// the first dry run showed BOTH env keys returning the same 9 loans.
export function spKeyClaims(token) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    const payload = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    const d = (payload && payload.data) || {};
    return { account: String(d.account || ''), accountType: String(d.account_type || ''), email: String(d.email_address || ''),
      exp: payload.exp ? new Date(payload.exp * 1000).toISOString().slice(0, 10) : '' };
  } catch (_) { return null; }
}
export function spKeyClaimsFor(account, env) {
  return spKeyClaims(String((env || process.env)[account.envVar] || '').trim());
}

// Their account numbers look like 26-0079-SL. Hand-typed servicer numbers on
// our side carry stray text now and then ("26-0239-SL AND") — match on the
// number inside, and let the sync rewrite the clean form.
export function normalizeServicerNumber(s) {
  const m = /(\d{2}-\d{4}-[A-Z]{2})/i.exec(String(s || '').toUpperCase());
  return m ? m[1].toUpperCase() : String(s || '').trim().toUpperCase();
}

export function spConfiguredAccounts(env) {
  const e = env || process.env;
  return Object.values(ACCOUNTS).filter((a) => String(e[a.envVar] || '').trim().length > 20);
}
export function spConfigured(env) {
  return spConfiguredAccounts(env).length > 0;
}

// "2026-10-01 00:00:00" | "2026-10-01" | null → "2026-10-01" | ''
export function spDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /^(null|n\/?a)$/i.test(s)) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return '';
  if (m[1] === '1900') return '';   // their "empty date"
  return m[1] + '-' + m[2] + '-' + m[3];
}
export function spNum(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return isFinite(n) ? n : null;
}
// Note rates arrive as percent numbers (11, 10.99); guard a decimal form anyway.
export function spPct(v) {
  const n = spNum(v);
  if (n == null || n <= 0) return '';
  const pct = n <= 1 ? n * 100 : n;
  return String(Math.round(pct * 100000) / 100000);
}

/**
 * One loan row from GET /api/v2/lender/loans, reduced to what the sync uses.
 * `account` is the Servicing Pros LoanAccount — our servicerLoanNumber.
 */
export function normalizeSpLoan(raw, accountKey) {
  const r = raw || {};
  const paidOff = spDate(r.LoanTermsPaidOffDate);
  return {
    book: accountKey || '',
    account: String(r.LoanAccount || '').trim(),
    accountNumber: String(r.LoanAccountNumber || '').trim(),
    recId: String(r.LoanRecID || '').trim(),
    origBalance: spNum(r.LoanTermsOrigBal),
    principalBalance: spNum(r.LoanTermsPrinBal),
    noteRate: spPct(r.LoanTermsNoteRate),
    closingDate: spDate(r.LoanTermsClosingDate),
    firstPaymentDate: spDate(r.LoanTermsFirstPaymentDate),
    maturityDate: spDate(r.LoanTermsMaturityDate),
    nextDueDate: spDate(r.LoanTermsNextDueDate),
    paidToDate: spDate(r.LoanTermsPaidToDate),
    paidOffDate: paidOff,
    lastPaymentDate: spDate(r.LastPaymentDate),
    regularPayment: spNum(r.LoanTermsRegularPayment) != null ? spNum(r.LoanTermsRegularPayment) : spNum(r.LoanTermsPmtPI),
    pmtPI: spNum(r.LoanTermsPmtPI),
    daysLate: spNum(r.LoanDaysLate),
    serviceStatus: spNum(r.LoanServiceStatus),      // 1 = active on their side
    unpaidInterest: spNum(r.LoanTermsUnpaidInterest),
    unpaidLateCharges: spNum(r.LoanTermsUnpaidLateCharges),
    trustBalance: spNum(r.LoanTermsTrustBalance),
    categories: String(r.LoanTermsCategories || '').trim(),
    // Borrower MAILING contact on their side — kept in sp* fields only, never
    // written over the client record (same rule as the FCI borrower fields).
    borrowerName: String(r.BorrowerFullName || '').trim(),
    borrowerEmail: String(r.BorrowerEmailAddress || '').trim().toLowerCase(),
    borrowerCity: String(r.BorrowerCity || '').trim(),
    borrowerState: String(r.BorrowerState || '').trim(),
    paidOff: !!paidOff,
  };
}

// Their book → our disposition. A paid-off date is explicit (unlike FCI's
// "Assigned"/"CLOSED" ambiguity), so both branches map.
export function dispositionForSp(loan) {
  return loan && loan.paidOff ? 'paid_off' : 'sold';
}

/**
 * Deploy 236.827's rule, for the same reason: one servicer account stamped on
 * SEVERAL of our loans (a 1st and a 2nd at one property, or a mis-tag) must
 * resolve to ONE loan, on the one number both sides agree on — the original
 * balance — or resolve to nothing and be reported.
 */
export function pickLoanForSpRow(matches, row) {
  if (!matches || matches.length <= 1) return { pick: matches && matches[0], reason: 'single' };
  const target = row && row.origBalance;
  if (target == null || target <= 0) return { pick: null, reason: 'no Servicing Pros original balance to match on' };
  const scored = matches
    .map((h) => ({ h, rel: h.loanAmt != null && h.loanAmt > 0 ? Math.abs(h.loanAmt - target) / target : Infinity }))
    .sort((a, b) => a.rel - b.rel);
  const best = scored[0], next = scored[1];
  if (!best || !isFinite(best.rel)) return { pick: null, reason: 'no loan amounts to compare' };
  if (best.rel > 0.02) return { pick: null, reason: 'closest amount is ' + (best.rel * 100).toFixed(1) + '% off the original balance' };
  if (next && isFinite(next.rel) && next.rel <= 0.02) return { pick: null, reason: 'two loans both match the balance within 2%' };
  return { pick: best.h, reason: 'matched on original balance' };
}

// ── HTTP ─────────────────────────────────────────────────────────────
async function spGet(account, path) {
  const token = String(process.env[account.envVar] || '').trim();
  if (!token) throw new Error(account.envVar + ' is not set');
  const r = await fetch(BASE_URL + path, {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
  });
  const text = await r.text();
  if (!r.ok) throw new Error('Servicing Pros ' + path + ' → HTTP ' + r.status + ': ' + text.slice(0, 200));
  if (!text.trim()) throw new Error('Servicing Pros ' + path + ' → empty body (not an endpoint?)');
  try { return JSON.parse(text); }
  catch (e) { throw new Error('Servicing Pros ' + path + ' → not JSON: ' + text.slice(0, 120)); }
}

/** Lender profile for the account (a cheap credential check). */
export async function spProfile(account) {
  return spGet(account, '/api/v2/lender');
}
/** Every loan on the account, normalized. */
export async function spLoans(account) {
  const rows = await spGet(account, '/api/v2/lender/loans');
  return (Array.isArray(rows) ? rows : []).map((r) => normalizeSpLoan(r, account.key));
}
/** Every payment on the account (raw rows; ~40 today). */
export async function spPayments(account) {
  const rows = await spGet(account, '/api/v2/lender/payments');
  return Array.isArray(rows) ? rows : [];
}
