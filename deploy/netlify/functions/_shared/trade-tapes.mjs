/**
 * _shared/trade-tapes.mjs — Deploy 236.885 (Mike)
 *
 * Trade-tape template registry. Each template maps loan records onto one
 * investor tape format; the export endpoint (trade-tape-export.mjs) feeds it
 * enriched contexts and streams back a real .xlsx (via _shared/xlsx-write).
 *
 * Templates (from Mike's sample files, column-for-column):
 *   colchis_trade      POST-CLOSE — "Loan Trade" tape sent to Colchis when
 *                      offering closed RTLs for trade (61 columns, A–BI).
 *   colchis_settlement POST-CLOSE — settlement tape once Colchis accepts the
 *                      trade (26 columns + totals row; trade-date math:
 *                      accrued interest on 30/360, Dutch accrues on the TOTAL
 *                      loan amount, Non-Dutch on the balance at purchase —
 *                      verified against 6 historical trade sheets).
 *   stride_dscr        PRE-FUNDING — Stride submission tape for a DSCR loan
 *                      (73-col "Form" sheet; Deploy 236.888). Investor-side
 *                      columns (Pass-thru Rate, Investor Lock Price, MERS MIN,
 *                      Stride/Servicer IDs) stay blank for hand-fill and are
 *                      surfaced in the missing report.
 *   stride_rtl         PRE-FUNDING — Stride submission tape for an RTL loan
 *                      (56-col "Sheet1"; Deploy 236.888). Same hand-fill rule.
 *
 * ctx per loan: { loan, client, guarantors[], sla, ownerKey, params }
 *   guarantors = ADDITIONAL guarantor client records (loan.guarantorClientIds).
 * Mappers return '' when the platform genuinely doesn't know the value; the
 * endpoint reports blanks in required columns so processors hand-fill
 * knowingly instead of discovering holes after the tape ships.
 *
 * Deploy 236.886 (Mike, tape test feedback):
 *   - doc-sourced columns (sqft, flood zone, 3rd-party AIV, valuation date/
 *     type/provider, borrower reserves, entity TIN) now read the screened
 *     Underwriting-tab values (loan.uwData — AI-extracted at doc review,
 *     human-verified) with the old loan-record fallbacks;
 *   - first payment + maturity derive from the funding date when unset;
 *   - rate/points/LTC/LTAIV/LTARV cells carry the 'pct' style so Excel shows
 *     10.99% instead of a raw 0.1099 ("showing as below zero");
 *   - broker-originated deals no longer leak the BROKER's name/address/FICO
 *     into the borrower + guarantor columns.
 */
import { clientActsAsBroker } from './borrower-prefill.mjs';

// ── helpers ────────────────────────────────────────────────────────────────
const num = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, ''));
  return isFinite(n) ? n : null;
};
// Rates are stored as percents (10.5) on native loans, fractions (0.105) on
// some Baseline imports — normalize to a DECIMAL fraction for tape output.
const rateFrac = (v) => {
  const n = num(v);
  if (n == null || n <= 0) return null;
  return n > 1 ? n / 100 : n;
};
const round2 = (n) => Math.round(n * 100) / 100;
const dstr = (v) => { // ISO-ish → M/D/YYYY string; '' when unparseable
  const s = String(v || '').slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return '';
  return parseInt(m[2], 10) + '/' + parseInt(m[3], 10) + '/' + m[1];
};
const dparts = (v) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || '').slice(0, 10));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
};
// US 30/360 day count (matches the historical settlement sheets, negative
// counts included — a trade dated before the paid-to date is an interest
// credit back to the buyer).
function days360(a, b) {
  if (!a || !b) return null;
  let d1 = Math.min(a.d, 30);
  let d2 = b.d;
  if (d2 === 31 && d1 >= 30) d2 = 30;
  return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1);
}
// "123 Main St, Cincinnati, OH, 45212" (or "...OH 45212") → parts.
function parseAddr(addr) {
  const parts = String(addr || '').split(',').map((p) => p.trim()).filter(Boolean);
  const out = { street: parts[0] || '', city: '', state: '', zip: '' };
  const rest = parts.slice(1);
  for (const p of rest) {
    const m = /^([A-Z]{2})\s*(\d{5})?/.exec(p);
    if (m && p.length <= 12) { out.state = m[1]; if (m[2]) out.zip = m[2]; continue; }
    const z = /^\d{5}(-\d{4})?$/.exec(p);
    if (z) { out.zip = p.slice(0, 5); continue; }
    if (/^(USA|US|United States)$/i.test(p)) continue;
    if (!out.city) out.city = p;
  }
  return out;
}
const clientName = (c) => {
  if (!c) return '';
  return (((c.firstName || '') + ' ' + (c.lastName || '')).replace(/\s+/g, ' ').trim());
};
// Deploy 236.886 — screened Underwriting-tab value (loan.uwData: AI-extracted
// at doc review, human-verified on the UW tab). Null when never gathered.
const uw = (c, key) => {
  const e = c.loan && c.loan.uwData && c.loan.uwData[key];
  const v = e && e.value;
  return (v == null || v === '') ? null : v;
};
// Deploy 236.886 — broker-originated deals: the primary client record is the
// BROKER, not the borrower (a live tape shipped with the broker's name + home
// address in the borrower columns). People on the tape = the real guarantor
// records only; the borrower name comes from the loan record itself.
const isBrokerCtx = (c) => {
  if (c._brokerCtx === undefined) c._brokerCtx = clientActsAsBroker(c.client, c.loan, null);
  return c._brokerCtx;
};
const gPeople = (c) => isBrokerCtx(c) ? c.guarantors : [c.client].concat(c.guarantors);
const entityNameOf = (c) => isBrokerCtx(c)
  ? (c.loan.entityName || '')
  : (c.loan.entityName || (c.client && c.client.entityName) || '');
