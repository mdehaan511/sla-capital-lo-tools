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
  // Deploy 237.233 (Mike: "keep the subtext to very simple 1 or 2 lines and avoid the
  // paragraphs") -- an entry's aiNote is "<document label> — <where on the doc>", and the
  // "where" half is written freehand by the AI. On a HUD it had started writing the whole
  // derivation in there: every title line item added up, plus a caveat about the owner's
  // policy. Six lines of subtext under a one-line number. The panel now prints the
  // LOCATOR only -- the document already has its own line (`from`) -- and hangs the rest
  // on a "⋯" next to it, so nothing the AI said is lost, it is just not shouted.
  var PROV_MAX = 62;
  function aiLocator(entry) {
    var note = String((entry && entry.aiNote) || '');
    var v = note.indexOf('⚠ VERIFY:'); // that half already has its own ⚠ button
    if (v >= 0) note = note.slice(0, v);
    note = note.replace(/\s*[—–-]\s*$/, '').trim();
    var segs = note.split(' — ');
    var where = segs.length > 1 ? segs.slice(1).join(' — ') : '';
    if (!where) return { text: 'AI', full: '' };
    // The locator ends where the working begins -- a colon, a semicolon, a parenthesis.
    var head = where.split(/[:;(]/)[0].trim() || where;
    var clipped = head.length < where.length; // measured BEFORE the cosmetic rewrite below
    head = head.replace(/\bPages?\s+(\d)/i, 'p.$1'); // "Page 2" reads as "p.2" like the rest
    if (head.length > PROV_MAX) {
      var cut = head.lastIndexOf(' ', PROV_MAX);
      head = head.slice(0, cut > 24 ? cut : PROV_MAX).replace(/[\s,;·—–-]+$/, '');
      clipped = true;
    }
    return { text: 'AI — ' + head, full: clipped ? where : '' };
  }

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
    // Deploy 237.246 -- a what-if ARV goes through the SAME engine, on a copy; the baseline
    // is kept so the banner can say what the ratio was.
    var wiArv = program === 'rtl' ? whatIfArv(loan) : 0;
    var baseLoan = calcLoan;
    if (wiArv) { calcLoan = copy(calcLoan); calcLoan.arv = wiArv; }
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
      var provFull = '';
      // Deploy 237.233 -- the AI's own provenance is rebuilt short here rather than
      // taken from the Underwriting tab's provText, which prints the note whole.
      if (entry && entry.isAI) {
        var loc = aiLocator(entry);
        prov = loc.text + (entry.verified ? ' (confirmed)' : ' — UNVERIFIED');
        provFull = loc.full;
      }
      var note = '';
      if (def.k === 'downPayment' && empty && program === 'rtl' && t.calcContext) {
        var cc = t.calcContext(calcLoan, calcData) || {};
        if (num(cc.downPayment) > 0) { display = money(cc.downPayment); empty = false; prov = 'Purchase price less the initial advance'; }
      }
      if (def.k === 'assignmentFee' && cv.assignmentDerived && num(cv.assignmentFeeEffective) > 0) {
        note = 'Using ' + money(cv.assignmentFeeEffective) + ' (assignment price less PSA price)';
      }
      if (def.k === 'ltarv' && program === 'rtl') prov = wiArv ? 'Loan ÷ the what-if ARV (not saved)' : (val.arv.read ? 'Loan ÷ the valuation’s ARV' : 'Loan ÷ term-sheet ARV (no valuation read yet)');
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
        display: display, empty: empty, prov: prov, provFull: provFull, note: note, flag: !!r.flag, calc: !!r.calc,
        unverified: unver, editable: !!r.editable, hasEntry: !!data[def.k], alert: doubtOf(entry) };
    }

    function specialRows(def) {
      if (def.special === 'arv') {
        // Deploy 237.246 -- while a what-if is on, the row IS the what-if, and says so.
        if (wiArv) {
          return [{ key: 'arv', label: def.label, from: 'What-if', display: money(wiArv), empty: false,
            prov: 'Not saved — the ' + (val.arv.read ? 'valuation' : 'term sheet') + ' reads ' + (val.arv.n > 0 ? money(val.arv.n) : 'nothing'),
            note: '', flag: false, calc: false, unverified: false, editable: true, tryArv: true, whatIf: true, hasEntry: false }];
        }
        var fromTxt = val.arv.read ? def.from : 'Term Sheet';
        var provTxt = val.arv.read ? 'Read from the valuation' : (val.arv.n > 0 ? 'No valuation read yet — this is the term-sheet ARV' : '');
        // ...and once an underwriter has ADOPTED a what-if (loan-uw-field-save, dataset
        // 'loan'), the figure is theirs, not the valuation's: say who, when, and what the
        // valuation read. The marker only counts while the loan still carries its number.
        var ov = (loan.arvBpoUwOverride && typeof loan.arvBpoUwOverride === 'object') ? loan.arvBpoUwOverride : null;
        if (ov && val.arv.read && num(ov.value) === val.arv.n) {
          fromTxt = 'Underwriting';
          provTxt = 'Set by ' + (ov.byName || ov.by || 'underwriting') + (ov.at ? ' ' + shortDate(ov.at) : '') +
            (num(ov.replaced) > 0 ? ' — the ' + (ov.replacedFromBpo ? 'valuation' : 'record') + ' read ' + money(ov.replaced) : '');
        }
        return [{ key: 'arv', label: def.label, from: fromTxt,
          display: val.arv.n > 0 ? money(val.arv.n) : '', empty: !(val.arv.n > 0),
          prov: provTxt, note: val.arv.note, flag: false, calc: false, unverified: false,
          editable: true, tryArv: true, hasEntry: false }];
      }
      if (def.special === 'asIs') {
        var e = data.asIsPrice || null;
        var unver = !val.asIs.fromLoan && !!(e && e.isAI && !e.verified);
        if (unver) unverified++;
        // Deploy 237.233 -- same short locator as every other AI-read row.
        var aLoc = (e && e.isAI) ? aiLocator(e) : null;
        return [{ key: 'asIsPrice', label: def.label, from: def.from,
          display: val.asIs.n > 0 ? money(val.asIs.n) : '', empty: !(val.asIs.n > 0),
          prov: val.asIs.fromLoan ? 'Read from the valuation'
            : (aLoc ? aLoc.text + (e.verified ? ' (confirmed)' : ' — UNVERIFIED')
                    : (e && t.provText ? t.provText(e) : '')),
          provFull: aLoc ? aLoc.full : '',
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
            acct: used ? { type: v.type || '', balance: num(v.balance), weight: (v.weight == null || v.weight === '') ? '' : num(v.weight), name: v.name || '', last4: v.last4 || '' } : { type: '', balance: '', weight: '', name: '', last4: '' },
            hasEntry: !!e });
        });
        // Deploy 237.226 (Mike: "add in the ability for the UW to add in another account just
        // in case it doesn't pull in correctly") -- blank rows are gone; an explicit "+ Add an
        // account" opens the editor on the first free row. A blank row is drawn only while
        // its editor is open.
        var free = out.filter(function (r) { return r.empty; }).map(function (r) { return r.key; });
        out = out.filter(function (r) { return !r.empty || _openAcct[r.key]; });
        out.push({ key: 'accountsAdd', label: '', from: '', display: '', empty: true, addAccount: true, freeSlot: free.filter(function (k) { return !_openAcct[k]; })[0] || '',
          prov: '', note: '', flag: false, calc: false, unverified: false, editable: false, hasEntry: false });
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
    // Deploy 237.246 -- what the what-if changed, for the banner and the confirmation:
    // the ratio now and at the baseline, both from the engine.
    var whatIf = null;
    if (wiArv) {
      var baseCalc = t.computeCalc(baseLoan, calcData);
      var lf = byKey.ltarv;
      var baseChecks = (t.buildChecksSummary ? t.buildChecksSummary(baseLoan, baseCalc) : []) || [];
      whatIf = { arv: wiArv, base: val.arv.n, baseFrom: val.arv.read ? 'valuation' : 'term sheet',
        ltarv: lf ? String((t.resolve(lf, calcLoan, data, calc) || {}).value || '') : '',
        ltarvBase: lf ? String((t.resolve(lf, baseLoan, data, baseCalc) || {}).value || '') : '',
        checks: checks.length, checksBase: baseChecks.length };
    }
    return { program: program, sections: sections, checks: checks, unverified: unverified, whatIf: whatIf,
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
      // Deploy 237.233 -- position:relative so the "⋯" note pops against this line
      // (.uwm-pop is absolutely placed against its nearest positioned ancestor).
      '.uwm-m { grid-column:1 / -1; position:relative; font-size:11px; color:var(--muted,#6b6459); line-height:1.35; }',
      '.uwm-m a { color:inherit; }',
      '.uwm-m .uw-confirm { color:#fff; }',
      '.uwm-why { border:none; background:none; cursor:pointer; color:var(--gold-mid,#b5712d); font:inherit; line-height:1; padding:0 2px; letter-spacing:1px; }',
      '.uwm-why:hover { color:var(--ink,#2b2722); }',
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
      '.uwm-acct-ed { grid-column:1 / -1; display:grid; grid-template-columns:1fr 64px; gap:5px; margin-top:3px; }',
      '.uwm-acct-ed .uw-acct-type { grid-column:1 / -1; }',
      '.uwm-acct-btns { grid-column:1 / -1; display:flex; justify-content:flex-end; gap:10px; font-size:11px; font-family:inherit; font-weight:400; }',
      '.uwm-acct-cancel { color:var(--muted,#6b6459); }',
      '.uwm-add { padding:6px 12px 8px; }',
      '.uwm-add a { font-size:12px; color:var(--gold-mid,#b5712d); text-decoration:none; font-weight:600; }',
      '.uwm-add a:hover { text-decoration:underline; }',
      '.uwm-more > summary { cursor:pointer; list-style:none; }',
      '.uwm-more > summary::-webkit-details-marker { display:none; }',
      '.uwm-more > summary::before { content:"\\25B8 "; }',
      '.uwm-more[open] > summary::before { content:"\\25BE "; }',
      '.uwm-acct-done { grid-column:1 / -1; text-align:right; font-size:11px; font-family:inherit; font-weight:400; color:var(--muted,#6b6459); }',
      '.uwm-acct-ed select, .uwm-acct-ed input { width:100%; box-sizing:border-box; padding:4px 5px; font-size:12px; border:1px solid var(--border,#ddd8d0); border-radius:5px; background:#fff; }',
      // Deploy 237.246 -- the what-if: an amber bar, an amber cell, and the confirmation card
      '.uwm-wi-bar { padding:8px 12px; font-size:12px; line-height:1.45; background:rgba(200,129,58,0.12); border-bottom:1px solid var(--gold,#C8813A); }',
      '.uwm-wi-btns { display:flex; gap:8px; margin-top:6px; flex-wrap:wrap; }',
      '.uwm-wi-bar .uwm-re { font-weight:600; }',
      '.uwm .uw-r-value.uwm-wi { background:rgba(200,129,58,0.16); outline:1px dashed var(--gold,#C8813A); }',
      '.uwm .uw-r-value[data-key="arv"].uw-editable:hover { outline:1px dashed var(--gold,#C8813A); }',
      '.uwm-wi-card { padding:14px 18px; font-size:13px; line-height:1.5; }',
      '.uwm-wi-card .uwm-wi-btns { justify-content:flex-end; margin-top:14px; }',
      '.uwm-wi-card .uwm-go { background:var(--gold,#C8813A); color:#fff; border-color:var(--gold,#C8813A); }'
    ].join('\n');
    var st = document.createElement('style');
    st.setAttribute('data-uwm', '1');
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  // Deploy 237.246 (Mike: "make the ARV temporarily editable meaning it can be changed but
  // not saved without confirmation so that the underwriter can see what all the metrics
  // look like with different ARVs. They do this in cases where the appraisals or BPOs
  // aren't convincing."). The what-if ARV lives HERE, on the page, and nowhere else:
  // build() runs the SAME engine with it in place of the valuation's figure, so every
  // ratio and guideline flag follows, and the loan object is never touched. Saving it is
  // a separate step behind a confirmation (_saveArv → modal → _commitArv).
  var _whatIf = null; // { loanId, arv }
  function whatIfArv(loan) { return (_whatIf && loan && _whatIf.loanId === loan.id && _whatIf.arv > 0) ? _whatIf.arv : 0; }
  function shortDate(iso) { try { var d = new Date(iso); return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); } catch (_) { return ''; } }

  var _openAcct = {}; // account rows whose editor is open (page session)
  var _moreOpen = false; // "More from the documents" stays open across repaints once opened
  function _moreToggled(open) { _moreOpen = !!open; }

  function rowHtml(r) {
    var rootJs = 'document.getElementById(\'' + PANEL_ID + '\')';
    if (r.addAccount) {
      return r.freeSlot
        ? '<div class="uwm-row uwm-add"><a href="#" onclick="event.preventDefault();SLA_UW_METRICS._addAcct(\'' + escA(r.freeSlot) + '\')">+ Add an account</a></div>'
        : '<div class="uwm-row uwm-add"><span class="uwm-empty">All five account rows are in use</span></div>';
    }
    var cls = 'uw-r-value' + (r.flag ? ' uw-flag' : '') + (r.unverified ? ' uw-unverified' : '') + (r.editable ? ' uw-editable' : '') + (r.account ? ' uw-acct' : '') + (r.whatIf ? ' uwm-wi' : '');
    var click = '';
    // Deploy 237.246 -- the ARV opens the WHAT-IF editor (nothing saves), not the field editor.
    if (r.tryArv) click = ' onclick="SLA_UW_METRICS._tryArv()" title="Try a different ARV — nothing is saved until you confirm it"';
    else if (r.editable && !r.account) click = ' onclick="SLA_UW_TAB._edit(\'uw\',\'' + escA(r.key) + '\',' + rootJs + ')" title="Click to edit"';
    if (r.account) click = ' onclick="SLA_UW_METRICS._toggleAcct(\'' + escA(r.key) + '\')" title="Click to edit this account"';
    var val = r.empty ? '<span class="uwm-empty">—</span>' : esc(r.display);
    // Deploy 237.224 (Mike: "if there is something weird ... have a little alert icon that
    // appears that can be clicked and a tiny pop up appears with that note")
    if (r.alert) val += '<button type="button" class="uwm-alert" title="Something to check — click" data-note="' + escA(r.alert) + '" onclick="event.stopPropagation();SLA_UW_METRICS._note(this)">⚠</button>';
    var bits = [];
    if (r.from) bits.push(esc(r.from));
    if (r.prov && r.prov !== r.from) bits.push(esc(r.prov));
    // Deploy 237.233 -- everything the short locator left out, one click away.
    if (r.provFull) bits.push('<button type="button" class="uwm-why" title="What the AI said — click" data-note="' + escA(r.provFull) + '" onclick="event.stopPropagation();SLA_UW_METRICS._note(this)">⋯</button>');
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
    // Deploy 237.226 -- one Save, not a save per field (a half-typed account used to be
    // written on every change); "what it is" and the last four are the person's to type
    // too. The tab's _acct reads all five controls by class, scoped to this panel.
    var on = ' onclick="event.stopPropagation()" onkeydown="if(event.key===\'Enter\'){event.preventDefault();SLA_UW_METRICS._saveAcct(\'' + escA(r.key) + '\')}else if(event.key===\'Escape\'){SLA_UW_METRICS._cancelAcct(\'' + escA(r.key) + '\')}"';
    return '<div class="uwm-acct-ed">' +
      '<input class="uw-acct-name" type="text" placeholder="What it is (e.g. Chase Business Checking)" value="' + escA(a.name || '') + '"' + on + ' />' +
      '<input class="uw-acct-last4" type="text" inputmode="numeric" maxlength="4" placeholder="Last 4" title="Last four digits of the account number" value="' + escA(a.last4 || '') + '"' + on + ' />' +
      '<select class="uw-acct-type"' + on + '>' + opts + '</select>' +
      '<input class="uw-acct-bal" type="text" inputmode="decimal" data-money placeholder="Balance" value="' + escA(a.balance !== '' && a.balance != null ? money(a.balance) : '') + '"' + on + ' />' +
      '<input class="uw-acct-wt" type="text" placeholder="Wt %" title="weight % (defaults from the type)" value="' + escA(a.weight === '' || a.weight == null ? '' : (num(a.weight) * 100) + '%') + '"' + on + ' />' +
      '<span class="uwm-acct-btns">' +
        '<a href="#" class="uwm-acct-cancel" onclick="event.stopPropagation();SLA_UW_METRICS._cancelAcct(\'' + escA(r.key) + '\');return false">Cancel</a>' +
        '<a href="#" class="uwm-acct-done uw-confirm" onclick="event.stopPropagation();SLA_UW_METRICS._saveAcct(\'' + escA(r.key) + '\');return false">Save</a>' +
      '</span>' +
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
    // Deploy 237.246 -- the what-if banner: what is being tried, what it does to LTARV,
    // that nothing is saved, and the two ways out.
    var wi = b.whatIf
      ? '<div class="uwm-wi-bar"><b>What-if ARV ' + money(b.whatIf.arv) + '</b> — the ' + esc(b.whatIf.baseFrom) + ' reads ' + (b.whatIf.base > 0 ? money(b.whatIf.base) : 'nothing') +
          '. LTARV ' + esc(b.whatIf.ltarv || '—') + (b.whatIf.ltarvBase ? ' (was ' + esc(b.whatIf.ltarvBase) + ')' : '') +
          (b.whatIf.checks !== b.whatIf.checksBase ? '; ' + b.whatIf.checks + ' out of guideline (was ' + b.whatIf.checksBase + ')' : '') +
          '. Nothing is saved.' +
          '<span class="uwm-wi-btns">' +
            '<button type="button" class="uwm-re" onclick="SLA_UW_METRICS._saveArv()">Save ' + money(b.whatIf.arv) + ' as the ARV…</button>' +
            '<button type="button" class="uwm-re" onclick="SLA_UW_METRICS._resetArv()">Back to ' + (b.whatIf.base > 0 ? money(b.whatIf.base) : 'the record') + '</button>' +
          '</span></div>'
      : '';
    return '<div class="uwm" id="' + PANEL_ID + '">' +
      '<div class="uwm-hd"><b>Key metrics</b>' +
        '<button type="button" class="uwm-re" id="uwmRefreshBtn" onclick="SLA_UW_METRICS.refresh(true)" title="Re-read the loan now">↻</button></div>' +
      '<div class="uwm-sub">Filled in from the documents as each one is reviewed. Click a value to correct it' + (b.program === 'rtl' ? ', or the ARV to try a different one' : '') + '.</div>' +
      wi + chk + ai +
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
  // Deploy 237.226 -- add / save / cancel for the account editor.
  function _addAcct(key) {
    if (!key) return;
    _openAcct[key] = true;
    repaint();
    try {
      var el = document.querySelector('#' + PANEL_ID + ' .uw-acct[data-key="' + key + '"] .uw-acct-name');
      if (el) el.focus();
    } catch (_) {}
  }
  function _saveAcct(key) {
    var t = T();
    var root = (typeof document !== 'undefined') ? document.getElementById(PANEL_ID) : null;
    if (!t || !t._acct || !root) return;
    var cell = root.querySelector('.uw-acct[data-key="' + key + '"]');
    var bal = cell && cell.querySelector('.uw-acct-bal');
    var type = cell && cell.querySelector('.uw-acct-type');
    if (!(bal && String(bal.value || '').trim()) && !(type && type.value)) {
      if (typeof showToast === 'function') showToast('Give the account a balance or a type first.');
      return;
    }
    _openAcct[key] = false;           // close now; the save's own redraw shows the row
    t._acct('uw', key, root);
  }
  function _cancelAcct(key) { _openAcct[key] = false; repaint(); }

  // ── Deploy 237.246 -- the what-if ARV ────────────────────────────────────
  function _ctxLoan() { var t = T(), c = t && t.ctx && t.ctx(); return (c && c.loan) || null; }
  // Click on the ARV: a money input in the cell. Enter / blur tries the number; Escape
  // puts the row back. Nothing here saves.
  function _tryArv() {
    if (typeof document === 'undefined') return;
    var root = document.getElementById(PANEL_ID);
    var cell = root && root.querySelector('.uw-r-value[data-key="arv"]');
    var vspan = cell && cell.querySelector('.uw-v');
    if (!vspan || cell.querySelector('.uw-edit-input')) return;
    var loan = _ctxLoan() || {};
    var cur = whatIfArv(loan) || num(loan.arvBpo) || num(loan.arv);
    vspan.innerHTML = '<input class="uw-edit-input" type="text" inputmode="decimal" data-money value="' + escA(cur > 0 ? cur : '') + '" placeholder="ARV to try" />';
    var inp = vspan.querySelector('.uw-edit-input'), done = false;
    function finish(apply) { if (done) return; done = true; if (apply) _applyArv(inp.value); else repaint(); }
    try { inp.focus(); if (inp.select) inp.select(); } catch (_) {}
    inp.onkeydown = function (e) { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { finish(false); } };
    inp.onblur = function () { finish(true); };
    inp.onclick = function (e) { e.stopPropagation(); };
  }
  // The typed figure becomes the what-if; blank, or the record's own figure, clears it.
  function _applyArv(raw) {
    var loan = _ctxLoan();
    if (!loan) return;
    var n = num(raw);
    var base = num(loan.arvBpo) || num(loan.arv);
    if (n > 0 && Math.abs(n - base) >= 1) {
      _whatIf = { loanId: loan.id, arv: n };
      if (typeof showToast === 'function') showToast('Trying ARV ' + money(n) + ' — nothing is saved');
    } else {
      _whatIf = null;
    }
    repaint();
  }
  function _resetArv() { _whatIf = null; repaint(); }
  // "Save … as the ARV": the confirmation says exactly what changes before anything is written.
  function _saveArv() {
    var loan = _ctxLoan();
    var b = loan && build(loan);
    if (!b || !b.whatIf || typeof document === 'undefined') return;
    var w = b.whatIf;
    var bg = document.createElement('div');
    bg.className = 'uw-hist-bg';
    bg.onclick = function (e) { if (e.target === bg) bg.remove(); };
    bg.innerHTML = '<div class="uw-hist-card"><div class="uw-hist-hd">Save this ARV?<button type="button" class="uw-hist-x" title="Close">✕</button></div>' +
      '<div class="uwm-wi-card">The ARV on this loan becomes <b>' + money(w.arv) + '</b>' +
        (w.base > 0 ? ' in place of the ' + esc(w.baseFrom) + '\u2019s ' + money(w.base) : '') + '.' +
        ' LTARV goes to <b>' + esc(w.ltarv || '\u2014') + '</b>' + (w.ltarvBase ? ' from ' + esc(w.ltarvBase) : '') + '.' +
        ' Loan Financials and the trade tapes will use this figure. The valuation on file is not changed, and if a valuation later reads a different figure, that figure takes over.' +
        '<div class="uwm-wi-btns">' +
          '<button type="button" class="uwm-re" data-act="cancel">Cancel</button>' +
          '<button type="button" class="uwm-re uwm-go" data-act="save">Save ' + money(w.arv) + ' as the ARV</button>' +
        '</div></div></div>';
    bg.querySelector('.uw-hist-x').onclick = function () { bg.remove(); };
    bg.querySelector('[data-act="cancel"]').onclick = function () { bg.remove(); };
    bg.querySelector('[data-act="save"]').onclick = function () { bg.remove(); _commitArv(w); };
    document.body.appendChild(bg);
  }
  // The confirmed write: loan-uw-field-save with dataset 'loan' sets arvBpo (the field the
  // ratios, Loan Financials and the trade tapes read), unlocks the Property-tab input and
  // leaves the who / when / what-the-valuation-read marker. The fresh loan is folded in
  // IN PLACE (mergeFresh), the way a review landing is.
  function _commitArv(w) {
    var t = T(), ctx = t && t.ctx && t.ctx();
    if (!ctx || !ctx.clientId || !ctx.loanId || !(window.SLA && SLA.api)) return;
    var body = { clientId: ctx.clientId, loanId: ctx.loanId, dataset: 'loan', key: 'arvBpo', value: w.arv, source: 'manual',
      sourceNote: 'Set from a what-if on the key metrics' + (w.base > 0 ? ' \u2014 the ' + w.baseFrom + ' read ' + money(w.base) : '') };
    if (ctx.owner) body.owner = ctx.owner;
    SLA.api('POST', '/api/loan-uw-field-save', body).then(function (r) {
      _whatIf = null;
      var folded = !!(r && r.loan && t.mergeFresh && t.mergeFresh(r.loan));
      if (!folded) repaint();
      if (typeof showToast === 'function') showToast('ARV saved: ' + money(w.arv));
    }).catch(function (e) {
      if (typeof showToast === 'function') showToast('The ARV was not saved: ' + ((e && e.message) || 'unknown'));
    });
  }

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

  var _API = { build: build, html: html, refresh: refresh, repaint: repaint, _toggleAcct: _toggleAcct, _addAcct: _addAcct, _saveAcct: _saveAcct, _cancelAcct: _cancelAcct, _moreToggled: _moreToggled, _note: _note,
    _tryArv: _tryArv, _applyArv: _applyArv, _resetArv: _resetArv, _saveArv: _saveArv, _commitArv: _commitArv, // Deploy 237.246
    PANEL_ID: PANEL_ID, LAYOUT: LAYOUT };
  if (typeof window !== 'undefined') window.SLA_UW_METRICS = _API;
  if (typeof module !== 'undefined' && module.exports) module.exports = _API;
})();
