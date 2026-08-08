/**
 * rtl-pricing.js — RTL (Bridge / Fix-Flip / Construction) pricing
 * engine, extracted from rtl-sizer.html. Hardening Phase G1 (Deploy
 * 236.408). Colchis wholesale matrix + SLA spreads/floors.
 *
 * Same contract as dscr-pricing.js: the sizer <script src>'s this
 * file, aliases the tables back into page scope, and calls
 * SLA_RTL.priceRTL(inputs) from calculate(); the render half is
 * untouched. scripts/pricing-test.mjs replays 37 golden scenarios
 * captured from the ORIGINAL inline code — outputs must be identical.
 *
 * TO UPDATE RATES: edit the tables below, run
 *   node scripts/pricing-test.mjs   (only intended diffs may appear)
 * then re-baseline via scripts/rtl-golden-capture.mjs --from-module.
 *
 * priceRTL(I) inputs (gathered by the sizer from the DOM + geo
 * detection): lt, fr, exp, pt, pp, arv, rb, term, purp, zhvi, sa,
 * state, geoWarning, geoReductionLabel, targetLoanAmt, dutchInterest.
 * Returns every value the sizer's render half consumes (rate, bMax,
 * bLabel, leverage caps, adjs, flags, payments, points, errors).
 *
 * IIFE-wrapped: only SLA_RTL escapes (see dscr-pricing.js 236.407 for
 * why — top-level const/var in classic scripts collide page-wide).
 */
