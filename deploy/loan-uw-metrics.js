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
    // The SAME gate as the Underwriting tab's mount(): RTL and DSCR only. programOf() on
    // its own calls everything that is not 'dscr' RTL -- a GUC loan, or a legacy loan with
    // no toolType (a DSCR loan by this page's own default) -- and RTL ratios on a loan
    // the engine was never vetted for are worse than no panel.
    var tt = String(loan.toolType || '').toLowerCase();
    if (tt !== 'rtl' && tt !== 'dscr') return null;
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
      if (unver) unverified++;
      return { key: def.k, label: def.label || field.label, from: def.from || (r.calc ? 'Calculated' : (field.sourceNote || '')),
        display: display, empty: empty, prov: prov, note: note, flag: !!r.flag, calc: !!r.calc,
        unverified: unver, editable: !!r.editable, hasEntry: !!data[def.k] };
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
        var out = [];
        ['account1', 'account2', 'account3', 'account4', 'account5'].forEach(function (k, i) {
          var e = data[k], v = (e && e.value && typeof e.value === 'object') ? e.value : null;
          var used = !!(v && (num(v.balance) > 0 || v.type));
          var unver = !!(used && e.isAI && !e.verified);
          if (unver) unverified++;
          var w = used ? (t.acctWeight ? t.acctWeight(v) : num(v.weight)) : 0;
          out.push({ key: k, label: used && v.type ? v.type : 'Account ' + (i + 1), from: 'Most Recent Account Statement',
            display: used ? money(v.balance) : '', empty: !used,
            prov: used && t.provText ? t.provText(e) : '',
            note: used ? 'Counts ' + money(num(v.balance) * w) + ' at ' + Math.round(w * 100) + '%' : '',
            flag: false, calc: false, unverified: unver, editable: true, account: true,
            acct: used ? { type: v.type || '', balance: num(v.balance), weight: (v.weight == null || v.weight === '') ? '' : num(v.weight) } : { type: '', balance: '', weight: '' },
            hasEntry: !!e });
        });
        // Blank rows are noise in a narrow column: keep every row in use, plus ONE blank
        // so there is always somewhere to add the next account.
        var firstBlank = -1;
        return out.filter(function (r, i) { if (!r.empty) return true; if (firstBlank < 0) { firstBlank = i; return true; } return false; });
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
    var checks = (t.buildChecksSummary ? t.buildChecksSummary(calcLoan, calc) : []) || [];
    return { program: program, sections: sections, checks: checks, unverified: unverified };
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
      '.uwm-acct-ed { grid-column:1 / -1; display:grid; grid-template-columns:1fr 92px 58px; gap:5px; margin-top:3px; }',
      '.uwm-acct-done { grid-column:1 / -1; text-align:right; font-size:11px; font-family:inherit; font-weight:400; color:var(--muted,#6b6459); }',
      '.uwm-acct-ed select, .uwm-acct-ed input { width:100%; box-sizing:border-box; padding:4px 5px; font-size:12px; border:1px solid var(--border,#ddd8d0); border-radius:5px; background:#fff; }'
    ].join('\n');
    var st = document.createElement('style');
    st.setAttribute('data-uwm', '1');
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  var _openAcct = {}; // account rows whose editor is open (page session)

  function rowHtml(r) {
    var rootJs = 'document.getElementById(\'' + PANEL_ID + '\')';
    var cls = 'uw-r-value' + (r.flag ? ' uw-flag' : '') + (r.unverified ? ' uw-unverified' : '') + (r.editable ? ' uw-editable' : '') + (r.account ? ' uw-acct' : '');
    var click = '';
    if (r.editable && !r.account) click = ' onclick="SLA_UW_TAB._edit(\'uw\',\'' + escA(r.key) + '\',' + rootJs + ')" title="Click to edit"';
    if (r.account) click = ' onclick="SLA_UW_METRICS._toggleAcct(\'' + escA(r.key) + '\')" title="Click to edit this account"';
    var val = r.empty ? '<span class="uwm-empty">—</span>' : esc(r.display);
    var bits = [];
    if (r.from) bits.push(esc(r.from));
    if (r.prov && r.prov !== r.from) bits.push(esc(r.prov));
    if (r.hasEntry && !r.account) bits.push('<a href="#" onclick="event.stopPropagation();SLA_UW_TAB._history(\'uw\',\'' + escA(r.key) + '\');return false">history</a>');
    if (r.unverified) bits.push('<a href="#" class="uw-confirm" onclick="event.stopPropagation();SLA_UW_TAB._confirm(\'uw\',\'' + escA(r.key) + '\');return false">✓ Confirm</a>');
    var total = (r.key === 'liquidityTotal' || r.key === 'liquidityRequirement' || r.key === 'reservesRequirement');
    var html = '<div class="uwm-row' + (r.flag ? ' is-flag' : '') + (total ? ' is-total' : '') + '">' +
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
    if (bits.length) html += '<div class="uwm-m">' + bits.join(' · ') + '</div>';
    if (r.note) html += '<div class="uwm-note">' + esc(r.note) + '</div>';
    return html + '</div>';
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

  var _API = { build: build, html: html, refresh: refresh, repaint: repaint, _toggleAcct: _toggleAcct, PANEL_ID: PANEL_ID, LAYOUT: LAYOUT };
  if (typeof window !== 'undefined') window.SLA_UW_METRICS = _API;
  if (typeof module !== 'undefined' && module.exports) module.exports = _API;
})();
