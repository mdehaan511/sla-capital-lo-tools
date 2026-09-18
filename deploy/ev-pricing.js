/**
 * ev-pricing.js — Eastview DSCR pricing engine (Deploy 237.148, Mike)
 *
 * Decoded from Mike's "EV DSCR S Sizer_09.16.26.xlsx" (Silver tier, guideline
 * version 8). Eastview does NOT price like DIYA: there is no rate sheet of
 * borrower rates. Eastview publishes a PRICE for every coupon, and the loan
 * sells at that price plus/minus LLPAs, so the LO picks the coupon and reads
 * the exit price — above 100 we earn a premium, below 100 it sells at a
 * discount.
 *
 *   exit price = base price for the coupon (by rate type)
 *              + FICO x LTV adjustment
 *              + every situational adjustment that applies (DSCR band, UPB
 *                size, cash out, condo / non-warrantable, 2-4 unit, 5-9 unit,
 *                prepay option, interest only, cross-collateralized)
 *              capped at the max price for the chosen prepay option
 *
 * Each adjustment is read from the LTV band column (<=50/55/60/65/70/75/80) of
 * its row, exactly as the workbook's nested IFs do; a null cell means the
 * combination is not allowed at that leverage (the workbook shows N/A).
 *
 * Sizing mirrors the workbook: the leverage grid (FICO bucket x loan purpose)
 * gives Max As-Is LTV + Max LTC, the deductions come off that, and the max loan
 * is min(LTC x cost basis, LTV x value) on a purchase, LTV x value on a refi.
 *
 * TO UPDATE PRICING: when Eastview sends a new workbook, re-run
 *   python3 scripts/_gen_ev_pricing.py     (regenerates the tables below)
 *   node scripts/ev-pricing-test.mjs       (golden: the workbook's own example
 *                                           loan prices to 0.9726970556)
 *
 * Exposes window.SLA_EV / module.exports: EASTVIEW, ficoBucket, ltvBandIndex,
 * calcPI, sizeLoan, priceEastview, rateLadder.
 */
