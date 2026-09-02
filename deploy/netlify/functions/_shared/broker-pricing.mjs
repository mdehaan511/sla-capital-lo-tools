/**
 * _shared/broker-pricing.mjs — Deploy 236.856 (Broker Portal, Phase 0)
 *
 * Server-side pricing for the Preferred Partner (broker) portal.
 *
 * WHY THIS EXISTS AT ALL
 * ----------------------
 * LO sizers price in the browser, which is right for staff and wrong for
 * brokers: it ships the whole pricing book to anyone who registers, leaves
 * no record of what they priced, and can't enforce broker-specific rules.
 * Moving broker pricing server-side fixes all three at once.
 *
 * PARITY IS STRUCTURAL, NOT REMEMBERED
 * ------------------------------------
 * This module imports the EXACT SAME engine files the LO sizers load —
 * deploy/dscr-pricing.js, rtl-pricing.js, guc-pricing.js, mf-pricing.js.
 * There is no second copy of the math to keep in sync, and the existing
 * golden tests (scripts/pricing-test.mjs) already guard it. A rate-sheet
 * update lands on both surfaces the moment the engine file changes.
 *
 * The engines are classic browser scripts that also do
 * `module.exports = API` when `module` exists, so esbuild bundles them
 * into the function as CommonJS. guc-pricing.js additionally does a
 * static `require('./rtl-pricing.js')` for the shared Colchis tables;
 * that resolves at bundle time. If it ever DOESN'T, guc's rtlApi() falls
 * back to null and prices silently return nulls — assertEnginesLoaded()
 * below exists to turn that silent failure into a loud one.
 *
 * WHAT LEAVES THIS MODULE
 * -----------------------
 * An ALLOWLIST, never a blocklist. The raw engine results carry
 * `baseRate` + `adjs` (which together ARE the pricing matrix) and
 * `netHiddenTpoPct` (our investor spread). A blocklist would have leaked
 * the next field somebody adds. See PUBLIC_FIELDS below — everything not
 * named there is dropped, including anything added later.
 */
import dscrEngine from '../../../dscr-pricing.js';
import rtlEngine  from '../../../rtl-pricing.js';
import gucEngine  from '../../../guc-pricing.js';
import mfEngine   from '../../../mf-pricing.js';

// ── Program registry ────────────────────────────────────────────────
// `shape` selects the projection: the two DSCR engines return one result
// shape, the two Colchis-derived engines return another.
export const PROGRAMS = {
  dscr: { label: 'DSCR 1-4 Unit',   engine: dscrEngine, fn: 'priceDSCR', shape: 'dscr' },
  mf:   { label: 'DSCR 5+ Unit',    engine: mfEngine,   fn: 'priceDSCR', shape: 'dscr' },
  rtl:  { label: 'Bridge / Rehab',  engine: rtlEngine,  fn: 'priceRTL',  shape: 'rtl'  },
  guc:  { label: 'Ground-Up',       engine: gucEngine,  fn: 'priceGUC',  shape: 'rtl'  },
};

export const PROGRAM_KEYS = Object.keys(PROGRAMS);

/**
 * Fields a broker may see. Everything else is dropped.
 *
 * The comments on the DENIED list are the whole point of this file —
 * read them before adding anything.
 */
const PUBLIC_FIELDS = {
  // priceDSCR (1-4 unit and 5+ unit)
  dscr: [
    'finalRate',        // the note rate — the answer
    'ltv', 'dscr',      // the two ratios that decide eligibility
    'pi', 'totalPayment', 'taxes', 'ins', 'hoa', 'rent',
    'loan', 'propVal',
    'origFee', 'buydownFee', 'totalFees',
    'brokerPts', 'brokerFeeDol', 'brokerProcFee',
    'loanType', 'prepay', 'isIO', 'purpose', 'propType', 'fico',
    'guidelineWarnings', // tells the broker WHY it doesn't fit — useful, not sensitive
  ],
  // priceRTL / priceGUC (Colchis-derived)
  rtl: [
    'rate',
    'bMax', 'bLabel',   // max loan + which constraint bound it
    'dp', 'p', 'pDol',
    'mo', 'moStart', 'moMax', 'initAdv', 'isDutch',
    'progLabel', 'rErr', 'flags', 'ltvBasis', 'aivApplied',
    // GUC land handling — borrower-facing arithmetic, not pricing-book
    'ownLand', 'landValue', 'landDebt', 'landEquityCredit',
    'dpBeforeCredit', 'totalCost',
  ],
};

/*
 * DENIED, and why — do not "just add" these:
 *
 *   baseRate      the un-adjusted starting rate. With adjs it reconstructs
 *   adjs          the adjustment list. This IS the matrix, one row at a time
 *   netHiddenTpoPct   our investor spread. Never leaves the building
 *   floor         the rate floor is pricing-book data
 *   mLtp, mLtc, mLarv, refiLtv, defMax, mByLtc, mByLarv
 *                 raw leverage caps + the constraint arithmetic. `bLabel`
 *                 already tells the broker which limit bound their deal,
 *                 which is all they need to act on
 *   tier          the Colchis experience tier maps to a pricing-card row
 *   sandbox       Admin Mode marker; brokers never have it
 *   borrower, borrowerEmail, address
 *                 echoed inputs — no reason to round-trip PII
 */

