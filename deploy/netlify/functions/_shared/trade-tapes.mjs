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
// Deploy 237.232 (Mike: "for borrower its always grabbing the guarantor. If an LLC exists it
// needs to use that and say the borrower type is entity"). This read loan.entityName and
// client.entityName only -- but the LLC lives first in loan.vestingLLCs (the Vesting Entity
// the LO sets on Loan Details), then in the long app's companies (client.companies), and
// the recorded Articles are the document of record. Same chain Loan Details resolves, plus
// the Articles' extracted name (ctx.reviewEntity, attached by trade-tape-export) and the
// long app itself. On a broker deal the primary client record IS the broker: its
// entityName / companies are never the borrower's.
const _trim = (v) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
export const entityNameOf = (c) => {
  const v = Array.isArray(c.loan.vestingLLCs) ? c.loan.vestingLLCs.find((x) => x && (typeof x === 'string' ? x.trim() : _trim(x.name))) : null;
  const vest = typeof v === 'string' ? _trim(v) : _trim(v && v.name);
  if (vest) return vest;
  if (_trim(c.loan.entityName)) return _trim(c.loan.entityName);
  if (_trim(c.reviewEntity)) return _trim(c.reviewEntity);
  for (const p of gPeople(c)) {
    const co = ((p && p.companies) || []).find((x) => x && _trim(x.name));
    if (co) return _trim(co.name);
  }
  if (c.longApp && _trim(c.longApp.llcName)) return _trim(c.longApp.llcName);
  if (!isBrokerCtx(c) && c.client && _trim(c.client.entityName)) return _trim(c.client.entityName);
  return '';
};
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
// Maturity fallback (loan has no stored maturityDate): 1st of the month
// FOLLOWING funding + term — the lender-standard convention (Deploy 236.913,
// Dan Austin). Matches fci-boarding.mjs maturityOf and the Loan Terms UI; a
// loan funding exactly on the 1st gets no bump.
// Term in months. Priority: servicing `term` → Loan Terms `loanTerm` → the
// sizer's formData.loanTerm, which is a pricing BUCKET (13 = "13 – 18 months",
// 19 = "19 – 24 months" — the note is written for the bucket's TOP) → 12.
// Deploy 236.914 (Mike): "look at the loan term in the sizer", not a flat 12.
const termOf = (l) => {
  const t = num(l.term) || num(l.loanTerm);
  if (t) return t;
  const fd = num(l.formData && l.formData.loanTerm);
  if (fd === 13) return 18;
  if (fd === 19) return 24;
  if (fd) return fd;
  return String(l.toolType || '').toLowerCase() === 'dscr' ? 360 : 12;
};
const maturityOf = (l) => {
  if (l.maturityDate) return dstr(l.maturityDate);
  const f = dparts(l.fundingDate);
  if (!f) return '';
  const t = termOf(l);
  let m = f.m + t, y = f.y;
  if (f.d > 1) m += 1;
  while (m > 12) { m -= 12; y += 1; }
  return m + '/1/' + y;
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
    if (w == null) w = 0; // Deploy 237.003: unknown type = 0, same as the UW tab (was 1, overstated reserves)
    if (w > 1) w = w / 100; // tolerate "70" for 70%
    total += bal * w;
    any = true;
  }
  const emd = num(uw(c, 'emd'));
  if (emd != null) { total += emd; any = true; }
  return any ? round2(total) : '';
};
// Deploy 237.132 (Mike) -- AIV comes from the BPO or the appraisal: the loan's AIV
// BPO, else the UW tab's As-Is value, else the as-is value the document review
// read off the valuation tray (c.reviewValuation, attached by trade-tape-export).
// Deploy 237.275 (Mike: "several loans on the recent trade tape had the wrong AIV" / "Make it
// always grab the BPO ARV and if that isnt available leave it blank") -- the loan's aivBpo /
// arvBpo fields are SHARED: the BPO / appraisal read writes them (stamping <key>FromBpo), but the
// RTL sizer's AIV box and the Property tab write the same fields, so a typed estimate went out as
// the "Third Party AIV" (11415 Prairie: the borrower's $360,000 ARV), and a missing BPO ARV fell
// back to the borrower's ARV (4113 Rambling Road). A figure counts only when a valuation document
// put it there (FromBpo), an underwriter set it on purpose (the UwOverride marker still
// matching), or it is a Baseline import's valuation of record. Otherwise the tray's own reading
// (c.reviewValuation, attached by trade-tape-export), else BLANK -- never the borrower's figures.
// loan-details.js _ldDocVal mirrors this for Loan Financials.
export const docValue = (loan, key) => {
  const v = num(loan && loan[key]);
  if (!(v > 0)) return null;
  if (loan[key + 'FromBpo'] === true) return v;
  const ov = loan[key + 'UwOverride'];
  if (ov && typeof ov === 'object' && num(ov.value) === v) return v;
  // A loan IMPORTED from Baseline (l_baseline_ id) carries the old LOS's valuation of record. Not
  // _baselineRaw: native loans that were synced TO Baseline hold that mirrored payload too, with
  // the same typed AIVs this rule exists to keep off the tape.
  if (/^l_baseline_/.test(String(loan.id || ''))) return v;
  return null;
};
const thirdPartyAiv = (c) => docValue(c.loan, 'aivBpo') || num(uw(c, 'asIsPrice')) || num(c.reviewValuation && c.reviewValuation.aiv) || null;
const thirdPartyArv = (c) => docValue(c.loan, 'arvBpo') || num(c.reviewValuation && c.reviewValuation.arv) || null;
// Exit strategy is a long-app answer (sell / refi / cash); saved onto the loan
// from 237.132, read straight off the long app (c.longApp) for older loans.
// Labels match Mike's own Stride submissions ("Sell", "Refinance").
const EXIT_LABEL = { sell: 'Sell', sale: 'Sell', refi: 'Refinance', refinance: 'Refinance', cash: 'Pay off in Cash' };
const exitStrategyOf = (c) => {
  const raw = String((c.loan && c.loan.exitStrategy) || (c.longApp && c.longApp.exitStrategy) || '').trim();
  return raw ? (EXIT_LABEL[raw.toLowerCase()] || raw) : '';
};