(function () {
var EASTVIEW = {
  tier: 'Silver',
  effectiveDate: '2026-09-16',
  guidelineVersion: 8,
  minLoan: 100000,          // Program Notes; the workbook's own check fails below 75,000
  hardMinLoan: 75000,
  maxLoan: 3000000,
  minPrice: 0.965,
  armMargin: 0.05,
  armIndex: '30 Day Average SOFR',
  armFloor: 0.05,
  armCaps: { '5/1 ARM': '2/2/5', '7/1 ARM': '5/2/5' },
  lockDays: 30,
  maxLockDays: 90,
  extensionCostBps: 30,
  // Leverage deductions (Sizer!K109:K112), summed and added to the grid max.
  deductions: { unleasedRefi: -0.05, nonWarrantable: -0.10, lowPerfMarket: -0.05, unit59: -0.05 },
  lowPerfMarkets: ['Chicago', 'Detroit', 'Baltimore', 'Flint'],
  // Coupon -> price, exactly as Eastview publishes it (Silver tier, 9/16/26).
  couponPrices: [
    { rate: 9.0, spread5yr: 4.14, fixed30: 1.068701283256355, arm51: 1.068701283256355, arm71: 1.068701283256355 },
    { rate: 8.875, spread5yr: 4.015, fixed30: 1.0644716447259908, arm51: 1.0644716447259908, arm71: 1.0644716447259908 },
    { rate: 8.75, spread5yr: 3.89, fixed30: 1.0602468366383566, arm51: 1.0602468366383566, arm71: 1.0602468366383566 },
    { rate: 8.625, spread5yr: 3.765, fixed30: 1.0560269991385554, arm51: 1.0560269991385554, arm71: 1.0560269991385554 },
    { rate: 8.5, spread5yr: 3.64, fixed30: 1.0518122747121676, arm51: 1.0518122747121676, arm71: 1.0518122747121676 },
    { rate: 8.375, spread5yr: 3.515, fixed30: 1.0476028081694835, arm51: 1.0476028081694835, arm71: 1.0476028081694835 },
    { rate: 8.25, spread5yr: 3.39, fixed30: 1.0433987466271986, arm51: 1.0433987466271986, arm71: 1.0433987466271986 },
    { rate: 8.125, spread5yr: 3.265, fixed30: 1.0392002394875677, arm51: 1.0392002394875677, arm71: 1.0392002394875677 },
    { rate: 8.0, spread5yr: 3.14, fixed30: 1.0350074384149008, arm51: 1.0350074384149008, arm71: 1.0350074384149008 },
    { rate: 7.875, spread5yr: 3.015, fixed30: 1.0308204973094022, arm51: 1.0308204973094022, arm71: 1.0308204973094022 },
    { rate: 7.75, spread5yr: 2.89, fixed30: 1.0266395722782615, arm51: 1.0266395722782615, arm71: 1.0266395722782615 },
    { rate: 7.625, spread5yr: 2.765, fixed30: 1.022464821603975, arm51: 1.022464821603975, arm71: 1.022464821603975 },
    { rate: 7.5, spread5yr: 2.64, fixed30: 1.0182964057099033, arm51: 1.0182964057099033, arm71: 1.0182964057099033 },
    { rate: 7.375, spread5yr: 2.515, fixed30: 1.0141344871228462, arm51: 1.0141344871228462, arm71: 1.0141344871228462 },
    { rate: 7.25, spread5yr: 2.39, fixed30: 1.0099792304328583, arm51: 1.0099792304328583, arm71: 1.0099792304328583 },
    { rate: 7.125, spread5yr: 2.265, fixed30: 1.005830802250032, arm51: 1.005830802250032, arm71: 1.005830802250032 },
    { rate: 7.0, spread5yr: 2.14, fixed30: 1.00168937115845, arm51: 1.00168937115845, arm71: 1.00168937115845 },
    { rate: 6.875, spread5yr: 2.015, fixed30: 0.9963051076670325, arm51: 0.9963051076670325, arm71: 0.9963051076670325 },
    { rate: 6.75, spread5yr: 1.89, fixed30: 0.9909281841574831, arm51: 0.9909281841574831, arm71: 0.9909281841574831 },
    { rate: 6.625, spread5yr: 1.765, fixed30: 0.9855587748291801, arm51: 0.9855587748291801, arm71: 0.9855587748291801 },
    { rate: 6.5, spread5yr: 1.64, fixed30: 0.9801970556411037, arm51: 0.9801970556411037, arm71: 0.9801970556411037 },
    { rate: 6.375, spread5yr: 1.515, fixed30: 0.9735932042506598, arm51: 0.9735932042506598, arm71: 0.9735932042506598 },
    { rate: 6.25, spread5yr: 1.39, fixed30: 0.9669973999496134, arm51: 0.9669973999496134, arm71: 0.9669973999496134 },
    { rate: 6.125, spread5yr: 1.265, fixed30: 0.9604098235968728, arm51: 0.9604098235968728, arm71: 0.9604098235968728 },
    { rate: 6.0, spread5yr: 1.14, fixed30: 0.953830657548393, arm51: 0.953830657548393, arm71: 0.953830657548393 },
  ],
  // LLPA columns, by LTV band: <=50, <=55, <=60, <=65, <=70, <=75, <=80.
  ltvBands: [0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8],
  ficoLlpa: {
    f780: [0.01375, 0.0125, 0.01, 0.007500000000000001, 0.00625, -0.00125, -0.0075], // FICO: 780+
    f760: [0.0125, 0.01125, 0.00875, 0.005, 0.0025, -0.0025, -0.00875], // FICO: 760 - 779
    f740: [0.01125, 0.01, 0.0075, 0.005, 0.00125, -0.005, -0.0125], // FICO: 740 - 759
    f720: [0.00675, 0.005, 0.00375, 0.00125, -0.0025, -0.0075, -0.015], // FICO: 720 - 739
    f700: [0.00375, 0.0025, 0, -0.0025, -0.0075, -0.015, -0.02], // FICO: 700 - 719
    f680: [0, -0.0025, -0.00375, -0.01, -0.015, -0.0225, null], // FICO: 680 - 699
    f660: [-0.00375, -0.00625, -0.01, -0.015, -0.0225, null, null], // FICO: 660 - 679
    f640: [null, null, null, null, null, null, null], // FICO: 640 - 659
    f620: [null, null, null, null, null, null, null], // FICO: 620 - 639
    fn: [-0.00375, -0.00625, -0.01, -0.015, -0.0225, null, null], // Foreign National
  },
  adj: {
    dscr80: [null, null, null, null, null, null, null], // 0.80 <= DSCR < 1.00
    dscr100: [0, 0, 0, 0, -0.00125, -0.0025, -0.00375], // 1.00 <= DSCR < 1.10
    dscr115: [0.005, 0.005, 0.00375, 0.00375, 0.00375, 0.0025, 0.0025], // DSCR >=1.15
    upbSmall: [0, 0, 0, 0, -0.0025, -0.005, -0.01], // UPB <= $150,000
    upbLarge: [-0.005, -0.005, -0.0075, -0.0125, -0.02, -0.03, null], // $2,000,000 < UPB <= $3,000,000
    cashOut: [-0.00125, -0.0025, -0.0025, -0.00375, -0.005, -0.0075, -0.03], // Refinance (Cash Out)
    nonWarrantable: [-0.005, -0.005, -0.005, -0.005, -0.005, null, null], // Non-Warrantable Condo
    condo: [-0.0025, -0.0025, -0.00375, -0.00375, -0.005, -0.00625, -0.0075], // Condo
    unit24: [-0.0025, -0.0025, -0.00375, -0.00375, -0.00375, -0.005, -0.005], // 2-4 Unit
    pp7min: [0.0175, 0.0175, 0.0175, 0.0175, 0.0175, 0.0175, 0.0175], // 7 Years (84 Months) Minimum Interest
    pp7: [0.015, 0.015, 0.015, 0.015, 0.015, 0.015, 0.015], // 7 Years (7%/6%/5%/4%/3%/2%/1%)
    pp5min: [0.0125, 0.0125, 0.0125, 0.0125, 0.0125, 0.0125, 0.0125], // 5 Years (60 Months) Minimum Interest
    pp5: [0.01, 0.01, 0.01, 0.01, 0.01, 0.01, 0.01], // 5 Years (5%/4%/3%/2%/1%)
    pp3: [0.0025, 0.0025, 0.0025, 0.0025, 0.0025, 0.0025, 0.0025], // 3 Years (3%/2%/1%)
    pp2: [-0.0025, -0.0025, -0.0025, -0.0025, -0.0025, -0.0025, -0.0025], // 2 Years (2%/1%)
    pp1: [-0.00875, -0.00875, -0.00875, -0.00875, -0.00875, -0.00875, -0.00875], // 1 Year (1%)
    ppNone: [-0.015, -0.015, -0.015, -0.015, -0.015, -0.015, -0.015], // No Prepayment Penalty
    io: [0, 0, 0, -0.0025, -0.0025, -0.00375, -0.005], // Interest Only (10 Years)
    unit59: [-0.04, -0.0425, -0.045, -0.05375, -0.06, -0.075, null], // 5-9 Unit
    crossColl: [-0.025, -0.025, -0.025, -0.025, -0.025, -0.025, -0.025], // Cross-Collateralized Portfolio
  },
  maxPriceByPrepay: {"pp7min": 1.045, "pp7": 1.045, "pp5min": 1.045, "pp5": 1.045, "pp3": 1.04, "pp2": 1.035, "pp1": 1.025, "ppNone": 1.02},
  prepayLabels: {"pp7min": "7 Years (84 Months) Minimum Interest", "pp7": "7 Years (7%/6%/5%/4%/3%/2%/1%)", "pp5min": "5 Years (60 Months) Minimum Interest", "pp5": "5 Years (5%/4%/3%/2%/1%)", "pp3": "3 Years (3%/2%/1%)", "pp2": "2 Years (2%/1%)", "pp1": "1 Year (1%)", "ppNone": "No Prepayment Penalty"},
  prepayMonths: {"pp7min": 84, "pp7": 84, "pp5min": 60, "pp5": 60, "pp3": 36, "pp2": 24, "pp1": 12, "ppNone": 0},
  levGrid: {"f780": {"purchase": {"ltv": 0.8, "ltc": 0.8}, "refi_rt": {"ltv": 0.8, "ltc": null}, "refi_co": {"ltv": 0.8, "ltc": null}}, "f760": {"purchase": {"ltv": 0.8, "ltc": 0.8}, "refi_rt": {"ltv": 0.8, "ltc": null}, "refi_co": {"ltv": 0.8, "ltc": null}}, "f740": {"purchase": {"ltv": 0.8, "ltc": 0.8}, "refi_rt": {"ltv": 0.8, "ltc": null}, "refi_co": {"ltv": 0.8, "ltc": null}}, "f720": {"purchase": {"ltv": 0.8, "ltc": 0.8}, "refi_rt": {"ltv": 0.8, "ltc": null}, "refi_co": {"ltv": 0.8, "ltc": null}}, "f700": {"purchase": {"ltv": 0.8, "ltc": 0.8}, "refi_rt": {"ltv": 0.8, "ltc": null}, "refi_co": {"ltv": 0.75, "ltc": null}}, "f680": {"purchase": {"ltv": 0.75, "ltc": 0.75}, "refi_rt": {"ltv": 0.75, "ltc": null}, "refi_co": {"ltv": 0.7, "ltc": null}}, "f660": {"purchase": {"ltv": 0.7, "ltc": 0.7}, "refi_rt": {"ltv": 0.7, "ltc": null}, "refi_co": {"ltv": 0.65, "ltc": null}}, "fn": {"purchase": {"ltv": 0.7, "ltc": 0.7}, "refi_rt": {"ltv": 0.7, "ltc": null}, "refi_co": {"ltv": 0.65, "ltc": null}}},
  statePrepayLimits: {"IN": "Max 2% / 2% / 2%", "KS": "No PPP Allowed", "MN": "No PPP Allowed", "NJ": "No PPP Allowed to Individuals", "NM": "No PPP Allowed", "OH": "Max: 1% for Loan >$107,633\nNo PPP Allowed for Loan <$107,633", "PA": "No PPP Allowed for Loan <$319,777", "RI": "Max: 2% / 0%"},
};

// ── Small helpers ──────────────────────────────────────────────────
function num(v) {
  var n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, ''));
  return isFinite(n) ? n : 0;
}
/** Credit score -> Eastview bucket key. 'FN' / 'Foreign National' -> fn. */
function ficoBucket(score) {
  var s = String(score == null ? '' : score).trim().toLowerCase();
  if (s === 'fn' || s.indexOf('foreign') === 0) return 'fn';
  var n = num(score);
  if (!(n > 0)) return '';
  if (n >= 780) return 'f780';
  if (n >= 760) return 'f760';
  if (n >= 740) return 'f740';
  if (n >= 720) return 'f720';
  if (n >= 700) return 'f700';
  if (n >= 680) return 'f680';
  if (n >= 660) return 'f660';
  if (n >= 640) return 'f640';
  return 'f620';
}
var FICO_LABELS = {
  f780: 'FICO: 780+', f760: 'FICO: 760 - 779', f740: 'FICO: 740 - 759', f720: 'FICO: 720 - 739',
  f700: 'FICO: 700 - 719', f680: 'FICO: 680 - 699', f660: 'FICO: 660 - 679', f640: 'FICO: 640 - 659',
  f620: 'FICO: 620 - 639', fn: 'Foreign National',
};
/**
 * LTV -> column index. The workbook walks bands as <=50, (50,55], (55,60],
 * (60,65], (65,70], (70,75], (75,80]; anything over 80 is off the grid (-1).
 */