(function () {
// ── Pricing data — Colchis RTL Pricing Sheet (Jun 29, 2026) ──
// Deploy 236.122 — refresh wholesale matrix per new Colchis sheet.
// Net rate movement vs Jun 09 sheet: +0.250% across the board on Bridge
// (8.375 → 8.625, 8.500 → 8.750) and Light Rehab top cells (8.500 → 8.750).
// Heavy Rehab and Construction also bumped +0.250% at the top end. Some
// Heavy/Construction 90% / 95% cells reopened or shifted. Pricing
// adjustments (NY/NJ/CT, CA, ZHVI, cash-out, term, $2M/$3M tiers, tier
// 1/3 experience) unchanged from prior sheet. Per-product Minimum Rate
// floors bumped — see the progMin branch in calculate() (~line 2030).
// PRICING values are Colchis's WHOLESALE base rate. Final borrower note
// rate = PRICING + SPREAD[fico] + adjustments. Tier 1 (8+) gets -0.25%
// reduction, Tier 2 baseline, Tier 3 +0.25%. MFR adjustment is per-LTV.
// Sub-680 borrowers don't qualify under Colchis — they get a hardcoded
// final rate from SUB680_RATE (SLA funds these through a separate channel).
//
// IMPORTANT: SLA's policy floor of 10.000% (line ~910) usually wins over
// Colchis program minimums for normal-leverage deals. The Colchis minimums
// only matter when wholesale + spread + adjustments would otherwise undercut
// them (rare, mostly seen on high-LTV heavy/construction deals).
var FLOOR = 0.08625; // Bridge program minimum 8.625% (Jun 29, 2026)
// Deploy 236.48 — single source of truth for FICO / LTV / pricing-
// eligibility error suffix. Mirror of EXCEPTION_HINT in DSCR sizer.
var EXCEPTION_HINT = ' Reach out to a manager to submit an exception request.';
var LABELS = { bridge:'Bridge', light:'Light Rehab', heavy:'Heavy Rehab', construction:'Construction' };
var SPREAD = { 740:.0175, 720:.02, 700:.0225, 680:.025 };
// LTV columns: <=70, <=75, <=80, <=85, <=90, <=95
var LTV_COLS = [.70, .75, .80, .85, .90, .95];

// Sub-680 hardcoded final rates (SLA-funded, bypass Colchis matrix + spread).
// Note: 660-679 corresponds to what was previously the "650-679" bucket —
// same rate, just renamed to honestly reflect the lower bound. The
// 640-659 bucket sits at 12.5%, midpoint between the 660 (.12) and
// 620 (.13) buckets to reflect its in-between risk profile.
var SUB680_RATE = { 660: .12, 640: .125, 620: .13, 550: .14 };

// Deploy 236.122 — Jun 29, 2026 Colchis sheet. Buckets in the code
// (740/720/700/680) map to sheet bands as: 740 → "740+", 720+700
// → "700-739", 680 → "680-699". The 660-679 row stays blank on the
// sheet, so sub-680 routes through SUB680_RATE below.
var PRICING = {
  bridge: {
    sfr: {
      740: [.08625, .08625, null,   null,   null,   null  ],
      720: [.08625, .08625, null,   null,   null,   null  ],
      700: [.08625, .08625, null,   null,   null,   null  ],
      680: [.0875,  null,   null,   null,   null,   null  ],
    },
    mfr: {
      740: [.08625, .08625, null,   null,   null,   null  ],
      720: [.08625, .08625, null,   null,   null,   null  ],
      700: [.08625, .08625, null,   null,   null,   null  ],
      680: [.0875,  null,   null,   null,   null,   null  ],
    },
  },
  light: {
    sfr: {
      740: [.0875,  .0875,  .0875,  .0875,  .08875, .0925 ],
      720: [.0875,  .0875,  .0875,  .08875, .09,    .09375],
      700: [.0875,  .0875,  .0875,  .08875, .09,    .09375],
      680: [.0875,  .08875, .09,    .09125, .0925,  null  ],
    },
    mfr: {
      740: [.0875,  .0875,  .0875,  .0875,  .08875, .0925 ],
      720: [.0875,  .0875,  .0875,  .08875, .09,    .09375],
      700: [.0875,  .0875,  .0875,  .08875, .09,    .09375],
      680: [.0875,  .08875, .09,    .09125, .0925,  null  ],
    },
  },
  heavy: {
    sfr: {
      740: [.09375, .09375, .095,   .09625, null,   null  ],
      720: [.09375, .095,   .09625, .0975,  null,   null  ],
      700: [.09375, .095,   .09625, .0975,  null,   null  ],
      680: [.09625, .0975,  .09875, .1,     null,   null  ],
    },
    mfr: {
      740: [null, null, null, null, null, null],
      720: [null, null, null, null, null, null],
      700: [null, null, null, null, null, null],
      680: [null, null, null, null, null, null],
    },
  },
  construction: {
    sfr: {
      740: [.09125, .0925,  .09375, .095,   .09875, null  ],
      720: [.0925,  .09375, .095,   .09625, .1,     null  ],
      700: [.0925,  .09375, .095,   .09625, .1,     null  ],
      680: [.095,   .09625, .0975,  .09875, null,   null  ],
    },
    mfr: {
      740: [null, null, null, null, null, null],
      720: [null, null, null, null, null, null],
      700: [null, null, null, null, null, null],
      680: [null, null, null, null, null, null],
    },
  },
};

// MFR per-LTV-column adjustments (added to base when property is multi-family).
// Bridge: +0.500% at <=70%. Light: +0.500% at <=70/75/80/85.
var MFR_ADJ = {
  bridge: [.005,  0,     0,     0,     0,     0    ],
  light:  [.005,  .005,  .005,  .005,  0,     0    ],
  heavy:  [0,     0,     0,     0,     0,     0    ],
  construction: [0,0,    0,     0,     0,     0    ],
};

// Leverage tables sourced from Colchis RTL Purchase Guidelines (Jan 2026).
// 680+ rows match the published doc exactly. Sub-680 rows are SLA-funded
// pricing (off Colchis's balance sheet) — see SUB680_RATE; the LTV caps
// shown there are SLA's internal numbers, not from the Colchis doc.
// Each cell is [8+ exp, 4-7 exp, 0-3 exp]. (Construction uses 6+/4-5/0-3
// per the doc but is mapped to the same indices.)
var MAX_LTP = {
  bridge:{
    sfr:{
      740:[.75,.75,.75], 720:[.75,.75,.70], 700:[.75,.75,.70], 680:[.70,.70,.65],
      660:[.65,.65,.65], 640:[.60,.60,.60], 620:[.60,.60,.60], 550:[.55,.55,.55],
    },
    mfr:{
      740:[.70,.70,.65], 720:[.70,.70,.60], 700:[.70,.65,.60], 680:[.65,.60,0],
      660:[.60,.60,.60], 640:[.55,.55,.55], 620:[.55,.55,.55], 550:[.50,.50,.50],
    },
  },
  light:{
    sfr:{
      // Deploy 236.57 — Jun 09 sheet merged the 720-739 + 700-719 buckets
      // into one "700-739" row; bumped 700 to match 720's 0-3 (.875)
      // and loosened the 680 0-3 column from .80 to .85.
      740:[.90,.90,.90], 720:[.90,.90,.875], 700:[.90,.90,.875], 680:[.875,.85,.85],
      660:[.80,.80,.80], 640:[.75,.75,.75], 620:[.75,.75,.75], 550:[.70,.70,.70],
    },
    mfr:{
      // 0-3 experience column is empty in the Colchis doc for MFR Light
      // at all FICO bands — not funded. Tier-3 cells are 0 here.
      // Deploy 236.57 — bumped 700 4-7 from .75 to .80 (matches the new
      // merged "700-739" cell).
      740:[.80,.80,0], 720:[.80,.80,0], 700:[.80,.80,0], 680:[.75,.75,0],
      660:[.70,.70,0], 640:[.65,.65,0], 620:[.65,.65,0], 550:[.60,.60,0],
    },
  },
  heavy:{
    sfr:{
      740:[.80,.80,0], 720:[.80,.80,0], 700:[.80,.80,0], 680:[.75,.75,0],
      660:[.70,.70,0], 640:[.65,.65,0], 620:[.65,.65,0], 550:[.60,.60,0],
    },
    mfr:{ 740:[0,0,0], 720:[0,0,0], 700:[0,0,0], 680:[0,0,0], 660:[0,0,0], 640:[0,0,0], 620:[0,0,0], 550:[0,0,0] },
  },
  construction:{
    sfr:{
      740:[.60,.60,0], 720:[.60,.60,0], 700:[.60,.60,0], 680:[.60,.60,0],
      660:[.55,.55,0], 640:[.50,.50,0], 620:[.50,.50,0], 550:[.45,.45,0],
    },
    mfr:{ 740:[0,0,0], 720:[0,0,0], 700:[0,0,0], 680:[0,0,0], 660:[0,0,0], 640:[0,0,0], 620:[0,0,0], 550:[0,0,0] },
  },
};
var MAX_LTC = {
  light:{
    sfr:{
      // Deploy 236.57 — Jun 09 sheet merged 720-739 + 700-719 into
      // "700-739"; bumped 700 to [.925, .925, .90] to match 720, and
      // loosened 680 0-3 column from .80 to .85.
      740:[.925,.925,.90], 720:[.925,.925,.90], 700:[.925,.925,.90], 680:[.90,.875,.85],
      660:[.85,.85,.80], 640:[.80,.80,.75], 620:[.80,.80,.75], 550:[.75,.75,.70],
    },
    mfr:{
      // 0-3 column not funded per Colchis doc for MFR Light — kept at 0
      // so the leverage calc returns "not eligible" rather than computing
      // off a stale value while LTP says ineligible.
      740:[.85,.85,0], 720:[.85,.80,0], 700:[.85,.80,0], 680:[.80,.80,0],
      660:[.75,.75,0], 640:[.70,.70,0], 620:[.70,.70,0], 550:[.65,.65,0],
    },
  },
  heavy:{
    sfr:{
      // Deploy 236.57 — Jun 09 sheet bumped 700-739 4-7 column LTC from
      // .825 to .85 (now matches the 720 row that was already at .85).
      740:[.85,.85,0], 720:[.85,.85,0], 700:[.85,.85,0], 680:[.825,.80,0],
      660:[.80,.75,0], 640:[.75,.70,0], 620:[.75,.70,0], 550:[.70,.65,0],
    },
    mfr:{ 740:[0,0,0], 720:[0,0,0], 700:[0,0,0], 680:[0,0,0], 660:[0,0,0], 640:[0,0,0], 620:[0,0,0], 550:[0,0,0] },
  },
  construction:{
    sfr:{
      740:[.90,.85,0], 720:[.90,.85,0], 700:[.90,.85,0], 680:[.85,.825,0],
      660:[.80,.775,0], 640:[.75,.725,0], 620:[.75,.725,0], 550:[.70,.675,0],
    },
    mfr:{ 740:[0,0,0], 720:[0,0,0], 700:[0,0,0], 680:[0,0,0], 660:[0,0,0], 640:[0,0,0], 620:[0,0,0], 550:[0,0,0] },
  },
};
var MAX_LTARV = {
  light:{
    sfr:{
      // Deploy 236.57 — Jun 09 sheet bumped 700 0-3 column to .75 (matches
      // merged "700-739" cell), and loosened 680 4-7 column from .70 to .75.
      740:[.75,.75,.75], 720:[.75,.75,.75], 700:[.75,.75,.75], 680:[.75,.75,.70],
      660:[.70,.70,.65], 640:[.65,.65,.60], 620:[.65,.65,.60], 550:[.60,.60,.55],
    },
    mfr:{
      740:[.65,.65,0], 720:[.65,.65,0], 700:[.65,.65,0], 680:[.60,.60,0],
      660:[.55,.55,0], 640:[.50,.50,0], 620:[.50,.50,0], 550:[.45,.45,0],
    },
  },
  heavy:{
    sfr:{
      740:[.70,.70,0], 720:[.70,.70,0], 700:[.70,.70,0], 680:[.65,.65,0],
      660:[.60,.60,0], 640:[.55,.55,0], 620:[.55,.55,0], 550:[.50,.50,0],
    },
    mfr:{ 740:[0,0,0], 720:[0,0,0], 700:[0,0,0], 680:[0,0,0], 660:[0,0,0], 640:[0,0,0], 620:[0,0,0], 550:[0,0,0] },
  },
  construction:{
    sfr:{
      740:[.70,.70,0], 720:[.70,.70,0], 700:[.70,.70,0], 680:[.70,.65,0],
      660:[.65,.60,0], 640:[.60,.55,0], 620:[.60,.55,0], 550:[.55,.50,0],
    },
    mfr:{ 740:[0,0,0], 720:[0,0,0], 700:[0,0,0], 680:[0,0,0], 660:[0,0,0], 640:[0,0,0], 620:[0,0,0], 550:[0,0,0] },
  },
};

// ── REFINANCE LTV TABLES (per Colchis RTL Purchase Guidelines, Jan 2026) ──
// The Colchis doc publishes ONLY LTV for refis — no LTC/LTARV grids, since
// vanilla refis don't have a rehab budget. So on a refi, the binding cap is
// simply LTV vs. as-is property value (no LTC/LTARV layered on top).
//
// The 660-679 FICO row is empty in the source doc for all refi tables —
// reflected here as 0 — which the rest of the code already treats as
// "not eligible." Refi minimum is 680 FICO per Colchis.
//
// Format mirrors MAX_LTP: REFI_LTV[purpose][propType][ficoKey] = [tier1, tier2, tier3]
var REFI_LTV = {
  rateterm: {
    sfr: {
      740: [.75, .75, .75],
      720: [.75, .75, .70],
      700: [.75, .75, .70],
      680: [.70, .70, .65],
      660: [0,   0,   0  ],
      640: [0,   0,   0  ],
      620: [0,   0,   0  ],
      550: [0,   0,   0  ],
    },
    mfr: {
      // Deploy 236.57 — Jun 09 sheet merged 720-739 + 700-719 into one
      // "700-739" row; bumped 700 4-7 from .65 to .70 (matches 720 row).
      740: [.70, .70, .65],
      720: [.70, .70, .60],
      700: [.70, .70, .60],
      680: [.65, .60, 0  ],
      660: [0,   0,   0  ],
      640: [0,   0,   0  ],
      620: [0,   0,   0  ],
      550: [0,   0,   0  ],
    },
  },
  cashout: {
    sfr: {
      740: [.70, .70, .70],
      720: [.70, .70, .65],
      700: [.70, .70, .65],
      680: [.65, .65, .60],
      660: [0,   0,   0  ],
      640: [0,   0,   0  ],
      620: [0,   0,   0  ],
      550: [0,   0,   0  ],
    },
    mfr: {
      // Deploy 236.57 — Jun 09 sheet bumped 700 8+ from .60 to .65 and
      // 4-7 from .55 to .60 (now matches the merged "700-739" cells).
      740: [.65, .60, .60],
      720: [.65, .60, .55],
      700: [.65, .60, .55],
      680: [.55, .55, 0  ],
      660: [0,   0,   0  ],
      640: [0,   0,   0  ],
      620: [0,   0,   0  ],
      550: [0,   0,   0  ],
    },
  },
};

// Map a numeric FICO (e.g. 740, 660, 640, 620) to the bucket key used in
// the pricing tables. Buckets: 740+, 720-739, 700-719, 680-699, 660-679,
// 640-659, 620-639, 550-619. (Previously: ... 650-679, 620-649, 550-619.)
function fk(f){ if(f>=740)return 740; if(f>=720)return 720; if(f>=700)return 700; if(f>=680)return 680; if(f>=660)return 660; if(f>=640)return 640; if(f>=620)return 620; return 550; }
function ei(e){ if(e>=8)return 0; if(e>=4)return 1; return 2; }
// Item: 3 points for sub-620 (550-619 band); 1.5 for 720+; 2.0 for 640-719
function pts(f){ if(f>=720)return 1.5; if(f>=620)return 2.0; return 3.0; }
function colchisRate(lt,pt,fk,ltv){
  var g=PRICING[lt]&&PRICING[lt][pt]&&PRICING[lt][pt][fk]; if(!g)return null;
  var b=null, idx=-1;
  // First pass: find the largest LTV column <= actual LTV. This is the
  // standard lookup — rates are bucketed at .70/.75/.80/.85/.90/.95 LTV.
  for(var i=0;i<LTV_COLS.length;i++){
    if(LTV_COLS[i]<=ltv+.005&&g[i]!==null){ b=g[i]; idx=i; }
  }
  // Fallback: when the actual LTV is below every defined column (most
  // common case: Bridge refis where Colchis caps LTV at 60–65% for some
  // FICO/experience combos, but the PRICING matrix starts at the .70
  // column). Rates only go UP with LTV, so applying the lowest defined
  // column's rate is conservative-correct (the borrower's actual lower
  // leverage means same-or-better risk; rate floors out at program min
  // anyway). Without this fallback, Bridge refis with low LTV caps
  // returned null and the result block showed "no pricing available."
  if (b === null) {
    for (var j = 0; j < LTV_COLS.length; j++) {
      if (g[j] !== null) { b = g[j]; idx = j; break; }
    }
  }
  return b===null?null:{rate:b, ltvIdx:idx};
}

// ── priceRTL: the pure pricing core ────────────────────────────────
// Body between the input mapping and the return is the sizer's
// calculate() segment VERBATIM (fkey/eidx through `var mo = moMax;`),
// golden-locked. The only transform: the two DOM reads take their
// values from I, and the geo globals become inputs.
function priceRTL(I) {
  I = I || {};
  var lt = I.lt, fr = I.fr, exp = I.exp, pt = I.pt, pp = I.pp, arv = I.arv,
      rb = I.rb, term = I.term, purp = I.purp, zhvi = I.zhvi, sa = I.sa,
      state = I.state;
  var isR = lt !== 'bridge';
  // Deploy 236.526 — Admin Sandbox. Set ONLY by the sizer's Admin Mode
  // (admin-gated). Defaults off, so all golden scenarios / normal pricing are
  // unaffected. When on, a Target Loan Amount above the guideline max is
  // honored instead of floored to the cap.
  var adminSandbox = I.adminSandbox === true;
  var geoWarning = I.geoWarning || '';
  var geoReductionLabel = I.geoReductionLabel || '';
  var fkey=fk(fr); var eidx=ei(exp);
  var adjs=[]; var flags=[];
  if(geoWarning) flags.push(geoWarning);
  var rErr = null;

  // ── LEVERAGE CALC ──────────────────────────────────────────
  // Two paths now:
  //   Purchase  → MAX_LTP / MAX_LTC / MAX_LTARV (existing path)
  //   Refi      → REFI_LTV only. No LTC/LTARV on refis per Colchis doc.
  //               LTC/LTARV cards in the UI are struck through downstream.
  var isRefi = (purp === 'cashout' || purp === 'rateterm');

  // Refi minimum credit: 680 per Colchis doc (660-679 row is empty in all
  // refi tables). The sub-680 SLA-funded pricing (12/13/14%) is for
  // Purchases only — refis at sub-680 are blocked entirely.
  // Deploy 236.48 — standardized exception-request wording. See EXCEPTION_HINT
  // at the top of this file (mirror of DSCR sizer).
  if (isRefi && fr < 680) {
    // Display label kept around for future use — current rErr message uses
    // the raw FICO number, not this label. Updated to reflect new buckets.
    var ficoLabel = (fr<620?'<620':fr<640?'620-639':fr<660?'640-659':fr<680?'660-679':String(fr)+'+');
    rErr = 'Refinance not supported (' + fr + ' FICO). Minimum 680 FICO required for any RTL refinance.' + EXCEPTION_HINT;
    // Bypass all leverage / rate math — render only the error
  }

  var ltpT, ltcT, larvT, mLtp, mLtc, mLarv;
  var refiLtv = null;  // only set on refi path

  if (isRefi && !rErr) {
    // Refi path: single LTV from REFI_LTV[purpose][propType][fico]
    var refiTbl = REFI_LTV[purp] && REFI_LTV[purp][pt] && REFI_LTV[purp][pt][fkey];
    refiLtv = refiTbl ? refiTbl[eidx] : 0;
    // ZHVI override applies to LTV per the doc
    if (zhvi === '200') {
      refiLtv = Math.max(0, refiLtv - .05);
      flags.push('ZHVI override: 200–300% of ZIP median — LTV reduced 5%.');
    } else if (zhvi === '300') {
      refiLtv = Math.max(0, refiLtv - .10);
      flags.push('ZHVI override: >300% of ZIP median — LTV reduced 10%.');
    }
    // Deploy 236.58 — guideline geographic -5% LTV reduction (Lee County
    // FL, Baltimore MD, Indianapolis IN). Detected upstream in
    // updateRegion(); applied here on the refi path.
    if (geoReductionLabel) {
      refiLtv = Math.max(0, refiLtv - .05);
      flags.push(geoReductionLabel);
    }
    mLtp = refiLtv;
    mLtc = 0;   // not applicable on refis
    mLarv = 0;  // not applicable on refis
  } else {
    // Purchase path: original behavior
    ltpT  = MAX_LTP[lt]   && MAX_LTP[lt][pt]   && MAX_LTP[lt][pt][fkey];
    ltcT  = isR ? (MAX_LTC[lt]   && MAX_LTC[lt][pt]   && MAX_LTC[lt][pt][fkey])  : null;
    larvT = isR ? (MAX_LTARV[lt] && MAX_LTARV[lt][pt] && MAX_LTARV[lt][pt][fkey]) : null;

    mLtp  = ltpT  ? ltpT[eidx]  : 0;
    mLtc  = ltcT  ? ltcT[eidx]  : 0;
    mLarv = larvT ? larvT[eidx] : 0;

    // Deploy 236.58 — Construction 90% LTC requires rehab budget under
    // $500,000 per June 2026 Colchis guidelines (footnote on Construction
    // LTC column). Otherwise capped at 85%. Applied BEFORE the ZHVI /
    // geographic reductions so the cap is on the BASE rate, not on an
    // already-reduced number.
    if (lt === 'construction' && mLtc >= 0.899 && rb >= 500000) {
      mLtc = 0.85;
      flags.push('Construction 90% LTC requires rehab budget under $500,000 — capped at 85%.');
    }

    if (zhvi === '200') {
      mLtp = Math.max(0, mLtp - .05);
      mLtc = Math.max(0, mLtc - .05);
      mLarv = Math.max(0, mLarv - .05);
      flags.push('ZHVI override: 200–300% of ZIP median — leverage reduced 5%.');
    } else if (zhvi === '300') {
      mLtp = Math.max(0, mLtp - .10);
      mLtc = Math.max(0, mLtc - .10);
      mLarv = Math.max(0, mLarv - .10);
      flags.push('ZHVI override: >300% of ZIP median — leverage reduced 10%.');
    }
    // Deploy 236.58 — guideline geographic -5% reduction on the purchase
    // path. Stacks on top of ZHVI when both apply (rare). Math.max guards
    // against the cap going negative.
    if (geoReductionLabel) {
      mLtp  = Math.max(0, mLtp  - .05);
      mLtc  = Math.max(0, mLtc  - .05);
      mLarv = Math.max(0, mLarv - .05);
      flags.push(geoReductionLabel);
    }
  }

  // On refis, bMax is just pp × LTV. No rehab budget added, no LTC/LTARV
  // layered. ("pp" = property as-is value on refis; the input field is
  // labeled Purchase Price but reused for refi as-is value.)
  var defMax, mByLtc, mByLarv;
  if (isRefi && !rErr) {
    defMax  = mLtp > 0 ? Math.round(pp * mLtp) : null;
    mByLtc  = null;
    mByLarv = null;
  } else if (!rErr) {
    defMax  = mLtp > 0 ? (isR ? Math.round(pp * mLtp) + rb : Math.round(pp * mLtp)) : null;
    mByLtc  = ltcT && mLtc > 0 ? Math.round((pp + rb) * mLtc) : null;
    mByLarv = larvT && mLarv > 0 ? Math.round(arv * mLarv) : null;
  } else {
    defMax = mByLtc = mByLarv = null;
  }

  var bMax = defMax;
  var bLabel = isRefi ? 'LTV' : 'LTP/LTV';
  if (bMax && mByLtc && mByLtc < bMax)  { bMax = mByLtc;  bLabel = 'LTC'; }
  if (bMax && mByLarv && mByLarv < bMax){ bMax = mByLarv; bLabel = 'LTARV'; }
  if (bMax && bMax > 3500000)          { bMax = 3500000; bLabel = 'Program max $3.5M'; }

  // Deploy 236.350 — Target Loan Amount cap. When the LO fills the
  // optional Target Loan Amount / Target LTV inputs on the form, the
  // sizer prices at that dollar figure instead of the guideline max.
  // Only reduces — a target ABOVE the guideline max still floors to
  // the max (LOs can't override up past what Colchis allows). The
  // bLabel changes to "LO Target" so the constraint reason is visible
  // in the result card next to the number.
  // (G1 extraction: value arrives via I — same {value} shape the golden
  // capture's DOM stub used, so behavior is bit-identical.)
  var targetLoanEl = { value: (I.targetLoanAmt !== undefined ? String(I.targetLoanAmt) : '') };
  if (targetLoanEl) {
    var targetLoan = parseFloat(targetLoanEl.value);
    if (isFinite(targetLoan) && targetLoan > 0 && bMax) {
      if (targetLoan < bMax) {
        bMax = Math.round(targetLoan);
        bLabel = 'LO Target';
      } else if (adminSandbox && targetLoan > bMax) {
        // Deploy 236.526 — Admin Sandbox: honor a Target Loan Amount ABOVE the
        // guideline max (and above the $3.5M program cap applied just above).
        // Admins build rate sheets at any leverage; the normal path still
        // floors to the cap because the `targetLoan < bMax` branch owns it.
        bMax = Math.round(targetLoan);
        bLabel = 'Admin Override';
      }
    }
  }

  // Down-payment math is purchase-specific. On a refi, the equivalent
  // concept is "cash to/from borrower" which gets computed downstream
  // from the Current Loan Amount field, so we just leave dp null.
  var dp = null;
  if (!isRefi && bMax !== null && pp > 0) {
    var ltpPart = isR ? bMax - rb : bMax;
    dp = Math.max(0, pp - ltpPart);
  }

  var rate = null;
  var floor = false;
  var progLabel = (LABELS[lt] || lt) + ' · ' + state;

  // FICO-based rate selection. Refi path already errored above if sub-680.
  // Sub-680 buckets are SLA-funded with hardcoded final rates that bypass
  // the Colchis matrix entirely. Bucket boundaries match the dropdown:
  //   660-679 = .12    (renamed from old "650-679" bucket — same rate)
  //   640-659 = .125   (midpoint — between 660 (.12) and 620 (.13))
  //   620-639 = .13    (was "620-649" — same rate)
  //   550-619 = .14    (unchanged)
  if (rErr) {
    // already set — skip rate path
  } else if (fr < 550) {
    rErr = 'FICO below 550 is outside all program guidelines.' + EXCEPTION_HINT;
  } else if (fr < 620) { rate = .14; }
  else if (fr < 640) { rate = .13; }
  else if (fr < 660) { rate = .125; }
  else if (fr < 680) { rate = .12; }
  else {
    if(!bMax){ rErr='No eligible loan amount for this combination.' + EXCEPTION_HINT; }
    else {
      var ltpF=isR?Math.round(pp*mLtp):bMax;
      var ltvF=ltpF/pp;
      var sz=bMax>3000000?'3m':bMax>2000000?'2m':'normal';
      // Sub-680 borrowers: SLA-funded with hardcoded final rates that bypass
      // the entire matrix + spread + adjustments path.
      if (fkey === 660 || fkey === 640 || fkey === 620 || fkey === 550) {
        rate = SUB680_RATE[fkey];
        var bandLabel = fkey === 660 ? '660-679'
                      : fkey === 640 ? '640-659'
                      : fkey === 620 ? '620-639'
                      : '550-619';
        adjs.push({l:'SLA Sub-680 program ('+bandLabel+')',v:rate,c:'pos'});
      } else {
        var cbResult = colchisRate(lt,pt,fkey,ltvF);
        if(!cbResult){ rErr='No pricing available for this FICO/LTV combination.' + EXCEPTION_HINT; }
        else {
          var cb = cbResult.rate;
          var ltvIdx = cbResult.ltvIdx;
          // Compute the TIER-1 baseline (most experienced borrower) first, then
          // apply floor, then Tier 2/3 adjustments stack on top. This keeps the
          // tier separation visible even when the floor activates on top-credit
          // deals: Tier 1 = floor, Tier 2 = floor + 0.25%, Tier 3 = floor + 0.50%.
          var adj=0;
          // MFR adjustment is per-LTV-column from the PDF
          if(pt==='mfr' && MFR_ADJ[lt] && ltvIdx >= 0) {
            var mfrA = MFR_ADJ[lt][ltvIdx] || 0;
            if(mfrA > 0) { adj += mfrA; adjs.push({l:'Multi-family property',v:mfrA,c:'pos'}); }
          }
          if(sa==='nynj'){ adj+=.0025; adjs.push({l:'NY/NJ/CT region',v:.0025,c:'pos'}); }
          else if(sa==='ca'){ adj-=.00125; adjs.push({l:'California',v:-.00125,c:'neg'}); }
          if(zhvi==='200'){ adj+=.0025; adjs.push({l:'Property value >200% ZHVI',v:.0025,c:'pos'}); }
          else if(zhvi==='300'){ adj+=.00375; adjs.push({l:'Property value >300% ZHVI',v:.00375,c:'pos'}); }
          if(purp==='cashout'){ adj+=.0025; adjs.push({l:'Cash-out refinance',v:.0025,c:'pos'}); }
          if(term===19){ adj+=.00125; adjs.push({l:'Loan term 19–24 months',v:.00125,c:'pos'}); }
          if(sz==='3m'){ adj+=.0025; adjs.push({l:'Loan amount >$3M',v:.0025,c:'pos'}); }
          // Tier-1 baseline = wholesale + adjustments + spread − 0.25% (Tier 1 reduction)
          var tier1Base = cb + adj + SPREAD[fkey] - .0025;
          // Apply program-minimum floors per the PDF (Jun 29, 2026 sheet).
          // Deploy 236.122 — bumped from Jun 09 values:
          //   Bridge:        8.375% -> 8.625%
          //   Light Rehab:   8.500% -> 8.750%
          //   Heavy Rehab:   9.125% -> 9.375%
          //   Construction:  8.875% -> 9.125%
          // In practice the SLA 10% policy floor below dominates for most
          // Tier-1 deals, but the program-min still binds at high-LTV
          // Tier-1 cells where the policy floor wouldn't otherwise apply.
          var progMin =
            (lt === 'bridge')       ? 0.08625  :
            (lt === 'light')        ? 0.0875   :
            (lt === 'heavy')        ? 0.09375  :
            (lt === 'construction') ? 0.09125  :
                                      0.08625;
          if(tier1Base < progMin){ tier1Base = progMin; floor = true; }
          // SLA policy floor: Tier 1 baseline never below 10.000%.
          // (Tier 2 will be at least 10.250%; Tier 3 at least 10.500%.)
          if (tier1Base < 0.10) { tier1Base = 0.10; floor = true; }
          // Now apply the experience tier — Tier 1 baseline is the minimum;
          // Tier 2 and Tier 3 each add 0.25% on top.
          if(exp>=8){
            rate = tier1Base;
            adjs.push({l:'Experience: Tier 1 (8+ projects)',v:-.0025,c:'neg'});
          } else if(exp>=4){
            rate = tier1Base + .0025;
          } else {
            rate = tier1Base + .005;
            adjs.push({l:'Experience: Tier 3 (0–3 projects)',v:.0025,c:'pos'});
          }
        }
      }
    }
  }

  var p=pts(fr);
  // Deploy 236.499 — RTL loan-size floors:
  //   • Below $100,000  → NOT eligible (hard stop).
  //   • $100k – $125k   → below the Colchis $125k minimum; SLA-fundable at
  //                       a floor of 12% / 2 points, requires manager approval.
  // Applied AFTER normal pricing so it overrides the computed rate/points.
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
  var pDol=bMax?bMax*p/100:null;
  // Deploy 196: Dutch vs Non-Dutch monthly payment math.
  //   Maximum monthly = interest on the full loan amount (max draw scenario).
  //   Starting monthly = interest on the initial advance:
  //     - Rehab purchases (light/heavy/construction): initial = bMax − rb.
  //       The rehab budget sits in escrow; the borrower only pays interest
  //       on what's actually been disbursed.
  //     - Bridge / Transactional / Refi: no escrow → initial = bMax.
  //   Dutch structure pays max from day one, so starting = max regardless.
  //   We always compute both so the rate-sheet PDF can show both rows.
  var dutchEl  = { value: (I.dutchInterest !== undefined ? String(I.dutchInterest) : '') }; // (G1: via I)
  var isDutch  = !!(dutchEl && dutchEl.value === 'dutch');
  var initAdv  = (isR && rb > 0 && bMax) ? Math.max(0, bMax - rb) : bMax;
  var moMax    = rate && bMax  ? (bMax   * rate / 12) : null;
  var moStart  = rate && initAdv != null
    ? (isDutch ? moMax : (initAdv * rate / 12))
    : null;
  // Legacy single-value `mo` kept for any downstream readers (rate-sheet
  // PDF DOM scrape, override flows). Equals max payment, which is the
  // worst-case the borrower will see — same value the old single-line
  // display showed.
  var mo = moMax;
  return {
    rErr: rErr, rate: rate, floor: floor, bMax: bMax, bLabel: bLabel,
    mLtp: mLtp, mLtc: mLtc, mLarv: mLarv, refiLtv: refiLtv,
    defMax: defMax, mByLtc: mByLtc, mByLarv: mByLarv, dp: dp,
    adjs: adjs, flags: flags, p: p, pDol: pDol,
    isDutch: isDutch, initAdv: initAdv, moMax: moMax, moStart: moStart,
    mo: mo, progLabel: progLabel, sandbox: adminSandbox,
  };
}

// ── Export root: browser global + CommonJS for the test runner ─────
var _SLA_RTL_API = {
  FLOOR: FLOOR, EXCEPTION_HINT: EXCEPTION_HINT, LABELS: LABELS,
  SPREAD: SPREAD, LTV_COLS: LTV_COLS, SUB680_RATE: SUB680_RATE,
  PRICING: PRICING, MFR_ADJ: MFR_ADJ, MAX_LTP: MAX_LTP, MAX_LTC: MAX_LTC,
  MAX_LTARV: MAX_LTARV, REFI_LTV: REFI_LTV,
  fk: fk, ei: ei, pts: pts, colchisRate: colchisRate,
  priceRTL: priceRTL,
};
if (typeof window !== 'undefined') window.SLA_RTL = _SLA_RTL_API;
if (typeof module !== 'undefined' && module.exports) module.exports = _SLA_RTL_API;
})();
