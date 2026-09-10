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
    var points = num(p.points), tpo = num(p.tpoSpread);
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
      parts = points.toFixed(2) + ' pts + ' + tpo.toFixed(2) + ' TPO' + (p.tpoAssumed ? ' (assumed — set at closing)' : '') +
        (spread > 0 ? ' + ' + tpoDelta.toFixed(2) + ' TPO for ' + spread.toFixed(2) + ' over sizer base'
          : spread < 0 ? ' − ' + Math.abs(tpoDelta).toFixed(2) + ' TPO for ' + Math.abs(spread).toFixed(2) + ' under sizer base' : '') +
        ((spread !== 0 && k !== 1) ? ' (' + k.toFixed(2) + ' pts per 1%)' : '');
    } else {
      margin = points + spread;
      parts = spread > 0
        ? points.toFixed(2) + ' pts + ' + spread.toFixed(2) + ' over sizer base'
        : spread < 0
          ? points.toFixed(2) + ' pts − ' + Math.abs(spread).toFixed(2) + ' under sizer base'
          : points.toFixed(2) + ' pts (at the sizer rate — no markup)';
    }
    return {
      tool: tool, amount: amount, ratePct: ratePct, points: points, tpoSpread: tpo,
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
    var tpo = (typeof calc.netHiddenTpoPct === 'number' && calc.netHiddenTpoPct > 0) ? calc.netHiddenTpoPct : DEFAULT_DSCR_TPO;
    return withLoanStamps({
      tool: tool || 'dscr',
      tpoPerRate: dscrTpoPerRate(),
      amount: (eff.loan != null) ? eff.loan : calc.loan,
      ratePct: (eff.finalRate != null) ? eff.finalRate : calc.finalRate,
      basePct: calc.finalRate,
      points: (o.points != null) ? o.points : (1 + (num(calc.buydown) || 0)),
      tpoSpread: tpo, tpoAssumed: true,
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
      detail = 'Settled on total revenue, not per loan. This loan: ' + money(r.amount) + ' · margin ' + r.margin.toFixed(2) + ' (' + esc(r.marginParts) + ').';
      foot = '';
    } else if (plan === 'salary') {
      headline = money(c.total);
      detail = esc(label) + ' · base ' + money(c.base) + ' (' + c.applied.toFixed(1) + ' bps) + point split ' + money(c.bonus) + ' on ' + money(r.amount) +
        ' · ' + esc(r.marginParts);
      foot = 'Plus salary via payroll. Settles at closing from the final amount, rate and points.';
    } else if (plan === 'flat50') {
      headline = money(c.total);
      detail = esc(label) + ' · 50 bps on ' + money(r.amount);
      foot = 'Settles at closing from the final loan amount.';
    } else {
      headline = money(c.total);
      detail = esc(label) + ' · ' + c.applied.toFixed(2) + ' bps on ' + money(r.amount) + ' · margin ' + r.margin.toFixed(2) + ' (' + esc(r.marginParts) + ')' +
        (r.source === 'company' ? ' · company-sourced first loan (½ tier)' : '');
      foot = (c.bonus ? 'Includes ' + money(c.bonus) + ' in bonuses on file. ' : '') +
        'Repeat-borrower and referral bonuses (+$250 each) are added at closing' + (r.source === 'company' ? '.' : '; company-sourced first loans pay half the tier.');
    }
    var note = STATE.plan.configured ? '' : ' <span title="No plan saved for you in the LO Compensation table yet — showing the default plan. Ask an admin if this looks wrong.">(default plan)</span>';
    host.innerHTML =
      '<div style="border:1px solid rgba(200,129,58,0.35);background:rgba(200,129,58,0.06);border-radius:10px;padding:12px 14px;margin-top:12px">' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;flex-wrap:wrap">' +
          '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.06em;color:#b5712d">Your expected commission' + note + '</div>' +
          '<div style="font-family:Lora,Georgia,serif;font-size:22px;font-weight:600;color:var(--dark,#261a36)">' + headline + '</div>' +
        '</div>' +
        '<div style="font-size:12px;color:#4a4458;margin-top:4px;line-height:1.45">' + detail + '</div>' +
        (foot ? '<div style="font-size:11px;color:#7a7488;margin-top:4px;line-height:1.4">' + foot + '</div>' : '') +
      '</div>';
    host.style.display = 'block';
  }

  var API = { attach: attach, mount: mount, update: update, load: load, refresh: refresh,
              rowFrom: rowFrom, summarize: summarize, fromDscr: fromDscr, fromRtl: fromRtl, dscrTpoPerRate: dscrTpoPerRate,
              DEFAULT_DSCR_TPO: DEFAULT_DSCR_TPO, _state: STATE };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.SLA_COMP_SIZER = API;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