const borrowerName = (ctx) => entityNameOf(ctx)
  || (isBrokerCtx(ctx) ? (ctx.loan.borrowerName || clientName(ctx.guarantors[0])) : clientName(ctx.client));
const propTypeLabel = (pt) => {
  const p = String(pt || '').toLowerCase();
  if (!p) return '';
  if (p === 'sfr' || p === 'sfh') return 'SFR';
  if (p === 'mfr' || p === 'multi' || p === '5+') return 'MFR';
  if (p === '2-4') return '2-4 Unit';
  if (p.indexOf('condo') === 0) return 'Condo';
  return pt;
};
const dutchLabel = (l) => {
  const d = String(l.dutchInterest || '').toLowerCase();
  if (d === 'dutch') return 'Dutch';
  if (d === 'non_dutch' || d === 'non-dutch') return 'Non-Dutch';
  return '';
};
const totalAmt = (l) => num(l.finalLoanAmount) || num(l.loanAmt) || null;
const rehabAmt = (l) => num(l.rehabBudget) || 0;
const ficoOf = (c, l) => {
  // Prefer a pulled mid score (the client's creditMidScore is stamped by the
  // Xactus flow), else the stated FICO bucket's number when it's a plain number.
  const mid = c && num(c.creditMidScore);
  if (mid) return mid;
  const f = c && num(c.fico);
  return f || (l ? num(l.creditMidScore) : null) || '';
};
// Deploy 236.886 — percent-styled cell ({ v, s:'pct' } renders "10.99%" via
// xlsx-write's numFmt 10). Input is a DECIMAL fraction.
const pct = (n) => (n == null || n === '' ? '' : { v: n, s: 'pct' });
// Date of First Payment = the month after the month after closing, on the 1st
// (Mike: "you should already know" it) — unless the loan record has one.
const firstPaymentOf = (l) => {
  if (l.firstPaymentDate) return dstr(l.firstPaymentDate);
  const f = dparts(l.fundingDate);
  if (!f) return '';
  let m = f.m + 2, y = f.y;
  if (m > 12) { m -= 12; y += 1; }
  return m + '/1/' + y;
};
// Maturity = funding date + term months (day clamped to the target month).
const maturityOf = (l) => {
  if (l.maturityDate) return dstr(l.maturityDate);
  const f = dparts(l.fundingDate);
  if (!f) return '';
  const t = num(l.term) || 12;
  let m = f.m + t, y = f.y;
  while (m > 12) { m -= 12; y += 1; }
  const dim = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return m + '/' + Math.min(f.d, dim) + '/' + y;
};
// Borrower Reserves = the UW tab's weighted liquidity: Σ(account balance ×
// weight) + EMD paid. Weights mirror loan-uw-fields.js ACCOUNT_WEIGHTS (the
// per-deal weight saved on each account row wins when present).
const TAPE_ACCOUNT_WEIGHTS = {
  'Checking/Savings': 0.70,
  'Stocks/Mutual Funds': 0.50,
  'IRA/401k/Retirement Plans': 0,
  'HELOC': 0,
  'Business Checking Acct.': 1.00,
};
const reservesOf = (c) => {
  let total = 0, any = false;
  for (let i = 1; i <= 5; i++) {
    const a = uw(c, 'account' + i);
    if (!a || typeof a !== 'object') continue;
    const bal = num(a.balance);
    if (bal == null) continue;
    let w = (a.weight != null && a.weight !== '') ? num(a.weight) : TAPE_ACCOUNT_WEIGHTS[a.type];
    if (w == null) w = 1;
    if (w > 1) w = w / 100; // tolerate "70" for 70%
    total += bal * w;
    any = true;
  }
  const emd = num(uw(c, 'emd'));
  if (emd != null) { total += emd; any = true; }
  return any ? round2(total) : '';
};
const thirdPartyAiv = (c) => num(c.loan.aivBpo) || num(uw(c, 'asIsPrice')) || null;