function ltvBandIndex(ltv) {
  var b = EASTVIEW.ltvBands;
  for (var i = 0; i < b.length; i++) {
    if (ltv <= b[i] + 1e-9) return i;
  }
  return -1;
}
function adjAt(row, bandIdx) {
  if (!row || bandIdx < 0) return null;
  var v = row[bandIdx];
  return (v === null || v === undefined) ? null : v;
}
/** Monthly P&I. Interest-only pays interest only (the workbook's IPMT period 1). */
function calcPI(loan, annualRatePct, isIO) {
  var r = num(annualRatePct) / 100 / 12;
  if (!(loan > 0) || !(r > 0)) return 0;
  if (isIO) return loan * r;
  return loan * r / (1 - Math.pow(1 + r, -360));
}
function roundTo(n, dp) { var f = Math.pow(10, dp || 0); return Math.round(n * f) / f; }

var UNIT_COUNT = { sfr: 1, townhome: 1, condo: 1, pud: 1, '2unit': 2, '3unit': 3, '4unit': 4,
  '5unit': 5, '6unit': 6, '7unit': 7, '8unit': 8, '9unit': 9 };
var PROP_LABELS = { sfr: 'SFR', townhome: 'Townhome', condo: 'Condo', pud: 'PUD', '2unit': '2 Unit',
  '3unit': '3 Unit', '4unit': '4 Unit', '5unit': '5 Unit', '6unit': '6 Unit', '7unit': '7 Unit',
  '8unit': '8 Unit', '9unit': '9 Unit' };
