/**
 * loan-uw-calc.js — deterministic calculation engine for the RTL
 * Underwriting tab (Deploy 236.491, Phase 1c). PURE functions, no DOM,
 * no AI — every value here is reproducible and unit-tested. The tab UI
 * and the red-flag layer consume computeUwCalcs(ctx).
 *
 * Formulas are Mike's, locked (see loan-uw-fields.js header):
 *   monthlyPayment       = loanAmt × rate ÷ 12
 *   ltarv                = loanAmt ÷ arv
 *   ltc                  = loanAmt ÷ (purchasePrice + renovation)  [= term sheet]
 *   ltaiv                = loanAmt ÷ asIsValue
 *   assignmentToPurchase = assignmentFee ÷ purchasePrice          (RED > 15%)
 *   prepaidInterest      = loanAmt × rate ÷ 365 × daysFundingToMonthEnd
 *   liquidityTotal       = Σ(account.balance × account.weight) + emdPaid
 *   liquidityRequirement = cashToClose + 0.20 × renovation + 6 × monthly
 *
 * `rate` is a DECIMAL (0.105 = 10.5%). All $ inputs are plain numbers.
 * Any missing/zero denominator yields null for that ratio (never NaN/∞).
 */
(function () {

  function num(v) {
    if (v === null || v === undefined || v === '') return 0;
    var n = Number(String(v).replace(/[$,%\s]/g, ''));
    return isFinite(n) ? n : 0;
  }

  // Days from the funding date through the LAST day of that same month,
  // counting the funding day itself (standard per-diem prepaid interest).
  // funding on the 1st of a 30-day month => 30 days; on the last day => 1.
  //
  // TIMEZONE-SAFE: a "YYYY-MM-DD" string is parsed by its components, NOT
  // via new Date(str) — the latter reads as UTC midnight and .getDate()
  // in a timezone behind UTC rolls back a day (would over/undercount the
  // per-diem, which is real money). Only a non-date-only value falls back
  // to Date parsing.
  function daysFundingToMonthEnd(fundingDate) {
    if (!fundingDate) return 0;
    var y, m, day;
    if (typeof fundingDate === 'string') {
      var mt = fundingDate.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
      if (mt) { y = +mt[1]; m = +mt[2] - 1; day = +mt[3]; }
      else {
        var dd = new Date(fundingDate);
        if (isNaN(dd.getTime())) return 0;
        y = dd.getFullYear(); m = dd.getMonth(); day = dd.getDate();
      }
    } else if (fundingDate instanceof Date && !isNaN(fundingDate.getTime())) {
      y = fundingDate.getFullYear(); m = fundingDate.getMonth(); day = fundingDate.getDate();
    } else {
      return 0;
    }
    if (!(m >= 0 && m <= 11) || !(day >= 1 && day <= 31)) return 0;
    var lastDay = new Date(y, m + 1, 0).getDate(); // day count of the month
    return Math.max(0, lastDay - day + 1);
  }

  function ratio(numer, denom) {
    numer = num(numer); denom = num(denom);
    if (denom <= 0) return null;
    return numer / denom;
  }

  /**
   * @param {Object} ctx
   *   loanAmt, rate(dec), arv, purchasePrice, renovation, asIsValue,
   *   assignmentFee, fundingDate, cashToClose, emdPaid(number),
   *   accounts: [{ type, balance, weight(0..1) }],
   *   caps?: { maxLtarv, maxLtc, maxLtaiv, minMiddleCredit } // optional, for flags
   * @returns { values:{...}, flags:{...} }
   */
  function computeUwCalcs(ctx) {
    ctx = ctx || {};
    var loanAmt   = num(ctx.loanAmt);
    var rate      = num(ctx.rate); // decimal
    var reno      = num(ctx.renovation);
    var monthly   = (loanAmt > 0 && rate > 0) ? (loanAmt * rate / 12) : 0;

    var ltarv = ratio(loanAmt, ctx.arv);
    var ltc   = ratio(loanAmt, num(ctx.purchasePrice) + reno);
    var ltaiv = ratio(loanAmt, ctx.asIsValue);
    var a2p   = ratio(ctx.assignmentFee, ctx.purchasePrice);

    var days = daysFundingToMonthEnd(ctx.fundingDate);
    var prepaidInterest = (loanAmt > 0 && rate > 0 && days > 0)
      ? (loanAmt * rate / 365 * days) : 0;

    // Weighted liquidity available = Σ(balance × weight) + EMD paid (100%).
    var accounts = Array.isArray(ctx.accounts) ? ctx.accounts : [];
    var liquidityTotal = num(ctx.emdPaid);
    for (var i = 0; i < accounts.length; i++) {
      var a = accounts[i] || {};
      var w = (a.weight === null || a.weight === undefined) ? 0 : num(a.weight);
      liquidityTotal += num(a.balance) * w;
    }

    // Requirement = Cash to Close + 20% reno + 6 months interest.
    var liquidityRequirement = num(ctx.cashToClose) + 0.20 * reno + 6 * monthly;

    var values = {
      monthlyPayment: monthly,
      ltarv: ltarv,
      ltc: ltc,
      ltaiv: ltaiv,
      assignmentToPurchase: a2p,
      prepaidInterest: prepaidInterest,
      prepaidInterestDays: days,
      liquidityTotal: liquidityTotal,
      liquidityRequirement: liquidityRequirement,
    };

    // ── Deterministic RED-flag rules ────────────────────────────────
    // Only rules confirmed with Mike. Leverage-cap + credit flags fire
    // only when the caller supplies the caps (from the priced loan /
    // guidelines) so we never invent a threshold.
    var caps = ctx.caps || {};
    var flags = {
      assignmentToPurchase: (a2p !== null && a2p > 0.15),
      liquidity: (liquidityTotal < liquidityRequirement - 0.005),
    };
    if (typeof caps.maxLtarv === 'number' && ltarv !== null) flags.ltarv = ltarv > caps.maxLtarv + 1e-6;
    if (typeof caps.maxLtc   === 'number' && ltc   !== null) flags.ltc   = ltc   > caps.maxLtc   + 1e-6;
    if (typeof caps.maxLtaiv === 'number' && ltaiv !== null) flags.ltaiv = ltaiv > caps.maxLtaiv + 1e-6;
    if (typeof caps.minMiddleCredit === 'number' && ctx.middleCredit != null && num(ctx.middleCredit) > 0) {
      flags.middleCredit = num(ctx.middleCredit) < caps.minMiddleCredit;
    }

    return { values: values, flags: flags };
  }

  var _API = {
    computeUwCalcs: computeUwCalcs,
    daysFundingToMonthEnd: daysFundingToMonthEnd,
    _num: num,
  };
  if (typeof window !== 'undefined') window.SLA_UW_CALC = _API;
  if (typeof module !== 'undefined' && module.exports) module.exports = _API;
})();