// ── Template: Colchis post-close trade tape (61 cols) ─────────────────────
const COLCHIS_TRADE_COLS = [
  ['Lender Loan ID', (c) => c.sla],
  ['Record Identifier', () => ''],
  ['Property Address', (c) => parseAddr(c.loan.address).street],
  ['Property City', (c) => parseAddr(c.loan.address).city],
  ['Property State', (c) => parseAddr(c.loan.address).state],
  ['Property ZIP', (c) => parseAddr(c.loan.address).zip],
  ['Property Type', (c) => propTypeLabel(c.loan.propType)],
  ['AIV Units', (c) => num(c.loan.numUnits) || 1],
  ['ARV Units', (c) => num(c.loan.numUnits) || 1],
  ['AIV Sqft', (c) => num(uw(c, 'propertySqFt')) || num(uw(c, 'valuationSqft')) || num(c.loan.sqft) || ''],
  ['ARV Sqft', (c) => num(uw(c, 'propertySqFt')) || num(uw(c, 'valuationSqft')) || num(c.loan.sqft) || ''],
  ['Flood Zone', (c) => {
    const z = String(c.loan.floodZone || uw(c, 'floodZone') || '').trim().toUpperCase();
    if (!z) return '';
    return (z === 'NO' || z === 'NONE' || z.charAt(0) === 'X' || z.charAt(0) === 'C' || z.charAt(0) === 'B') ? 'No' : 'Yes';
  }],
  ['Property Purchase Date', (c) => dstr(c.loan.purchaseDate || (String(c.loan.loanPurpose || '') === 'purchase' ? c.loan.fundingDate : ''))],
  ['Property Purchase Price', (c) => num(c.loan.purchasePrice) || ''],
  ['Assignment Fee', () => 0],
  ['Remaining Rehab Budget', (c) => rehabAmt(c.loan)],
  ['Rehab Spent to Date', () => 0],
  ['Total Cost Basis', (c) => (num(c.loan.purchasePrice) || 0) + rehabAmt(c.loan) || ''],
  ['Third Party AIV', (c) => thirdPartyAiv(c) || ''],
  ['Third Party ARV', (c) => num(c.loan.arvBpo) || num(c.loan.arv) || ''],
  ['Valuation Date', (c) => dstr(uw(c, 'valuationDate')) || String(uw(c, 'valuationDate') || '')],
  ['Third Party Valuation Type', (c) => uw(c, 'valuationType') || (num(c.loan.aivBpo) ? 'BPO' : '')],
  ['Third Party Valuation Provider', (c) => uw(c, 'valuationProvider') || ''],
  ['Loan Purpose', (c) => {
    const p = String(c.loan.loanPurpose || '').toLowerCase();
    if (p === 'purchase') return 'Purchase';
    if (p.indexOf('refi') === 0 || p === 'cashout' || p === 'refinance') return 'Refinance';
    return '';
  }],
  ['Loan Strategy', (c) => {
    const lt = String(c.loan.loanType || '').toLowerCase();
    if (lt === 'bridge') return 'Bridge';
    return rehabAmt(c.loan) > 0 ? 'Rehab' : 'Bridge';
  }],
  ['Origination Date', (c) => dstr(c.loan.fundingDate)],
  ['Date of First Payment', (c) => firstPaymentOf(c.loan)],
  ['Original Maturity Date', (c) => maturityOf(c.loan)],
  ['Term (Mo.)', (c) => num(c.loan.term) || 12],
  ['Total Loan Amount', (c) => totalAmt(c.loan) || ''],
  ['Balance At Submission', (c) => num(c.loan.upb) || totalAmt(c.loan) || ''],
  ['Initial Loan Amount', (c) => { const t = totalAmt(c.loan); return t == null ? '' : t - rehabAmt(c.loan); }],
  ['Initial Rehab Holdback', (c) => rehabAmt(c.loan)],
  ['Initial Interest Reserve', () => 0],
  ['Appraisal Holdback', () => 0],
  ['Note Rate (%)', (c) => pct(rateFrac(c.loan.rate))],
  ['Orig Points (%)', (c) => { const p = num(c.loan.points); return p == null ? '' : pct(p / 100); }],
  ['Original P&I Amount', (c) => {
    const t = totalAmt(c.loan), r = rateFrac(c.loan.rate);
    return (t && r) ? round2(t * r / 12) : '';
  }],
  ['Interest Accrual Methodology', () => '30/360'],
  ['Cash Out Amount (Refi)', () => ''],
  ['Dutch/Non-Dutch', (c) => dutchLabel(c.loan)],
  ['Initial LTC', (c) => {
    const t = totalAmt(c.loan), pp = num(c.loan.purchasePrice);
    return (t && pp) ? pct(round4((t - rehabAmt(c.loan)) / pp)) : '';
  }],
  ['LTAIV', (c) => {
    const t = totalAmt(c.loan), aiv = thirdPartyAiv(c);
    return (t && aiv) ? pct(round4(t / aiv)) : '';
  }],
  ['Total LTC', (c) => {
    const t = totalAmt(c.loan), pp = num(c.loan.purchasePrice);
    const basis = (pp || 0) + rehabAmt(c.loan);
    return (t && basis) ? pct(round4(t / basis)) : '';
  }],
  ['LTARV', (c) => {
    const t = totalAmt(c.loan), arv = num(c.loan.arvBpo) || num(c.loan.arv);
    return (t && arv) ? pct(round4(t / arv)) : '';
  }],
  ['Borrower Name', (c) => borrowerName(c)],
  ['Borrower Type', (c) => (entityNameOf(c) ? 'Entity' : 'Individual')],
  ['Experience (# projects in 3yrs)', (c) => {
    const g1 = gPeople(c)[0];
    return num(c.loan.experience) != null ? num(c.loan.experience) : (num(g1 && g1.flips) || '');
  }],
  ['Foreign National Flag (Y/N)', (c) => {
    const g1 = gPeople(c)[0];
    const u = String((g1 && g1.usCitizen) || c.loan.usCitizen || uw(c, 'usCitizen') || '').toLowerCase();
    if (!u) return '';
    return u === 'yes' || u === 'y' || u === 'true' ? 'N' : 'Y';
  }],
  ['Borrower Reserves', (c) => reservesOf(c)],
  // Borrower address = the primary PERSON on the deal (never the broker's).
  ['Borrower Address', (c) => { const g = gPeople(c)[0]; return (g && g.homeAddress && g.homeAddress.street) || ''; }],
  ['Borrower City', (c) => { const g = gPeople(c)[0]; return (g && g.homeAddress && g.homeAddress.city) || ''; }],
  ['Borrower State', (c) => { const g = gPeople(c)[0]; return (g && g.homeAddress && g.homeAddress.state) || ''; }],
  ['Borrower ZIP', (c) => { const g = gPeople(c)[0]; return (g && g.homeAddress && g.homeAddress.zip) || ''; }],
  ['Entity TIN', (c) => {
    const screened = uw(c, 'entityTin');
    if (screened) return String(screened);
    // Fall back to a company on the primary person's record, entity-name-matched
    // first. On broker deals the broker's own companies are never consulted.
    const person = gPeople(c)[0];
    const cos = (person && person.companies) || [];
    const ent = String(borrowerName(c)).toLowerCase();
    const hit = cos.find((co) => co && co.ein && String(co.name || '').toLowerCase() === ent) || cos.find((co) => co && co.ein);
    return (hit && hit.ein) || '';
  }],
  ['Guarantor 1 Name', (c) => clientName(gPeople(c)[0])],
  ['Guarantor 1 FICO', (c) => { const g = gPeople(c)[0]; return g ? ficoOf(g, c.loan) : ''; }],
  ['Guarantor 1 DOB', (c) => { const g = gPeople(c)[0]; return dstr(g && g.dob); }],
  ['Guarantor 2 Name', (c) => clientName(gPeople(c)[1])],
  ['Guarantor 2 FICO', (c) => { const g = gPeople(c)[1]; return g ? ficoOf(g, null) : ''; }],
  ['Guarantor 2 DOB', (c) => { const g = gPeople(c)[1]; return dstr(g && g.dob); }],
];
function round4(n) { return Math.round(n * 10000) / 10000; }
// Columns whose blanks the processor must hand-fill before sending.
const COLCHIS_TRADE_REQUIRED = ['Property Address', 'Property State', 'Total Loan Amount',
  'Note Rate (%)', 'Origination Date', 'Original Maturity Date', 'Borrower Name',
  'Guarantor 1 Name', 'Guarantor 1 FICO', 'Third Party AIV', 'Entity TIN', 'Dutch/Non-Dutch'];

