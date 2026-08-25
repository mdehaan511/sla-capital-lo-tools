/**
 * guc-pricing.js — GUC (Ground-Up Construction) pricing engine.
 *
 * Deploy 236.697. Companion to rtl-pricing.js. The GUC sizer is a
 * near-clone of the RTL sizer locked to Colchis's CONSTRUCTION program,
 * so this module reuses SLA_RTL's construction leverage/rate tables
 * (single source of truth — a rate-sheet update in rtl-pricing.js
 * flows straight through) and adds only the GUC-specific rules:
 *
 *   1. Experience is "# of New Builds Completed", tiered 6+ / 4-5 / 0-3
 *      (the Colchis Construction card's own tiers — NOT the 8+/4-7/0-3
 *      used elsewhere in RTL).
 *   2. The 0-3 tier is BLANK on the Colchis card. Per Mike, price it at
 *      the 4-5 tier's LTP/LTV, LTC and LTARV, flagged "subject to
 *      additional due diligence." (Rate still takes the Tier-3 +0.25%.)
 *   3. Land-ownership branch:
 *        • Don't own the land (buying it) → standard construction max:
 *          LTP × land price + full build cost, capped by LTC & LTARV.
 *        • Own the land → ask land value + existing land debt. If the
 *          debt is below 60% LTV of the land, the equity above the debt
 *          (0.60 × value − debt) can be applied toward the down payment.
 *   4. Interest is always Non-Dutch (no Dutch option in the GUC sizer).
 *
 * priceGUC(I) returns the SAME shape as SLA_RTL.priceRTL so the sizer's
 * render / save / term-sheet halves consume it unchanged, plus a few
 * GUC-only extras (ownLand, landValue, landDebt, landEquityCredit,
 * dpBeforeCredit).
 *
 * IIFE-wrapped: only SLA_GUC escapes (see dscr-pricing.js 236.407 for
 * why top-level const/var in classic scripts collide page-wide).
 */
