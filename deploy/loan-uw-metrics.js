/**
 * loan-uw-metrics.js — Deploy 237.222 (Mike)
 *
 * The key-metrics panel on Documents > Underwriting, beside the trays. Mike sent the
 * "Underwriting" + "Liquidity Requirements" blocks of his sheet: "these items [are] the
 * important metrics we need to track ... All of this information should be read from and
 * import from documents as they're uploaded. The current larger underwriting tab in the
 * Loan Details is meant to be replaced by this." (No US Citizen / Marital Status; plus
 * Loan Amount and Holdback "just to verify they are correct".)
 *
 * THIS FILE OWNS NO NUMBERS. Every value comes from the same three places the
 * Underwriting tab uses, so the two can never disagree:
 *   SLA_UW_FIELDS  — what a field is and which document it comes from
 *   SLA_UW_TAB     — resolve() (value + provenance), computeCalc() (the ONE set of
 *                    formulas + guideline flags), and the save / confirm / history path
 *   the loan       — uwData (AI-read values land here UNVERIFIED as each document is
 *                    reviewed), plus aivBpo / arvBpo written by the valuation itself
 *
 * ONE deliberate difference from the big tab: ARV and As-is come from the VALUATION once
 * one has been read (the sheet sources both from "BPO/Valuation"), and the ratios below
 * them use those same numbers, so the panel is consistent with itself. Until a valuation
 * is read the term-sheet ARV is shown and labelled as exactly that.
 *
 * Depends on: loan-uw-fields.js, loan-uw-calc.js, loan-uw-tab.js (same deploy or newer —
 * it needs the exports added alongside this file). Mounted by loan-doc-review.js.
 */