var PURPOSE_LABELS = { purchase: 'Purchase', refi_rt: 'Refinance (No Cash Out)', refi_co: 'Refinance (Cash Out)' };

function unitsOf(propType) { return UNIT_COUNT[propType] || 1; }
function is24(propType) { var u = unitsOf(propType); return u >= 2 && u <= 4; }
function is59(propType) { var u = unitsOf(propType); return u >= 5 && u <= 9; }

/**
 * Max loan from the leverage grid + deductions (Sizer!G125:H127).
 * Returns { maxLtv, maxLtc, deductions, maxLoan, byLtv, byLtc, gridLabel }.
 */
function sizeLoan(p) {
  var bucket = ficoBucket(p.fico);
  var purpose = p.purpose || 'purchase';
  var grid = (EASTVIEW.levGrid[bucket] || {})[purpose] || null;
  var value = num(p.value);
  var costBasis = purpose === 'purchase' ? num(p.purchasePrice) * (1 + num(p.closingCostPct) / 100) : null;
  var ded = 0;
  var dedParts = [];
  if (purpose !== 'purchase' && p.leased === false && !p.recentRenovation) {
    ded += EASTVIEW.deductions.unleasedRefi; dedParts.push('Unleased refinance −5%');
  }
  if (p.nonWarrantableCondo) { ded += EASTVIEW.deductions.nonWarrantable; dedParts.push('Non-warrantable condo −10%'); }
  if (p.lowPerfMarket) { ded += EASTVIEW.deductions.lowPerfMarket; dedParts.push('Low-performance market −5%'); }
  if (is59(p.propType)) { ded += EASTVIEW.deductions.unit59; dedParts.push('5-9 units −5%'); }
  var out = {
    bucket: bucket, bucketLabel: FICO_LABELS[bucket] || '',
    gridLabel: (FICO_LABELS[bucket] || '') + ' / ' + (PURPOSE_LABELS[purpose] || purpose),
    deductions: ded, deductionParts: dedParts, costBasis: costBasis,
    maxLtvPre: grid ? grid.ltv : null, maxLtcPre: grid ? grid.ltc : null,
    maxLtv: null, maxLtc: null, byLtv: null, byLtc: null, maxLoan: null,
  };
  if (!grid) return out;
  out.maxLtv = grid.ltv == null ? null : grid.ltv + ded;
  out.maxLtc = grid.ltc == null ? null : grid.ltc + ded;
  out.byLtv = (out.maxLtv != null && value > 0) ? out.maxLtv * value : null;
  out.byLtc = (out.maxLtc != null && costBasis > 0) ? out.maxLtc * costBasis : null;
  var caps = [];
  if (out.byLtv != null) caps.push(out.byLtv);
  if (purpose === 'purchase' && out.byLtc != null) caps.push(out.byLtc);
  out.maxLoan = caps.length ? Math.floor(Math.min.apply(null, caps)) : null;
  return out;
}

