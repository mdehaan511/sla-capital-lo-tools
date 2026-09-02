/**
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
  // Deploy 236.543 — Diya 1-4 Unit Rate Sheet effective 8.12.26.
  // ONLY the base rates moved vs the 8.4.26 sheet (+0.075 across the board):
  //   30Y Fixed & 10/6 ARM: 6.375 -> 6.45
  //   7/6 ARM & 5/6 ARM:    6.275 -> 6.35
  //   Everything else byte-identical: FICO grid, IO, Cash-Out, NW Condo,
  //   2-4 Unit, Portfolio, UPB, DSCR adj, PPP, TPO Premium (1.00% still 0.320
  //   -> HIDDEN_TPO_ADJ), Rate Buydown, and the (still-unwired) TPO/Buydown caps.
  //
  // Deploy 236.523 — Diya 1-4 Unit Rate Sheet effective 8.4.26.
  // Only two grids moved vs the 7.22.26 sheet:
  //   Portfolio: 0.200 -> 0.250 across all LTVs (reverts the 7.22.26 cut)
  //   DSCR 1.20+: high-LTV cols flattened to -0.050 —
  //     65-70 -0.075 -> -0.050, 70-75 -0.100 -> -0.050, 75-80 -0.125 -> -0.050
  //     (the <=65 LTV cols were already -0.050, unchanged)
  //   Unchanged: base rates, FICO, IO, Cash-Out, NW Condo, 2-4 Unit, UPB,
  //     PPP, TPO Premium (1.00% still 0.320 -> HIDDEN_TPO_ADJ), Rate Buydown,
  //     and the (still-unwired) TPO/Buydown caps.
  //
  // Deploy 236.374 — Diya 1-4 Unit Rate Sheet effective 7.22.26.
  // Changes vs the 6.12.26 sheet:
  //   Base rates -0.025: 30Y/10-6 6.400 -> 6.375, 7/6 & 5/6 6.300 -> 6.275
  //   FICO grid: 780+ through 700-719 improved at 60-80 LTV cols;
  //     700-719 gains a NEW 75.01-80 tier at +0.500 (was N/A)
  //   IO: 65-70 col 0.300 -> 0.250, 70-75 col 0.350 -> 0.250
  //   Portfolio: 0.250 -> 0.200 across all LTVs
  //   PPP: 321 0.150 -> 0.050, 320 0.200 -> 0.150, 300 0.300 -> 0.250
  //   TPO Premium table: all rows up ~0.03-0.04 (1.00% row 0.280 -> 0.320)
  //     => HIDDEN_TPO_ADJ follows to 0.320 per the standing 236.39 rule
  //   Unchanged: Cash-Out, NW Condo, 2-4 Unit, UPB, DSCR adj, Rate Buydown
  //
  // STANDING RULE (from Deploy 236.39, unchanged) -- supersedes Deploy
  // 234.1 (which said to IGNORE Diya's Rate Buydown table). We mirror
  // the Rate Buydown table from the rate sheet AND lock the TPO
  // Premium at 1.00% (rate adj = 0.280) regardless of buy-down. Two
  // separate adjustments on the rate:
  //   + 0.280 from hidden 1% TPO (always)
  //   + entry from DIYA.rateBuydown[buydownPts] (negative; <= 0)
  // Net: 0.25% buy-down reduces rate by 0.045 (was 0.070 under the
  // old "buydown reduces TPO" model). Borrower pays the same fee,
  // gets a smaller rate reduction; extra spread accrues to SLA.
  //
  // TPO Premium / Rate Buydown caps by UPB band on the 7.22.26 sheet
  // are still intentionally NOT wired into sizer math. If Mike wants
  // those enforced later, the caps live at the bottom of the sheet
  // under "TPO Premium Caps" + "Rate Buydown Caps".
  effectiveDate: "September 2, 2026",
  // Deploy 236.842 — 9.2.26 sheet ("rate-sheet-2026-09-02.xlsx"): base rates
  // +0.050 across all four products. Every other table on that sheet — FICO,
  // IO, cash-out, property type, UPB, DSCR, PPP, TPO premium, rate buydown —
  // was diffed cell-by-cell against this file and is UNCHANGED, so this is the
  // only edit the sheet calls for. (The UPB 600k-1.499m -0.050 band is again
  // absent from the sheet and again deliberately KEPT — same call as 236.823.)
  baseRate: { "30Y Fixed": 6.575, "10/6 ARM": 6.575, "7/6 ARM": 6.475, "5/6 ARM": 6.475 }, // 236.842: +0.050 (9.2.26 sheet)
  ltvCols: [50, 55, 60, 65, 70, 75, 80],
  fico: {
    "780+":    [-0.125,-0.125,-0.125,-0.075,-0.050,-0.025, 0.100],
    "760-779": [-0.100,-0.100,-0.100,-0.050,-0.025, 0.000, 0.150],
    "740-759": [-0.075,-0.075,-0.050,-0.025, 0.000, 0.050, 0.175],
    "720-739": [-0.050,-0.025, 0.000, 0.025, 0.050, 0.075, 0.200],
    "700-719": [ 0.000, 0.025, 0.050, 0.075, 0.100, 0.125, 0.500],
    "680-699": [ 0.100, 0.200, 0.250, 0.300, 0.450,  null,  null],
    "660-679": [ 0.625, 0.750, 0.900, 1.100,  null,  null,  null],
  },
  io:        [0.100, 0.150, 0.200, 0.250, 0.250, 0.250,  null],
  cashOut:   [0.050, 0.050, 0.050, 0.050, 0.050, 0.050,  null],
  nwCondo:   [0.150, 0.150, 0.150, 0.150, 0.150, 0.150, 0.150],
  multiUnit: [0.000, 0.025, 0.050, 0.075, 0.100, 0.100, 0.100],
  portfolio: [0.250, 0.250, 0.250, 0.250, 0.250, 0.250, 0.250], // 236.523: 0.200 -> 0.250 (8.4.26 sheet)
  upb: [
    { min:  75000, max:  99999, adj:[0.700,0.700,0.700,0.750,0.750,0.750,0.750] },
    // Deploy 236.39 -- UPB 100k-149k flattened from 0.650/0.675 split
    // to 0.625 across all LTV cols on the 6.2.26 sheet.
    { min: 100000, max: 149999, adj:[0.625,0.625,0.625,0.625,0.625,0.625,0.625] },
    { min: 150000, max: 199999, adj:[0.200,0.200,0.200,0.225,0.225,0.225,0.225] },
    { min: 600000, max:1499999, adj:[-0.050,-0.050,-0.050,-0.050,-0.050,-0.050,-0.050] },
  ],
  dscr: {
    "1.00-1.19": [0,0,0,0,0,0,0],
    "1.20+":     [-0.050,-0.050,-0.050,-0.050,-0.050,-0.050,-0.050], // 236.523: high-LTV cols flattened to -0.050 (8.4.26 sheet)
  },
  // Deploy 236.216 — "No Prepayment" option added. Placeholder
  // adjustment of +0.500% reflects the typical premium lenders
  // charge to give up all prepayment lockout; adjust per rate sheet
  // update if Diya publishes an official number. Rate override still
  // available if the LO needs a specific number for a given loan.
  // "none" stays at the 236.216 placeholder (+0.500) — the 7.22.26
  // sheet still doesn't publish an official No-Prepayment adjustment.
  ppp: { "5y6m":-0.150, "54321":-0.100, "321":0.050, "320":0.150, "300":0.250, "none":0.500 },

  // TPO rate adjustments by premium percentage. Deploy 236.39 -- this
  // table is no longer consulted by calculate() for the buy-down
  // math. TPO is locked at 1.00% (rate adj 0.280) and buy-down has
  // its own DIYA.rateBuydown table below. Kept here for reference
  // / future use should the pricing model change again.
  tpo: {
    "0":0, "0.25":0.080, "0.50":0.160, "0.75":0.240,
    "1.00":0.320, "1.25":0.390, "1.50":0.460, "1.75":0.530,
    "2.00":0.600, "2.25":0.670, "2.50":0.740,
  },

  // Deploy 236.39 -- Rate Buydown table mirrored from the 6.2.26
  // sheet. Buy-down is now a separate additive rate adjustment
  // (negative) ON TOP of the always-on 1% TPO premium. Keys match
  // the buy-down dropdown values; values are the rate adjustment
  // contribution from that buy-down level.
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

  // Hidden 1% TPO always applied (rate adj = 0.320 per 7.22.26 sheet).
  // Deploy 236.39 -- buy-down NO LONGER touches this. The TPO premium
  // is locked at 1.00%; buy-down is a separate adjustment via the
  // rateBuydown table above.
  HIDDEN_TPO_PCT: 1.00,   // percentage (1.00 = 1%)
  HIDDEN_TPO_ADJ: 0.320,  // rate adjustment for 1.00% TPO (always applied)
};

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
  eligibleStates: ['AK','AL','AR','CO','CT','DC','DE','FL','GA','HI',
    'IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MO','MS','MT',
    'NC','NE','NH','NJ','NM','NY','OH','OK','OR','PA','RI','SC',
    'TN','TX','VA','WA','WI','WV','WY'],

  // ALL US state abbreviations for detecting non-US addresses
  allUSStates: ['AK','AL','AR','AZ','CA','CO','CT','DC','DE','FL','GA','HI',
    'IA','ID','IL','IN','KS','KY','LA','MA','MD','ME','MI','MN','MO','MS','MT',
    'NC','ND','NE','NH','NJ','NM','NV','NY','OH','OK','OR','PA','RI','SC','SD',
    'TN','TX','UT','VA','VT','WA','WI','WV','WY'],

  // Property value limits (1-4 Unit SFR)
  minPropertyValue: 100000,   // Deploy 236.507 — $100,000 (was $125,000; matches guidelines.html)
  maxPropertyValue_1unit: 3000000,   // $3,000,000 for 1-unit
  maxPropertyValue_24unit: 5000000,  // $5,000,000 for 2-4 unit
  // Deploy 236.65 — portfolio loans are aggregate-of-properties, so the
  // "property value" field represents combined value. $6.25M caps the
  // pool at the level that supports a $5M portfolio loan at 80% LTV.
  maxPropertyValue_portfolio: 6250000,

  // Loan amount limits (1-4 Unit SFR)
  minLoanAmount: 100000,       // $100,000 single property
  maxLoanAmount_1unit: 1500000,  // $1,500,000 single-unit SFR/condo
  maxLoanAmount_24unit: 2500000, // $2,500,000 for 2-4 unit
  // Deploy 236.65 — portfolio loans cap at $5M in the sizer, but
  // anything above the $3M "standard" threshold surfaces a warning
  // (not a hard error) noting that the deal requires final approval.
  // Lets the LO size the deal end-to-end before escalating.
  maxLoanAmount_portfolio: 5000000,
  portfolioSoftCap: 3000000,

  // FICO minimums
  minFICO: 660,               // 660 min (< 680 requires pre-approval)
  preApprovalFICO: 680,       // 660-679 allowed but requires pre-approval

  // Max LTV by FICO and purpose (SFR 1-4 Unit, 1-10 properties, standard market)
  // Format: { ficoMin: { purchase: max, rateTerm: max, cashOut: max } }
  // Using the more conservative (Small/Very Small) values where there's a split
  maxLTV: {
    740: { purchase: 0.80, rateTerm: 0.80, cashOut: 0.75 },
    720: { purchase: 0.80, rateTerm: 0.80, cashOut: 0.75 },
    // Deploy 236.375 — Mike confirmed (7/22/26): guidelines now allow
    // 80% LTV for 700-719 on purchase + rate/term ONLY. Cash-out stays
    // capped at 75%. Matches the new 700-719 @ 75.01-80 pricing tier
    // on the 7.22.26 rate sheet (+0.500 adj).
    700: { purchase: 0.80, rateTerm: 0.80, cashOut: 0.75 },
    680: { purchase: 0.70, rateTerm: 0.65, cashOut: 0.65 },
    660: { purchase: 0.65, rateTerm: 0.65, cashOut: 0.65 },
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
      msgs.push({level:'error', msg:'Property value $'+propVal.toLocaleString()+' is below the $100,000 minimum.'});
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
      maxPVLabel = '$3,000,000';
    }
    if (propVal > maxPV) {
      msgs.push({level:'error', msg:'Property value $'+propVal.toLocaleString()+' exceeds the '+maxPVLabel+' maximum for this property type.'});
    }
  }

  // 2. Loan amount
  if (loan > 0) {
    if (loan < GUIDELINES.minLoanAmount) {
      msgs.push({level:'error', msg:'Loan amount $'+loan.toLocaleString()+' is below the $100,000 minimum.'});
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
        msgs.push({level:'error', msg:'Loan amount $'+loan.toLocaleString()+' exceeds the '+(propType==='2-4'?'$2,500,000':'$1,500,000')+' maximum. Exceeding these limits requires pre-approval.'});
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
      msgs.push({level:'error', msg:'FICO below 660 is not eligible.'});
    } else if (ficoMin < GUIDELINES.preApprovalFICO) {
      msgs.push({level:'warn', msg:'FICO 660-679 is eligible but requires pre-approval, 1.10x minimum DSCR, and additional liquidity reserves.'});
    }
  }

  // 5. State eligibility (from address)
  if (address) {
    var st = extractStateFromAddress(address);
    if (st && GUIDELINES.eligibleStates.indexOf(st) < 0) {
      msgs.push({level:'error', msg:'State "'+st+'" is not an eligible lending state.'});
    }
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
  var SUB660 = ['640-659', '620-639', '550-619'];
  if (SUB660.indexOf(fico) >= 0) {
    return {
      error: 'No DSCR pricing available for FICO ' + fico + '. ' +
        'DIYA\'s minimum credit score is 660.' + EXCEPTION_HINT,
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
  if (ltv>80 && !adminSandbox) {
    return {error:'LTV '+ltv.toFixed(1)+'% exceeds the 80% maximum.' + maxLoanMsg(80) + EXCEPTION_HINT};
  }

  var ci = ltvCol(ltv);
  if (ci===null) {
    // Above the top LTV column. In the sandbox, clamp the pricing lookup to the
    // top tier (rate/points are overridden manually in Admin Mode anyway) so we
    // return a priceable result instead of erroring; otherwise keep the cap.
    if (adminSandbox) ci = DIYA.ltvCols.length - 1;
    else return {error:'LTV '+ltv.toFixed(1)+'% exceeds the 80% maximum.' + maxLoanMsg(80) + EXCEPTION_HINT};
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

  // Property
  if (propType==='nw_condo') adjs.push({label:'Non-Warrantable Condo', value:DIYA.nwCondo[ci]});
  else if (propType==='2-4') adjs.push({label:'2&ndash;4 Unit', value:DIYA.multiUnit[ci]});
  else if (propType==='portfolio') adjs.push({label:'Portfolio', value:DIYA.portfolio[ci]});

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

  // PI at pass-1 rate
  var pi1 = calcPI(loan, ratePass1/100, isIO);
  var pmt1 = pi1+taxes+ins+hoa;
  var dscr1 = pmt1>0&&rent>0?rent/pmt1:null;

  // Deploy 236.584 — DSCR-below-1.0 is a MANAGER-EXCEPTION case, not a hard
  // stop. Waive the floor when the admin sandbox is on OR a manager exception
  // has been granted (raw.dscrException, set by the sizer's Below-1.0 ack). The
  // loan then prices normally through the 1.00-1.19 band below. We still tag the
  // error return with dscr + dscrBelowMin so the sizer can show a "Submit
  // manager exception" button on the ineligible card.
  if (dscr1!==null && dscr1<1.0 && !adminSandbox && raw.dscrException!==true) {
    return {error:'DSCR '+dscr1.toFixed(2)+'x is below minimum 1.00x.' + EXCEPTION_HINT, dscr: dscr1, dscrBelowMin: true};
  }

  // DSCR adj
  var dscrAdj = 0;
  if (dscr1!==null) {
    var dk = dscr1>=1.20?'1.20+':'1.00-1.19';
    dscrAdj = DIYA.dscr[dk][ci];
    adjs.push({label:'DSCR ('+dk+')', value:dscrAdj});
  }

  var finalRate = ratePass1 + dscrAdj;
  var piFinal = calcPI(loan, finalRate/100, isIO);
  var pmtFinal = piFinal+taxes+ins+hoa;
  var dscrFinal = pmtFinal>0&&rent>0?rent/pmtFinal:null;

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
  };
}

// ── Export root: browser global + CommonJS for the test runner ─────
var _SLA_DSCR_API = {
  DIYA: DIYA, FEES: FEES, GUIDELINES: GUIDELINES,
  ltvCol: ltvCol, calcPI: calcPI,
  validateGuidelines: validateGuidelines, getFICOMin: getFICOMin,
  EXCEPTION_HINT: EXCEPTION_HINT,
  priceDSCR: priceDSCR,
};
if (typeof window !== 'undefined') window.SLA_DSCR = _SLA_DSCR_API;
if (typeof module !== 'undefined' && module.exports) module.exports = _SLA_DSCR_API;
})();
