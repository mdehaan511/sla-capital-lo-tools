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
 *   (Stride pre-funding DSCR + RTL tapes: next phase.)
 *
 * ctx per loan: { loan, client, guarantors[], sla, ownerKey, params }
 *   guarantors = ADDITIONAL guarantor client records (loan.guarantorClientIds).
 * Mappers return '' when the platform genuinely doesn't know the value; the
 * endpoint reports blanks in required columns so processors hand-fill
 * knowingly instead of discovering holes after the tape ships.
 */

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
const borrowerName = (ctx) => ctx.loan.entityName || (ctx.client && ctx.client.entityName) || clientName(ctx.client);
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
  ['AIV Sqft', (c) => num(c.loan.sqft) || ''],
  ['ARV Sqft', (c) => num(c.loan.sqft) || ''],
  ['Flood Zone', (c) => {
    const z = String(c.loan.floodZone || '').trim().toUpperCase();
    if (!z) return '';
    return (z === 'NO' || z === 'NONE' || z.charAt(0) === 'X' || z.charAt(0) === 'C' || z.charAt(0) === 'B') ? 'No' : 'Yes';
  }],
  ['Property Purchase Date', (c) => dstr(c.loan.purchaseDate || (String(c.loan.loanPurpose || '') === 'purchase' ? c.loan.fundingDate : ''))],
  ['Property Purchase Price', (c) => num(c.loan.purchasePrice) || ''],
  ['Assignment Fee', () => 0],
  ['Remaining Rehab Budget', (c) => rehabAmt(c.loan)],
  ['Rehab Spent to Date', () => 0],
  ['Total Cost Basis', (c) => (num(c.loan.purchasePrice) || 0) + rehabAmt(c.loan) || ''],
  ['Third Party AIV', (c) => num(c.loan.aivBpo) || ''],
  ['Third Party ARV', (c) => num(c.loan.arvBpo) || num(c.loan.arv) || ''],
  ['Valuation Date', () => ''],
  ['Third Party Valuation Type', (c) => (num(c.loan.aivBpo) ? 'BPO' : '')],
  ['Third Party Valuation Provider', () => ''],
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
  ['Date of First Payment', (c) => dstr(c.loan.firstPaymentDate)],
  ['Original Maturity Date', (c) => dstr(c.loan.maturityDate)],
  ['Term (Mo.)', (c) => num(c.loan.term) || 12],
  ['Total Loan Amount', (c) => totalAmt(c.loan) || ''],
  ['Balance At Submission', (c) => num(c.loan.upb) || totalAmt(c.loan) || ''],
  ['Initial Loan Amount', (c) => { const t = totalAmt(c.loan); return t == null ? '' : t - rehabAmt(c.loan); }],
  ['Initial Rehab Holdback', (c) => rehabAmt(c.loan)],
  ['Initial Interest Reserve', () => 0],
  ['Appraisal Holdback', () => 0],
  ['Note Rate (%)', (c) => rateFrac(c.loan.rate) || ''],
  ['Orig Points (%)', (c) => { const p = num(c.loan.points); return p == null ? '' : p / 100; }],
  ['Original P&I Amount', (c) => {
    const t = totalAmt(c.loan), r = rateFrac(c.loan.rate);
    return (t && r) ? round2(t * r / 12) : '';
  }],
  ['Interest Accrual Methodology', () => '30/360'],
  ['Cash Out Amount (Refi)', () => ''],
  ['Dutch/Non-Dutch', (c) => dutchLabel(c.loan)],
  ['Initial LTC', (c) => {
    const t = totalAmt(c.loan), pp = num(c.loan.purchasePrice);
    return (t && pp) ? round4((t - rehabAmt(c.loan)) / pp) : '';
  }],
  ['LTAIV', (c) => {
    const t = totalAmt(c.loan), aiv = num(c.loan.aivBpo);
    return (t && aiv) ? round4(t / aiv) : '';
  }],
  ['Total LTC', (c) => {
    const t = totalAmt(c.loan), pp = num(c.loan.purchasePrice);
    const basis = (pp || 0) + rehabAmt(c.loan);
    return (t && basis) ? round4(t / basis) : '';
  }],
  ['LTARV', (c) => {
    const t = totalAmt(c.loan), arv = num(c.loan.arvBpo) || num(c.loan.arv);
    return (t && arv) ? round4(t / arv) : '';
  }],
  ['Borrower Name', (c) => borrowerName(c)],
  ['Borrower Type', (c) => (c.loan.entityName || (c.client && c.client.entityName)) ? 'Entity' : 'Individual'],
  ['Experience (# projects in 3yrs)', (c) => num(c.loan.experience) != null ? num(c.loan.experience) : (num(c.client && c.client.flips) || '')],
  ['Foreign National Flag (Y/N)', (c) => {
    const u = String((c.client && c.client.usCitizen) || c.loan.usCitizen || '').toLowerCase();
    if (!u) return '';
    return u === 'yes' || u === 'y' || u === 'true' ? 'N' : 'Y';
  }],
  ['Borrower Reserves', () => ''],
  ['Borrower Address', (c) => (c.client && c.client.homeAddress && c.client.homeAddress.street) || ''],
  ['Borrower City', (c) => (c.client && c.client.homeAddress && c.client.homeAddress.city) || ''],
  ['Borrower State', (c) => (c.client && c.client.homeAddress && c.client.homeAddress.state) || ''],
  ['Borrower ZIP', (c) => (c.client && c.client.homeAddress && c.client.homeAddress.zip) || ''],
  ['Entity TIN', (c) => {
    const cos = (c.client && c.client.companies) || [];
    const ent = String(borrowerName(c)).toLowerCase();
    const hit = cos.find((co) => co && co.ein && String(co.name || '').toLowerCase() === ent) || cos.find((co) => co && co.ein);
    return (hit && hit.ein) || '';
  }],
  ['Guarantor 1 Name', (c) => clientName(c.client)],
  ['Guarantor 1 FICO', (c) => ficoOf(c.client, c.loan)],
  ['Guarantor 1 DOB', (c) => dstr(c.client && c.client.dob)],
  ['Guarantor 2 Name', (c) => clientName(c.guarantors[0])],
  ['Guarantor 2 FICO', (c) => (c.guarantors[0] ? ficoOf(c.guarantors[0], null) : '')],
  ['Guarantor 2 DOB', (c) => dstr(c.guarantors[0] && c.guarantors[0].dob)],
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
    gross != null ? gross : '',
    colchis != null ? colchis : '',
    (gross != null && colchis != null) ? round4(gross - colchis) : '',
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
    1, // Purchase Price (%)
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
};
