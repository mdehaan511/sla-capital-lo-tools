/**
 * lo-comp-sizer.js — "Your expected commission" box for the pricing sizers.
 *
 * Deploy 236.960 (Mike: "For each Loan Officer can we add their expected comp
 * to the sizer so they know what they stand to make as they price out loans?
 * This should show for Loan Officers and Senior LOs as well as Jeremy and
 * Chance. It should match their comp structure in the LO Compensation table.")
 *
 * Shared by dscr-sizer / mf-dscr-sizer (family 'dscr') and rtl-sizer /
 * guc-sizer (family 'rtl'). Each sizer adds, at the end of <body>:
 *
 *   SLA_COMP_SIZER.attach({ family: 'dscr'|'rtl', tool: 'dscr'|'rtl'|'guc' })
 *
 * attach() drops a box right after #results, reads the sizer's own stashes on
 * every render (the sizers rewrite #results.innerHTML on each recalculation
 * and patch it on each override, so a MutationObserver on #results is the one
 * hook that follows both without touching their code):
 *
 *   dscr family  window._dscrLastCalc (engine result: loan, finalRate %, buydown,
 *                netHiddenTpoPct), window._dscrLastCalcEffective (loan,
 *                finalRate % after overrides), window._dscrOverrides.points
 *   rtl family   window._rtlLastCalc (bMax, rate DECIMAL, points — the engine
 *                base), window._rtlLastCalcEffective (bMax, rate, points after
 *                overrides)
 *
 * The math is SLA_COMP.computeRow (deploy/lo-comp.js) on a row shaped exactly
 * like the LO Commissions page builds from a closed loan, so the number here is
 * the number that page shows once the loan closes — on today's tier schedule
 * (the loan closes in the future). RTL/GUC margin = points + (rate − the
 * sizer's engine rate), i.e. a manual rate markup counts, as it does at
 * closing. DSCR margin = points + TPO spread; the sizers don't enter a TPO
 * spread (it is set at closing), so the box assumes the engine's standard
 * hidden TPO (1.00) and says so. Repeat-borrower / referral bonuses are set at
 * closing and are not guessed (an existing loan's stamps are honoured).
 *
 * Deploy 237.128 (Mike): the box leads with the COMP SPREAD the tier is read
 * from (live -- every sizer recalculation re-renders #results, which the
 * observer follows), the plan's tier ladder with the current rung marked, and a
 * "next tier" line: how much more spread, as points at this rate or as a rate
 * at these points, and what it is worth on this loan. See upsell().
 *
 * Visibility: the LO Compensation table decides. /api/lo-comp-plan says whether
 * the signed-in user has a plan on file (configured) — Jeremy and Chance do —
 * and loan_officer / senior_lo roles always qualify (default plan if none is
 * saved). Admins and processors without a plan never see the box.
 *
 * ES5 on purpose (field-office browsers). CommonJS export for the gate script
 * (scripts/comp-sizer-test.mjs).
 */