// ── Template: Colchis settlement tape (26 cols + totals) ──────────────────
function settlementRow(c) {
  const l = c.loan;
  const trade = dparts(c.params.tradeDate);
  const paidTo = trade ? { y: trade.y, m: trade.m, d: 1 } : null;
  const nextDue = trade ? (trade.m === 12 ? { y: trade.y + 1, m: 1, d: 1 } : { y: trade.y, m: trade.m + 1, d: 1 }) : null;
  const fmt = (p) => p ? (p.m + '/' + p.d + '/' + p.y) : '';
  const gross = rateFrac(l.rate);
  const colchis = rateFrac(l.soldRate);
  const L = totalAmt(l);
  const N = rehabAmt(l);
  const O = 0; // rehab drawn — not tracked reliably at trade time; hand-fill if drawn
  const P = N - O;
  const M = L != null ? L - P : null;
  const dutch = dutchLabel(l);
  const V = days360(paidTo, trade);
  // Accrued interest at the COLCHIS rate: Dutch accrues on the full loan
  // amount, Non-Dutch on the balance at purchase (verified against 6
  // historical settlement sheets, negative day counts included).
  const W = (V != null && colchis != null && L != null && M != null)
    ? round2((dutch === 'Dutch' ? L : M) * colchis / 360 * V) : null;
  const Y = (M != null) ? round2(M + (W || 0)) : null;
  return [
    c.sla,
    parseAddr(l.address).street,
    borrowerName(c),
    dutch,
    '30/360',
    fmt(paidTo),
    fmt(nextDue),
    fmt(trade),
    pct(gross),
    pct(colchis),
    (gross != null && colchis != null) ? pct(round4(gross - colchis)) : '',
    L != null ? L : '',
    M != null ? M : '',
    N,
    O,
    P,
    0, // Appraisal Holdback Remaining
    0, // Interest Escrow Balance
    0, // B-Piece $
    0, // B-Piece %
    M != null ? M : '', // CCM Balance
    V != null ? V : '',
    W != null ? W : '',
    pct(1), // Purchase Price (%) — 100.00%
    Y != null ? Y : '',
    String(c.params.fundingBank || ''),
  ];
}
const COLCHIS_SETTLE_HEADERS = ['Loan Number', 'Street Address', 'Borrower Name', 'Dutch Interest',
  'Interest Accrual', 'Paid to Date', 'Next Due Date', 'Trade Date', 'Gross Rate', 'Colchis Rate',
  'Seller Spread', 'Total Loan Amount', 'Loan Balance At Purchase', 'Rehab Holdback Amount',
  'Rehab Drawn', 'Current Rehab Holdback', 'Appraisal Holdback Remaining', 'Interest Escrow Balance',
  'B-Piece $', 'B-Piece %', 'CCM Balance', 'Days Accrued', 'Accrued Interest', 'Purchase Price (%)',
  'Proceeds', 'Funding Bank'];
