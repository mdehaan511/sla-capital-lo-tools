/**
 * mf-pricing.js — MULTIFAMILY 5+ (LoBal) DSCR pricing engine.
 * Deploy 236.748 — clone of dscr-pricing.js with the MF rate matrix.
 * NOTE: exposes window.SLA_DSCR (same global as dscr-pricing.js) so the
 * cloned sizer page needs zero pricing-reference changes — the two files
 * are NEVER loaded on the same page.
 *
 * (original header follows)
 * dscr-pricing.js — DSCR pricing engine, extracted from dscr-sizer.html.
 * Hardening Phase G1 (Deploy 236.406).
 *
 * WHY THIS FILE EXISTS: pricing math used to live inline in the sizer
 * where nothing could test it. Now the sizer <script src>'s this file
 * (no build step — same pattern as sla-api.js) and
 * scripts/pricing-test.mjs runs 42 golden scenarios against it on
 * demand. Every future rate-sheet update edits THIS file and reruns
 * the goldens: expected diffs only, everything else must hold.
 *
 * TO UPDATE RATES: edit DIYA below + effectiveDate, then run
 *   node scripts/pricing-test.mjs        (expect only intended diffs)
 *   node scripts/dscr-golden-capture.mjs --from-module   (re-baseline)
 *
 * Exposes (browser): window.SLA_DSCR = { DIYA, FEES, GUIDELINES,
 *   ltvCol, calcPI, validateGuidelines, getFICOMin, EXCEPTION_HINT,
 *   priceDSCR }
 * priceDSCR(raw) takes the RAW string field values (exactly what the
 * DOM inputs hold — parsing lives here so behavior is identical) and
 * returns the same result object calculate() always returned.
 *
 * The sizer aliases these back into page scope, so all existing
 * renderResult / PDF / save code is untouched.
 *
 * IIFE-wrapped (Deploy 236.407): top-level `const` in a classic
 * script binds page-wide and collided with the sizer's `var DIYA`
 * aliases ("Identifier 'DIYA' has already been declared"). Only
 * SLA_DSCR escapes this file; the page reaches everything through it.
 */