(function (root) {
  'use strict';

  var STATE = { plan: null, roles: [], eligible: false, ready: false, loading: null, host: null, last: null, reader: null };
  var LO_ROLES = ['loan_officer', 'senior_lo'];
  var DEFAULT_DSCR_TPO = 1.00;

  function comp() {
    if (root && root.SLA_COMP) return root.SLA_COMP;
    if (typeof require === 'function') { try { return require('./lo-comp.js'); } catch (_) {} }
    return null;
  }
  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[$,%]/g, '')); return isFinite(n) ? n : 0; }
  // 0.1125 and 11.25 both mean 11.25% — same convention as lo-comp.js marginOf.
  function pct(v) { var n = num(v); return n > 1 ? n : n * 100; }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  // ── The commission row the LO Commissions page would build for this pricing ──
  function rowFrom(p) {
    p = p || {};
    var C = comp();
    var tool = String(p.tool || '').toUpperCase() || '?';
    var amount = num(p.amount), ratePct = pct(p.ratePct), basePct = pct(p.basePct);
    // Deploy 237.214 (Mike) — buy-down points go to the end investor, so they
    // are not comp. p.points is the TOTAL on the term sheet; take the buy-down
    // off through the same rule the closed book uses (lo-comp.js compPoints).
    var buydown = (tool === 'DSCR') ? Math.max(0, num(p.buydown)) : 0;
    var points = C && C.compPoints
      ? C.compPoints({ toolType: tool, points: p.points, buydown: buydown }, { pointsAreTotal: true })
      : Math.max(0, num(p.points) - buydown);
    var tpo = num(p.tpoSpread);
    // Deploy 236.963 (Mike: "if they lower the interest rate before the base
    // rate on the sizer ... it reduces the multiplier used for the comp.
    // Example 10.5 and 1.5 base ... 10% 1.5 points then its 1 point") — the
    // rate spread over the sizer's engine rate is SIGNED and moves the margin
    // point for point in both directions (matches lo-comp.js marginOf on the
    // closed book). DSCR: applied on top of the assumed TPO the same way.
    var spread = (basePct > 0 && ratePct > 0) ? ratePct - basePct : 0;
    var margin, parts;
    if (tool === 'DSCR') {
      // Deploy 236.964 (Mike: "have it scale to the TPO sensitivity") — on DSCR a
      // rate move changes the investor's premium, not the points, and the
      // engine says how much: HIDDEN_TPO_PCT of premium per HIDDEN_TPO_ADJ of
      // rate (1.00 / 0.320 = 3.125 pts per 1%). fromDscr() passes that ratio
      // as tpoPerRate; without it the move counts point for point.
      var k = (num(p.tpoPerRate) > 0) ? num(p.tpoPerRate) : 1;
      var tpoDelta = spread * k;
      margin = points + tpo + tpoDelta;
      parts = points.toFixed(2) + ' pts + ' + tpo.toFixed(2) + ' TPO' + (p.tpoAssumed ? ' (assumed — set at closing)' : (p.tpoAdmin ? ' (Admin Mode)' : '')) +
        (spread > 0 ? ' + ' + tpoDelta.toFixed(2) + ' TPO for ' + spread.toFixed(2) + ' over sizer base'
          : spread < 0 ? ' − ' + Math.abs(tpoDelta).toFixed(2) + ' TPO for ' + Math.abs(spread).toFixed(2) + ' under sizer base' : '') +
        ((spread !== 0 && k !== 1) ? ' (' + k.toFixed(2) + ' pts per 1%)' : '') +
        (buydown > 0 ? ' \u00b7 ' + buydown.toFixed(2) + ' buy-down pts excluded (paid to the investor)' : '');
    } else {
      margin = points + spread;
      parts = spread > 0
        ? points.toFixed(2) + ' pts + ' + spread.toFixed(2) + ' over sizer base'
        : spread < 0
          ? points.toFixed(2) + ' pts − ' + Math.abs(spread).toFixed(2) + ' under sizer base'
          : points.toFixed(2) + ' pts (at the sizer rate — no markup)';
    }
    return {
      tool: tool, amount: amount, ratePct: ratePct, points: points, buydown: buydown, tpoSpread: tpo,
      margin: margin, marginParts: parts, marginMissing: false,
      closeDate: p.closeDate || (C ? C.todayISO() : ''),
      source: String(p.source || '').toLowerCase() === 'company' ? 'company' : 'lo',
      referral: !!p.referral, isRepeat: !!p.isRepeat,
    };
  }

  function summarize(p, plan) {
    var C = comp();
    var row = rowFrom(p);
    var calc = C ? C.computeRow(row, plan) : { tier: 0, applied: 0, base: 0, bonus: 0, total: 0 };
    return { row: row, calc: calc, plan: plan };
  }

  // ── Readers for the two sizer families ─────────────────────────────
  function withLoanStamps(p) {
    var l = root && root._loadedLoan;
    if (l && typeof l === 'object') {
      if (l.commissionSource) p.source = l.commissionSource;
      p.referral = String(l.commissionReferral || '').toLowerCase() === 'yes';
    }
    return p;
  }
  function fromDscr(tool) {
    var calc = root._dscrLastCalc;
    if (!calc || typeof calc !== 'object') return null;
    var eff = root._dscrLastCalcEffective || {};
    var o = root._dscrOverrides || {};
    // Deploy 237.059 (Mike) -- Admin Mode TPO premium (dscr-sizer): an explicit
    // premium for whichever investor the admin is pricing off of. It replaces the
    // assumed DIYA 1.00 AND switches off the rate-spread scaling (that curve is
    // DIYA's): margin = points + this TPO, exactly. 0 is a valid premium.
    var adminTpo = (root._dscrAdminMode && root._dscrAdminTpo != null && isFinite(Number(root._dscrAdminTpo))) ? Number(root._dscrAdminTpo) : null;
    var tpo = (adminTpo != null) ? adminTpo : ((typeof calc.netHiddenTpoPct === 'number' && calc.netHiddenTpoPct > 0) ? calc.netHiddenTpoPct : DEFAULT_DSCR_TPO);
    var effRate = (eff.finalRate != null) ? eff.finalRate : calc.finalRate;
    return withLoanStamps({
      tool: tool || 'dscr',
      tpoPerRate: dscrTpoPerRate(),
      amount: (eff.loan != null) ? eff.loan : calc.loan,
      ratePct: effRate,
      basePct: (adminTpo != null) ? effRate : calc.finalRate,
      points: (o.points != null) ? o.points : (1 + (num(calc.buydown) || 0)),   // the TOTAL on the term sheet
      buydown: num(calc.buydown) || 0,                                          // 237.214 — rowFrom takes it back off
      tpoSpread: tpo, tpoAssumed: adminTpo == null, tpoAdmin: adminTpo != null,
    });
  }
  // Deploy 236.964 — points of TPO premium per 1% of rate, from the DSCR engine
  // the page loaded (the MF sizer prices through SLA_DSCR too). Honours a
  // historical sheet when activePricing() exposes one; falls back to DIYA.
  function dscrTpoPerRate() {
    var eng = root && root.SLA_DSCR;
    if (!eng) return 0;
    var d = null;
    try { if (typeof eng.activePricing === 'function') d = eng.activePricing(); } catch (_) { d = null; }
    if (!d || !(num(d.HIDDEN_TPO_ADJ) > 0)) d = eng.DIYA || null;
    if (!d) return 0;
    var adj = num(d.HIDDEN_TPO_ADJ), pctv = num(d.HIDDEN_TPO_PCT);
    return (adj > 0 && pctv > 0) ? pctv / adj : 0;
  }
  function fromRtl(tool) {
    var calc = root._rtlLastCalc;
    if (!calc || typeof calc !== 'object') return null;
    var eff = root._rtlLastCalcEffective || {};
    return withLoanStamps({
      tool: tool || 'rtl',
      amount: (eff.bMax != null) ? eff.bMax : calc.bMax,
      ratePct: (eff.rate != null) ? eff.rate : calc.rate,
      basePct: calc.rate,
      points: (eff.points != null) ? eff.points : calc.points,
      tpoSpread: 0,
    });
  }

  // ── Eligibility + plan (one fetch per page) ─────────────────────────
  function load() {
    if (STATE.loading) return STATE.loading;
    var S = root.SLA;
    if (!S || typeof S.api !== 'function') { STATE.ready = true; return Promise.resolve(STATE); }
    var pUser = (typeof S.getCurrentUser === 'function') ? S.getCurrentUser().catch(function () { return null; }) : Promise.resolve(null);
    var pPlan = S.api('GET', '/api/lo-comp-plan').catch(function () { return null; });
    STATE.loading = Promise.all([pUser, pPlan]).then(function (res) {
      var user = res[0], plan = res[1];
      var roles = [];
      try { roles = (typeof S.getRoles === 'function') ? S.getRoles(user) : ((user && user.app_metadata && user.app_metadata.roles) || []); } catch (_) { roles = []; }
      STATE.roles = roles || [];
      STATE.plan = (plan && plan.ok) ? plan : null;
      var isLo = STATE.roles.some(function (r) { return LO_ROLES.indexOf(String(r).toLowerCase()) >= 0; });
      STATE.eligible = !!(STATE.plan && (STATE.plan.configured || isLo));
      STATE.ready = true;
      if (STATE.last) render(STATE.last);
      return STATE;
    });
    return STATE.loading;
  }

  function mount(host) {
    STATE.host = (typeof host === 'string') ? document.getElementById(host) : host;
    if (STATE.host) STATE.host.style.display = 'none';
    load();
    return STATE.host;
  }

  function update(p) {
    STATE.last = p || null;
    if (!STATE.ready) { load(); return; }
    render(STATE.last);
  }

  function refresh() {
    if (!STATE.reader) return;
    try { update(STATE.reader()); } catch (e) { /* never break the sizer */ }
  }

  // Drop the box after #results and follow every render of it.
  function attach(opts) {
    opts = opts || {};
    if (typeof document === 'undefined') return null;
    var results = document.getElementById(opts.resultsId || 'results');
    if (!results || !results.parentNode) return null;
    var host = document.getElementById('slaCompBox');
    if (!host) {
      host = document.createElement('div');
      host.id = 'slaCompBox';
      results.parentNode.insertBefore(host, results.nextSibling);
    }
    mount(host);
    var tool = opts.tool || opts.family || 'dscr';
    STATE.reader = (opts.family === 'rtl') ? function () { return fromRtl(tool); } : function () { return fromDscr(tool); };
    var timer = null;
    function queue() { if (timer) clearTimeout(timer); timer = setTimeout(function () { timer = null; refresh(); }, 60); }
    if (typeof MutationObserver === 'function') {
      try { new MutationObserver(queue).observe(results, { childList: true, subtree: true, characterData: true }); } catch (_) {}
    }
    refresh();
    return host;
  }

  function money(n) { var C = comp(); return C ? C.money(n) : ('$' + Math.round(n)); }

  // ── Deploy 237.128 (Mike: "show the current spread being used to determine
  // the commission and have it update as they modify the sizer. Also list what
  // the tiers are so they know what they need to upsell to") ────────────────
  // Pure: the ladder the plan pays on and what this pricing would need to reach
  // the next rung. Tiered plans: SLA_COMP's close-date schedule, need = spread to
  // the next bound, levers = points at this rate OR rate at these points (DSCR
  // rate moves scaled by the engine's TPO sensitivity; an Admin Mode TPO makes the
  // TPO itself the lever). Salary plan: the RTL rate multiplier steps + the 1.50
  // point-split floor. Flat / revenue plans have no ladder.
  function fmtBps(b) { var n = num(b); return (Math.round(n * 100) / 100 === Math.round(n)) ? String(Math.round(n)) : n.toFixed(2).replace(/0$/, ''); }
  function fmtRate(x) { return num(x).toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%'; }
  function rangeLabel(t) {
    if (!t) return '';
    if (t.min <= 0) return 'under ' + t.max.toFixed(2);
    if (!isFinite(t.max)) return t.min.toFixed(2) + '+';
    return t.min.toFixed(2) + '–' + (t.max - 0.01).toFixed(2);
  }
  function upsell(p, plan, s) {
    var C = comp();
    if (!C) return { kind: 'none' };
    s = s || summarize(p, plan);
    var r = s.row, c = s.calc;
    var isDscr = r.tool === 'DSCR';
    if (plan === 'flat50') return { kind: 'flat' };
    if (plan === 'revenue') return { kind: 'none' };
    if (plan === 'salary') {
      var basis = isDscr ? (r.points + r.tpoSpread) : r.points;   // what the 50/50 split is measured on
      var res = { kind: 'salary', isDscr: isDscr, floor: 1.5, basis: basis, above: basis - 1.5, mult: C.salaryMultiplier(r.ratePct, isDscr), steps: [], next: null, gain: 0, rateDelta: 0, targetRatePct: 0 };
      if (isDscr || !(r.ratePct > 0)) return res;
      var snapped = Math.min(13, Math.max(10, Math.round(r.ratePct * 2) / 2));
      var steps = C.SALARY_RATE_STEPS || [];
      var ci = -1;
      for (var i = 0; i < steps.length; i++) {
        var cur = steps[i] === snapped;
        if (cur) ci = i;
        res.steps.push({ rate: steps[i], mult: C.salaryMultiplier(steps[i], false), current: cur });
      }
      if (ci >= 0 && ci + 1 < res.steps.length) {
        var nx = res.steps[ci + 1];
        var row2 = {};
        for (var k2 in r) if (Object.prototype.hasOwnProperty.call(r, k2)) row2[k2] = r[k2];
        row2.ratePct = nx.rate;
        res.next = nx;
        res.targetRatePct = nx.rate - 0.25;   // half-point snapping: 12.25 already rounds up to the 12.5 step
        res.rateDelta = res.targetRatePct - r.ratePct;
        res.gain = C.computeRow(row2, plan).total - c.total;
      }
      return res;
    }
    // Tiered comp model (the default plan).
    var nt = C.nextTierFor(r.margin, r.closeDate);
    var out = { kind: 'tiers', ladder: nt.ladder, current: nt.current, next: nt.next, need: 0, gain: 0, targetPoints: 0, targetRatePct: 0, rateDelta: 0, targetTpo: 0, lever: '' };
    if (!nt.next) return out;
    var need = nt.need;
    if (need < 0.005) need = 0.01;   // float noise right at a bound
    need = Math.round(need * 100) / 100;
    out.need = need;
    out.gain = r.amount * (nt.next.bps - nt.current.bps) / 10000 * (r.source === 'company' ? 0.5 : 1);
    out.targetPoints = r.points + need;
    if (isDscr && p.tpoAdmin) { out.lever = 'tpo'; out.targetTpo = r.tpoSpread + need; }
    else {
      var k = (isDscr && num(p.tpoPerRate) > 0) ? num(p.tpoPerRate) : 1;
      out.lever = 'rate'; out.rateDelta = need / k; out.targetRatePct = r.ratePct + out.rateDelta;
    }
    return out;
  }
  function chip(label, sub, state) {
    var st = 'display:inline-block;border-radius:8px;padding:4px 8px;margin:4px 6px 0 0;font-size:11px;line-height:1.25;text-align:center;';
    if (state === 'current') st += 'border:2px solid #b5712d;background:rgba(200,129,58,0.16);color:#261a36;font-weight:700;';
    else if (state === 'below') st += 'border:1px solid rgba(74,68,88,0.18);color:#8a8497;';
    else st += 'border:1px solid rgba(200,129,58,0.35);color:#4a4458;';
    return '<span style="' + st + '"' + (state === 'current' ? ' title="Where this pricing lands now"' : '') + '>' + label +
      '<br><span style="font-size:10px;font-weight:400">' + sub + '</span></span>';
  }
  function ladderHtml(u, r) {
    if (!u || u.kind === 'none' || u.kind === 'flat') return '';
    var chips = '', line = '', title = '', seen = false, i;
    if (u.kind === 'tiers') {
      title = 'Comp tiers — bps by spread';
      for (i = 0; i < u.ladder.length; i++) {
        var t = u.ladder[i];
        chips += chip(fmtBps(t.bps) + ' bps', esc(rangeLabel(t)), t.current ? 'current' : (seen ? 'above' : 'below'));
        if (t.current) seen = true;
      }
      if (!u.next) line = 'Top tier — ' + fmtBps(u.current.bps) + ' bps.';
      else {
        var how = '<b>' + u.targetPoints.toFixed(2) + ' pts</b> at this rate';
        if (u.lever === 'rate') how += ', or a rate of <b>' + fmtRate(u.targetRatePct) + '</b> (+' + fmtRate(u.rateDelta) + ') at ' + r.points.toFixed(2) + ' pts';
        else if (u.lever === 'tpo') how += ', or a <b>' + u.targetTpo.toFixed(2) + ' TPO</b>';
        line = 'Next tier <b>' + fmtBps(u.next.bps) + ' bps</b> starts at a ' + u.current.max.toFixed(2) + ' spread — you need <b>+' + u.need.toFixed(2) + '</b>: e.g. ' + how + '. Worth <b>+' + money(u.gain) + '</b> on this loan.';
      }
    } else if (u.kind === 'salary') {
      var ab = u.above;
      var floorLine = 'Point split: 50% of ' + (u.isDscr ? 'pts + TPO' : 'points') + ' above the 1.50 floor — now ' +
        (ab >= 0 ? '<b>+' + ab.toFixed(2) + '</b>' : '<b>−' + Math.abs(ab).toFixed(2) + '</b> (a deficit nets against your payout)') + '.';
      if (!u.steps.length) return '<div style="font-size:12px;color:#4a4458;margin-top:6px;line-height:1.45">' + floorLine + '</div>';
      title = 'Rate multiplier steps (RTL)';
      for (i = 0; i < u.steps.length; i++) {
        var st = u.steps[i];
        chips += chip('×' + st.mult.toFixed(1), fmtRate(st.rate), st.current ? 'current' : (seen ? 'above' : 'below'));
        if (st.current) seen = true;
      }
      line = (u.next
        ? 'Next step <b>×' + u.next.mult.toFixed(1) + '</b> from a rate of <b>' + fmtRate(u.targetRatePct) + '</b> (+' + fmtRate(u.rateDelta) + '). Worth <b>+' + money(u.gain) + '</b> on this loan. '
        : 'Top step — ×' + u.mult.toFixed(1) + '. ') + floorLine;
    }
    return '<div style="margin-top:8px">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488">' + esc(title) + '</div>' +
      '<div>' + chips + '</div>' +
      '<div style="font-size:12px;color:#4a4458;margin-top:6px;line-height:1.45">' + line + '</div></div>';
  }
  function spreadHtml(u, r, plan) {
    var C = comp();
    var label = 'Comp spread', big = r.margin.toFixed(2), sub = esc(r.marginParts);
    if (plan === 'salary' && r.tool !== 'DSCR' && C) {
      label = 'Points'; big = r.points.toFixed(2);
      sub = 'rate ' + fmtRate(r.ratePct) + ' → ×' + C.salaryMultiplier(r.ratePct, false).toFixed(1) + ' multiplier';
    }
    return '<div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin-top:8px">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#7a7488">' + label + '</div>' +
      '<div style="font-family:Lora,Georgia,serif;font-size:20px;font-weight:600;color:var(--dark,#261a36)">' + big + '</div>' +
      '<div style="font-size:12px;color:#4a4458">' + sub + '</div></div>';
  }


  function render(p) {
    var host = STATE.host;
    if (!host) return;
    var C = comp();
    if (!STATE.eligible || !p || !C || !(num(p.amount) > 0)) { host.style.display = 'none'; host.innerHTML = ''; return; }
    var plan = STATE.plan.plan;
    var s = summarize(p, plan);
    var r = s.row, c = s.calc;
    var label = (C.PLAN_LABEL && C.PLAN_LABEL[plan]) || plan;
    var headline, detail, foot;
    if (plan === 'revenue') {
      headline = '<span style="font-size:15px;font-weight:600;color:var(--dark,#261a36)">Revenue-based plan</span>';
      detail = 'Settled on total revenue, not per loan. This loan: ' + money(r.amount) + '.';
      foot = '';
    } else if (plan === 'salary') {
      headline = money(c.total);
      detail = esc(label) + ' · base ' + money(c.base) + ' (' + c.applied.toFixed(1) + ' bps) + point split ' + money(c.bonus) + ' on ' + money(r.amount) + '.';
      foot = '';
    } else if (plan === 'flat50') {
      headline = money(c.total);
      detail = esc(label) + ' · 50 bps on ' + money(r.amount);
      foot = '';
    } else {
      headline = money(c.total);
      detail = esc(label) + ' · ' + c.applied.toFixed(2) + ' bps on ' + money(r.amount) +
        (r.source === 'company' ? ' · company-sourced first loan (½ tier)' : '');
      foot = c.bonus ? 'Includes ' + money(c.bonus) + ' in bonuses on file.' : '';
    }
    var u = upsell(p, plan, s); // Deploy 237.128
    var note = STATE.plan.configured ? '' : ' <span title="No plan saved for you in the LO Compensation table yet — showing the default plan. Ask an admin if this looks wrong.">(default plan)</span>';
    host.innerHTML =
      '<div style="border:1px solid rgba(200,129,58,0.35);background:rgba(200,129,58,0.06);border-radius:10px;padding:12px 14px;margin-top:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">' +
          '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#b5712d">Your expected commission' + note + '</div>' +
          '<div style="font-family:Lora,Georgia,serif;font-size:22px;font-weight:600;color:var(--dark,#261a36)">' + headline + '</div>' +
        '</div>' +
        spreadHtml(u, r, plan) + ladderHtml(u, r) + // Deploy 237.128
        '<div style="font-size:12px;color:#4a4458;margin-top:8px;line-height:1.45">' + detail + '</div>' +
        (foot ? '<div style="font-size:11px;color:#7a7488;margin-top:4px;line-height:1.4">' + foot + '</div>' : '') +
      '</div>';
    host.style.display = 'block';
  }

  var API = { attach: attach, mount: mount, update: update, load: load, refresh: refresh,
              rowFrom: rowFrom, summarize: summarize, fromDscr: fromDscr, fromRtl: fromRtl, dscrTpoPerRate: dscrTpoPerRate,
              upsell: upsell, fmtBps: fmtBps, fmtRate: fmtRate, rangeLabel: rangeLabel, // Deploy 237.128
              DEFAULT_DSCR_TPO: DEFAULT_DSCR_TPO, _state: STATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.SLA_COMP_SIZER = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