const COLCHIS_SETTLE_REQUIRED = ['Street Address', 'Gross Rate', 'Colchis Rate', 'Total Loan Amount', 'Dutch Interest'];

// ── Stride pre-funding tapes (Deploy 236.888) ─────────────────────────────
// One row per loan, column-for-column from Mike's sample submissions
// ("Stride - DSCR Tape.xlsm" Form sheet / "Stride - RTL Template.xlsx"
// Sheet1). Sample files carry Excel serial dates; Stride accepts date
// strings, so we emit M/D/YYYY like the Colchis tapes.

// Monthly amortizing payment, 360-month term (DSCR is 30-yr amortizing).
const amortPI = (total, rf) => {
  if (!total || rf == null) return null;
  if (rf === 0) return round2(total / 360);
  const m = rf / 12;
  const f = Math.pow(1 + m, 360);
  return round2(total * m * f / (f - 1));
};
// DSCR sizer prepay codes → Stride's flag / term (months) / type string.
const PREPAY_MAP = {
  '5y6m':  { term: 60, type: '5yr/6mo' },
  '54321': { term: 60, type: '5-4-3-2-1' },
  '321':   { term: 36, type: '3-2-1' },
  '320':   { term: 24, type: '3-2-0' },
  '300':   { term: 12, type: '3-0-0' },
};
const prepayInfo = (l) => PREPAY_MAP[String(l.prepay || '').toLowerCase()] || null;
const dscrPurpose = (l) => {
  const p = String(l.loanPurpose || '').toLowerCase();
  if (!p) return '';
  if (p.indexOf('cash') >= 0) return 'Cash-Out Refinance';
  if (p.charAt(0) === 'p') return 'Purchase';
  return 'R/T Refinance';
};
// Y when the primary client's book holds another loan that already closed.
const repeatBorrower = (c) => {
  const loans = (c.client && c.client.loans) || [];
  const done = loans.some((l) => l && l.id !== c.loan.id &&
    /^(closed|sold|liquidated)$/.test(String(l.status || '').toLowerCase()));
  return done ? 'Y' : 'N';
};
const yn = (v) => (v ? 'Yes' : 'No');
const addDays = (iso, days) => {
  const p = dparts(iso);
  if (!p) return '';
  const d = new Date(Date.UTC(p.y, p.m - 1, p.d + days));
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
};
// DSCR PITIA — the sizer stamps its computed total onto the loan.
const pitiaOf = (l) => num(l._totalPayment) || null;
const dscrOf = (l) => num(l.dscr) || num(l._dscr) || null;
// DSCR points: loan.points, else the sizer's "_points" display ("2.00 pts").
const dscrPoints = (l) => num(l.points) != null ? num(l.points) : num(l._points);
const g1Of = (c) => gPeople(c)[0] || null;
const citizenOf = (c) => {
  const g1 = g1Of(c);
  const u = String((g1 && g1.usCitizen) || c.loan.usCitizen || uw(c, 'usCitizen') || '').toLowerCase();
  if (!u) return null;
  return (u === 'yes' || u === 'y' || u === 'true');
};

