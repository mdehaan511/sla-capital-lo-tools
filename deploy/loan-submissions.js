/**
 * loan-submissions.js — Build downloadable submission tapes for closed
 * loans. Designed to support multiple tape formats (RTL v2025 today,
 * other formats later) via a factory map on window.LoanSubmissions.
 *
 * Deploy 236.29. Loaded by loans.html when the user selects closed
 * loans + clicks "Export Submission Template". The .xlsx is built
 * entirely client-side using SheetJS (lazy-loaded from CDN on first
 * use) so we avoid any 10s Netlify timeout for big batches.
 *
 * Public API:
 *   window.LoanSubmissions.formats              → list of registered formats
 *   window.LoanSubmissions.export(formatKey, payloads, filename)
 *
 * Each payload is { loan, client, borrowerInfo } — borrowerInfo may
 * be null (we don't have a long-app for every loan). Format builders
 * gracefully tolerate missing fields and leave the cell blank.
 *
 * To add a new tape format, register a builder in FORMATS below.
 */
(function () {
  'use strict';

  var SHEETJS_URL = 'https://cdn.jsdelivr.net/npm/xlsx@0.20.3/dist/xlsx.full.min.js';
  var _sheetJsLoaded = false;
  var _sheetJsLoading = null;

  function loadSheetJs() {
    if (_sheetJsLoaded) return Promise.resolve();
    if (_sheetJsLoading) return _sheetJsLoading;
    _sheetJsLoading = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = SHEETJS_URL;
      s.onload = function () { _sheetJsLoaded = true; resolve(); };
      s.onerror = function () { reject(new Error('Failed to load SheetJS from CDN')); };
      document.head.appendChild(s);
    });
    return _sheetJsLoading;
  }

  // ── Tiny utilities ─────────────────────────────────────────────
  function num(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(String(v).replace(/[$,]/g, ''));
    return isFinite(n) ? n : null;
  }
  function str(v) { return v == null ? '' : String(v); }
  // Address parser — small mirror of _shared/address.mjs. Handles
  // "Street, City, ST ZIP" and the comma variants Google Places emits.
  function parseAddress(s) {
    var out = { street1: '', city: '', state: '', zip: '' };
    if (!s) return out;
    var parts = String(s).split(',').map(function (p) { return p.trim(); }).filter(Boolean);
    if (parts.length && /^(USA|US|United States)$/i.test(parts[parts.length - 1])) parts.pop();
    if (!parts.length) return out;
    out.street1 = parts[0];
    if (parts.length === 1) return out;
    var last = parts[parts.length - 1];
    var stateZip   = last.match(/^([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
    var zipOnly    = last.match(/^(\d{5})(?:-\d{4})?$/);
    var stateOnly  = last.match(/^([A-Z]{2})$/);
    if (stateZip) {
      out.state = stateZip[1]; out.zip = stateZip[2];
      if (parts.length >= 3) out.city = parts.slice(1, parts.length - 1).join(', ');
    } else if (zipOnly && parts.length >= 3) {
      out.zip = zipOnly[1];
      var secondLast = parts[parts.length - 2];
      if (/^[A-Z]{2}$/.test(secondLast)) {
        out.state = secondLast;
        if (parts.length >= 4) out.city = parts.slice(1, parts.length - 2).join(', ');
      } else {
        out.city = parts.slice(1, parts.length - 1).join(', ');
      }
    } else if (stateOnly && parts.length >= 2) {
      out.state = stateOnly[1];
      if (parts.length >= 3) out.city = parts.slice(1, parts.length - 1).join(', ');
    } else {
      out.city = parts.slice(1).join(', ');
    }
    return out;
  }
  // Convert YYYY-MM-DD or ISO date strings to a Date — leaves invalid
  // strings as-is so SheetJS will write them as text rather than
  // accidentally claiming "9/15/" is some weird date.
  function asDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return String(v);
    return d;
  }
  // Loan addresses sometimes come single-line, sometimes pre-split.
  // Prefer explicit loan fields if present, fall back to parsed.
  function loanAddressParts(loan) {
    var parsed = parseAddress(loan.address);
    return {
      street: loan.propertyStreet || parsed.street1 || loan.address || '',
      city:   loan.propertyCity   || parsed.city    || '',
      state:  loan.propertyState  || parsed.state   || '',
      zip:    loan.propertyZip    || parsed.zip     || '',
    };
  }

  // ── Format builders ────────────────────────────────────────────
  // Each builder takes the array of payloads and returns:
  //   { headers: [...colHeaders], rows: [[...row1cells], [...row2cells]] }
  // The caller turns that into the actual workbook via SheetJS.

  // RTL v2025 — matches "Loan Submission Template v2025.xlsx". 61 cols
  // matching the original template's "Submission" sheet exactly.
  function buildRtlV2025(payloads) {
    var headers = [
      'Lender Loan ID',            // A
      'Record Identifier',         // B
      'Property Address',          // C
      'Property City',             // D
      'Property State',            // E
      'Property ZIP',              // F
      'Property Type',             // G
      'AIV Units',                 // H
      'ARV Units',                 // I
      'AIV Sqft',                  // J
      'ARV Sqft',                  // K
      'Flood Zone',                // L
      'Property Purchase Date',    // M
      'Property Purchase Price',   // N
      'Assignment Fee',            // O
      'Remaining Rehab Budget',    // P
      'Rehab Spent to Date',       // Q
      'Total Cost Basis',          // R
      'Third Party AIV',           // S
      'Third Party ARV',           // T
      'Valuation Date',            // U
      'Third Party Valuation Type',// V
      'Third Party Valuation Provider', // W
      'Loan Purpose',              // X
      'Loan Strategy',             // Y
      'Origination Date',          // Z
      'Date of First Payment',     // AA
      'Original Maturity Date',    // AB
      'Term (Mo.)',                // AC
      'Total Loan Amount',         // AD
      'Balance At Submission',     // AE
      'Initial Loan Amount',       // AF
      'Initial Rehab Holdback',    // AG
      'Initial Interest Reserve',  // AH
      'Appraisal Holdback',        // AI
      'Note Rate (%)',             // AJ
      'Orig Points (%)',           // AK
      'Original P&I Amount',       // AL
      'Interest Accrual Methodology', // AM
      'Cash Out Amount (Refi)',    // AN
      'Dutch/Non-Dutch',           // AO
      'Initial LTC',               // AP
      'LTAIV',                     // AQ
      'Total LTC',                 // AR
      'LTARV',                     // AS
      'Borrower Name',             // AT
      'Borrower Type',             // AU
      'Experience (# projects in 3yrs)', // AV
      'Foreign National Flag (Y/N)',     // AW
      'Borrower Reserves',         // AX
      'Borrower Address',          // AY
      'Borrower City',             // AZ
      'Borrower State',            // BA
      'Borrower ZIP',              // BB
      'Entity TIN',                // BC
      'Guarantor 1 Name',          // BD
      'Guarantor 1 FICO',          // BE
      'Guarantor 1 DOB',           // BF
      'Guarantor 2 Name',          // BG
      'Guarantor 2 FICO',          // BH
      'Guarantor 2 DOB',           // BI
    ];

    var rows = payloads.map(function (p) {
      var loan   = p.loan   || {};
      var client = p.client || {};
      var bi     = (p.borrowerInfo && p.borrowerInfo.data) || p.borrowerInfo || {};

      var propAddr = loanAddressParts(loan);
      // Note Rate: stored decimal (.085) or already-percent (8.5).
      // Template wants decimal (e.g. 0.0999 for 9.99%).
      var rateRaw = num(loan.rate);
      var rateDecimal = rateRaw == null ? null : (rateRaw > 1 ? rateRaw / 100 : rateRaw);
      var ptsRaw  = num(loan.points);
      var ptsDecimal = ptsRaw == null ? null : (ptsRaw > 1 ? ptsRaw / 100 : ptsRaw);

      // Loan strategy mapping from our RTL loanType → Baseline taxonomy
      var strategy = '';
      switch ((loan.loanType || '').toLowerCase()) {
        case 'bridge':         strategy = 'Bridge'; break;
        case 'fix-flip':
        case 'fix_flip':
        case 'light':
        case 'lightrehab':
        case 'light-rehab':    strategy = 'Rehab'; break;
        case 'heavy':
        case 'heavyrehab':
        case 'heavy-rehab':    strategy = 'Heavy Rehab'; break;
        case 'construction':
        case 'gu':
        case 'ground-up':      strategy = 'Construction'; break;
        case 'transactional':  strategy = 'Bridge'; break;
        default: strategy = '';
      }

      // Loan purpose: our loanPurpose is "purchase"/"refinance"/"cash-out"
      var purposeMap = {
        'purchase':    'Purchase',
        'refinance':   'Refinance',
        'rate-term':   'Refinance',
        'cash-out':    'Cash-Out Refinance',
        'cashout':     'Cash-Out Refinance',
        'cash_out':    'Cash-Out Refinance',
      };
      var purpose = purposeMap[(loan.loanPurpose || '').toLowerCase()] || '';

      // Borrower (entity vs individual). Entity uses LLC name; Individual
      // uses the client name. Type and mailing address come from the
      // long-app where available.
      var borrowerName, borrowerType, borrowerAddr, borrowerCity, borrowerState, borrowerZip, entityTin;
      if (bi && (bi.entityName || bi.borrowerType === 'entity')) {
        borrowerName = bi.entityName || '';
        borrowerType = 'Entity';
        var eAddr = parseAddress(bi.entityAddress || '');
        borrowerAddr  = bi.entityStreet || eAddr.street1 || '';
        borrowerCity  = bi.entityCity   || eAddr.city    || '';
        borrowerState = bi.entityState  || eAddr.state   || '';
        borrowerZip   = bi.entityZip    || eAddr.zip     || '';
        entityTin     = bi.entityTaxId || bi.entityTIN || bi.tin || '';
      } else {
        borrowerName = ((client.firstName || '') + ' ' + (client.lastName || '')).trim();
        borrowerType = 'Individual';
        var mAddr = parseAddress((bi && (bi.borrower1MailingAddress || bi.borrower1HomeAddress)) || client.address || '');
        borrowerAddr  = mAddr.street1;
        borrowerCity  = mAddr.city;
        borrowerState = mAddr.state;
        borrowerZip   = mAddr.zip;
        entityTin     = '';
      }

      // Guarantors. borrower-info captures borrower1 (always present
      // when long-app complete) and borrower2 (co-signer, optional).
      var g1Name = bi && (bi.borrower1FullName ||
        [(bi.borrower1FirstName || ''), (bi.borrower1LastName || '')].filter(Boolean).join(' ').trim())
        || borrowerName;
      var g1Fico = bi && (bi.borrower1Fico || bi.borrower1FICO || '');
      var g1Dob  = bi && (bi.borrower1Dob  || bi.borrower1DOB  || '');
      var g2Name = bi && (bi.borrower2FullName ||
        [(bi.borrower2FirstName || ''), (bi.borrower2LastName || '')].filter(Boolean).join(' ').trim())
        || '';
      var g2Fico = bi && (bi.borrower2Fico || bi.borrower2FICO || '');
      var g2Dob  = bi && (bi.borrower2Dob  || bi.borrower2DOB  || '');

      var foreignNat = bi && bi.borrower1ForeignNational
        ? (String(bi.borrower1ForeignNational).toLowerCase().startsWith('y') ? 'Y' : 'N')
        : '';

      // Origination / maturity. We typically store closeDate (YYYY-MM-DD).
      // First payment + maturity often blank in SLA data — leave as-is.
      var origDate = loan.closeDate || loan.closingDate || loan.originationDate || '';
      var term = num(loan.term);
      var maturity = '';
      if (origDate && term) {
        var od = new Date(origDate);
        if (!isNaN(od.getTime())) {
          od.setMonth(od.getMonth() + Math.round(term));
          maturity = od.toISOString().slice(0, 10);
        }
      }

      var purchasePrice = num(loan.purchasePrice);
      var rehabBudget   = num(loan.rehabBudget);
      var asIsValue     = num(loan.asIsValue);
      var arv           = num(loan.arv);
      var loanAmt       = num(loan.loanAmt);
      var initialAdv    = num(loan.initialAdvance) || loanAmt; // most RTL closed loans = full LA initial

      return [
        loan.id || '',                             // A: Lender Loan ID
        'Loan',                                    // B
        propAddr.street,                           // C
        propAddr.city,                             // D
        propAddr.state,                            // E
        propAddr.zip,                              // F
        '',                                        // G: Property Type — not captured
        '',                                        // H: AIV Units
        '',                                        // I: ARV Units
        num(loan.sqft),                            // J: AIV Sqft
        '',                                        // K: ARV Sqft
        '',                                        // L: Flood Zone
        '',                                        // M: Property Purchase Date
        purchasePrice,                             // N
        '',                                        // O: Assignment Fee
        rehabBudget,                               // P
        '',                                        // Q: Rehab Spent to Date
        '',                                        // R: Total Cost Basis (formula written below)
        asIsValue,                                 // S
        arv,                                       // T
        '',                                        // U: Valuation Date
        '',                                        // V
        '',                                        // W
        purpose,                                   // X
        strategy,                                  // Y
        asDate(origDate),                          // Z
        '',                                        // AA: First payment
        asDate(maturity),                          // AB
        term,                                      // AC
        loanAmt,                                   // AD
        loanAmt,                                   // AE: balance at submission = total at origination
        initialAdv,                                // AF
        rehabBudget,                               // AG: Initial Rehab Holdback
        '',                                        // AH: Initial Interest Reserve
        '',                                        // AI: Appraisal Holdback
        rateDecimal,                               // AJ
        ptsDecimal,                                // AK
        '',                                        // AL: P&I — needs amortization calc
        '30/360',                                  // AM: default
        '',                                        // AN: Cash Out Amount
        loan.dutch ? 'Dutch' : 'Non-Dutch',        // AO
        '', '', '', '',                            // AP-AS: LTC / LTAIV / LTARV — formulas below
        borrowerName,                              // AT
        borrowerType,                              // AU
        num(bi && bi.borrowerExperience),          // AV
        foreignNat,                                // AW
        num(bi && bi.borrowerReserves),            // AX
        borrowerAddr,                              // AY
        borrowerCity,                              // AZ
        borrowerState,                             // BA
        borrowerZip,                               // BB
        entityTin,                                 // BC
        g1Name,                                    // BD
        num(g1Fico),                               // BE
        asDate(g1Dob),                             // BF
        g2Name,                                    // BG
        num(g2Fico),                               // BH
        asDate(g2Dob),                             // BI
      ];
    });

    return { headers: headers, rows: rows };
  }

  var FORMATS = {
    'rtl-v2025': {
      label: 'RTL Submission Template (v2025)',
      filename: 'RTL_Submissions',
      sheetName: 'Submission',
      // Column letters where derived formulas should be written per row
      // (1-based row index passed in). Total Cost Basis = N+O+P+Q;
      // LTC/LTAIV ratios use loan amount over cost basis / values.
      formulasPerRow: function (rowIdx /* 1-based incl header */) {
        return {
          // R: Total Cost Basis = N + O + P + Q
          R: '=IFERROR(N' + rowIdx + '+O' + rowIdx + '+P' + rowIdx + '+Q' + rowIdx + ', "")',
          // AP: Initial LTC = AF / (N + Q)
          AP: '=IFERROR(AF' + rowIdx + '/(N' + rowIdx + '+Q' + rowIdx + '), "")',
          // AQ: LTAIV = AF / S
          AQ: '=IFERROR(AF' + rowIdx + '/S' + rowIdx + ', "")',
          // AR: Total LTC = AD / R
          AR: '=IFERROR(AD' + rowIdx + '/R' + rowIdx + ', "")',
          // AS: LTARV = AD / T
          AS: '=IFERROR(AD' + rowIdx + '/T' + rowIdx + ', "")',
        };
      },
      build: buildRtlV2025,
    },
  };

  function colLetter(n) {
    // 1 → A, 26 → Z, 27 → AA, ...
    var s = '';
    while (n > 0) {
      var rem = (n - 1) % 26;
      s = String.fromCharCode(65 + rem) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }

  function buildWorkbook(formatKey, payloads) {
    var fmt = FORMATS[formatKey];
    if (!fmt) throw new Error('Unknown submission format: ' + formatKey);
    var XLSX = window.XLSX;
    if (!XLSX) throw new Error('SheetJS not loaded yet');

    var built = fmt.build(payloads);
    var aoa = [built.headers].concat(built.rows);
    var ws = XLSX.utils.aoa_to_sheet(aoa);

    // Inject formulas for ratio/total columns. SheetJS reads numeric
    // cells as { v: N }; setting f: '...' makes it a formula cell.
    if (fmt.formulasPerRow) {
      for (var r = 0; r < built.rows.length; r++) {
        var rowIdx = r + 2; // +1 header, +1 to 1-based
        var formulas = fmt.formulasPerRow(rowIdx);
        Object.keys(formulas).forEach(function (col) {
          var ref = col + rowIdx;
          ws[ref] = { t: 'n', f: formulas[col] };
        });
      }
    }

    // Reasonable widths so the file isn't unusable as soon as it opens.
    ws['!cols'] = built.headers.map(function (h) {
      return { wch: Math.min(28, Math.max(11, String(h).length + 2)) };
    });
    // Freeze header row + first column.
    ws['!freeze'] = { xSplit: 1, ySplit: 1 };

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, fmt.sheetName);
    return { wb: wb, fmt: fmt };
  }

  function download(formatKey, payloads, filename) {
    return loadSheetJs().then(function () {
      var built = buildWorkbook(formatKey, payloads);
      var XLSX = window.XLSX;
      var defaultName = built.fmt.filename + '_' +
        new Date().toISOString().slice(0, 10).replace(/-/g, '') + '.xlsx';
      XLSX.writeFile(built.wb, filename || defaultName);
    });
  }

  window.LoanSubmissions = {
    formats: Object.keys(FORMATS).map(function (k) {
      return { key: k, label: FORMATS[k].label };
    }),
    export: download,
    // Exported for testing.
    _internal: { buildWorkbook: buildWorkbook, FORMATS: FORMATS },
  };
})();