function project(raw, shape) {
  if (!raw || typeof raw !== 'object') return null;
  const allow = PUBLIC_FIELDS[shape] || [];
  const out = {};
  for (const k of allow) {
    if (raw[k] !== undefined) out[k] = raw[k];
  }
  return out;
}

/**
 * The pricing effective date for a program, when the engine publishes one.
 *
 * DSCR and MF carry DIYA.effectiveDate. RTL and GUC don't have one yet
 * (see rtl-pricing.js) — they return null here until that field lands,
 * and the caller is expected to surface null rather than invent a date.
 */
export function effectiveDateFor(programKey) {
  const p = PROGRAMS[programKey];
  if (!p) return null;
  const e = p.engine;
  return (e && e.DIYA && e.DIYA.effectiveDate)
    || (e && e.EFFECTIVE_DATE)
    || null;
}

/**
 * Fail loudly if a bundling change silently detached an engine. Called on
 * every request — it's four property reads, and the alternative is a
 * broker quietly receiving nulls that look like a decline.
 */
export function assertEnginesLoaded() {
  const broken = [];
  for (const [key, p] of Object.entries(PROGRAMS)) {
    if (!p.engine || typeof p.engine[p.fn] !== 'function') broken.push(key);
  }
  // guc reaches into rtl for the construction tables; if that require()
  // didn't survive bundling, priceGUC returns nulls instead of throwing.
  if (!rtlEngine || typeof rtlEngine.priceRTL !== 'function') {
    if (!broken.includes('guc')) broken.push('guc(rtl-dependency)');
  }
  return broken;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/**
 * Price one scenario for a broker.
 *
 * @param {string} programKey    one of PROGRAM_KEYS
 * @param {object} inputs        engine-shaped scenario inputs
 * @param {number} brokerFeePts  the broker's own fee, in points
 * @returns {{ok:boolean, error?:string, program, effectiveDate, result, fee, allIn}}
 *
 * BROKER FEE HANDLING — the rule Mike set: our price is our price, the
 * broker's fee goes ON TOP.
 *
 * The DSCR engines already implement exactly that: passing brokerFee
 * leaves finalRate and origFee untouched and adds the fee to totalFees,
 * reporting it separately as brokerPts / brokerFeeDol (verified against
 * the engine before this was written). So DSCR/MF pass it through.
 *
 * The Colchis engines take no fee input, so we compute it here off the
 * max loan amount and keep it in its own field. In neither case does the
 * broker's fee touch `rate` or `p` — those stay SLA's numbers, because
 * commissions, TPO spread and investor economics all read them.
 */
export function priceScenario(programKey, inputs, brokerFeePts) {
  const prog = PROGRAMS[programKey];
  if (!prog) {
    return { ok: false, error: 'Unknown program: ' + programKey };
  }
  const feePts = Math.max(0, Number(brokerFeePts) || 0);
  const scenario = Object.assign({}, inputs || {});

  let raw;
  try {
    // Let the DSCR engines do the fee arithmetic — they already separate
    // it from rate and origination.
    //
    // Only WRITE the fee when one was explicitly passed. An earlier
    // version always assigned (clearing to '' when feePts was 0), which
    // silently discarded a brokerFee the caller had put in `inputs` and
    // broke parity against the engine for exactly those scenarios — the
    // golden harness caught it. The endpoint strips broker-supplied fee
    // fields from `inputs` before calling, so the explicit parameter
    // stays the single channel where it matters.
    if (prog.shape === 'dscr' && feePts > 0) {
      scenario.brokerFee = String(feePts);
    }
    raw = prog.engine[prog.fn](scenario);
  } catch (e) {
    return { ok: false, error: 'Pricing failed: ' + ((e && e.message) || 'unknown') };
  }

  const result = project(raw, prog.shape);
  if (!result) return { ok: false, error: 'Pricing returned no result' };

  // Loan amount + SLA's own points, per shape, for the fee math + summary.
  const loanAmt   = prog.shape === 'dscr' ? Number(raw.loan || 0)  : Number(raw.bMax || 0);
  const slaPts    = prog.shape === 'dscr'
    ? (loanAmt > 0 ? (Number(raw.origFee || 0) / loanAmt) * 100 : 0)
    : Number(raw.p || 0);
  const slaRate   = prog.shape === 'dscr' ? Number(raw.finalRate || 0) : Number(raw.rate || 0);

  const feeDollars = prog.shape === 'dscr'
    ? Number(raw.brokerFeeDol || 0)      // engine already computed it
    : round2(loanAmt * feePts / 100);    // Colchis engines don't take a fee

  if (prog.shape !== 'dscr' && feePts > 0) {
    result.brokerPts    = feePts;
    result.brokerFeeDol = feeDollars;
  }

  return {
    ok: true,
    program: programKey,
    programLabel: prog.label,
    effectiveDate: effectiveDateFor(programKey),
    result,
    // The split, stated explicitly so no caller has to infer it.
    fee: {
      slaRate:    round2(slaRate),
      slaPoints:  round2(slaPts),
      brokerPoints:  round2(feePts),
      brokerDollars: round2(feeDollars),
    },
    allIn: {
      loanAmount: loanAmt,
      // What the broker's borrower pays in points, all in. The RATE is
      // unchanged — a points-only fee model (v1 decision).
      points:  round2(slaPts + feePts),
      dollars: round2((loanAmt * slaPts / 100) + feeDollars),
    },
  };
}
