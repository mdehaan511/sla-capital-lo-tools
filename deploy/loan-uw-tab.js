/**
 * loan-uw-tab.js — renderer for the Underwriting + Lightning Docs tabs
 * (Deploy 236.493, Phase 1b/1c). Self-contained so the big feature stays
 * OUT of the already-huge loan-details.js. Loaded via <script src> on
 * loan-details.html; loan-details calls SLA_UW_TAB.mount(ctx) after the
 * tab panes exist.
 *
 * Depends on: loan-uw-fields.js (SLA_UW_FIELDS), loan-uw-calc.js
 * (SLA_UW_CALC), and window.SLA (api). RTL loans only for now.
 *
 * Value resolution per field (most-trustworthy first — the accuracy model):
 *   1. a saved entry in loan.uwData / loan.lightningData (with provenance)
 *   2. const   → the fixed constant
 *   3. loan    → auto-filled from the loan record (never AI)
 *   4. calc    → the deterministic engine
 *   5. (empty) → needs entry
 * Editable fields are 'doc' / 'manual'. calc/const/loan-auto are read-only
 * (loan-auto can be overridden by saving an entry, which then wins).
 */
(function () {
  var F = (typeof window !== 'undefined' && window.SLA_UW_FIELDS) || null;
  var CALC = (typeof window !== 'undefined' && window.SLA_UW_CALC) || null;

  var _ctx = null; // { loan, clientId, loanId, owner, canEdit, refreshLoan }

  function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escA(s){ return esc(s).replace(/"/g,'&quot;'); }
  function num(v){ if(v==null||v==='')return 0; var n=Number(String(v).replace(/[$,%\s]/g,'')); return isFinite(n)?n:0; }
  function money(n){ return '$'+Math.round(num(n)).toLocaleString(); }
  function pct(x){ return (x==null)?'—':(x*100).toFixed(2)+'%'; }

  // Currency fields — displayed with $ and commas (Mike). Calc money fields
  // are already money-formatted in calcDisplay; this covers input/loan/const
  // values + account balances.
  var MONEY_KEYS = {
    arv:1, bpoValuation:1, loanAmount:1, constructionHoldback:1, brokerOriginationFee:1,
    brokerOtherFees:1, originationFee:1, documentPrepFee:1, underwritingFee:1, processingFee:1,
    creditBackgroundFee:1, prepaidInterest:1,
    asIsPrice:1, purchasePrice:1, assignmentContractPrice:1, assignmentFee:1,
    downPayment:1, titleEscrowFees:1, emd:1
  };
  function looksNumeric(v){ return /^[$\s]*-?[\d,]+(\.\d+)?[\s]*$/.test(String(v)); }
  function fmtDisplay(key, value){
    if (value === '' || value == null) return value;
    if (MONEY_KEYS[key] && looksNumeric(value)) return money(value);
    return value;
  }

  // Loan rate may be stored as a percent (10.5) or decimal (0.105).
  function rateDecimal(loan){ var r=num(loan&&loan.rate); return r>1 ? r/100 : r; }

  // ── Build the calc-engine context from loan + saved uw entries ─────
  function calcContext(loan, uwData) {
    uwData = uwData || {};
    function e(k){ var x=uwData[k]; return x&&x.value!=null?x.value:''; }
    var loanAmt = num(loan.loanAmt);
    var rate    = rateDecimal(loan);
    var reno    = num(loan.rehabBudget);
    var purchase = num(e('purchasePrice')) || num(loan.purchasePrice);

    // Cash to Close — same shape as the RTL sizer's Cash Reserve leg
    // (Deploy 236.485): down payment + total SLA fees (+ title/escrow if
    // entered). Down payment = purchase gap the borrower funds.
    var points = num(loan.points);
    var origFee = loanAmt * points / 100;
    var flatFees = 2150; // 600+900+500+150
    var brokerFee = loanAmt * num(loan.brokerFee) / 100;
    var titleEscrow = num(e('titleEscrowFees'));
    var purchaseLoanPart = Math.max(0, loanAmt - reno);
    var downPayment = num(e('downPayment')) || Math.max(0, purchase - purchaseLoanPart);
    var cashToClose = origFee + flatFees + brokerFee + titleEscrow + downPayment;

    // Accounts → [{type,balance,weight}]
    var accounts = [];
    ['account1','account2','account3','account4','account5'].forEach(function(k){
      var x = uwData[k] && uwData[k].value;
      if (x && typeof x === 'object' && (num(x.balance) > 0 || x.type)) {
        accounts.push({ type: x.type||'', balance: num(x.balance), weight: (x.weight==null?0:num(x.weight)) });
      }
    });

    return {
      loanAmt: loanAmt, rate: rate, arv: num(loan.arv), purchasePrice: purchase,
      renovation: reno, asIsValue: num(e('asIsPrice')), assignmentFee: num(e('assignmentFee')),
      assignmentContractPrice: num(e('assignmentContractPrice')),
      fundingDate: e('earliestSigningDate') || loan.fundingDate || '',
      cashToClose: cashToClose, emdPaid: num(e('emd')), accounts: accounts,
      middleCredit: num(e('middleCredit')),
    };
  }

  // Resolve a field's display value + provenance + editability.
  function resolve(field, loan, data, calc) {
    var entry = data && data[field.key];
    if (entry && entry.value !== undefined && entry.value !== '') {
      return { value: entry.value, entry: entry, editable: field.source==='doc'||field.source==='manual', prov: provText(entry) };
    }
    if (field.source === 'const') {
      return { value: field.const, editable: false, prov: 'Constant' };
    }
    if (field.source === 'loan' && field.loanField) {
      var v = loan[field.loanField];
      if (field.key === 'interestRate' && v != null && v !== '') v = (num(v)>1? num(v): num(v)*100).toFixed(3) + '%';
      return { value: (v==null?'':v), editable: false, prov: 'From loan record' };
    }
    if (field.source === 'calc') {
      return calcDisplay(field, calc);
    }
    // doc / manual with no entry yet → empty & editable
    return { value: '', editable: field.source==='doc'||field.source==='manual', prov: field.sourceNote ? ('Source: '+field.sourceNote) : '' };
  }

  function provText(entry) {
    if (!entry) return '';
    if (entry.isAI) {
      return 'AI' + (entry.aiNote ? ' — ' + entry.aiNote : '') + (entry.verified ? ' (confirmed)' : ' — UNVERIFIED');
    }
    var when = entry.at ? new Date(entry.at).toLocaleDateString('en-US',{month:'short',day:'numeric'}) : '';
    return (entry.byName || entry.by || 'Edited') + (when ? ' · ' + when : '');
  }

  // Map a calc field key → its computed display value + flag.
  function calcDisplay(field, calc) {
    var v = calc.values, flg = calc.flags;
    switch (field.key) {
      case 'monthlyPayment':      return { value: money(v.monthlyPayment), editable:false, prov:'Calculated', calc:true };
      case 'ltarv':               return { value: pct(v.ltarv), editable:false, prov:'Loan ÷ ARV', calc:true, flag:!!flg.ltarv };
      case 'ltc':                 return { value: pct(v.ltc), editable:false, prov:'Loan ÷ (Purchase + Reno)', calc:true, flag:!!flg.ltc };
      case 'ltaiv':               return { value: pct(v.ltaiv), editable:false, prov:'Loan ÷ As-is', calc:true, flag:!!flg.ltaiv };
      case 'assignmentFeeEffective': return { value: money(v.assignmentFeeEffective), editable:false, prov: v.assignmentDerived ? 'Derived: Assign price − PSA price' : 'Listed on contract', calc:true };
      case 'assignmentToPurchase':return { value: pct(v.assignmentToPurchase), editable:false, prov:'Assign ÷ Purchase (RED > 15%)', calc:true, flag:!!flg.assignmentToPurchase };
      case 'prepaidInterest':     return { value: money(v.prepaidInterest), editable:false, prov: v.prepaidInterestDays+' days × per-diem (365)', calc:true };
      case 'liquidityTotal':      return { value: money(v.liquidityTotal), editable:false, prov:'Σ(account × weight) + EMD', calc:true };
      case 'liquidityRequirement':return { value: money(v.liquidityRequirement), editable:false, prov:'Cash to Close + 20% Reno + 6mo', calc:true, flag:!!flg.liquidity };
      default:                    return { value:'', editable:false, prov:'Calculated', calc:true };
    }
  }

  // ── Render one dataset (uw | lightning) into a pane ────────────────
  function renderDataset(dataset) {
    var loan = _ctx.loan || {};
    var data = dataset==='uw' ? (loan.uwData||{}) : (loan.lightningData||{});
    var fields = dataset==='uw' ? F.UNDERWRITING_FIELDS : F.LIGHTNING_DOCS_FIELDS;
    var calc = CALC.computeUwCalcs(calcContext(loan, loan.uwData||{}));

    // Group by section (preserve declaration order).
    var order = [], bySection = {};
    fields.forEach(function(f){ if(!bySection[f.section]){bySection[f.section]=[];order.push(f.section);} bySection[f.section].push(f); });

    var html = '<div class="uw-wrap">';
    order.forEach(function(sec){
      html += '<div class="uw-section"><div class="uw-section-head">'+esc(sec)+'</div><div class="uw-grid">';
      bySection[sec].forEach(function(f){
        if (f.accountRow) { html += accountRowHtml(dataset, f, data); return; }
        var r = resolve(f, loan, data, calc);
        var cls = 'uw-cell' + (r.flag?' uw-flag':'') + (r.calc?' uw-calc':'') + (r.editable?' uw-editable':'');
        var editAttr = r.editable ? ' onclick="SLA_UW_TAB._edit(\''+dataset+'\',\''+f.key+'\')" title="Click to edit"' : '';
        html += '<div class="'+cls+'"'+editAttr+' data-key="'+escA(f.key)+'">'
          + '<div class="uw-label">'+esc(f.label)+'</div>'
          + '<div class="uw-value">'+ (r.value===''||r.value==null ? '<span class="uw-empty">—</span>' : esc(r.calc ? r.value : fmtDisplay(f.key, r.value))) +'</div>'
          + '<div class="uw-prov">'+esc(r.prov||'')
          + (data[f.key] ? ' <a href="#" class="uw-hist" onclick="event.stopPropagation();SLA_UW_TAB._history(\''+dataset+'\',\''+f.key+'\');return false">history</a>' : '')
          + '</div>'
          + '</div>';
      });
      html += '</div></div>';
    });
    html += '</div>';
    return html;
  }

  function accountRowHtml(dataset, f, data) {
    var val = (data[f.key] && data[f.key].value) || {};
    var weights = F.ACCOUNT_WEIGHTS || [];
    var opts = '<option value="">— type —</option>' + weights.map(function(w){
      return '<option value="'+escA(w.type)+'"'+(val.type===w.type?' selected':'')+'>'+esc(w.type)+'</option>';
    }).join('');
    var wDisp = (val.weight==null||val.weight==='') ? '' : (num(val.weight)*100)+'%';
    return '<div class="uw-cell uw-acct" data-key="'+escA(f.key)+'">'
      + '<div class="uw-label">'+esc(f.label)+'</div>'
      + '<div class="uw-acct-row">'
      +   '<select class="uw-acct-type" onchange="SLA_UW_TAB._acct(\''+dataset+'\',\''+f.key+'\')">'+opts+'</select>'
      +   '<input class="uw-acct-bal" type="text" inputmode="decimal" placeholder="balance" value="'+escA(val.balance!=null&&val.balance!==''?money(val.balance):'')+'" onchange="SLA_UW_TAB._acct(\''+dataset+'\',\''+f.key+'\')" />'
      +   '<input class="uw-acct-wt" type="text" placeholder="wt %" value="'+escA(wDisp)+'" onchange="SLA_UW_TAB._acct(\''+dataset+'\',\''+f.key+'\')" title="weight % (defaults from type)" />'
      + '</div>'
      + '<div class="uw-prov">'+esc(data[f.key]?provText(data[f.key]):'Most Recent Account Statement')+'</div>'
      + '</div>';
  }

  // ── Mount / re-render ──────────────────────────────────────────────
  function mount(ctx) {
    _ctx = ctx || {};
    if (!F || !CALC) { console.warn('[SLA UW] registry/calc not loaded'); return; }
    var isRtl = String((_ctx.loan&&_ctx.loan.toolType)||'').toLowerCase() === 'rtl';
    ['underwriting','lightning'].forEach(function(which){
      var pane = document.getElementById(which==='underwriting'?'ldPaneUnderwriting':'ldPaneLightning');
      if (!pane) return;
      if (!isRtl) {
        pane.innerHTML = '<div class="uw-gate">These tabs are set up for RTL loans. DSCR underwriting is coming next.</div>';
        return;
      }
      pane.innerHTML = renderDataset(which==='underwriting'?'uw':'lightning');
    });
  }

  function _rerender(){ if (_ctx) mount(_ctx); }

  // ── Inline edit ────────────────────────────────────────────────────
  function _edit(dataset, key) {
    var loan = _ctx.loan || {};
    var data = dataset==='uw' ? (loan.uwData||{}) : (loan.lightningData||{});
    var cur = data[key] && data[key].value != null ? data[key].value : '';
    var next = window.prompt('Enter value:', String(cur));
    if (next === null) return; // cancelled
    _save(dataset, key, next);
  }

  function _acct(dataset, key) {
    var cell = document.querySelector('.uw-acct[data-key="'+key+'"]');
    if (!cell) return;
    var type = cell.querySelector('.uw-acct-type').value;
    var bal  = cell.querySelector('.uw-acct-bal').value;
    var wtIn = cell.querySelector('.uw-acct-wt').value;
    var weight;
    if (wtIn !== '' && wtIn != null) { weight = num(wtIn)/100; }
    else {
      var w = (F.ACCOUNT_WEIGHTS||[]).filter(function(x){return x.type===type;})[0];
      weight = w && w.weight!=null ? w.weight : 0;
    }
    _save(dataset, key, { type:type, balance:num(bal), weight:weight });
  }

  function _save(dataset, key, value) {
    var body = { clientId:_ctx.clientId, loanId:_ctx.loanId, dataset:dataset, key:key, value:value, source:'manual' };
    if (_ctx.owner) body.owner = _ctx.owner;
    if (window.SLA && SLA.api) {
      SLA.api('POST','/api/loan-uw-field-save', body).then(function(r){
        if (r && r.loan) { _ctx.loan = r.loan; if (_ctx.refreshLoan) _ctx.refreshLoan(r.loan); }
        _rerender();
        if (typeof showToast==='function') showToast('Saved');
      }).catch(function(err){
        if (typeof showToast==='function') showToast('Save failed: '+(err&&err.message||'unknown'));
      });
    }
  }

  function _history(dataset, key) {
    var loan = _ctx.loan || {};
    var audit = (dataset==='uw' ? loan.uwAudit : loan.lightningAudit) || [];
    var rows = audit.filter(function(a){return a.key===key;}).slice().reverse();
    if (!rows.length) { alert('No change history yet.'); return; }
    var msg = rows.map(function(a){
      var who = a.isAI ? ('AI'+(a.aiNote?' ('+a.aiNote+')':'')) : (a.byName||a.by||'?');
      var when = a.at ? new Date(a.at).toLocaleString() : '';
      var val = (a.to && typeof a.to==='object') ? JSON.stringify(a.to) : String(a.to==null?'':a.to);
      return '• ' + val + '   — ' + who + (when?'  ['+when+']':'');
    }).join('\n');
    alert('Change history — '+key+'\n\n'+msg);
  }

  window.SLA_UW_TAB = { mount:mount, _edit:_edit, _acct:_acct, _history:_history };
})();