const STRIDE_DSCR_COLS = [
  ['Loan Numbers', (c) => c.sla],
  ['Seller', () => 'Sir Lends A Lot LLC'],
  ['Channel', () => 'Retail'],
  ['Seller Program', () => 'DSCR'],
  ['Original Loan Amount', (c) => totalAmt(c.loan) || ''],
  [' Current UPB', (c) => num(c.loan.upb) || totalAmt(c.loan) || ''],
  ['Borrower Name First', (c) => borrowerName(c)],
  ['Borrower Name Last', () => ''],
  ['Co-Borrower Name First', () => ''],
  ['Co-Borrower Name Last', () => ''],
  ['Guarantor', (c) => clientName(gPeople(c)[0])],
  ['Guarantor 2', (c) => clientName(gPeople(c)[1])],
  ['Property Address', (c) => parseAddr(c.loan.address).street],
  ['Property City', (c) => parseAddr(c.loan.address).city],
  ['Property State', (c) => parseAddr(c.loan.address).state],
  ['Property Zip', (c) => parseAddr(c.loan.address).zip],
  ['Note Rate', (c) => pct(rateFrac(c.loan.rate || c.loan._finalRate))],
  ['Pass-thru Rate', () => ''], // investor-side — hand-fill
  [' FICO', (c) => { const g = g1Of(c); return g ? ficoOf(g, c.loan) : ''; }],
  [' LTV', (c) => {
    const t = totalAmt(c.loan), v = num(uw(c, 'appraisedValue')) || num(c.loan.propValue);
    return (t && v) ? pct(round4(t / v)) : '';
  }],
  ['CLTV', (c) => {
    const t = totalAmt(c.loan), v = num(uw(c, 'appraisedValue')) || num(c.loan.propValue);
    return (t && v) ? pct(round4(t / v)) : ''; // no junior liens on our deals
  }],
  ['DSCR', (c) => dscrOf(c.loan) || ''],
  [' DTI', () => ''],
  ['Sales Price', (c) => (dscrPurpose(c.loan) === 'Purchase' ? (num(c.loan.purchasePrice) || '') : '')],
  ['Property Value', (c) => num(uw(c, 'appraisedValue')) || num(c.loan.propValue) || ''],
  ['Doc Type', () => 'DSCR'],
  ['Doc Months', () => ''],
  ['Doc Type Detail', () => ''],
  ['Purpose', (c) => dscrPurpose(c.loan)],
  ['Occupancy', () => 'Investment'],
  ['Property Type', (c) => propTypeLabel(c.loan.propType)],
  ['Units', (c) => num(c.loan.numUnits) || 1],
  ['Orig Term', () => 360],
  ['Amort Term', () => 360],
  ['Seasoning', () => ''],
  ['IO Flag', (c) => yn(String(c.loan.isIO || '').toLowerCase() === 'yes')],
  ['IO Months', (c) => (String(c.loan.isIO || '').toLowerCase() === 'yes' ? 120 : 0)],
  ['ARM Flag', (c) => yn(/arm/i.test(String(c.loan.product || c.loan.productType || '')))],
  ['Fixed Period', () => ''],
  ['Product Type', (c) => c.loan.product || '30 year fixed'],
  ['Product', () => ''],
  ['Non-Warrantable Flag', () => 'No'],
  ['Rural Flag', (c) => yn(/^y/i.test(String(uw(c, 'rucaRural') || '')))],
  ['ST Rental Flag', (c) => yn(!!(c.loan.shortTermRental || c.loan.strRental || /str|short/i.test(String(c.loan.rentalType || ''))))],
  ['Prepay Flag', (c) => yn(!!prepayInfo(c.loan))],
  ['Prepay Penalty Term', (c) => { const p = prepayInfo(c.loan); return p ? p.term : 0; }],
  ['Prepay Penalty Type', (c) => { const p = prepayInfo(c.loan); return p ? p.type : ''; }],
  ['Citizenship', (c) => { const u = citizenOf(c); return u == null ? '' : (u ? 'US Citizen' : 'Foreign National'); }],
  ['Foreign National Flag', (c) => { const u = citizenOf(c); return u == null ? '' : (u ? 'No' : 'Yes'); }],
  ['ITIN Flag', () => 'No'],
  ['FTHB Flag', () => 'No'],
  // DSCR + MF5+ escrow taxes AND insurance (Deploy 236.855 standing rule).
  ['Monthly Insurance', () => 'Yes'],
  ['Monthly Tax', () => 'Yes'],
  ['Escrow Payment', () => 'Yes'],
  ['Program', () => ''],
  ['Monthly P&I', (c) => {
    const t = totalAmt(c.loan), rf = rateFrac(c.loan.rate || c.loan._finalRate);
    if (!t || rf == null) return '';
    // IO loans pay interest only (the sample sheet's own P&I is exactly this).
    return String(c.loan.isIO || '').toLowerCase() === 'yes' ? round2(t * rf / 12) : amortPI(t, rf);
  }],
  ['Monthly PITI', (c) => pitiaOf(c.loan) || ''],
  ['Application Date', () => ''],
  ['Closing Date', (c) => dstr(c.loan.closingDate || c.loan.fundingDate)],
  ['Origination Points', (c) => dscrPoints(c.loan) != null ? dscrPoints(c.loan) : ''],
  ['Estimated Disbursment Date', (c) => dstr(c.loan.fundingDate)],
  ['First Payment Date', (c) => firstPaymentOf(c.loan)],
  ['Escrows at Close', () => ''],
  ['Pre-Paid Interest at Close', () => ''],
  ['Investor Name', () => 'Colchis'],
  ['Investor Lock Date', (c) => dstr(c.loan.rateLockStart)],
  ['Investor Lock Expiration Date', (c) => addDays(c.loan.rateLockStart, 45)], // 45-day DSCR lock
  ['Investor Lock Price', () => ''], // investor-side — hand-fill
  ['Estimated Investor Sale Date', () => ''],
  ['Servicer ID', () => ''],
  ['MERs MIN ID', () => ''], // assigned at registration — hand-fill
  ['ULI', () => ''],
  ['Day Count (360, 365)', () => 360],
];
const STRIDE_DSCR_REQUIRED = ['Property Address', 'Property State', 'Original Loan Amount',
  'Note Rate', ' FICO', ' LTV', 'DSCR', 'Property Value', 'Purpose', 'Monthly PITI',
  'First Payment Date', 'Guarantor', 'Investor Lock Date',
  'Pass-thru Rate', 'Investor Lock Price', 'MERs MIN ID'];