(function () {
  var EXCEPTION_HINT = ' Reach out to a manager to submit an exception request.';

  // Resolve the RTL pricing API (construction tables + shared helpers).
  // Browser: window.SLA_RTL (rtl-pricing.js must load first). Node/test:
  // require the sibling module.
  function rtlApi() {
    if (typeof window !== 'undefined' && window.SLA_RTL) return window.SLA_RTL;
    try { return require('./rtl-pricing.js'); } catch (_) { return null; }
  }

  // GUC experience → tier index. Colchis Construction card tiers are
  // 6+ (Tier 1), 4-5 (Tier 2), 0-3 (Tier 3). The sizer's dropdown stores
  // 6 / 4 / 1 so this maps cleanly.
  function eiGUC(e) { if (e >= 6) return 0; if (e >= 4) return 1; return 2; }

  function priceGUC(I) {
    I = I || {};
    var rtl = rtlApi();
    if (!rtl) {
      return { rErr: 'Pricing engine unavailable (SLA_RTL not loaded).', rate: null, floor: false,
        bMax: null, bLabel: '', adjs: [], flags: [], p: 0, pDol: null };
    }

    var fr = I.fr, exp = I.exp, pt = I.pt, term = I.term, sa = I.sa, state = I.state;
    var landValue = I.landValue || 0;   // land purchase price (buying) OR current value (owned)
    var buildCost = I.buildCost || 0;   // construction budget (hard + soft costs)
    var arv = I.arv || 0;               // after-completion value
    var zhvi = I.zhvi || 'normal';
    var ownLand = (I.ownLand === true || I.ownLand === 'yes');
    var landDebt = I.landDebt || 0;
    var geoWarning = I.geoWarning || '';
    var geoReductionLabel = I.geoReductionLabel || '';
    var adminSandbox = (I.adminSandbox === true);

    var fk = rtl.fk, colchisRate = rtl.colchisRate, SPREAD = rtl.SPREAD,
        pts = rtl.pts, LABELS = rtl.LABELS, MFR_ADJ = rtl.MFR_ADJ;
    var CT_LTP  = rtl.MAX_LTP.construction,
        CT_LTC  = rtl.MAX_LTC.construction,
        CT_LARV = rtl.MAX_LTARV.construction;

    var adjs = [], flags = [];
    if (geoWarning) flags.push(geoWarning);
    var rErr = null;

    var fkey = fk(fr);
    var eidx = eiGUC(exp);
    // 0-3 tier is blank on the Colchis card → borrow the 4-5 (index 1)
    // leverage row. Rate keeps its own Tier-3 add-on below.
    var lvIdx = (eidx === 2) ? 1 : eidx;
    if (eidx === 2) {
      flags.push('0–3 new builds: priced at the 4–5 build tier — subject to additional due diligence.');
    }

    var ltpT  = CT_LTP[pt]  && CT_LTP[pt][fkey];
    var ltcT  = CT_LTC[pt]  && CT_LTC[pt][fkey];
    var larvT = CT_LARV[pt] && CT_LARV[pt][fkey];
    var mLtp  = ltpT  ? ltpT[lvIdx]  : 0;
    var mLtc  = ltcT  ? ltcT[lvIdx]  : 0;
    var mLarv = larvT ? larvT[lvIdx] : 0;

    // Multi-family (5-20 unit) ground-up construction is BLANK on the
    // Colchis card — not rate-carded. Surface a clear manual-review note;
    // the zero leverage below yields "not eligible" unless admin sandbox.
    var mfrUncarded = (pt === 'mfr' && !(mLtp > 0 || mLtc > 0 || mLarv > 0));
    if (mfrUncarded) {
      flags.push('Multi-family (5–20 unit) ground-up construction is not rate-carded — requires manual underwriting review.');
    }

    // 90% LTC requires a construction budget under $500,000; else 85%.
    // (Colchis Construction LTC footnote.) Applied before ZHVI/geo cuts.
    if (mLtc >= 0.899 && buildCost >= 500000) {
      mLtc = 0.85;
      flags.push('90% LTC requires a construction budget under $500,000 — capped at 85%.');
    }

    if (zhvi === '200') {
      mLtp = Math.max(0, mLtp - .05); mLtc = Math.max(0, mLtc - .05); mLarv = Math.max(0, mLarv - .05);
      flags.push('ZHVI override: 200–300% of ZIP median — leverage reduced 5%.');
    } else if (zhvi === '300') {
      mLtp = Math.max(0, mLtp - .10); mLtc = Math.max(0, mLtc - .10); mLarv = Math.max(0, mLarv - .10);
      flags.push('ZHVI override: >300% of ZIP median — leverage reduced 10%.');
    }
    if (geoReductionLabel) {
      mLtp = Math.max(0, mLtp - .05); mLtc = Math.max(0, mLtc - .05); mLarv = Math.max(0, mLarv - .05);
      flags.push(geoReductionLabel);
    }

    // ── MAX LOAN ─────────────────────────────────────────────────────
    // Construction max is the min of three caps:
    //   byLTP   = LTP/LTV × land value  +  full construction budget
    //   byLTC   = LTC × (land value + construction budget)
    //   byLTARV = LTARV × after-completion value
    // The land value is the purchase price when buying the lot, or the
    // appraised land value when the borrower already owns it.
    var totalCost = landValue + buildCost;
    var defMax  = mLtp  > 0 ? Math.round(landValue * mLtp) + buildCost : null;
    var mByLtc  = mLtc  > 0 ? Math.round(totalCost * mLtc) : null;
    var mByLarv = mLarv > 0 ? Math.round(arv * mLarv) : null;

    var bMax = defMax, bLabel = 'LTP/LTV';
    if (bMax && mByLtc  && mByLtc  < bMax) { bMax = mByLtc;  bLabel = 'LTC'; }
    if (bMax && mByLarv && mByLarv < bMax) { bMax = mByLarv; bLabel = 'LTARV'; }
    if (bMax && bMax > 3500000)            { bMax = 3500000; bLabel = 'Program max $3.5M'; }

    // Admin sandbox: never block on eligibility — fall back to total cost.
    if (adminSandbox && !bMax) {
      if (totalCost > 0) { bMax = Math.round(totalCost); bLabel = 'Admin Override'; }
    }

    // Target Loan Amount cap (LO can only reduce; admin can exceed).
    var targetLoan = parseFloat(I.targetLoanAmt);
    if (isFinite(targetLoan) && targetLoan > 0 && bMax) {
      if (targetLoan < bMax) { bMax = Math.round(targetLoan); bLabel = 'LO Target'; }
      else if (adminSandbox && targetLoan > bMax) { bMax = Math.round(targetLoan); bLabel = 'Admin Override'; }
    }

    // ── LAND EQUITY CREDIT (owned land only) ─────────────────────────
    // When the borrower owns the land and the debt on it is below 60% LTV,
    // the equity between the debt and 60% of the value can be applied to
    // the down payment. e.g. land $100k, debt $40k → 0.60×100k−40k = $20k.
    var landEquityCredit = 0;
    if (ownLand && landValue > 0) {
      landEquityCredit = Math.max(0, Math.round(0.60 * landValue - landDebt));
    }

    // ── DOWN PAYMENT / CASH TO CLOSE ─────────────────────────────────
    // Total project cost not covered by the loan = borrower's cash. On an
    // owned-land deal the land-equity credit offsets that requirement.
    var dp = null, dpBeforeCredit = null;
    if (bMax !== null && totalCost > 0) {
      dpBeforeCredit = Math.max(0, totalCost - bMax);
      dp = ownLand ? Math.max(0, dpBeforeCredit - landEquityCredit) : dpBeforeCredit;
    }

    // ── RATE ─────────────────────────────────────────────────────────
    var rate = null, floor = false;
    var progLabel = 'Ground-Up Construction · ' + (state || '');

    if (fr < 680 && !adminSandbox) {
      // Colchis Construction card is blank below 680 FICO (660-679 empty).
      rErr = 'Ground-up construction requires a minimum 680 FICO.' + EXCEPTION_HINT;
    } else if (!bMax) {
      if (!adminSandbox) {
        rErr = (mfrUncarded
          ? 'No rate card for multi-family ground-up construction — manual review required.'
          : 'No eligible loan amount for this combination.') + EXCEPTION_HINT;
      }
    } else {
      // Effective LTV for the rate lookup = the land LTP (as in the RTL
      // construction path). colchisRate falls back to the lowest defined
      // column when the actual LTV is below every column (construction
      // LTP is ~60%, below the .70 start).
      var ltvF = mLtp;
      var sz = bMax > 3000000 ? '3m' : bMax > 2000000 ? '2m' : 'normal';
      var cbResult = colchisRate('construction', pt, fkey, ltvF);
      if (!cbResult) {
        if (!adminSandbox) {
          rErr = 'No pricing available for this FICO/LTV combination.' + EXCEPTION_HINT;
        } else {
          rate = 0.09125; // construction program min placeholder
        }
      } else {
        var cb = cbResult.rate, ltvIdx = cbResult.ltvIdx;
        var adj = 0;
        if (pt === 'mfr' && MFR_ADJ.construction && ltvIdx >= 0) {
          var mfrA = MFR_ADJ.construction[ltvIdx] || 0;
          if (mfrA > 0) { adj += mfrA; adjs.push({ l: 'Multi-family property', v: mfrA, c: 'pos' }); }
        }
        if (sa === 'nynj') { adj += .0025; adjs.push({ l: 'NY/NJ/CT region', v: .0025, c: 'pos' }); }
        else if (sa === 'ca') { adj -= .00125; adjs.push({ l: 'California', v: -.00125, c: 'neg' }); }
        if (zhvi === '200') { adj += .0025; adjs.push({ l: 'Property value >200% ZHVI', v: .0025, c: 'pos' }); }
        else if (zhvi === '300') { adj += .00375; adjs.push({ l: 'Property value >300% ZHVI', v: .00375, c: 'pos' }); }
        if (term === 19) { adj += .00125; adjs.push({ l: 'Loan term 19–24 months', v: .00125, c: 'pos' }); }
        if (sz === '3m') { adj += .0025; adjs.push({ l: 'Loan amount >$3M', v: .0025, c: 'pos' }); }

        // Tier-1 baseline = wholesale + adjustments + spread − 0.25%.
        var tier1Base = cb + adj + SPREAD[fkey] - .0025;
        var progMin = 0.09125; // Construction program minimum (Jun 29 2026 sheet)
        if (tier1Base < progMin) { tier1Base = progMin; floor = true; }
        if (tier1Base < 0.10) { tier1Base = 0.10; floor = true; } // SLA policy floor

        // Experience tier add-on: 6+ = Tier 1, 4-5 = Tier 2 (+0.25%),
        // 0-3 = Tier 3 (+0.50%).
        if (eidx === 0) {
          rate = tier1Base;
          adjs.push({ l: 'Experience: Tier 1 (6+ builds)', v: -.0025, c: 'neg' });
        } else if (eidx === 1) {
          rate = tier1Base + .0025;
        } else {
          rate = tier1Base + .005;
          adjs.push({ l: 'Experience: Tier 3 (0–3 builds)', v: .0025, c: 'pos' });
        }
      }
    }

    // ── POINTS + LOAN-SIZE FLOORS (mirror RTL) ───────────────────────
    var p = pts(fr);
    if (!rErr && bMax && bMax > 0) {
      if (bMax < 100000) {
        rErr = 'Loan amount below the $100,000 minimum — not eligible.' + EXCEPTION_HINT;
      } else if (bMax < 125000) {
        if (rate == null || rate < 0.12) rate = 0.12;
        if (p < 2) p = 2;
        floor = true;
        flags.push('⚠ Loan under $125,000 — priced at the SLA minimum (12% / 2 pts). Requires approval.');
      }
    }
    var pDol = bMax ? bMax * p / 100 : null;

    // ── MONTHLY PAYMENT (always Non-Dutch for GUC) ───────────────────
    // Non-Dutch: interest accrues on drawn funds. Starting payment = interest
    // on the initial advance (loan minus the construction budget held in
    // escrow); it grows to the max as the build draws down.
    var isDutch = false;
    var initAdv = (bMax != null) ? Math.max(0, bMax - buildCost) : bMax;
    var moMax   = (rate && bMax) ? (bMax * rate / 12) : null;
    var moStart = (rate && initAdv != null) ? (initAdv * rate / 12) : null;
    var mo = moMax;

    return {
      rErr: rErr, rate: rate, floor: floor, bMax: bMax, bLabel: bLabel,
      mLtp: mLtp, mLtc: mLtc, mLarv: mLarv, refiLtv: null,
      defMax: defMax, mByLtc: mByLtc, mByLarv: mByLarv, dp: dp,
      adjs: adjs, flags: flags, p: p, pDol: pDol,
      isDutch: isDutch, initAdv: initAdv, moMax: moMax, moStart: moStart,
      mo: mo, progLabel: progLabel, sandbox: adminSandbox,
      // ── GUC-only extras ──
      ownLand: ownLand, landValue: landValue, landDebt: landDebt,
      landEquityCredit: landEquityCredit, dpBeforeCredit: dpBeforeCredit,
      totalCost: totalCost, tier: eidx,
    };
  }

  var _SLA_GUC_API = { EXCEPTION_HINT: EXCEPTION_HINT, eiGUC: eiGUC, priceGUC: priceGUC };
  if (typeof window !== 'undefined') window.SLA_GUC = _SLA_GUC_API;
  if (typeof module !== 'undefined' && module.exports) module.exports = _SLA_GUC_API;
})();