(function () {
  var PANEL_ID = 'uwMetricsPanel';

  function T() { return (typeof window !== 'undefined' && window.SLA_UW_TAB) || null; }
  function F() { return (typeof window !== 'undefined' && window.SLA_UW_FIELDS) || null; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function escA(s) { return esc(s).replace(/"/g, '&quot;'); }
  function num(v) { if (v == null || v === '') return 0; var n = Number(String(v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : 0; }
  function money(n) { return '$' + Math.round(num(n)).toLocaleString('en-US'); }
  function copy(o) { var out = {}; Object.keys(o || {}).forEach(function (k) { out[k] = o[k]; }); return out; }

  // The sheet, in the sheet's order. `k` is a registry key (dataset 'uw'); `special` rows
  // are loan-record values the registry keeps on the Lightning side or not at all.
  // `from` is the sheet's own "where this comes from" column.
  var LAYOUT = {
    rtl: [
      { title: 'Underwriting', rows: [
        { special: 'arv',            label: 'ARV',                    from: 'BPO / Valuation' },
        { special: 'asIs',           label: 'As-is Price',            from: 'BPO / Valuation' },
        { k: 'purchasePrice',        label: 'Purchase Price',         from: 'PSA / Assignment' },
        { k: 'assignmentFee',        label: 'Assignment Fee',         from: 'PSA / Assignment' },
        { k: 'downPayment',          label: 'Down Payment',           from: 'Term Sheet' },
        { k: 'titleEscrowFees',      label: 'Title/Escrow Fees',      from: 'HUD Statement' },
        { k: 'lowCredit',            label: 'Low Credit',             from: 'Credit Report' },
        { k: 'middleCredit',         label: 'Middle Credit',          from: 'Credit Report' },
        { k: 'monthlyPayment',       label: 'Monthly Payment' },
        { k: 'ltarv',                label: 'LTARV' },
        { k: 'ltc',                  label: 'LTC' },
        { k: 'ltaiv',                label: 'LTAIV' },
        { k: 'assignmentToPurchase', label: 'Assignment to Purchase' },
        { special: 'loanAmount',     label: 'Loan Amount',            from: 'Term Sheet' },
        { special: 'holdback',       label: 'Holdback',               from: 'Term Sheet' }
      ] },
      { title: 'Liquidity Requirements', rows: [
        { special: 'accounts' },
        { k: 'emd',                  label: 'EMD',                    from: 'EMD Receipt from Title' },
        { k: 'liquidityTotal',       label: 'Total' },
        { k: 'liquidityRequirement', label: 'Liquidity Requirement' }
      ] }
    ],
    dscr: [
      { title: 'Underwriting', rows: [
        { k: 'appraisedValue',       label: 'Appraised Value',        from: 'Appraisal' },
        { k: 'rents',                label: 'Rents',                  from: 'Appraisal or lease' },
        { k: 'purchasePrice',        label: 'Purchase Price',         from: 'PSA / Assignment' },
        { k: 'downPayment',          label: 'Down Payment',           from: 'Term Sheet' },
        { k: 'lowCredit',            label: 'Low Credit',             from: 'Credit Report' },
        { k: 'middleCredit',         label: 'Middle Credit',          from: 'Credit Report' },
        { k: 'monthlyTax',           label: 'Monthly Tax',            from: 'Tax Certificate' },
        { k: 'monthlyHOI',           label: 'Monthly HOI',            from: 'EOI or Declarations' },
        { k: 'monthlyHOA',           label: 'Monthly HOA',            from: 'Title Commitment' },
        { k: 'monthlyPI',            label: 'Monthly P&I' },
        { k: 'monthlyPayment',       label: 'Monthly Payment (PITIA)' },
        { k: 'ltv',                  label: 'LTV' },
        { k: 'dscr',                 label: 'DSCR' },
        { special: 'loanAmount',     label: 'Loan Amount',            from: 'Term Sheet' }
      ] },
      { title: 'Liquidity Requirements', rows: [
        { special: 'accounts' },
        { k: 'emd',                  label: 'EMD',                    from: 'HUD' },
        { k: 'liquidityTotal',       label: 'Total' },
        { k: 'reservesRequirement',  label: 'Reserves Requirement' }
      ] }
    ]
  };

  // What the VALUATION says, when one has been read. A value a person typed or confirmed
  // on the As-is row still wins over the AI's reading of the same document.
  function valuation(loan, data) {
    var arvBpo = num(loan.arvBpo), arvTs = num(loan.arv);
    var arv = arvBpo > 0
      ? { n: arvBpo, read: true, note: (arvTs > 0 && Math.abs(arvTs - arvBpo) >= 1) ? 'Term sheet says ' + money(arvTs) : '' }
      : { n: arvTs, read: false, note: '' };
    var e = data.asIsPrice;
    var human = !!(e && e.value !== undefined && e.value !== '' && (e.isAI !== true || e.verified === true));
    var aiv = num(loan.aivBpo);
    var asIs = human ? { n: num(e.value), fromLoan: false }
      : (aiv > 0 ? { n: aiv, fromLoan: true } : { n: num(e && e.value), fromLoan: false });
    return { arv: arv, asIs: asIs };
  }

  // Deploy 237.224 -- the AI's "⚠ VERIFY: ..." tail on an aiNote (uw-field-write): the one
  // thing a person should look at before trusting the number. Shown as an icon, not a line.
  function doubtOf(entry) {
    var s = entry && entry.aiNote ? String(entry.aiNote) : '';
    var i = s.indexOf('⚠ VERIFY:');
    return i >= 0 ? s.slice(i + '⚠ VERIFY:'.length).trim() : '';
  }

  function holdbackOf(loan) {
    var v = (typeof window !== 'undefined' && typeof window._ldRehabHoldback === 'function')
      ? window._ldRehabHoldback(loan) : (loan && loan.rehabBudget);
    return num(v);
  }

  /**
   * The panel as data. Pure: same loan in, same rows out — this is what the gate runs.
   * Returns null when the engine is not on the page (the caller then draws nothing).
   */
  function build(loan) {
    var t = T(), f = F();
    if (!t || !f || !f.fieldsFor || !t.computeCalc || !t.resolve || !t.programOf) return null;
    loan = loan || {};
    // The SAME gate as the Underwriting tab's mount(). Deploy 237.223 (Mike: "the GUC
    // loans have the same basic rules as RTLs") -- GUC runs the RTL engine; its loanType is
    // 'construction', which the Colchis cap tables already carry. A legacy loan with no
    // toolType still gets nothing: programOf() alone would run RTL math on it.
    var tt = String(loan.toolType || '').toLowerCase();
    if (tt !== 'rtl' && tt !== 'dscr' && tt !== 'guc') return null;
    var program = t.programOf(loan) === 'dscr' ? 'dscr' : 'rtl';
    var data = (loan.uwData && typeof loan.uwData === 'object') ? loan.uwData : {};
    var byKey = {};
    f.fieldsFor(program, 'uw').forEach(function (x) { byKey[x.key] = x; });

    var val = valuation(loan, data);
    var calcLoan = loan, calcData = data;
    if (program === 'rtl') {
      if (val.arv.read) { calcLoan = copy(loan); calcLoan.arv = val.arv.n; }
      if (val.asIs.fromLoan) { calcData = copy(data); calcData.asIsPrice = { value: val.asIs.n }; }
    }
    var calc = t.computeCalc(calcLoan, calcData);
    var cv = (calc && calc.values) || {};
    var unverified = 0;

    function regRow(def) {
      var field = byKey[def.k];
      if (!field) return null;
      var r = t.resolve(field, calcLoan, data, calc) || {};
      var entry = r.entry || null;
      var unver = !!(entry && entry.isAI && !entry.verified);
      var empty = (r.value === '' || r.value == null);
      var display = empty ? '' : (r.calc ? String(r.value) : String(t.fmtDisplay ? t.fmtDisplay(def.k, r.value) : r.value));
      var prov = r.prov || '';
      var note = '';
      if (def.k === 'downPayment' && empty && program === 'rtl' && t.calcContext) {
        var cc = t.calcContext(calcLoan, calcData) || {};
        if (num(cc.downPayment) > 0) { display = money(cc.downPayment); empty = false; prov = 'Purchase price less the initial advance'; }
      }
      if (def.k === 'assignmentFee' && cv.assignmentDerived && num(cv.assignmentFeeEffective) > 0) {
        note = 'Using ' + money(cv.assignmentFeeEffective) + ' (assignment price less PSA price)';
      }
      if (def.k === 'ltarv' && program === 'rtl') prov = val.arv.read ? 'Loan ÷ the valuation’s ARV' : 'Loan ÷ term-sheet ARV (no valuation read yet)';
      // Deploy 237.223 (Mike) -- LTAIV is the INITIAL advance over as-is, so on a rehab
      // loan say which number went on top; "just to verify" means showing the work.
      if (def.k === 'ltaiv' && program === 'rtl' && num(cv.initialAdvance) > 0 && num(cv.initialAdvance) < num(loan.loanAmt)) {
        note = 'Initial advance ' + money(cv.initialAdvance) + ' (loan less the holdback) over as-is';
      }
      // Deploy 237.224 (Mike) -- Low / Middle Credit are DERIVED across every guarantor
      // (lowest / highest of their middle scores, uw-field-write deriveGuarantorCredit);
      // the entry's sourceNote is the working: "Lowest of the 2 guarantors' middle scores —
      // K. Lingan 723 (pulled) · J. Doe 678 (report)".
      if ((def.k === 'lowCredit' || def.k === 'middleCredit') && entry && entry.derived && entry.sourceNote) note = entry.sourceNote;
      if (unver) unverified++;
      return { key: def.k, label: def.label || field.label, from: def.from || (r.calc ? 'Calculated' : (field.sourceNote || '')),
        display: display, empty: empty, prov: prov, note: note, flag: !!r.flag, calc: !!r.calc,
        unverified: unver, editable: !!r.editable, hasEntry: !!data[def.k], alert: doubtOf(entry) };
    }

    function specialRows(def) {
      if (def.special === 'arv') {
        return [{ key: 'arv', label: def.label, from: val.arv.read ? def.from : 'Term Sheet',
          display: val.arv.n > 0 ? money(val.arv.n) : '', empty: !(val.arv.n > 0),
          prov: val.arv.read ? 'Read from the valuation' : (val.arv.n > 0 ? 'No valuation read yet — this is the term-sheet ARV' : ''),
          note: val.arv.note, flag: false, calc: false, unverified: false, editable: false, hasEntry: false }];
      }
      if (def.special === 'asIs') {
        var e = data.asIsPrice || null;
        var unver = !val.asIs.fromLoan && !!(e && e.isAI && !e.verified);
        if (unver) unverified++;
        return [{ key: 'asIsPrice', label: def.label, from: def.from,
          display: val.asIs.n > 0 ? money(val.asIs.n) : '', empty: !(val.asIs.n > 0),
          prov: val.asIs.fromLoan ? 'Read from the valuation' : (e && t.provText ? t.provText(e) : ''),
          note: '', flag: false, calc: false, unverified: unver, editable: true, hasEntry: !!e }];
      }
      if (def.special === 'loanAmount') {
        var la = num(loan.loanAmt);
        return [{ key: 'loanAmount', label: def.label, from: def.from, display: la > 0 ? money(la) : '', empty: !(la > 0),
          prov: 'From the loan record', note: '', flag: false, calc: false, unverified: false, editable: false, hasEntry: false }];
      }
      if (def.special === 'holdback') {
        var hb = holdbackOf(loan);
        var sowE = data.rehabBudget, sow = num(sowE && sowE.value);
        var off = hb > 0 && sow > 0 && Math.abs(hb - sow) >= 1;
        return [{ key: 'constructionHoldback', label: def.label, from: def.from, display: hb > 0 ? money(hb) : (program === 'rtl' ? '$0' : ''),
          empty: false, prov: 'From the loan record',
          note: sow > 0 ? (off ? 'The SOW total reads ' + money(sow) : '✓ Matches the SOW total') : '',
          flag: off, calc: false, unverified: false, editable: false, hasEntry: false }];
      }
      if (def.special === 'accounts') {
        // Deploy 237.224 (Mike: "Account 1: $XXXX (sub text - checking account) ... showing
        // the account number, amount, and what exactly it is, and then the sub total").
        // The weight note is gone; anything the AI wants a person to check is an alert icon.
        var out = [], rawSum = 0, weightedSum = 0, inUse = 0;
        ['account1', 'account2', 'account3', 'account4', 'account5'].forEach(function (k, i) {
          var e = data[k], v = (e && e.value && typeof e.value === 'object') ? e.value : null;
          var used = !!(v && (num(v.balance) > 0 || v.type));
          var unver = !!(used && e.isAI && !e.verified);
          if (unver) unverified++;
          var w = used ? (t.acctWeight ? t.acctWeight(v) : num(v.weight)) : 0;
          if (used) { inUse++; rawSum += num(v.balance); weightedSum += num(v.balance) * w; }
          var what = used ? [v.name || v.type || '', (v.name && v.type) ? v.type : ''].filter(Boolean).join(' · ') + (v.last4 ? ' ••' + String(v.last4) : '') : '';
          out.push({ key: k, label: 'Account ' + (i + 1), from: '',
            display: used ? money(v.balance) : '', empty: !used,
            sub: what,
            prov: used ? (e.isAI ? 'AI' : (t.provText ? t.provText(e) : '')) : '',
            note: '', alert: used ? doubtOf(e) : '',
            flag: false, calc: false, unverified: unver, editable: true, account: true,
            acct: used ? { type: v.type || '', balance: num(v.balance), weight: (v.weight == null || v.weight === '') ? '' : num(v.weight) } : { type: '', balance: '', weight: '' },
            hasEntry: !!e });
        });
        // Blank rows are noise in a narrow column: keep every row in use, plus ONE blank
        // so there is always somewhere to add the next account.
        var firstBlank = -1;
        out = out.filter(function (r, i) { if (!r.empty) return true; if (firstBlank < 0) { firstBlank = i; return true; } return false; });
        if (inUse) {
          out.push({ key: 'accountsSubtotal', label: 'Subtotal', from: '', display: money(rawSum), empty: false,
            prov: (Math.abs(weightedSum - rawSum) >= 1) ? money(weightedSum) + ' counts toward liquidity after account weights' : '',
            note: '', flag: false, calc: true, unverified: false, editable: false, subtotal: true, hasEntry: false });
        }
        return out;
      }
      return [];
    }

    var sections = LAYOUT[program].map(function (sec) {
      var rows = [];
      sec.rows.forEach(function (def) {
        if (def.special) rows = rows.concat(specialRows(def));
        else { var r = regRow(def); if (r) rows.push(r); }
      });
      return { title: sec.title, rows: rows };
    });
    // Deploy 237.223 (Mike: "you can hide the old underwriting tab now") -- everything
    // else that tab held (valuation date / provider / sq ft, entity TIN, flood zone,
    // insurance, the SOW budget...) feeds the trade tapes and must keep a place where a
    // person can see, correct and confirm it. Folded below the sheet, collapsed.
    var shownKeys = { arv: 1, asIsPrice: 1, loanAmount: 1, constructionHoldback: 1, usCitizen: 1, maritalStatus: 1 };
    sections.forEach(function (s) { s.rows.forEach(function (r) { shownKeys[r.key] = 1; }); });
    var moreRows = [];
    f.fieldsFor(program, 'uw').forEach(function (x) {
      if (x.accountRow || shownKeys[x.key]) return;
      var r = regRow({ k: x.key, from: x.sourceNote || '' });
      if (r) moreRows.push(r);
    });
    var checks = (t.buildChecksSummary ? t.buildChecksSummary(calcLoan, calc) : []) || [];
    return { program: program, sections: sections, checks: checks, unverified: unverified,
      more: { rows: moreRows, filled: moreRows.filter(function (r) { return !r.empty; }).length } };
  }

  // ── drawing ───────────────────────────────────────────────────────────────
  var _styled = false;
  function ensureStyles() {
    if (_styled || typeof document === 'undefined') return;
    _styled = true;
    var css = [
      '.uwm { background:#fff; border:1px solid var(--border,#ddd8d0); border-radius:10px; font-size:12.5px; overflow:hidden; }',
      '.uwm-hd { display:flex; align-items:center; gap:8px; padding:10px 12px; border-bottom:1px solid var(--border,#ddd8d0); background:var(--bg,#f0ece5); }',
      '.uwm-hd b { font-size:13px; flex:1; }',
      '.uwm-re { border:1px solid var(--border,#ddd8d0); background:#fff; border-radius:6px; cursor:pointer; font-size:12px; padding:2px 7px; }',
      '.uwm-re[disabled] { opacity:.5; cursor:default; }',
      '.uwm-sub { padding:7px 12px; font-size:11.5px; color:var(--muted,#6b6459); border-bottom:1px solid var(--border,#ddd8d0); line-height:1.35; }',
      '.uwm-chk { padding:7px 12px; font-size:12px; border-bottom:1px solid var(--border,#ddd8d0); }',
      '.uwm-chk.bad { background:rgba(124,31,31,0.07); color:var(--danger,#7c1f1f); }',
      '.uwm-chk.ok { background:rgba(15,118,110,0.07); color:#0f766e; }',
      '.uwm-chk ul { margin:4px 0 0 16px; padding:0; }',
      '.uwm-ai { padding:6px 12px; font-size:11.5px; background:rgba(181,113,45,0.10); color:var(--gold-mid,#b5712d); border-bottom:1px solid var(--border,#ddd8d0); }',
      '.uwm-secs { display:grid; grid-template-columns:repeat(auto-fit,minmax(270px,1fr)); }',
      '.uwm-st { padding:7px 12px; font-weight:700; font-size:11px; letter-spacing:.04em; text-transform:uppercase; color:var(--muted,#6b6459); background:rgba(0,0,0,0.025); border-top:1px solid var(--border,#ddd8d0); border-bottom:1px solid var(--border,#ddd8d0); }',
      '.uwm-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:2px 10px; padding:6px 12px; border-bottom:1px solid rgba(0,0,0,0.05); align-items:baseline; }',
      '.uwm-l { color:var(--ink,#2b2722); }',
      '.uwm .uw-r-value { text-align:right; font-family:\'DM Mono\',monospace; font-weight:600; padding:1px 5px; border-radius:4px; min-width:84px; }',
      '.uwm .uw-r-value.uw-editable { cursor:pointer; }',
      '.uwm .uw-r-value.uw-editable:hover { outline:1px dashed var(--gold,#C8813A); }',
      '.uwm-empty { color:#b9b2a6; font-weight:400; }',
      '.uwm-m { grid-column:1 / -1; font-size:11px; color:var(--muted,#6b6459); line-height:1.35; }',
      '.uwm-m a { color:inherit; }',
      '.uwm-m .uw-confirm { color:#fff; }',
      '.uwm-note { grid-column:1 / -1; font-size:11px; color:var(--ink,#2b2722); }',
      '.uwm-row.is-flag .uwm-note { color:var(--danger,#7c1f1f); font-weight:600; }',
      '.uwm-row.is-total { background:rgba(0,0,0,0.025); font-weight:600; }',
      '.uwm-row.is-sub { border-top:1px solid var(--border,#ddd8d0); }',
      '.uwm-row.is-sub .uwm-l { color:var(--muted,#6b6459); font-style:italic; }',
      '.uwm-sub { grid-column:1 / -1; font-size:11.5px; color:var(--ink,#2b2722); }',
      '.uwm .uw-r-value { position:relative; }',
      '.uwm-alert { border:none; background:none; cursor:pointer; color:var(--gold-mid,#b5712d); font-size:13px; line-height:1; padding:0 0 0 5px; vertical-align:baseline; }',
      '.uwm-alert:hover { color:var(--danger,#7c1f1f); }',
      '.uwm-pop { position:absolute; right:0; top:100%; z-index:20; margin-top:4px; max-width:260px; min-width:160px; padding:8px 10px; background:#fffdf7; color:var(--ink,#2b2722); border:1px solid var(--gold-mid,#b5712d); border-radius:8px; box-shadow:0 6px 18px rgba(0,0,0,0.14); font:12px/1.4 inherit; font-family:inherit; font-weight:400; text-align:left; white-space:normal; }',
      '.uwm-acct-ed { grid-column:1 / -1; display:grid; grid-template-columns:1fr 92px 58px; gap:5px; margin-top:3px; }',
      '.uwm-more > summary { cursor:pointer; list-style:none; }',
      '.uwm-more > summary::-webkit-details-marker { display:none; }',
      '.uwm-more > summary::before { content:"\\25B8 "; }',
      '.uwm-more[open] > summary::before { content:"\\25BE "; }',
      '.uwm-acct-done { grid-column:1 / -1; text-align:right; font-size:11px; font-family:inherit; font-weight:400; color:var(--muted,#6b6459); }',
      '.uwm-acct-ed select, .uwm-acct-ed input { width:100%; box-sizing:border-box; padding:4px 5px; font-size:12px; border:1px solid var(--border,#ddd8d0); border-radius:5px; background:#fff; }'
    ].join('\n');
    var st = document.createElement('style');
    st.setAttribute('data-uwm', '1');
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  var _openAcct = {}; // account rows whose editor is open (page session)
  var _moreOpen = false; // "More from the documents" stays open across repaints once opened
  function _moreToggled(open) { _moreOpen = !!open; }

  function rowHtml(r) {
    var rootJs = 'document.getElementById(\'' + PANEL_ID + '\')';
    var cls = 'uw-r-value' + (r.flag ? ' uw-flag' : '') + (r.unverified ? ' uw-unverified' : '') + (r.editable ? ' uw-editable' : '') + (r.account ? ' uw-acct' : '');
    var click = '';
    if (r.editable && !r.account) click = ' onclick="SLA_UW_TAB._edit(\'uw\',\'' + escA(r.key) + '\',' + rootJs + ')" title="Click to edit"';
    if (r.account) click = ' onclick="SLA_UW_METRICS._toggleAcct(\'' + escA(r.key) + '\')" title="Click to edit this account"';
    var val = r.empty ? '<span class="uwm-empty">—</span>' : esc(r.display);
    // Deploy 237.224 (Mike: "if there is something weird ... have a little alert icon that
    // appears that can be clicked and a tiny pop up appears with that note")
    if (r.alert) val += '<button type="button" class="uwm-alert" title="Something to check — click" data-note="' + escA(r.alert) + '" onclick="event.stopPropagation();SLA_UW_METRICS._note(this)">⚠</button>';
    var bits = [];
    if (r.from) bits.push(esc(r.from));
    if (r.prov && r.prov !== r.from) bits.push(esc(r.prov));
    if (r.hasEntry && !r.account) bits.push('<a href="#" onclick="event.stopPropagation();SLA_UW_TAB._history(\'uw\',\'' + escA(r.key) + '\');return false">history</a>');
    if (r.unverified) bits.push('<a href="#" class="uw-confirm" onclick="event.stopPropagation();SLA_UW_TAB._confirm(\'uw\',\'' + escA(r.key) + '\');return false">✓ Confirm</a>');
    var total = (r.key === 'liquidityTotal' || r.key === 'liquidityRequirement' || r.key === 'reservesRequirement');
    var html = '<div class="uwm-row' + (r.flag ? ' is-flag' : '') + (total ? ' is-total' : '') + (r.subtotal ? ' is-sub' : '') + '">' +
      '<div class="uwm-l">' + esc(r.label) + '</div>';
    if (r.account) {
      // Same three controls, same class names and same handler as the Underwriting tab's
      // account row (SLA_UW_TAB._acct reads them by class), scoped to this panel.
      var open = !!_openAcct[r.key];
      html += '<div class="' + cls + '" data-key="' + escA(r.key) + '"' + (open ? '' : click) + '><span class="uw-v">' + val + '</span>' +
        (open ? acctEditorHtml(r, rootJs) : '') + '</div>';
    } else {
      html += '<div class="' + cls + '" data-key="' + escA(r.key) + '"' + click + '><span class="uw-v">' + val + '</span></div>';
    }
    // the account as the statement printed it: "Chase Business Complete Checking · Business Checking Acct. ••1234"
    if (r.sub) html += '<div class="uwm-sub">' + esc(r.sub) + '</div>';
    if (bits.length) html += '<div class="uwm-m">' + bits.join(' · ') + '</div>';
    if (r.note) html += '<div class="uwm-note">' + esc(r.note) + '</div>';
    return html + '</div>';
  }

  // Deploy 237.224 -- the tiny pop-up behind the alert icon. One at a time; any click
  // elsewhere, Escape, or the icon again closes it.
  function _note(btn) {
    if (typeof document === 'undefined' || !btn) return;
    var open = document.querySelector('.uwm-pop');
    var mine = open && open.previousSibling === btn;
    if (open) open.parentNode.removeChild(open);
    if (mine) return;
    var pop = document.createElement('div');
    pop.className = 'uwm-pop';
    pop.setAttribute('role', 'note');
    pop.textContent = btn.getAttribute('data-note') || '';
    pop.onclick = function (e) { e.stopPropagation(); };
    btn.parentNode.insertBefore(pop, btn.nextSibling);
    var close = function () {
      if (pop.parentNode) pop.parentNode.removeChild(pop);
      document.removeEventListener('click', close, true);
      document.removeEventListener('keydown', onKey, true);
    };
    var onKey = function (e) { if (e.key === 'Escape') close(); };
    setTimeout(function () {
      document.addEventListener('click', close, true);
      document.addEventListener('keydown', onKey, true);
    }, 0);
  }

  function acctEditorHtml(r, rootJs) {
    var f = F(), weights = (f && f.ACCOUNT_WEIGHTS) || [];
    var a = r.acct || {};
    var opts = '<option value="">— type —</option>' + weights.map(function (w) {
      return '<option value="' + escA(w.type) + '"' + (a.type === w.type ? ' selected' : '') + '>' + esc(w.type) + '</option>';
    }).join('');
    var on = ' onclick="event.stopPropagation()" onchange="SLA_UW_TAB._acct(\'uw\',\'' + escA(r.key) + '\',' + rootJs + ')"';
    return '<div class="uwm-acct-ed">' +
      '<select class="uw-acct-type"' + on + '>' + opts + '</select>' +
      '<input class="uw-acct-bal" type="text" inputmode="decimal" placeholder="balance" value="' + escA(a.balance !== '' && a.balance != null ? money(a.balance) : '') + '"' + on + ' />' +
      '<input class="uw-acct-wt" type="text" placeholder="wt %" title="weight % (defaults from the type)" value="' + escA(a.weight === '' || a.weight == null ? '' : (num(a.weight) * 100) + '%') + '"' + on + ' />' +
      // The open editor takes the cell's own click away, so it needs its own way out.
      '<a href="#" class="uwm-acct-done" onclick="event.stopPropagation();SLA_UW_METRICS._toggleAcct(\'' + escA(r.key) + '\');return false">Done</a>' +
      '</div>';
  }

  function html(loan) {
    ensureStyles();
    var b = build(loan);
    if (!b) return '';
    var chk = b.checks.length
      ? '<div class="uwm-chk bad"><b>⚠ ' + b.checks.length + ' item' + (b.checks.length === 1 ? '' : 's') + ' out of guideline</b><ul>' +
          b.checks.map(function (c) { return '<li><b>' + esc(c.label) + '</b> — ' + esc(c.detail) + '</li>'; }).join('') + '</ul></div>'
      : '<div class="uwm-chk ok">✓ Every check that can be run is within guideline.</div>';
    var ai = b.unverified
      ? '<div class="uwm-ai">' + b.unverified + ' value' + (b.unverified === 1 ? ' was' : 's were') + ' read by AI and ' + (b.unverified === 1 ? 'has' : 'have') + ' not been confirmed. Check each against its document, then Confirm.</div>'
      : '';
    return '<div class="uwm" id="' + PANEL_ID + '">' +
      '<div class="uwm-hd"><b>Key metrics</b>' +
        '<button type="button" class="uwm-re" id="uwmRefreshBtn" onclick="SLA_UW_METRICS.refresh(true)" title="Re-read the loan now">↻</button></div>' +
      '<div class="uwm-sub">Filled in from the documents as each one is reviewed. Click a value to correct it.</div>' +
      chk + ai +
      '<div class="uwm-secs">' + b.sections.map(function (s) {
        return '<div class="uwm-sec"><div class="uwm-st">' + esc(s.title) + '</div>' + s.rows.map(rowHtml).join('') + '</div>';
      }).join('') + '</div>' +
      (b.more && b.more.rows.length
        ? '<details class="uwm-more"' + (_moreOpen ? ' open' : '') + ' ontoggle="SLA_UW_METRICS._moreToggled(this.open)"><summary class="uwm-st">More from the documents · ' + b.more.filled + ' of ' + b.more.rows.length + ' filled</summary>' +
            b.more.rows.map(rowHtml).join('') + '</details>'
        : '') +
    '</div>';
  }

  // Redraw in place (used for the account editor toggle; saves and refreshes come back
  // through SLA_UW_TAB's subscribers, which loan-doc-review.js listens to).
  function repaint() {
    var t = T(), ctx = t && t.ctx && t.ctx();
    var el = (typeof document !== 'undefined') && document.getElementById(PANEL_ID);
    if (!el || !ctx || !ctx.loan || !el.parentNode) return;
    el.parentNode.innerHTML = html(ctx.loan);
  }
  function _toggleAcct(key) { _openAcct[key] = !_openAcct[key]; repaint(); }

  // ── "as they're uploaded" ────────────────────────────────────────────────
  // A review writes its values to the loan on the SERVER. Ask for the loan again, a beat
  // after the review lands (the write and the review save are separate), and fold in
  // what a review can change. Coalesced: a ZIP of twenty documents is one fetch.
  var _timer = null, _inflight = false, _again = false;
  function refresh(now) {
    if (_timer) { clearTimeout(_timer); _timer = null; }
    _timer = setTimeout(function () { _timer = null; _fetch(); }, now ? 0 : 1500);
  }
  function _fetch() {
    var t = T(), ctx = t && t.ctx && t.ctx();
    if (!ctx || !ctx.clientId || !ctx.loanId || !t.mergeFresh) return;
    if (!(window.SLA && SLA.Clients && SLA.Clients.get)) return;
    if (_inflight) { _again = true; return; }
    _inflight = true;
    var btn = document.getElementById('uwmRefreshBtn');
    if (btn) btn.disabled = true;
    SLA.Clients.get(ctx.clientId, ctx.owner ? { owner: ctx.owner } : {}).then(function (r) {
      var client = (r && r.client) || r || {};
      var fresh = (client.loans || []).filter(function (l) { return l && l.id === ctx.loanId; })[0];
      if (fresh) t.mergeFresh(fresh);
    }).catch(function (e) {
      console.warn('[SLA] uw-metrics: refresh failed:', e && e.message);
    }).then(function () {
      _inflight = false;
      var b2 = document.getElementById('uwmRefreshBtn');
      if (b2) b2.disabled = false;
      if (_again) { _again = false; refresh(); }
    });
  }

  var _API = { build: build, html: html, refresh: refresh, repaint: repaint, _toggleAcct: _toggleAcct, _moreToggled: _moreToggled, _note: _note, PANEL_ID: PANEL_ID, LAYOUT: LAYOUT };
  if (typeof window !== 'undefined') window.SLA_UW_METRICS = _API;
  if (typeof module !== 'undefined' && module.exports) module.exports = _API;
})();