(function () {
const DIYA = {
  // Deploy 236.748 — MULTIFAMILY 5+ (LoBal) rate sheet effective 8-7-26
  // (rate-sheet-2026-08-07.xlsx). This file clones the DSCR engine
  // (dscr-pricing.js) with the MF matrix; the machinery below the tables is
  // kept in lock-step with dscr-pricing.js — port engine fixes to BOTH.
  //
  // Sheet facts (rates below refreshed by 236.823 — see effectiveDate):
  // base rates 30Y/10-6 6.525, 7/6 & 5/6 6.425; min rate 6.25;
  // FICO floor 700 (680-699 and below all NA); the 5+ Multi property
  // adjustment is +1.000 and NA above 75 LTV -> effective max LTV 75;
  // cash-out +0.05 (<=75); IO 0 (<=75); DSCR >= 1.20 REQUIRED (-0.050
  // adjustment; 1.00-1.19 is NA on this sheet); PPP: 5y6m -0.150,
  // 54321 -0.100, 321 +0.050 (5-Year 32111 listed but NA -> omitted).
  //
  // ASSUMPTIONS (flagged to Mike at build time — verify):
  //  - UPB rows: sheet lists <100k NA, 100-199k NA, 350-599k 0, 1.5-3.0m 0,
  //    >3m NA and OMITS 200-349k + 600k-1.499m. We enforce loan range
  //    350k-3.0m via GUIDELINES and apply no UPB adjustment inside it.
  //  - TPO premium (hidden 1.00% / +0.320) + Rate Buydown table carried over
  //    from the DIYA 1-4 unit model (sheet has no TPO/buydown tables).
  //  - "No Prepayment" +0.500 placeholder carried over (not on sheet).
  //  - Fees identical to the 1-4 unit DSCR sizer.
  // Deploy 236.823 — 9.1.26 sheet ("5+ Unit 9-1-2026 DSCR.xlsx"): base rates
  // +0.075 on all four products. Everything else was diffed cell-by-cell and is
  // UNCHANGED — FICO (still floor 700, 680-699 and below NA), the +1.000 5+
  // Multi adjustment (still NA above 75 LTV, so max leverage stays 75), IO,
  // cash-out, DSCR >= 1.20, PPP and the UPB bands. Min rate still 6.25.
  //
  // The 9.1.26 sheet does publish FICO columns for 75.01-80 / 80.01-85 /
  // 85.01-90, but they're unreachable on this product: the 5+ Multi row is NA
  // above 75 and it is always applied here (property type is locked), so the
  // matrix stays 6 columns wide.
  effectiveDate: "September 1, 2026",
  minRate: 6.25,
  baseRate: { "30Y Fixed": 6.525, "10/6 ARM": 6.525, "7/6 ARM": 6.425, "5/6 ARM": 6.425 }, // 236.823: +0.075 (9.1.26 sheet)
  ltvCols: [50, 55, 60, 65, 70, 75],
  fico: {
    "780+":    [-0.125,-0.125,-0.125,-0.050, 0.000, 0.050],
    "760-779": [-0.100,-0.100,-0.100,-0.025, 0.025, 0.100],
    "740-759": [-0.075,-0.075,-0.050, 0.000, 0.050, 0.150],
    "720-739": [-0.025, 0.000, 0.025, 0.050, 0.075, 0.200],
    "700-719": [ 0.000, 0.050, 0.075, 0.100, 0.125, 0.250],
  },
  io:        [0.000, 0.000, 0.000, 0.000, 0.000, 0.000],
  cashOut:   [0.050, 0.050, 0.050, 0.050, 0.050, 0.050],
  // 5+ Multifamily property adjustment — ALWAYS applied on this sizer
  // (property type is locked). NA above 75 LTV is what caps leverage.
  multifamily5: [1.000, 1.000, 1.000, 1.000, 1.000, 1.000],
  // Kept for engine-shape parity; unreachable with propType locked 'multi'.
  nwCondo:   [null, null, null, null, null, null],
  multiUnit: [null, null, null, null, null, null],
  portfolio: [null, null, null, null, null, null],
  upb: [],
  dscr: {
    "1.20+": [-0.050,-0.050,-0.050,-0.050,-0.050,-0.050],
  },
  ppp: { "5y6m":-0.150, "54321":-0.100, "321":0.050, "none":0.500 },
  tpo: {
    "0":0, "0.25":0.080, "0.50":0.160, "0.75":0.240,
    "1.00":0.320, "1.25":0.390, "1.50":0.460, "1.75":0.530,
    "2.00":0.600, "2.25":0.670, "2.50":0.740,
  },
  rateBuydown: {
    "0":    0,
    "0.25": -0.045,
    "0.50": -0.090,
    "0.75": -0.135,
    "1.00": -0.180,
    "1.25": -0.225,
    "1.50": -0.270,
    "1.75": -0.315,
    "2.00": -0.360,
  },
  HIDDEN_TPO_PCT: 1.00,
  HIDDEN_TPO_ADJ: 0.320,
  // Deploy 236.750 — NCF-based DSCR inputs (Mike's spec): vacancy/credit loss
  // defaults to 5% (admin-overridable in the sizer); CapEx reserves are fixed
  // at $300/unit/year (not editable anywhere).
  vacancyDefaultPct: 5,
  capexPerUnitYr: 300,
};

// Deploy 236.750 — annual operating-expense fields summed into the NCF math.
// Keep in sync with the sizer inputs, apply.html's MF section, and the Loan
// Details MF Operating Statement box.
const OPEX_FIELDS = [
  'opexTaxes', 'opexInsurance', 'opexFlood', 'opexUtilities', 'opexRepairs',
  'opexMgmt', 'opexHOA', 'opexLandscaping', ];

// Fixed fees (always shown on term sheet)
const FEES = {
  origination_pct: 1,        // 1% of loan amount
  underwriting: 995,
  doc_prep: 700,
  legal_doc: 500,
  desktop_analysis: 120,
};

// ══════════════════════════════════════════════════════════════════
// DIYA GUIDELINE VALIDATION  (Source: Diya_Guideline_Matrix_2026_01_29)
// ══════════════════════════════════════════════════════════════════
const GUIDELINES = {
  // Deploy 236.507 — no-lend list now matches apply.html (the source of
  // truth per Mike): AZ, CA, MN, ND, NV, SD, UT, VT are NOT eligible.
  // (Was ...ID... — ID is now eligible; MN is now excluded.)
  // Deploy 236.749 — MF guideline: Diya/REIL do NOT lend MF in Idaho (plus
  // the standard NV/UT/ND/SD/VT + territories); ID is removed vs the 1-4
  // unit list. CA/AZ/OR/MN carry TPO-licensing conditions and stay excluded
  // operationally (same as the 1-4 unit sizer).
  eligibleStates: ['AK','AL','AR','CO','CT','DC','DE','FL','GA','HI',
    'IA','IL','IN','KS','KY','LA','MA','MD','ME','MI','MO','MS','MT',
    'NC','NE','NH','NJ','NM','NY','OH','OK','OR','PA','RI','SC',
    'TN','TX','VA','WA','WI','WV','WY'],

  // ALL US state abbreviations for detecting non-US addresses
  allUSStates: ['AK','AL','AR','AZ','CA','CO','CT','DC','DE','FL','GA','HI',
    'IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MN','MO','MS','MT',
    'NC','ND','NE','NH','NJ','NM','NV','NY','OH','OK','OR','PA','RI','SC','SD',
    'TN','TX','UT','VA','VT','WA','WI','WV','WY'],

  // Property value limits (1-4 Unit SFR)
  // Deploy 236.749 — Diya MF (5+) Term Guideline Matrix (updated 6/7/2026)
  // replaces the 236.748 assumptions: property $500k-$15M (avg $75k/unit),
  // loan $350k-$5M ($3M+ = CRE-program gate; $10M on exception), 5-30 units
  // (>10 = CRE gate), max $1M avg loan/unit, LTV 74.99 (740+) / 70 below,
  // DSCR 1.20 Top/Standard (1.30 Small, 1.40 Very Small), FICO 700 floor.
  minPropertyValue: 500000,
  maxPropertyValue_1unit: 15000000,  // Deploy 236.749 — guideline: max per-property value $15,000,000
  maxPropertyValue_24unit: 5000000,  // $5,000,000 for 2-4 unit
  // Deploy 236.65 — portfolio loans are aggregate-of-properties, so the
  // "property value" field represents combined value. $6.25M caps the
  // pool at the level that supports a $5M portfolio loan at 80% LTV.
  maxPropertyValue_portfolio: 6250000,

  // Loan amount limits (1-4 Unit SFR)
  minLoanAmount: 350000,       // Deploy 236.749 — CONFIRMED by the guideline matrix ($350,000 minimum)
  maxLoanAmount_1unit: 5000000,  // Deploy 236.749 — guideline max $5M (to $10M on exception); NOTE the RATE sheet prices UPB only to $3.0M
  mfCreGateLoan: 3000000,        // > $3M requires the TPO approved for Diya's CRE program (warn)
  // Unit-count rules (guideline matrix). The sizer's Number of Units input
  // feeds these; blank = checks skipped.
  minUnits: 5,
  maxUnits: 30,                  // higher on exception
  creGateUnits: 10,              // > 10 units requires the CRE program (warn)
  maxLoanPerUnit: 1000000,       // max AVERAGE loan amount per unit
  minValuePerUnit: 75000,        // min AVERAGE per-unit value
  maxLoanAmount_24unit: 2500000, // $2,500,000 for 2-4 unit
  // Deploy 236.65 — portfolio loans cap at $5M in the sizer, but
  // anything above the $3M "standard" threshold surfaces a warning
  // (not a hard error) noting that the deal requires final approval.
  // Lets the LO size the deal end-to-end before escalating.
  maxLoanAmount_portfolio: 5000000,
  portfolioSoftCap: 3000000,

  // FICO minimums — Deploy 236.748: MF LoBal floor is 700 (680-699 and
  // below are all NA on the sheet; no pre-approval band).
  minFICO: 700,
  preApprovalFICO: 700,

  // Max LTV by FICO and purpose (SFR 1-4 Unit, 1-10 properties, standard market)
  // Format: { ficoMin: { purchase: max, rateTerm: max, cashOut: max } }
  // Using the more conservative (Small/Very Small) values where there's a split
  // Deploy 236.749 — guideline LTV matrix (Top/Standard markets; Small/Very
  // Small cap at 70% across the board — surfaced as a warning, since the
  // sizer has no market-tier input): 740+ = 74.99%, 700-739 = 70%.
  maxLTV: {
    740: { purchase: 0.7499, rateTerm: 0.7499, cashOut: 0.7499 },
    720: { purchase: 0.70, rateTerm: 0.70, cashOut: 0.70 },
    700: { purchase: 0.70, rateTerm: 0.70, cashOut: 0.70 },
  }
};

// Extract 2-letter state abbreviation from a US address string
function extractStateFromAddress(address) {
  if (!address) return null;
  // Match ", ST " or ", ST, " or ends with ", ST XXXXX" or ", ST"
  var m = address.match(/,\s*([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?\s*(?:,|$)/i);
  if (m) return m[1].toUpperCase();
  // Try just last 2-letter word that's a state abbrev
  var parts = address.toUpperCase().split(/[\s,]+/);
  for (var i = parts.length-1; i >= 0; i--) {
    if (/^[A-Z]{2}$/.test(parts[i]) && GUIDELINES.allUSStates.indexOf(parts[i]) >= 0) {
      return parts[i];
    }
  }
  return null;
}

// Validate inputs against Diya guidelines — returns array of {level, msg} objects
// level: 'error' (cannot proceed) or 'warn' (pre-approval needed)
function validateGuidelines(params) {
  var msgs = [];
  var loan     = params.loan     || 0;
  var propVal  = params.propVal  || 0;
  var ltv      = params.ltv      || 0;
  var fico     = params.fico     || '';  // e.g. "740-759"
  var address  = params.address  || '';
  var purpose  = params.purpose  || 'purchase';
  var propType = params.propType || 'sfr';
  // Deploy 236.526 — Admin Sandbox: in admin mode every guideline breach is
  // intentional, so downgrade all 'error' messages to non-blocking 'warn' at
  // the end (the admin still sees what they're exceeding, in amber not red).
  var adminSandbox = params.adminSandbox === true;

  // 1. Property value
  if (propVal > 0) {
    if (propVal < GUIDELINES.minPropertyValue) {
      msgs.push({level:'error', msg:'Property value $'+propVal.toLocaleString()+' is below the $500,000 minimum for Multifamily (5+).'});
    }
    // Deploy 236.65 — portfolio gets its own property-value cap
    // (aggregate of pool, sized to support a $5M loan at 80% LTV).
    var maxPV, maxPVLabel;
    if (propType === 'portfolio') {
      maxPV = GUIDELINES.maxPropertyValue_portfolio;
      maxPVLabel = '$6,250,000';
    } else if (propType === '2-4') {
      maxPV = GUIDELINES.maxPropertyValue_24unit;
      maxPVLabel = '$5,000,000';
    } else {
      maxPV = GUIDELINES.maxPropertyValue_1unit;
      maxPVLabel = '$15,000,000';
    }
    if (propVal > maxPV) {
      msgs.push({level:'error', msg:'Property value $'+propVal.toLocaleString()+' exceeds the '+maxPVLabel+' maximum for this property type.'});
    }
  }

  // 2. Loan amount
  if (loan > 0) {
    if (loan < GUIDELINES.minLoanAmount) {
      msgs.push({level:'error', msg:'Loan amount $'+loan.toLocaleString()+' is below the $350,000 minimum for Multifamily (5+).'});
    }
    // Deploy 236.65 — portfolio loans size up to $5M in the sizer;
    // anything above the $3M "standard" threshold passes through with a
    // soft warning ("requires final approval") rather than a hard error
    // so the LO can complete the sizer and escalate. > $5M hard-errors
    // as before.
    if (propType === 'portfolio') {
      if (loan > GUIDELINES.maxLoanAmount_portfolio) {
        msgs.push({level:'error', msg:'Portfolio loan amount $'+loan.toLocaleString()+' exceeds the $5,000,000 maximum supported by the sizer. Loans above this require manual underwriting outside the platform.'});
      } else if (loan > GUIDELINES.portfolioSoftCap) {
        msgs.push({level:'warn', msg:'Portfolio loan amount $'+loan.toLocaleString()+' is above the $3,000,000 standard limit. Eligible up to $5,000,000 but requires final approval from a manager before closing.'});
      }
    } else {
      var maxLoan = propType === '2-4' ? GUIDELINES.maxLoanAmount_24unit : GUIDELINES.maxLoanAmount_1unit;
      if (loan > maxLoan) {
        msgs.push({level:'error', msg:'Loan amount $'+loan.toLocaleString()+' exceeds the $5,000,000 Multifamily maximum. Up to $10,000,000 is available on an exception basis — reach out to a manager.'});
      } else if (loan > GUIDELINES.mfCreGateLoan) {
        // Deploy 236.749 — CRE-program gate + heavier requirements at $3M+.
        msgs.push({level:'warn', msg:'Loans above $3,000,000 require the TPO to be approved for Diya\'s CRE program, guarantor net worth of 1.5x the loan amount, and a Property Condition Assessment (PCA). NOTE: the 8/7/26 rate sheet prices UPB only to $3.0M — pricing above that needs manager confirmation.'});
      }
    }
  }

  // 3. LTV check
  if (ltv > 0 && fico) {
    var ficoMin = getFICOMin(fico);
    var purposeKey = purpose === 'refi_co' ? 'cashOut' : purpose === 'refi_rt' ? 'rateTerm' : 'purchase';
    var maxLTVrow = null;
    // Find applicable row (highest ficoMin <= ficoMin)
    var tiers = [740, 720, 700, 680, 660];
    for (var t = 0; t < tiers.length; t++) {
      if (ficoMin >= tiers[t]) { maxLTVrow = GUIDELINES.maxLTV[tiers[t]]; break; }
    }
    if (maxLTVrow) {
      var maxAllowed = maxLTVrow[purposeKey] * 100;
      if (ltv > maxAllowed + 0.01) {
        var maxLoanAtLTV = propVal > 0 ? Math.floor(propVal * maxLTVrow[purposeKey]) : null;
        var maxLoanMsg = maxLoanAtLTV ? ' Maximum loan at this LTV is $'+maxLoanAtLTV.toLocaleString()+'.' : '';
        msgs.push({level:'error', msg:'LTV '+ltv.toFixed(1)+'% exceeds the '+maxAllowed+'% maximum for '+fico+' FICO and '+(purposeKey==='cashOut'?'cash-out refi':purposeKey==='rateTerm'?'rate/term refi':'purchase')+'.'+maxLoanMsg});
      }
    }
  }

  // 4. FICO eligibility
  if (fico) {
    var ficoMin = getFICOMin(fico);
    if (ficoMin < GUIDELINES.minFICO) {
      msgs.push({level:'error', msg:'FICO below 700 is not eligible for Multifamily LoBal.'});
    }
  }

  // 5. State eligibility (from address)
  if (address) {
    var st = extractStateFromAddress(address);
    if (st && GUIDELINES.eligibleStates.indexOf(st) < 0) {
      msgs.push({level:'error', msg:'State "'+st+'" is not an eligible lending state.'});
    }
  }

  // ── Deploy 236.749 — Multifamily (5+) guideline checks ──────────────
  // Unit-count rules (skipped when the Units input is blank).
  var units = parseInt(params.units, 10);
  if (isFinite(units) && units > 0) {
    if (units < GUIDELINES.minUnits) {
      msgs.push({level:'error', msg:'This program is for 5+ unit properties ('+units+' units entered). Use the standard DSCR sizer for 1-4 units.'});
    }
    if (units > GUIDELINES.maxUnits) {
      msgs.push({level:'error', msg:units+' units exceeds the 30-unit maximum. Higher unit counts are available on an exception basis — reach out to a manager.'});
    } else if (units > GUIDELINES.creGateUnits) {
      msgs.push({level:'warn', msg:'Properties above 10 units require the TPO to be approved for Diya\'s CRE program.'});
    }
    if (loan > 0 && (loan / units) > GUIDELINES.maxLoanPerUnit) {
      msgs.push({level:'error', msg:'Average loan per unit $'+Math.round(loan/units).toLocaleString()+' exceeds the $1,000,000 maximum.'});
    }
    if (propVal > 0 && (propVal / units) < GUIDELINES.minValuePerUnit) {
      msgs.push({level:'error', msg:'Average value per unit $'+Math.round(propVal/units).toLocaleString()+' is below the $75,000 minimum.'});
    }
    // Occupancy requirement (informational — the sizer has no occupancy
    // input). Guideline table: 5-19 units -> units-1 occupied; 20 -> 18;
    // >20 -> 90% (rounded up).
    if (units >= GUIDELINES.minUnits) {
      var reqOcc = units <= 19 ? (units - 1) : (units === 20 ? 18 : Math.ceil(units * 0.9));
      msgs.push({level:'warn', msg:'Occupancy requirement: at least '+reqOcc+' of '+units+' units must be occupied. 85% may be approved on exception for recently built/renovated Top/Standard-market properties.'});
    }
  }
  // Cash-out cap (the sizer doesn't capture the cash-out amount).
  if (purpose === 'refi_co') {
    msgs.push({level:'warn', msg:'Max cash-out is $500,000 (up to $1,000,000 when LTV ≤ 65% and LTC ≤ 100%). Higher cash-out requires pre-approval. Rate/Term treatment requires the paid-off debt to be a recorded lien.'});
  }
  // Market-tier caveats (no market-tier input on the sizer).
  if (ltv > 70) {
    msgs.push({level:'warn', msg:'LTV above 70% is only available in Top/Standard markets with FICO 740+ (Small/Very Small markets cap at 70%).'});
  }
  if (params.dscr != null && params.dscr < 1.30) {
    msgs.push({level:'warn', msg:'DSCR '+params.dscr.toFixed(2)+'x meets the 1.20x Top/Standard-market minimum, but Small markets require 1.30x and Very Small markets 1.40x.'});
  }

  // Deploy 236.526 — sandbox: nothing blocks. Downgrade errors to warnings so
  // the admin can proceed while still seeing every breached guideline.
  if (adminSandbox) {
    for (var mi = 0; mi < msgs.length; mi++) {
      if (msgs[mi].level === 'error') msgs[mi] = { level: 'warn', msg: msgs[mi].msg };
    }
  }

  return msgs;
}

function getFICOMin(ficoStr) {
  // "780+" -> 780, "740-759" -> 740, "660-679" -> 660
  if (ficoStr.indexOf('+') >= 0) return parseInt(ficoStr);
  var parts = ficoStr.split('-');
  return parseInt(parts[0]);
}

function ltvCol(ltv) {
  var c = DIYA.ltvCols;
  for (var i = 0; i < c.length; i++) if (ltv <= c[i]) return i;
  return null;
}

function calcPI(loan, annualRate, isIO) {
  if (!loan || !annualRate) return 0;
  var r = annualRate / 12;
  if (isIO) return loan * r;
  return loan * r * Math.pow(1+r,360) / (Math.pow(1+r,360) - 1);
}

function ac(v) {
  if (v===null||v===undefined||isNaN(v)) return 'zero';
  return v>0?'pos':v<0?'neg':'zero';
}
function fa(v) {
  if (v===null||v===undefined||isNaN(v)) return 'N/A';
  if (v===0) return '&mdash;';
  return (v>0?'+':'')+v.toFixed(3)+'%';
}
function fmtD(n) {
  if (n==null) return '&mdash;';
  return '$'+n.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
}
function fmtX(n) { return n!=null?n.toFixed(2)+'x':'&mdash;'; }

// Deploy 236.48 — single source of truth for the FICO / LTV / pricing-
// eligibility error suffix. Same string in RTL sizer. Replaces the
// older product-routing suggestions ("Try an RTL or Bridge") with a
// manager-exception escalation invitation.
var EXCEPTION_HINT = ' Reach out to a manager to submit an exception request.';

// ── priceDSCR: the pure pricing entry point ─────────────────────
// Body is calculate() from the sizer verbatim, with DOM reads
// ($('id').value) swapped for raw.<field>. Golden-locked — see
// scripts/fixtures/dscr-golden.json.
function priceDSCR(raw) {
  raw = raw || {};
  var loan      = parseFloat(raw.loanAmt)    || 0;
  var propVal   = parseFloat(raw.propValue)  || 0;
  var ltv       = propVal>0?(loan/propVal)*100:0;
  var loanType  = String(raw.loanType || '');
  var isIO      = raw.isIO==='yes';
  var purpose   = String(raw.loanPurpose || '');
  var propType  = String(raw.propType || '');
  var fico      = String(raw.fico || '');
  var prepay    = String(raw.prepay || '');
  var buydown   = parseFloat(raw.buydown) || 0;
  var rent      = parseFloat(raw.rent)       || 0;
  var taxes     = parseFloat(raw.taxes)      || 0;
  var ins       = parseFloat(raw.insurance)  || 0;
  var hoa       = parseFloat(raw.hoa)        || 0;
  // Deploy 236.750 — NCF-based DSCR (guideline: NCF ÷ P&I). Gross monthly
  // income (total rent + other income) less vacancy (default 5%, admin-
  // overridable), less annual operating expenses and the fixed $300/unit/yr
  // CapEx reserve, gives monthly Net Cash Flow.
  var otherInc  = parseFloat(raw.otherIncomeMo) || 0;
  var vacPct    = parseFloat(raw.vacancyPct);
  if (!isFinite(vacPct) || String(raw.vacancyPct == null ? '' : raw.vacancyPct).trim() === '') vacPct = DIYA.vacancyDefaultPct;
  if (vacPct < 0) vacPct = 0; if (vacPct > 100) vacPct = 100;
  var unitsN    = parseInt(raw.numUnits, 10) || 0;
  var opexAnnual = 0;
  for (var oi = 0; oi < OPEX_FIELDS.length; oi++) {
    var ov = parseFloat(String(raw[OPEX_FIELDS[oi]] == null ? '' : raw[OPEX_FIELDS[oi]]).replace(/[$,]/g, ''));
    if (isFinite(ov) && ov > 0) opexAnnual += ov;
  }
  var capexAnnual = DIYA.capexPerUnitYr * unitsN;
  var grossMo = rent + otherInc;
  var vacMo   = grossMo * vacPct / 100;
  var egiMo   = grossMo - vacMo;
  var opexMo  = opexAnnual / 12;
  var capexMo = capexAnnual / 12;
  var ncfMo   = egiMo - opexMo - capexMo;
  var borrower  = String(raw.borrowerName || '').trim();
  var borrowerEmail = String(raw.borrowerEmail || '').trim();
  var address   = String(raw.propAddress || '').trim();
  // Deploy 236.526 — Admin Sandbox. Set ONLY by the sizer's Admin Mode
  // (admin-gated). Defaults off, so every non-admin path and all golden
  // scenarios are unaffected. When on, LTV caps become non-blocking so an
  // admin can build a rate sheet at any leverage.
  var adminSandbox = raw.adminSandbox === true;

  if (loan<=0) return {error:'Enter a loan amount'};

  // DIYA's pricing matrix bottoms out at FICO 660-679. The apply form
  // and the FICO dropdown both include sub-660 ranges (640-659, 620-639,
  // 550-619) for parity, but DSCR can't actually be priced for those
  // borrowers. Bail with a clear message instead of letting the calc
  // fall through to "no row matched" or a misleading default.
  // Deploy 236.48 — standardized exception-request wording. All FICO /
  // LTV / pricing-eligibility errors now invite the LO to escalate to a
  // manager instead of suggesting an alternate product. EXCEPTION_HINT
  // is defined as a module-level constant at the top of the file (see
  // RTL sizer for the matching string).
  // Deploy 236.748 — MF LoBal FICO floor is 700.
  var SUB700 = ['680-699', '660-679', '640-659', '620-639', '550-619'];
  if (SUB700.indexOf(fico) >= 0) {
    return {
      error: 'No Multifamily LoBal pricing available for FICO ' + fico + '. ' +
        'The minimum credit score is 700.' + EXCEPTION_HINT,
    };
  }

  // Helper: max loan at the given LTV cap given the property value
  function maxLoanAt(ltvPct) {
    if (propVal <= 0) return null;
    return Math.floor(propVal * ltvPct / 100);
  }
  function maxLoanMsg(ltvPct) {
    var ml = maxLoanAt(ltvPct);
    return ml ? ' Maximum loan at this property value is $' + ml.toLocaleString() + '.' : '';
  }

  if (ltv<=0) return {error:'Enter property value'};
  if (ltv>75 && !adminSandbox) {
    return {error:'LTV '+ltv.toFixed(1)+'% exceeds the 75% maximum for Multifamily LoBal.' + maxLoanMsg(75) + EXCEPTION_HINT};
  }

  var ci = ltvCol(ltv);
  if (ci===null) {
    // Above the top LTV column. In the sandbox, clamp the pricing lookup to the
    // top tier (rate/points are overridden manually in Admin Mode anyway) so we
    // return a priceable result instead of erroring; otherwise keep the cap.
    if (adminSandbox) ci = DIYA.ltvCols.length - 1;
    else return {error:'LTV '+ltv.toFixed(1)+'% exceeds the 75% maximum for Multifamily LoBal.' + maxLoanMsg(75) + EXCEPTION_HINT};
  }

  var baseRate = DIYA.baseRate[loanType]||DIYA.baseRate['30Y Fixed'];
  var adjs = [];

  // FICO
  var fRow = DIYA.fico[fico];
  if (!fRow) return {error:'FICO not supported.' + EXCEPTION_HINT};
  var fAdj = fRow[ci];
  if (fAdj===null||fAdj===undefined) {
    // Find the highest LTV column that's not null for this FICO
    var maxFicoLTV = null;
    for (var i = fRow.length - 1; i >= 0; i--) {
      if (fRow[i] !== null && fRow[i] !== undefined) { maxFicoLTV = DIYA.ltvCols[i]; break; }
    }
    var ficoMaxMsg = maxFicoLTV ? maxLoanMsg(maxFicoLTV) : '';
    var ficoMaxStr = maxFicoLTV ? ' Maximum LTV for FICO ' + fico + ' is ' + maxFicoLTV + '%.' + ficoMaxMsg : '';
    return {error:'FICO '+fico+' is not available at '+ltv.toFixed(1)+'% LTV.' + ficoMaxStr + EXCEPTION_HINT};
  }
  adjs.push({label:'FICO adjustment', value:fAdj});

  // IO
  if (isIO) {
    var ioA = DIYA.io[ci];
    if (ioA===null) {
      var ioMaxLTV = null;
      for (var i = DIYA.io.length - 1; i >= 0; i--) {
        if (DIYA.io[i] !== null && DIYA.io[i] !== undefined) { ioMaxLTV = DIYA.ltvCols[i]; break; }
      }
      var ioMaxStr = ioMaxLTV ? ' Maximum LTV for Interest Only is ' + ioMaxLTV + '%.' + maxLoanMsg(ioMaxLTV) : '';
      return {error:'Interest Only is not available at '+ltv.toFixed(1)+'% LTV.' + ioMaxStr + EXCEPTION_HINT};
    }
    adjs.push({label:'Interest Only', value:ioA});
  }

  // Cash-out
  if (purpose==='refi_co') {
    var coA = DIYA.cashOut[ci];
    if (coA===null) {
      var coMaxLTV = null;
      for (var j = DIYA.cashOut.length - 1; j >= 0; j--) {
        if (DIYA.cashOut[j] !== null && DIYA.cashOut[j] !== undefined) { coMaxLTV = DIYA.ltvCols[j]; break; }
      }
      var coMaxStr = coMaxLTV ? ' Maximum LTV for cash-out refi is ' + coMaxLTV + '%.' + maxLoanMsg(coMaxLTV) : '';
      return {error:'LTV '+ltv.toFixed(1)+'% is not available for cash-out refi.' + coMaxStr + EXCEPTION_HINT};
    }
    adjs.push({label:'Cash-Out Refi', value:coA});
  }

  // Property — Deploy 236.748: this sizer is locked to 5+ Multifamily, so
  // the +1.000 MF adjustment ALWAYS applies (it is what the sheet prices).
  adjs.push({label:'5+ Unit Multifamily', value:DIYA.multifamily5[ci]});

  // UPB
  var uRow = DIYA.upb.find(function(u){return loan>=u.min&&loan<=u.max;});
  if (uRow) adjs.push({label:'Loan amount (UPB)', value:uRow.adj[ci]});

  // PPP
  var pppA = DIYA.ppp[prepay]!==undefined?DIYA.ppp[prepay]:0;
  adjs.push({label:'Prepay penalty ('+prepay+')', value:pppA});

  // Deploy 236.39 — new pricing model. TPO is locked at 1.00% so
  // the hidden TPO adjustment is always DIYA.HIDDEN_TPO_ADJ (0.280),
  // regardless of buy-down. Buy-down is its own separate negative
  // rate adjustment, looked up in DIYA.rateBuydown. Both are
  // applied silently (not in adjs[]) so the borrower's breakdown
  // shows only the legitimate adjustments.
  var hiddenTpoAdj  = DIYA.HIDDEN_TPO_ADJ;                   // always 0.280
  var buydownAdj    = DIYA.rateBuydown[buydown.toFixed(2)] || 0; // negative
  // netHiddenTpoPct kept in the return value for legacy callers /
  // PDFs that surface "TPO retained" info. With the new model it's
  // always = HIDDEN_TPO_PCT (no longer flexes with buy-down).
  var netHiddenTpoPct = DIYA.HIDDEN_TPO_PCT;
  var baseAdj = adjs.reduce(function(s,a){return s+(a.value||0);},0);
  var ratePass1 = baseRate + baseAdj + hiddenTpoAdj + buydownAdj;

  // PI at pass-1 rate — Deploy 236.750: DSCR is NCF ÷ P&I (taxes/insurance
  // live inside the annual operating expenses, not the payment).
  var pi1 = calcPI(loan, ratePass1/100, isIO);
  var pmt1 = pi1;
  var dscr1 = pi1>0&&grossMo>0?ncfMo/pi1:null;

  // Deploy 236.584 — DSCR-below-1.0 is a MANAGER-EXCEPTION case, not a hard
  // stop. Waive the floor when the admin sandbox is on OR a manager exception
  // has been granted (raw.dscrException, set by the sizer's Below-1.0 ack). The
  // loan then prices normally through the 1.00-1.19 band below. We still tag the
  // error return with dscr + dscrBelowMin so the sizer can show a "Submit
  // manager exception" button on the ineligible card.
  // Deploy 236.748 — MF LoBal requires DSCR >= 1.20 (1.00-1.19 is NA on the sheet).
  if (dscr1!==null && dscr1<1.20 && !adminSandbox && raw.dscrException!==true) {
    return {error:'DSCR '+dscr1.toFixed(2)+'x is below the 1.20x minimum for Multifamily LoBal.' + EXCEPTION_HINT, dscr: dscr1, dscrBelowMin: true};
  }

  // DSCR adj
  var dscrAdj = 0;
  if (dscr1!==null && dscr1>=1.20) {
    dscrAdj = DIYA.dscr['1.20+'][ci];
    adjs.push({label:'DSCR (1.20+)', value:dscrAdj});
  }

  var finalRate = ratePass1 + dscrAdj;
  // Deploy 236.748 — sheet config: Min Rate 6.25% floor.
  if (DIYA.minRate && finalRate < DIYA.minRate) finalRate = DIYA.minRate;
  var piFinal = calcPI(loan, finalRate/100, isIO);
  var pmtFinal = piFinal; // Deploy 236.750 — NCF model: payment = P&I only
  var dscrFinal = piFinal>0&&grossMo>0?ncfMo/piFinal:null;

  // Fees
  var origFee = loan * FEES.origination_pct / 100;
  var buydownFee = loan * buydown / 100;
  // Broker fee — in points, same convention as origination. Computed
  // against the loan amount and included in totalFees so cash-to-close
  // and the rate sheet PDF both reflect it.
  var brokerPts = parseFloat(raw.brokerFee) || 0;
  var brokerFeeDol = loan * brokerPts / 100;
  // Deploy 236.376 — flat broker processing fee (dollars, not points).
  var brokerProcFee = parseFloat(raw.brokerProcFee) || 0;
  var totalFees = origFee + FEES.underwriting + FEES.doc_prep + FEES.legal_doc + FEES.desktop_analysis + buydownFee + brokerFeeDol + brokerProcFee;

  // Guideline validation
  var guidelineWarnings = validateGuidelines({
    loan: loan, propVal: propVal, ltv: ltv, fico: fico,
    address: address, purpose: purpose, propType: propType,
    adminSandbox: adminSandbox,
    // Deploy 236.749 — MF guideline inputs: unit count + computed DSCR.
    units: raw.numUnits, dscr: dscrFinal,
  });

  return {
    loanType, ltv, dscr:dscrFinal, fico, baseRate, adjs,
    finalRate, pi:piFinal, taxes, ins, hoa,
    totalPayment:pmtFinal, rent,
    borrower, borrowerEmail, address, loan, propVal, prepay, buydown, isIO, purpose, propType,
    origFee, buydownFee, totalFees,
    brokerPts, brokerFeeDol, brokerProcFee,
    netHiddenTpoPct, guidelineWarnings,
    sandbox: adminSandbox,
    // Deploy 236.750 — NCF breakdown for the result card + rate-sheet PDF.
    grossMo: grossMo, otherIncomeMo: otherInc, vacancyPct: vacPct, vacMo: vacMo,
    egiMo: egiMo, opexMo: opexMo, capexMo: capexMo, ncfMo: ncfMo, numUnits: unitsN,
  };
}

// ── Export root: browser global + CommonJS for the test runner ─────
var _SLA_DSCR_API = {
  DIYA: DIYA, FEES: FEES, GUIDELINES: GUIDELINES,
  ltvCol: ltvCol, calcPI: calcPI,
  validateGuidelines: validateGuidelines, getFICOMin: getFICOMin,
  EXCEPTION_HINT: EXCEPTION_HINT,
  priceDSCR: priceDSCR,
  OPEX_FIELDS: OPEX_FIELDS, // Deploy 236.750
};
if (typeof window !== 'undefined') window.SLA_DSCR = _SLA_DSCR_API;
if (typeof module !== 'undefined' && module.exports) module.exports = _SLA_DSCR_API;
})();