const STRIDE_RTL_COLS = [
  ['Servicer ID', () => ''],
  ['Initial Escrow', () => 0],
  ['Loan Number', (c) => c.sla],
  ['Seller', () => 'Sir Lends A Lot, LLC'],
  ['Stride ID', () => ''], // assigned by Stride — hand-fill
  ['Seller Program', () => 'RTL'],
  ['Investor', () => 'Colchis'],
  ['Investor Buy Rate', (c) => pct(rateFrac(c.loan.soldRate))],
  ['Loan Number', (c) => c.sla], // yes, twice — the template repeats it
  ['Borrowing Entity', (c) => borrowerName(c)],
  ['Guarantor', (c) => gPeople(c).map(clientName).filter(Boolean).join('; ')],
  ['Address', (c) => parseAddr(c.loan.address).street],
  ['City', (c) => parseAddr(c.loan.address).city],
  ['State', (c) => parseAddr(c.loan.address).state],
  ['Zip', (c) => parseAddr(c.loan.address).zip],
  ['Total Loan Amount', (c) => totalAmt(c.loan) || ''],
  ['Original Rehab Amount', (c) => rehabAmt(c.loan)],
  ['Current Rehab Amount', (c) => rehabAmt(c.loan)], // pre-funding: nothing drawn yet
  ['Current Balance', (c) => { const t = totalAmt(c.loan); return t == null ? '' : t - rehabAmt(c.loan); }],
  ['Original Interest Reserve', () => 'n/a'], // we don't hold interest reserves
  ['Current Interest Reserve', () => 'n/a'],
  ['OOP Rehab', () => 'n/a'],
  ['Total Rehab Amount', (c) => rehabAmt(c.loan)],
  ['Borrower Total Projects Completed', (c) => {
    const g1 = g1Of(c);
    return num(c.loan.experience) != null ? num(c.loan.experience) : (num(g1 && g1.flips) || '');
  }],
  ['FICO', (c) => { const g = g1Of(c); return g ? ficoOf(g, c.loan) : ''; }],
  ['Purchase Price', (c) => (String(c.loan.loanPurpose || '').toLowerCase() === 'purchase' ? (num(c.loan.purchasePrice) || '') : 'N/A')],
  ['AIV', (c) => thirdPartyAiv(c) || ''],
  ['ARV', (c) => num(c.loan.arvBpo) || num(c.loan.arv) || ''],
  ['Appraisal Type', (c) => {
    const t = String(uw(c, 'valuationType') || '').toLowerCase();
    if (t === 'appraisal') return '1004';
    if (t === 'bpo' || (!t && num(c.loan.aivBpo))) return 'BPO';
    if (t === 'avm') return 'AVM';
    return '';
  }],
  ['Note Rate', (c) => pct(rateFrac(c.loan.rate))],
  ['Origination Date', (c) => dstr(c.loan.fundingDate)],
  ['Next Due', (c) => firstPaymentOf(c.loan)], // pre-funding: next due IS first due
  ['First Due', (c) => firstPaymentOf(c.loan)],
  ['Maturity Date', (c) => maturityOf(c.loan)],
  ['Term', (c) => (num(c.loan.term) || 12) + ' months'],
  ['Purchase/Refi', (c) => (String(c.loan.loanPurpose || '').toLowerCase() === 'purchase' ? 'PURCHASE' : (c.loan.loanPurpose ? 'REFI' : ''))],
  // Sample uses "Note" where interest accrues on the full note (our Dutch).
  ['Accrual Type', (c) => { const d = dutchLabel(c.loan); return d === 'Dutch' ? 'Note' : (d === 'Non-Dutch' ? 'As Disbursed' : ''); }],
  ['Borrower Internal Projects Exited', () => ''],
  ['# of Years Experience', () => ''],
  ['Repeat Borrower (Y/N)', (c) => repeatBorrower(c)],
  ['# of Bed/Baths', (c) => {
    const bd = num(c.loan.bedrooms), ba = num(c.loan.bathrooms);
    return (bd || ba) ? ((bd || '?') + ' bed ' + (ba || '?') + ' bath') : '';
  }],
  ['Pre- Rehab Sqft', (c) => num(uw(c, 'propertySqFt')) || num(uw(c, 'valuationSqft')) || num(c.loan.sqft) || ''],
  ['Post- Rehab Sqft', (c) => num(uw(c, 'propertySqFt')) || num(uw(c, 'valuationSqft')) || num(c.loan.sqft) || ''],
  ['# of Units', (c) => num(c.loan.numUnits) || 1],
  ['Property Type', (c) => { const p = propTypeLabel(c.loan.propType); return p === 'SFR' ? 'SF' : p; }],
  ['Loan Type', (c) => {
    const lt = String(c.loan.loanType || '').toLowerCase();
    if (lt === 'bridge') return 'Bridge';
    if (lt === 'ground_up' || lt === 'guc' || String(c.loan.toolType || '').toLowerCase() === 'guc') return 'GUC';
    return 'RTL';
  }],
  ['Exit Strategy', () => ''], // lives on the long app, not the loan — hand-fill
  ['Guarantor Citizenship Status', (c) => { const u = citizenOf(c); return u == null ? '' : (u ? 'US' : 'Foreign National'); }],
  ['Multi Property Flag', () => 'N'],
  ['Cross Collateralized Flag', () => 'N'],
  ['Asset Purchased', (c) => { const p = propTypeLabel(c.loan.propType); return p === 'SFR' ? 'SF' : p; }],
  ['Entitlement Status', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? '' : 'NA')],
  ['Build Status', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? '' : 'NA')],
  ['Lot Purchase Price', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? (num(c.loan.purchasePrice) || '') : 'NA')],
  ['Lot Purchase Date', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? '' : 'NA')],
  ['Project Summary', (c) => String(c.loan.projectDescription || '').slice(0, 500)],
];
const STRIDE_RTL_REQUIRED = ['Address', 'State', 'Total Loan Amount', 'Note Rate',
  'FICO', 'AIV', 'ARV', 'Origination Date', 'Maturity Date', 'Borrowing Entity',
  'Guarantor', 'Exit Strategy', 'Stride ID'];