/**
 * Exit price for ONE coupon. Returns { price, capped, parts[], blocked }.
 * `blocked` names the adjustment whose cell is N/A at this leverage — the
 * workbook would show "N/A", so the coupon is not quotable.
 */
function priceAtCoupon(p, coupon, ctx) {
  var bandIdx = ctx.bandIdx;
  var rateType = p.rateType || 'FIXED 30';
  var row = null;
  for (var i = 0; i < EASTVIEW.couponPrices.length; i++) {
    if (Math.abs(EASTVIEW.couponPrices[i].rate - coupon) < 1e-9) { row = EASTVIEW.couponPrices[i]; break; }
  }
  if (!row) return { price: null, blocked: 'coupon not on the sheet', parts: [] };
  var base = rateType === '5/1 ARM' ? row.arm51 : rateType === '7/1 ARM' ? row.arm71 : row.fixed30;
  var parts = [{ label: 'Base price @ ' + coupon.toFixed(3) + '% (' + rateType + ')', value: base }];
  var total = base;
  var blocked = '';
  var add = function (label, key) {
    var v = adjAt(EASTVIEW.adj[key], bandIdx);
    if (v === null) { blocked = blocked || label; return; }
    if (v === 0) { parts.push({ label: label, value: 0 }); return; }
    parts.push({ label: label, value: v });
    total += v;
  };
  // FICO x LTV
  var ficoAdj = adjAt(EASTVIEW.ficoLlpa[ctx.bucket], bandIdx);
  if (ficoAdj === null) blocked = blocked || (FICO_LABELS[ctx.bucket] || 'FICO') + ' at this LTV';
  else { parts.push({ label: (FICO_LABELS[ctx.bucket] || 'FICO') + ' @ ' + ctx.bandLabel, value: ficoAdj }); total += ficoAdj; }

  if (ctx.dscr != null) {
    if (ctx.dscr > 0.8 && ctx.dscr < 1) add('DSCR 0.80–1.00', 'dscr80');
    else if (ctx.dscr >= 1 && ctx.dscr < 1.1) add('DSCR 1.00–1.10', 'dscr100');
    else if (ctx.dscr >= 1.15) add('DSCR 1.15+', 'dscr115');
  }
  if (ctx.loan > 0 && ctx.loan <= 150000) add('UPB ≤ $150,000', 'upbSmall');
  if (ctx.loan > 2000000) add('UPB over $2,000,000', 'upbLarge');
  if (p.purpose === 'refi_co') add('Cash-out refinance', 'cashOut');
  if (p.nonWarrantableCondo) add('Non-warrantable condo', 'nonWarrantable');
  if (p.propType === 'condo') add('Condo', 'condo');
  if (is24(p.propType)) add('2-4 unit', 'unit24');
  if (is59(p.propType)) add('5-9 unit', 'unit59');
  if (p.interestOnly) add('Interest only (10 years)', 'io');
  if (num(p.portfolioCount) > 1) add('Cross-collateralized portfolio', 'crossColl');
  var ppKey = p.prepay || 'pp5';
  add('Prepay: ' + (EASTVIEW.prepayLabels[ppKey] || ppKey), ppKey);

  if (blocked) return { price: null, blocked: blocked, parts: parts };
  var cap = EASTVIEW.maxPriceByPrepay[ppKey];
  var capped = cap != null && total > cap;
  return { price: capped ? cap : total, uncapped: total, capped: capped, cap: cap, parts: parts, base: base };
}