// ── Template: Colchis post-close trade tape (61 cols) ─────────────────────
// Deploy 237.229 (Mike, against "SLA Trade #23.xlsx"): the money columns carry the
// currency format ($#,##0.00), the date columns are real Excel dates, and Record
// Identifier always says "Loan". `cur` / `dateCell` are the settlement tape's own helpers.
const cur = (n) => sty(n, 'cur');
// Valuation metadata: the screened UW value first, else what the document review read
// off the valuation tray itself (ctx.reviewValuation, attached by trade-tape-export --
// the tray keeps its extraction even when the write to the loan never happened).
const valMeta = (c, key) => uw(c, key) || (c.reviewValuation && c.reviewValuation[key]) || '';
// Purchase price vs assignment fee (Deploy 237.229, Mike's Trade #23 has Luna Court as
// 119,000 + 21,000 where the loan record says 140,000). The loan's purchase price is
// whatever the LO priced off; the documents say how it splits:
//   - the PSA's own price (uwData.psaPrice) under the loan's price → the LO entered the
//     all-in figure; the seller gets the PSA price, the rest is the fee;
//   - an assignment fee stated on the assignment agreement (≤ the price) → that fee;
//   - an assignment-contract price ABOVE the loan's price → the LO entered the PSA price
//     and the fee is the difference (the underwriting engine's own rule);
//   - else no assignment: the whole price, fee 0.
// Cost basis and both LTCs use purchase + fee, as the tape's own formulas do
// (S = O+P+Q+R, Initial LTC = AG/(O+P)); with no fee nothing changes.
const assignmentSplit = (c) => {
  const pp = num(c.loan.purchasePrice);
  if (pp == null) return { purchase: null, fee: 0 };
  const psa = num(uw(c, 'psaPrice')), explicit = num(uw(c, 'assignmentFee')), ac = num(uw(c, 'assignmentContractPrice'));
  if (psa > 0 && psa < pp) return { purchase: psa, fee: round2(pp - psa) };
  if (explicit > 0 && explicit <= pp) return { purchase: pp, fee: explicit };
  if (ac > pp) return { purchase: pp, fee: round2(ac - pp) };
  return { purchase: pp, fee: 0 };
};
const basisOf = (c) => { const s = assignmentSplit(c); return s.purchase == null ? null : s.purchase + s.fee; };
// Deploy 237.230 (Mike: "the same formulas in columns should be used in the printed Loan
// Trade sheet") -- the six formula cells of "SLA Trade #23.xlsx", verbatim, one column to
// the left (his sheet carries an untitled column A). `r` is the sheet row; the cached value
// is our own arithmetic so the number paints before Excel's first recalc, and a formula
// whose inputs are blank carries no cache and computes on open exactly as his sheet would.
// The column letters are the tape's fixed positions; scripts/colchis-tape-test.mjs pins each
// one to its header, so inserting a column fails the gate instead of mis-referencing.
const fx = (f, v, s) => ({ f, v: (typeof v === 'number' && isFinite(v)) ? v : undefined, s });
const COLCHIS_FORMULAS = {
  'Total Cost Basis':    (r) => 'N' + r + '+O' + r + '+P' + r + '+Q' + r,   // purchase + fee + remaining rehab + rehab spent
  'Original P&I Amount': (r) => 'AJ' + r + '*AD' + r + '/12',               // note rate × total loan ÷ 12
  'Initial LTC':         (r) => 'AF' + r + '/(N' + r + '+O' + r + ')',     // initial loan ÷ (purchase + fee)
  'LTAIV':               (r) => 'AF' + r + '/S' + r,                        // initial loan ÷ third-party AIV
  'Total LTC':           (r) => 'AD' + r + '/R' + r,                        // total loan ÷ total cost basis
  'LTARV':               (r) => 'AD' + r + '/T' + r,                        // total loan ÷ third-party ARV
};
const COLCHIS_TRADE_COLS = [
  ['Lender Loan ID', (c) => c.sla],
  ['Record Identifier', () => 'Loan'],
  ['Property Address', (c) => parseAddr(c.loan.address).street],
  ['Property City', (c) => parseAddr(c.loan.address).city],
  ['Property State', (c) => parseAddr(c.loan.address).state],
  ['Property ZIP', (c) => parseAddr(c.loan.address).zip],
  ['Property Type', (c) => propTypeLabel(c.loan.propType)],
  ['AIV Units', (c) => num(c.loan.numUnits) || 1],
  ['ARV Units', (c) => num(c.loan.numUnits) || 1],
  ['AIV Sqft', (c) => num(uw(c, 'propertySqFt')) || num(valMeta(c, 'valuationSqft')) || num(c.loan.sqft) || ''],
  ['ARV Sqft', (c) => num(uw(c, 'propertySqFt')) || num(valMeta(c, 'valuationSqft')) || num(c.loan.sqft) || ''],
  ['Flood Zone', (c) => {
    const z = String(c.loan.floodZone || uw(c, 'floodZone') || '').trim().toUpperCase();
    if (!z) return '';
    return (z === 'NO' || z === 'NONE' || z.charAt(0) === 'X' || z.charAt(0) === 'C' || z.charAt(0) === 'B') ? 'No' : 'Yes';
  }],
  ['Property Purchase Date', (c) => dateCell(dstr(c.loan.purchaseDate || (String(c.loan.loanPurpose || '') === 'purchase' ? c.loan.fundingDate : '')))],
  ['Property Purchase Price', (c) => cur(assignmentSplit(c).purchase)],
  ['Assignment Fee', (c) => cur(assignmentSplit(c).purchase == null ? null : assignmentSplit(c).fee)],
  ['Remaining Rehab Budget', (c) => cur(rehabAmt(c.loan))],
  ['Rehab Spent to Date', () => cur(0)],
  ['Total Cost Basis', (c, r) => { const b = basisOf(c); const v = (b || 0) + rehabAmt(c.loan); return fx(COLCHIS_FORMULAS['Total Cost Basis'](r), v || null, 'cur'); }],
  ['Third Party AIV', (c) => cur(thirdPartyAiv(c))],
  ['Third Party ARV', (c) => cur(thirdPartyArv(c))], // Deploy 237.275 -- the BPO / appraisal ARV or blank, never the borrower's
  // Deploy 237.229 (Mike: "Valuation Date and Third Party Valuation Provider should be
  // able to be pulled off the valuation docs") -- they are read at review time (uw-field-map
  // bpo_valuation / appraisal); this reaches for the tray's own reading when the loan
  // never received it. A date that will not parse is passed through as text.
  ['Valuation Date', (c) => { const v = valMeta(c, 'valuationDate'); const s = dstr(v); return s ? dateCell(s) : String(v || ''); }],
  ['Third Party Valuation Type', (c) => valMeta(c, 'valuationType') || (c.reviewValuation && c.reviewValuation.kind === 'appraisal' ? 'Appraisal' : '') || (thirdPartyAiv(c) ? 'BPO' : '')],
  ['Third Party Valuation Provider', (c) => valMeta(c, 'valuationProvider')],
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
  ['Origination Date', (c) => dateCell(dstr(c.loan.fundingDate))],
  ['Date of First Payment', (c) => dateCell(firstPaymentOf(c.loan))],
  ['Original Maturity Date', (c) => dateCell(maturityOf(c.loan))],
  ['Term (Mo.)', (c) => termOf(c.loan)],
  ['Total Loan Amount', (c) => cur(totalAmt(c.loan))],
  ['Balance At Submission', (c) => cur(num(c.loan.upb) || totalAmt(c.loan))],
  ['Initial Loan Amount', (c) => { const t = totalAmt(c.loan); return t == null ? '' : cur(t - rehabAmt(c.loan)); }],
  ['Initial Rehab Holdback', (c) => cur(rehabAmt(c.loan))],
  ['Initial Interest Reserve', () => cur(0)],
  ['Appraisal Holdback', () => cur(0)],
  ['Note Rate (%)', (c) => pct(rateFrac(c.loan.rate))],
  ['Orig Points (%)', (c) => { const p = num(c.loan.points); return p == null ? '' : pct(p / 100); }],
  ['Original P&I Amount', (c, r) => {
    const t = totalAmt(c.loan), rf = rateFrac(c.loan.rate);
    return fx(COLCHIS_FORMULAS['Original P&I Amount'](r), (t && rf) ? round2(t * rf / 12) : null, 'cur');
  }],
  ['Interest Accrual Methodology', () => '30/360'],
  // A purchase has no cash out: $0.00. A refi's cash-out is not on the loan record -- left
  // for hand-fill rather than guessed.
  ['Cash Out Amount (Refi)', (c) => (String(c.loan.loanPurpose || '').toLowerCase() === 'purchase' ? cur(0) : '')],
  ['Dutch/Non-Dutch', (c) => dutchLabel(c.loan)],
  ['Initial LTC', (c, r) => {
    const t = totalAmt(c.loan), b = basisOf(c);
    return fx(COLCHIS_FORMULAS['Initial LTC'](r), (t && b) ? round4((t - rehabAmt(c.loan)) / b) : null, 'pct');
  }],
  ['LTAIV', (c, r) => {
    // Deploy 237.223 (Mike: "LTAIV should use the initial advance in ... the colchis
    // tape") -- initial advance (total less the rehab holdback) over the as-is value, the
    // same basis as Initial LTC two cells up. Was the full loan. The sheet's own formula
    // (AG/T there, AF/S here) says the same thing.
    const t = totalAmt(c.loan), aiv = thirdPartyAiv(c);
    return fx(COLCHIS_FORMULAS['LTAIV'](r), (t && aiv) ? round4((t - rehabAmt(c.loan)) / aiv) : null, 'pct');
  }],
  ['Total LTC', (c, r) => {
    const t = totalAmt(c.loan);
    const basis = (basisOf(c) || 0) + rehabAmt(c.loan);
    return fx(COLCHIS_FORMULAS['Total LTC'](r), (t && basis) ? round4(t / basis) : null, 'pct');
  }],
  ['LTARV', (c, r) => {
    const t = totalAmt(c.loan), arv = thirdPartyArv(c); // Deploy 237.275 -- same ARV as the Third Party ARV cell
    return fx(COLCHIS_FORMULAS['LTARV'](r), (t && arv) ? round4(t / arv) : null, 'pct');
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
  ['Borrower Reserves', (c) => { const r = reservesOf(c); return r === '' ? '' : cur(r); }],
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
  ['Guarantor 1 DOB', (c) => { const g = gPeople(c)[0]; return dateCell(dstr(g && g.dob)); }],
  ['Guarantor 2 Name', (c) => clientName(gPeople(c)[1])],
  ['Guarantor 2 FICO', (c) => { const g = gPeople(c)[1]; return g ? ficoOf(g, null) : ''; }],
  ['Guarantor 2 DOB', (c) => { const g = gPeople(c)[1]; return dateCell(dstr(g && g.dob)); }],
];
function round4(n) { return Math.round(n * 10000) / 10000; }
// Columns whose blanks the processor must hand-fill before sending.
const COLCHIS_TRADE_REQUIRED = ['Property Address', 'Property State', 'Total Loan Amount',
  'Note Rate (%)', 'Origination Date', 'Original Maturity Date', 'Borrower Name',
  'Guarantor 1 Name', 'Guarantor 1 FICO', 'Third Party AIV', 'Entity TIN', 'Dutch/Non-Dutch'];

// ── Template: Colchis settlement tape (26 cols + totals) ──────────────────
// Deploy 236.976 (Mike) — the tape mirrors the hand-built settlement sheets
// FORMULAS AND ALL, so a processor can nudge a date/rate and every dependent
// cell (spread, days, accrued interest, proceeds, totals) recomputes:
//   K Seller Spread   =+IFERROR(I-J,0)
//   T B-Piece %       =-S/L
//   U CCM Balance     =M+S
//   V Days Accrued    =+IFERROR(DAYS360(EDATE(G,-1),H),"")
//   W Accrued Int.    =IFERROR(ROUND(IF(D="Dutch",L+S,U)*J*V/IF(E="Actual/Actual",365,360),2),0)
//   Y Proceeds        =+U+W*X       totals L/M/Y = SUM over the data rows
// Dates go in as REAL Excel serials (date strings break DAYS360/EDATE).
// Colchis Rate = the Closings tab's Buy Rate (loan.buyRate; soldRate is the
// legacy fallback), and Funding Bank derives from the Closings tab's Funding
// Source instead of a hand-typed export param.
const excelSerial = (p) => p ? Math.round((Date.UTC(p.y, p.m - 1, p.d) - Date.UTC(1899, 11, 30)) / 86400000) : null;
const FUNDING_BANK_BY_SOURCE = {
  sla_capital: 'SLA #10102114000205',
  stride:      'Stride #10812200',
  king_arthur: 'KAF #10109974300203',
};
function settlementRow(c, r) {
  const l = c.loan;
  const trade = dparts(c.params.tradeDate);
  // Deploy 236.977 (Mike) — Paid To / Next Due key off the CLOSING date, not
  // the trade date: paid-to = 1st of the month AFTER closing, next due = the
  // month after that. A loan closed 9/11 is paid through 10/1 (next due
  // 11/1) — so a 9/11 trade shows NEGATIVE days accrued (an interest credit
  // back to the buyer); one closed 8/20 is paid through 9/1 (next due 10/1).
  // Old trade-month convention stays only as the fallback when the loan has
  // no funding date on record.
  const addMonths = (p, n) => { let m = p.m + n, y = p.y; while (m > 12) { m -= 12; y += 1; } return { y, m, d: 1 }; };
  const closing = dparts(l.fundingDate);
  const paidTo = closing ? addMonths(closing, 1) : (trade ? { y: trade.y, m: trade.m, d: 1 } : null);
  const nextDue = paidTo ? addMonths(paidTo, 1) : null;
  const dcell = (p) => { const s = excelSerial(p); return s != null ? { v: s, s: 'date' } : ''; };
  // Deploy 236.977 — currency-formatted number ($#,##0.00).
  const cur = (n) => (n == null || n === '' ? '' : { v: n, s: 'cur' });
  const gross = rateFrac(l.rate);
  const colchis = rateFrac((l.buyRate != null && l.buyRate !== '') ? l.buyRate : l.soldRate);
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
  const fundingBank = FUNDING_BANK_BY_SOURCE[String(l.fundingSource || '').toLowerCase()] ||
    String(c.params.fundingBank || '');
  // Formula cells carry the row's live formula + our computed value as the
  // pre-recalc cache (fullCalcOnLoad recomputes on open either way).
  const fc = (formula, cached, style) => {
    const cell = { f: formula };
    if (typeof cached === 'number' && isFinite(cached)) cell.v = cached;
    if (style) cell.s = style;
    return cell;
  };
  return [
    c.sla,
    parseAddr(l.address).street,
    borrowerName(c),
    dutch,
    '30/360',
    dcell(paidTo),
    dcell(nextDue),
    dcell(trade),
    pct(gross),
    pct(colchis),
    fc('+IFERROR(I' + r + '-J' + r + ',0)', (gross != null && colchis != null) ? round4(gross - colchis) : null, 'pct'),
    cur(L),
    cur(M),
    cur(N),
    cur(O),
    cur(P),
    cur(0), // Appraisal Holdback Remaining
    cur(0), // Interest Escrow Balance
    cur(0), // B-Piece $
    fc('-S' + r + '/L' + r, (L ? 0 : null), 'pct'), // B-Piece %
    fc('M' + r + '+S' + r, M != null ? M : null, 'cur'),   // CCM Balance
    fc('+IFERROR(DAYS360(EDATE(G' + r + ',-1),H' + r + '),"")', V != null ? V : null),
    fc('IFERROR(ROUND(IF(D' + r + '="Dutch",L' + r + '+S' + r + ',U' + r + ')*J' + r + '*V' + r + '/IF(E' + r + '="Actual/Actual",365,360),2),0)', W != null ? W : null, 'cur'),
    pct(1), // Purchase Price (%) — 100.00%
    fc('+U' + r + '+W' + r + '*X' + r, Y != null ? Y : null, 'cur'),
    fundingBank,
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

// ── Deploy 237.131 (Mike: "make it so those tapes get all of the formulas and
// appropriate widths like we did with the Colchis Settlement tape") ──────────
// Measured against Mike's own Stride submissions (3 RTL .xlsx, 2 DSCR .xlsm):
//   RTL  Sheet1 carries three formulas per loan (I =+C, S =P-Q, W =R), $ money
//        columns, 0.000% buy rate, real date serials, bold wrapped grey headers
//        (yellow on the two Stride-owned columns) -- and a SECOND sheet,
//        "Form, mapped", that re-expresses each Sheet1 row in Stride's Form
//        layout with ~38 formulas a row. Both are reproduced; the mapped sheet's
//        one hand-broken cell (AB3 =#REF!) is written as the working =Sheet1!L.
//   DSCR Form has NO formulas in the samples; it gets the template's formats
//        (accounting amounts, 0.000% rate, 0.000 DSCR, real dates), the frozen
//        wrapped header, and live formulas only where the cell is OUR arithmetic
//        (LTV = amount / value, CLTV = LTV, P&I, lock expiry = lock + 45) so a
//        hand-corrected amount / rate / value / lock date flows through.
//        The .xlsm's Funding Notice + hidden Data / Batch Calc sheets and macros
//        are Stride's own machinery and are NOT reproduced.
// Column letters in the formulas are the templates' fixed positions;
// scripts/stride-tape-test.mjs pins every referenced header to its letter.
const sty = (n, s) => (n == null || n === '' || typeof n !== 'number' || !isFinite(n) ? '' : { v: n, s });
const dateCell = (mdY) => { // 'M/D/YYYY' → a real Excel date serial
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(String(mdY || ''));
  if (!m) return mdY || '';
  return { v: excelSerial({ y: +m[3], m: +m[1], d: +m[2] }), s: 'date' };
};
const dscrValueOf = (c) => num(uw(c, 'appraisedValue')) || num(c.loan.propValue) || null;
const dscrPI = (c) => {
  const t = totalAmt(c.loan), rf = rateFrac(c.loan.rate || c.loan._finalRate);
  if (!t || rf == null) return null;
  // IO loans pay interest only (the sample sheet's own P&I is exactly this).
  return String(c.loan.isIO || '').toLowerCase() === 'yes' ? round2(t * rf / 12) : amortPI(t, rf);
};

const STRIDE_DSCR_COLS = [
  ['Loan Numbers', (c) => c.sla],
  ['Seller', () => 'Sir Lends A Lot LLC'],
  ['Channel', () => 'Retail'],
  ['Seller Program', () => 'DSCR'],
  ['Original Loan Amount', (c) => sty(totalAmt(c.loan), 'acct0')],
  [' Current UPB', (c) => sty(num(c.loan.upb) || totalAmt(c.loan), 'acct0')],
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
  ['Note Rate', (c) => sty(rateFrac(c.loan.rate || c.loan._finalRate), 'pct3')],
  ['Pass-thru Rate', () => ''], // investor-side — hand-fill
  [' FICO', (c) => { const g = g1Of(c); return g ? ficoOf(g, c.loan) : ''; }],
  // 237.131 — live: E = Original Loan Amount, Y = Property Value (the same value this divides by).
  [' LTV', (c, r) => {
    const t = totalAmt(c.loan), v = dscrValueOf(c);
    return (t && v) ? { f: 'IF(Y' + r + '>0,ROUND(E' + r + '/Y' + r + ',4),"")', v: round4(t / v), s: 'pct' } : '';
  }],
  ['CLTV', (c, r) => {
    const t = totalAmt(c.loan), v = dscrValueOf(c);
    return (t && v) ? { f: 'T' + r, v: round4(t / v), s: 'pct' } : ''; // no junior liens on our deals
  }],
  ['DSCR', (c) => sty(dscrOf(c.loan), 'acct3')],
  [' DTI', () => ''],
  ['Sales Price', (c) => (dscrPurpose(c.loan) === 'Purchase' ? sty(num(c.loan.purchasePrice) || null, 'acct2') : '')],
  ['Property Value', (c) => sty(dscrValueOf(c), 'acct2')],
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
  // 237.131 — live: E amount, Q note rate, AH amort term, AJ IO flag.
  ['Monthly P&I', (c, r) => {
    const pi = dscrPI(c);
    if (pi == null) return '';
    return { f: 'IF(AJ' + r + '="Yes",ROUND(E' + r + '*Q' + r + '/12,2),ROUND(-PMT(Q' + r + '/12,AH' + r + ',E' + r + '),2))', v: pi, s: 'acct2' };
  }],
  ['Monthly PITI', (c) => sty(pitiaOf(c.loan), 'acct2')],
  ['Application Date', () => ''],
  ['Closing Date', (c) => dateCell(dstr(c.loan.closingDate || c.loan.fundingDate))],
  ['Origination Points', (c) => sty(dscrPoints(c.loan), 'acct2')],
  ['Estimated Disbursment Date', (c) => dateCell(dstr(c.loan.fundingDate))],
  ['First Payment Date', (c) => dateCell(firstPaymentOf(c.loan))],
  ['Escrows at Close', () => ''],
  ['Pre-Paid Interest at Close', () => ''],
  ['Investor Name', () => 'Colchis'],
  ['Investor Lock Date', (c) => dateCell(dstr(c.loan.rateLockStart))],
  ['Investor Lock Expiration Date', (c, r) => { // 45-day DSCR lock — live off BN (lock date), 237.131
    const d = dateCell(addDays(c.loan.rateLockStart, 45));
    return (d && typeof d === 'object') ? { f: 'BN' + r + '+45', v: d.v, s: 'date' } : '';
  }],
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
  // 237.131 — the Closings-tab Buy Rate first (as the settlement tape), 0.000% like the template.
  ['Investor Buy Rate', (c) => sty(rateFrac(c.loan.buyRate) || rateFrac(c.loan.soldRate), 'pct3')],
  ['Loan Number', (c, r) => ({ f: '+C' + r, v: String(c.sla || '') })], // yes, twice — the template's own =+C2
  ['Borrowing Entity', (c) => borrowerName(c)],
  ['Guarantor', (c) => gPeople(c).map(clientName).filter(Boolean).join('; ')],
  ['Address', (c) => parseAddr(c.loan.address).street],
  ['City', (c) => parseAddr(c.loan.address).city],
  ['State', (c) => parseAddr(c.loan.address).state],
  ['Zip', (c) => parseAddr(c.loan.address).zip],
  ['Total Loan Amount', (c) => sty(totalAmt(c.loan), 'cur')],
  ['Original Rehab Amount', (c) => sty(rehabAmt(c.loan), 'cur')],
  ['Current Rehab Amount', (c) => sty(rehabAmt(c.loan), 'cur')], // pre-funding: nothing drawn yet
  // 237.131 — the template's own formula: Total (P) less Original Rehab (Q).
  ['Current Balance', (c, r) => { const t = totalAmt(c.loan); return t == null ? '' : { f: 'P' + r + '-Q' + r, v: t - rehabAmt(c.loan), s: 'cur' }; }],
  ['Original Interest Reserve', () => 'n/a'], // we don't hold interest reserves
  ['Current Interest Reserve', () => 'n/a'],
  ['OOP Rehab', () => 'n/a'],
  ['Total Rehab Amount', (c, r) => ({ f: 'R' + r, v: rehabAmt(c.loan), s: 'cur' })], // template: =R2 (Current Rehab)
  ['Borrower Total Projects Completed', (c) => {
    const g1 = g1Of(c);
    return num(c.loan.experience) != null ? num(c.loan.experience) : (num(g1 && g1.flips) || '');
  }],
  ['FICO', (c) => { const g = g1Of(c); return g ? ficoOf(g, c.loan) : ''; }],
  ['Purchase Price', (c) => (String(c.loan.loanPurpose || '').toLowerCase() === 'purchase' ? sty(num(c.loan.purchasePrice) || null, 'cur') : 'N/A')],
  ['AIV', (c) => sty(thirdPartyAiv(c), 'cur')],
  ['ARV', (c) => sty(thirdPartyArv(c), 'cur')], // Deploy 237.275 -- the BPO / appraisal ARV or blank
  ['Appraisal Type', (c) => {
    const t = String(uw(c, 'valuationType') || '').toLowerCase();
    if (t === 'appraisal') return '1004';
    if (t === 'bpo' || (!t && docValue(c.loan, 'aivBpo'))) return 'BPO';
    if (t === 'avm') return 'AVM';
    if (!t && c.reviewValuation && c.reviewValuation.kind) return c.reviewValuation.kind === 'appraisal' ? '1004' : 'BPO'; // 237.132
    return '';
  }],
  ['Note Rate', (c) => pct(rateFrac(c.loan.rate))],
  ['Origination Date', (c) => dateCell(dstr(c.loan.fundingDate))],
  ['Next Due', (c) => dateCell(firstPaymentOf(c.loan))], // pre-funding: next due IS first due
  ['First Due', (c) => dateCell(firstPaymentOf(c.loan))],
  ['Maturity Date', (c) => dateCell(maturityOf(c.loan))],
  ['Term', (c) => termOf(c.loan) + ' months'],
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
  ['Exit Strategy', (c) => exitStrategyOf(c)], // 237.132 -- from the long app
  ['Guarantor Citizenship Status', (c) => { const u = citizenOf(c); return u == null ? '' : (u ? 'US' : 'Foreign National'); }],
  ['Multi Property Flag', () => 'N'],
  ['Cross Collateralized Flag', () => 'N'],
  ['Asset Purchased', (c) => { const p = propTypeLabel(c.loan.propType); return p === 'SFR' ? 'SF' : p; }],
  ['Entitlement Status', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? '' : 'NA')],
  ['Build Status', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? '' : 'NA')],
  ['Lot Purchase Price', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? sty(num(c.loan.purchasePrice) || null, 'cur') : 'NA')],
  ['Lot Purchase Date', (c) => (String(c.loan.toolType || c.loan.loanType || '').toLowerCase().indexOf('g') === 0 ? '' : 'NA')],
  ['Project Summary', (c) => String(c.loan.projectDescription || '').slice(0, 500)],
];
const STRIDE_RTL_REQUIRED = ['Address', 'State', 'Total Loan Amount', 'Note Rate',
  'FICO', 'AIV', 'ARV', 'Origination Date', 'Maturity Date', 'Borrowing Entity',
  'Guarantor', 'Exit Strategy', 'Stride ID'];

// ── Deploy 237.131 — Stride template layouts (widths in Excel character units,
// read from the sample workbooks; the writer takes them as per-column FLOORS and
// still widens a column for long data, never for the wrapped header). ─────────
const STRIDE_RTL_WIDTHS = [13.86, 9.29, 18.86, 17.43, 8.71, 8.71, 14.71, 8.71, 18.14, 19, 15.86, 19.43, 8.71, 8.71, 9.29, 13.57, 12.71, 12.71, 12.71, 10.14, 11, 8.71, 12.71, 11.86, 9.29, 11.57, 13.57, 13.57, 9.29, 9.29, 11.43, 9.29, 9.29, 9.29, 11.14, 8.71, 8.71, 11.14, 8.71, 8.71, 11.14, 9.29, 9.29, 9.29, 8.71, 8.71, 11.71, 8.71, 8.71, 8.71, 8.71, 8.71, 8.71, 12.71, 11.71, 11.29];
const STRIDE_MAPPED_WIDTHS = [20.43, 16, 15.14, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 19.43, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 16, 12.57, 12.57, 12.57, 12.57, 12.57, 16, 20.43, 12.57, 12.57];
const STRIDE_DSCR_WIDTHS = [20.43, 23.86, 8.71, 17.57, 13.86, 13.86, 30.71, 20.43, 19, 16.14, 22.43, 19.29, 24.43, 8.71, 8.71, 9.29, 8.71, 13.86, 9.29, 9.29, 9.29, 9.29, 8.71, 13.29, 13.29, 8.71, 8.71, 8.71, 15.57, 25.29, 8.71, 8.71, 15.86, 9.29, 13.14, 8.71, 8.71, 8.71, 9.29, 15, 8.71, 8.71, 8.71, 8.71, 8.71, 9.29, 9, 12.14, 18.86, 8.71, 8.71, 14.71, 8.71, 8.71, 8.71, 10.57, 10.57, 17.86, 10.57, 9.43, 14.71, 9.86, 10.57, 9.57, 11, 10.14, 9.71, 9.29, 11, 11.14, 8.71, 8.71, 8.71];
const STRIDE_MAPPED_HEADERS = ['Loan Number', 'Servicer ID', 'Est Fund Date', 'Request Date', 'Closing Date', 'Investor Lock Number', 'Originator Description', 'Originator Type Description', 'Product Type Description', 'Loan Type Description', 'Loan Purpose Description', 'Lien Position', 'Total Loan Amount', 'Sales Price', 'Initial Funded Amount', 'LTV', 'CLTV', 'Note Rate', 'Term of Loan', 'Monthly Ins Prem', 'Monthly Taxes', 'Pass-thru Rate', 'Monthly P & I', 'Monthly PITI (A)', 'DSCR', 'Front-End Ratio', 'Back-End Ratio', 'Property Address Line 1', 'Property Address Line 2', 'Property Addr City', 'Prop Addr State', 'Prop Addr Zip', 'Property Type Desc', 'Occupancy Desc', 'Appraisal Amt', 'Guarantor', 'Guarantor2', 'Citizenship', 'Processor Desc', 'Underwriter Desc', 'Borrower First Name', 'Borrower Last Name', 'Borrower SSN', 'Borrower Date of Birth', 'Borrower Credit Score', 'Co-Borrower First Name', 'Co-Borrower Last Name', 'Co-Borrower SSN', 'Co-Borrower Date of Birth', 'Co-Borrower Credit Score', 'QM Loan', 'QM Type', 'Origination Points', 'Initial Escrow', 'Lock Capital Partner', 'Payment Reserve', 'Lock Expiration Date', 'Locked Price', 'Prepay Mos', 'IO Term', 'Amort Term', 'Fixed / ARM', 'Doc Type', 'First Pay Date', 'MERS MIN', 'ULI', 'Day Count'];
const STRIDE_MAPPED_GROUPS = { C: 'Disbursment Date', E: 'Close Date', M: 'Total Loan Amount', O: 'Current Loan Amt', R: 'Note Rate', V: 'Pass-thru Rate', AJ: 'Guarantor', AK: 'Guarantor2' };
const colIdx = (letters) => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

// "Form, mapped" — one formula row per Sheet1 loan row (mapped row = Sheet1 row + 1).
// Every cell is a live formula back into Sheet1 with a cached value, so a viewer
// that never recalculates still reads this tape's data.
function strideRtlMapped(sheet1Rows) {
  const S = 'Sheet1!';
  const M = "'Form, mapped'!";
  const width = STRIDE_MAPPED_HEADERS.length;
  const prim = (cell) => (cell && typeof cell === 'object') ? (cell.v != null ? cell.v : (cell.t != null ? cell.t : '')) : (cell == null ? '' : cell);
  const isNum = (x) => typeof x === 'number' && isFinite(x);
  const fcell = (f, v, s) => { const o = { f }; if (v != null && (typeof v === 'string' || isNum(v))) o.v = v; if (s) o.s = s; return o; };
  const top = new Array(width).fill('');
  Object.keys(STRIDE_MAPPED_GROUPS).forEach((k) => { top[colIdx(k)] = { t: STRIDE_MAPPED_GROUPS[k], s: 'hdrGreen' }; });
  const rows = [top, STRIDE_MAPPED_HEADERS.map((h) => ({ t: h, s: 'hdrNavy' }))];
  for (let i = 1; i < sheet1Rows.length; i++) {
    const src = sheet1Rows[i] || [];
    const r = i + 1;      // Sheet1 row number
    const m = i + 2;      // this sheet's row number
    const g = (L) => prim(src[colIdx(L)]);
    const row = new Array(width).fill('');
    const put = (L, cell) => { row[colIdx(L)] = cell; };
    const ref = (L, s) => put(L[0], fcell(S + L[1] + r, g(L[1]), s));
    const total = g('P'), bal = g('S'), aiv = g('AA'), arv = g('AB'), term = String(g('AI') || '');
    put('A', fcell('"PK"&' + S + 'C' + r, 'PK' + String(g('C') || '')));
    ref(['B', 'A']); ref(['C', 'AE'], 'date'); ref(['E', 'AE'], 'date'); ref(['G', 'D']);
    put('I', fcell(S + 'F' + r + '&"-"&' + S + 'AU' + r, String(g('F') || '') + '-' + String(g('AU') || '')));
    ref(['J', 'AT']); ref(['K', 'AJ']); ref(['M', 'P'], 'acct2'); ref(['N', 'Z'], 'acct2'); ref(['O', 'S'], 'acct2');
    put('P', fcell('IFERROR(' + M + '$O' + m + '/' + S + 'AA' + r + ',"")', (isNum(bal) && isNum(aiv) && aiv) ? bal / aiv : null, 'pct1'));
    put('Q', fcell('IFERROR(' + S + 'P' + r + '/' + S + 'AB' + r + ',"")', (isNum(total) && isNum(arv) && arv) ? total / arv : null, 'pct1'));
    ref(['R', 'AD'], 'pct');
    put('S', fcell('LEFT(' + S + 'AI' + r + ',2)', term.slice(0, 2)));
    ref(['V', 'H'], 'pct3');
    ref(['AB', 'L']); ref(['AD', 'M']); ref(['AE', 'N']); ref(['AF', 'O']);
    put('AG', fcell(S + 'AS' + r + '&" Units: "&' + S + 'AR' + r, String(g('AS') || '') + ' Units: ' + String(g('AR') || '')));
    put('AH', 'Investment');
    ref(['AI', 'AB'], 'acct2'); ref(['AJ', 'K']); ref(['AP', 'J']); ref(['AS', 'Y']);
    ref(['BB', 'B'], 'acct2'); ref(['BC', 'G']);
    put('BF', fcell('IF(' + M + '$O' + m + '<0.5*' + M + '$M' + m + ',96,99)', (isNum(bal) && isNum(total) && bal < 0.5 * total) ? 96 : 99));
    put('BH', fcell(M + '$S' + m, term.slice(0, 2)));
    put('BI', fcell(M + '$S' + m + '-' + M + '$BH' + m, 0));
    ref(['BJ', 'AK']);
    put('BK', 'RTL');
    ref(['BL', 'AG'], 'date');
    rows.push(row);
  }
  return [{
    name: 'Form, mapped', rows,
    minWidths: STRIDE_MAPPED_WIDTHS, autofitFromRow: 2,
    rowHeights: { 1: 15.75, 2: 15.75 },
    merges: ['Z1:AA1', 'AB1:AC1', 'AD1:AE1', 'AF1:AG1', 'AH1:AI1'],
  }];
}
const STRIDE_RTL_LAYOUT = {
  header: (label, i) => ({ t: label, s: i < 2 ? 'hdrYellow' : 'hdrGrey' }), // A-B are Stride's own columns
  sheet: { minWidths: STRIDE_RTL_WIDTHS, autofitFromRow: 1, rowHeights: { 1: 60 } },
  extraSheets: strideRtlMapped,
};
const STRIDE_DSCR_LAYOUT = {
  header: (label) => ({ t: label, s: 'hdrWrap' }),
  sheet: { minWidths: STRIDE_DSCR_WIDTHS, autofitFromRow: 1, rowHeights: { 1: 56.25 }, freeze: { cols: 1, rows: 1 } },
};

function strideBuild(cols, required, sheetName, filenameBase, layout) {
  return function build(ctxs) {
    // Deploy 237.131 — styled header cells, the sheet row number handed to each
    // mapper (formula cells need it), template layout, and any extra sheets.
    const hdr = (layout && layout.header) || ((label) => label);
    const rows = [cols.map((col, i) => hdr(col[0], i))];
    const missing = [];
    ctxs.forEach((c, n) => {
      const r = n + 2; // header is row 1
      const row = cols.map((col) => { try { return col[1](c, r); } catch (e) { return ''; } });
      rows.push(row);
      cols.forEach((col, i) => {
        if (required.indexOf(col[0]) >= 0 && (row[i] === '' || row[i] == null)) {
          missing.push(c.sla + ': ' + col[0].trim());
        }
      });
    });
    const sheets = [Object.assign({ name: sheetName, rows }, (layout && layout.sheet) || {})];
    if (layout && typeof layout.extraSheets === 'function') Array.prototype.push.apply(sheets, layout.extraSheets(rows, ctxs));
    return { sheets, missing, filenameBase };
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
        const r = rows.length + 1; // Deploy 237.230 -- the sheet row this loan lands on (header is row 1)
        const row = COLCHIS_TRADE_COLS.map((col) => { try { return col[1](c, r); } catch (e) { return ''; } });
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
      // Deploy 236.976 — a cell may now be a { f, v } formula object; sum the
      // cached value when present.
      const cellNum = (x) => num(x && typeof x === 'object' ? x.v : x) || 0;
      for (const c of ctxs) {
        const row = settlementRow(c, rows.length + 1); // sheet row number (1-based, header is row 1)
        rows.push(row);
        sumL += cellNum(row[11]); sumM += cellNum(row[12]); sumY += cellNum(row[24]);
        COLCHIS_SETTLE_HEADERS.forEach((h, i) => {
          if (COLCHIS_SETTLE_REQUIRED.indexOf(h) >= 0 && (row[i] === '' || row[i] == null)) {
            missing.push(c.sla + ': ' + h);
          }
        });
      }
      // Blank spacer, then the totals row (L, M, Y) — matches the historical
      // sheets, and 236.973 makes them live SUM formulas over the data rows.
      // Deploy 237.276 (Mike: "They need to sum those columns for all of the rows not just
      // the first 3 like they were doing"). The formulas were SUM(L2:L4) -- a range fixed at
      // the last row we generated. Excel does not widen a range for rows added BELOW its end,
      // so a 3-loan tape that had more loans added before it went out still summed three. Each
      // total now sums from row 2 to the row just above ITSELF, whatever is inserted or pasted
      // in between; the cached value is still the generated total.
      rows.push([]);
      const totals = new Array(COLCHIS_SETTLE_HEADERS.length).fill('');
      totals[11] = { f: 'SUM(L2:INDEX(L:L,ROW()-1))', v: round2(sumL), s: 'cur' };
      totals[12] = { f: 'SUM(M2:INDEX(M:M,ROW()-1))', v: round2(sumM), s: 'cur' };
      totals[24] = { f: 'SUM(Y2:INDEX(Y:Y,ROW()-1))', v: round2(sumY), s: 'cur' };
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
    build: strideBuild(STRIDE_DSCR_COLS, STRIDE_DSCR_REQUIRED, 'Form', 'Stride Submission Loan Tape - DSCR', STRIDE_DSCR_LAYOUT),
  },
  stride_rtl: {
    key: 'stride_rtl',
    label: 'Stride Submission Tape — RTL (pre-funding)',
    stage: 'pre_funding',
    params: [],
    build: strideBuild(STRIDE_RTL_COLS, STRIDE_RTL_REQUIRED, 'Sheet1', 'Stride Submission Loan Tape - RTL', STRIDE_RTL_LAYOUT),
  },
};