function strideBuild(cols, required, sheetName, filenameBase) {
  return function build(ctxs) {
    const rows = [cols.map((col) => col[0])];
    const missing = [];
    for (const c of ctxs) {
      const row = cols.map((col) => { try { return col[1](c); } catch (e) { return ''; } });
      rows.push(row);
      cols.forEach((col, i) => {
        if (required.indexOf(col[0]) >= 0 && (row[i] === '' || row[i] == null)) {
          missing.push(c.sla + ': ' + col[0].trim());
        }
      });
    }
    return { sheets: [{ name: sheetName, rows }], missing, filenameBase };
  };
}

// ── Registry ───────────────────────────────────────────────────────────────
export const TRADE_TAPES = {
  colchis_trade: {
    key: 'colchis_trade',
    label: 'Colchis Trade Tape (post-close)',
    stage: 'post_close',
    params: [],
    build(ctxs) {
      const rows = [COLCHIS_TRADE_COLS.map((col) => col[0])];
      const missing = [];
      for (const c of ctxs) {
        const row = COLCHIS_TRADE_COLS.map((col) => { try { return col[1](c); } catch (e) { return ''; } });
        rows.push(row);
        COLCHIS_TRADE_COLS.forEach((col, i) => {
          if (COLCHIS_TRADE_REQUIRED.indexOf(col[0]) >= 0 && (row[i] === '' || row[i] == null)) {
            missing.push(c.sla + ': ' + col[0]);
          }
        });
      }
      return { sheets: [{ name: 'Sheet1', rows }], missing, filenameBase: 'Loan Trade' };
    },
  },
  colchis_settlement: {
    key: 'colchis_settlement',
    label: 'Colchis Settlement Tape (trade agreed)',
    stage: 'post_close',
    params: ['tradeDate', 'fundingBank'],
    build(ctxs) {
      const rows = [COLCHIS_SETTLE_HEADERS.slice()];
      const missing = [];
      let sumL = 0, sumM = 0, sumY = 0;
      for (const c of ctxs) {
        const row = settlementRow(c);
        rows.push(row);
        sumL += num(row[11]) || 0; sumM += num(row[12]) || 0; sumY += num(row[24]) || 0;
        COLCHIS_SETTLE_HEADERS.forEach((h, i) => {
          if (COLCHIS_SETTLE_REQUIRED.indexOf(h) >= 0 && (row[i] === '' || row[i] == null)) {
            missing.push(c.sla + ': ' + h);
          }
        });
      }
      // Blank spacer, then the totals row (L, M, Y) — matches the historical sheets.
      rows.push([]);
      const totals = new Array(COLCHIS_SETTLE_HEADERS.length).fill('');
      totals[11] = round2(sumL); totals[12] = round2(sumM); totals[24] = round2(sumY);
      rows.push(totals);
      return { sheets: [{ name: 'SLA Trade', rows }], missing, filenameBase: 'SLA Colchis Settlement' };
    },
  },
  // Deploy 236.888 — Stride pre-funding submission tapes (Processing Pipeline).
  stride_dscr: {
    key: 'stride_dscr',
    label: 'Stride Submission Tape — DSCR (pre-funding)',
    stage: 'pre_funding',
    params: [],
    build: strideBuild(STRIDE_DSCR_COLS, STRIDE_DSCR_REQUIRED, 'Form', 'Stride Submission Loan Tape - DSCR'),
  },
  stride_rtl: {
    key: 'stride_rtl',
    label: 'Stride Submission Tape — RTL (pre-funding)',
    stage: 'pre_funding',
    params: [],
    build: strideBuild(STRIDE_RTL_COLS, STRIDE_RTL_REQUIRED, 'Sheet1', 'Stride Submission Loan Tape - RTL'),
  },
};