/**
 * The whole quote: sizing, DSCR, the coupon ladder and the guideline checks.
 * Inputs are raw-ish (strings fine). Percentages are whole numbers (80 = 80%).
 */
function priceEastview(raw) {
  var p = raw || {};
  var value = num(p.value);
  var purpose = p.purpose || 'purchase';
  var propType = p.propType || 'sfr';
  var units = unitsOf(propType);
  var sizing = sizeLoan({
    fico: p.fico, purpose: purpose, value: value, purchasePrice: p.purchasePrice,
    closingCostPct: p.closingCostPct, leased: p.leased, recentRenovation: p.recentRenovation,
    nonWarrantableCondo: p.nonWarrantableCondo, lowPerfMarket: p.lowPerfMarket, propType: propType,
  });
  var loan = num(p.loanAmt) || sizing.maxLoan || 0;
  var ltv = value > 0 ? loan / value : 0;
  var ltc = sizing.costBasis > 0 ? loan / sizing.costBasis : null;
  var bandIdx = ltvBandIndex(ltv);
  var bucket = ficoBucket(p.fico);

  var expenses = num(p.taxes) + num(p.insurance) + num(p.flood) + num(p.hoa) + num(p.opex);
  var rent = num(p.rent);
  var coupon = num(p.rate);
  var pi = calcPI(loan, coupon, !!p.interestOnly);
  var pitia = expenses + pi;
  var dscr = pitia > 0 && rent > 0 ? roundTo(rent / pitia, 2) : null;

  var ctx = {
    bucket: bucket, bandIdx: bandIdx, bandLabel: bandIdx >= 0 ? ('≤' + Math.round(EASTVIEW.ltvBands[bandIdx] * 100) + '% LTV') : 'over 80% LTV',
    dscr: dscr, loan: loan,
  };
  var ladder = [];
  for (var i = 0; i < EASTVIEW.couponPrices.length; i++) {
    var c = EASTVIEW.couponPrices[i].rate;
    var q = priceAtCoupon(p, c, ctx);
    var piC = calcPI(loan, c, !!p.interestOnly);
    var pitiaC = expenses + piC;
    ladder.push({
      rate: c, price: q.price, capped: !!q.capped, blocked: q.blocked || '',
      premiumPct: q.price == null ? null : (q.price - 1) * 100,
      premiumDollars: q.price == null ? null : (q.price - 1) * loan,
      belowMin: q.price != null && q.price < EASTVIEW.minPrice,
      pi: piC, pitia: pitiaC, dscr: pitiaC > 0 && rent > 0 ? roundTo(rent / pitiaC, 2) : null,
      parts: q.parts,
    });
  }
  var selected = null;
  for (var j = 0; j < ladder.length; j++) if (Math.abs(ladder[j].rate - coupon) < 1e-9) selected = ladder[j];

  // ── Guideline checks (Pricing!B52:E67 + Sizer!P30:R38) ──
  var checks = [];
  var fail = function (label, ok, detail) { checks.push({ label: label, pass: !!ok, detail: detail || '' }); };
  var ficoN = num(p.fico);
  var isFN = bucket === 'fn';
  fail('Minimum FICO 660', isFN || ficoN >= 660, isFN ? 'Foreign national' : ('Qualifying score ' + (ficoN || '—')));
  fail('DSCR at or above 0.80', dscr == null || dscr > 0.8, dscr == null ? 'No rent entered' : ('DSCR ' + dscr.toFixed(2)));
  fail('DSCR not between 0.80 and 1.00', dscr == null || !(dscr > 0.8 && dscr < 1), dscr == null ? '' : ('DSCR ' + dscr.toFixed(2)));
  fail('Loan at or above $75,000', loan >= EASTVIEW.hardMinLoan, '');
  fail('Loan at or below $3,000,000', loan <= EASTVIEW.maxLoan, '');
  fail('Loan over $2M needs LTV at or below 75%', !(loan > 2000000 && ltv > 0.75), '');
  fail('5-9 units need LTV at or below 75%', !(is59(propType) && ltv > 0.75), '');
  fail('Portfolio over $1.5M needs LTV at or below 65%', !(num(p.portfolioCount) > 1 && loan > 1500000 && ltv > 0.65), '');
  fail('Cash out + interest only needs LTV at or below 75%', !(purpose === 'refi_co' && p.interestOnly && ltv > 0.75), '');
  fail('Cash out on non-SFR needs LTV at or below 75%', !(purpose === 'refi_co' && propType !== 'sfr' && ltv > 0.75), '');
  fail('Cash out with DSCR under 1.15 needs LTV at or below 75%', !(purpose === 'refi_co' && dscr != null && dscr < 1.15 && ltv > 0.75), '');
  fail('Portfolio + interest only needs LTV at or below 75%', !(num(p.portfolioCount) > 1 && p.interestOnly && ltv > 0.75), '');
  fail('Portfolio with DSCR under 1.15 needs LTV at or below 65%', !(num(p.portfolioCount) > 1 && dscr != null && dscr < 1.15 && ltv > 0.75), '');
  fail('Portfolio cannot hold 5-9 unit properties', !(num(p.portfolioCount) > 1 && is59(propType)), '');
  fail('Within max leverage', sizing.maxLoan == null || loan <= sizing.maxLoan,
    sizing.maxLoan == null ? 'No leverage grid for this FICO and purpose' : ('Max ' + Math.round(sizing.maxLoan).toLocaleString()));
  fail('Exit price at or above ' + (EASTVIEW.minPrice * 100).toFixed(2), !selected || selected.price == null || selected.price >= EASTVIEW.minPrice,
    selected && selected.price != null ? (selected.price * 100).toFixed(3) : '');

  var stateLimit = p.state ? EASTVIEW.statePrepayLimits[String(p.state).toUpperCase()] : null;

  return {
    sizing: sizing, loan: loan, ltv: ltv, ltc: ltc, units: units,
    bucket: bucket, bucketLabel: FICO_LABELS[bucket] || '', bandLabel: ctx.bandLabel,
    rent: rent, expenses: expenses, pi: pi, pitia: pitia, dscr: dscr,
    ladder: ladder, selected: selected,
    checks: checks, eligible: checks.every(function (c) { return c.pass; }),
    statePrepayLimit: stateLimit || '',
    // Sizer!P89:V92 -- 6 payments of reserves when the DSCR clears 1.00, 9 when
    // it does not, plus the down payment + closing costs on a purchase. (The
    // workbook's own V90 multiplies by 6 either way; that is a formula bug on
    // their side, so we hold the requirement its own label states.)
    liquidity: (function () {
      var months = dscr != null && dscr > 1 ? 6 : 9;
      var down = purpose === 'purchase' ? Math.max(0, (sizing.costBasis || 0) - loan) : 0;
      return { paymentsRequired: months, paymentReserve: pitia * months, downPayment: down, total: pitia * months + down };
    })(),
    labels: { propType: PROP_LABELS[propType] || propType, purpose: PURPOSE_LABELS[purpose] || purpose },
  };
}

var _API = {
  EASTVIEW: EASTVIEW, FICO_LABELS: FICO_LABELS, PROP_LABELS: PROP_LABELS, PURPOSE_LABELS: PURPOSE_LABELS,
  ficoBucket: ficoBucket, ltvBandIndex: ltvBandIndex, calcPI: calcPI, unitsOf: unitsOf,
  sizeLoan: sizeLoan, priceAtCoupon: priceAtCoupon, priceEastview: priceEastview,
};
if (typeof window !== 'undefined') window.SLA_EV = _API;
if (typeof module !== 'undefined' && module.exports) module.exports = _API;
})();
