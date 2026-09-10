/**
 * lo-comp.js — the LO commission model, shared.
 *
 * Deploy 236.952 (Mike: "make it so that the LOs can see their commissions and
 * status of the pay out in their profiles"). Until now the comp math lived
 * inline in lo-commissions.html (admin only). An LO's own view on profile.html
 * has to agree with the admin page to the cent, so the model moved here and
 * both pages load it. Browser global `SLA_COMP`; CommonJS export for the gate
 * (scripts/comp-tiers-test.mjs) and for netlify functions (lo-comp-plan.mjs).
 *
 * ES5 on purpose — this runs in whatever browser an LO has. No DOM access.
 *
 * What lives here:
 *   plans      DEFAULT_PLANS / PLAN_LABEL / SALARY_PLAN_NOTE
 *   tiers      TIER_SCHEDULES (by CLOSE DATE, newest first) / tierScheduleFor / tierBps
 *   margin     marginOf(loan)  — DSCR = points + TPO spread; RTL/GUC = points + (rate − sizer base)
 *   rows       isClosedWon(loan) / buildRows(byOwner) — one row per closed loan, repeat-borrower detected
 *   math       computeRow(row, plan) — { tier, applied, base, bonus, total }
 *   payout     payoutState(row) — { key, label, date } for the BILL / manual-paid stamps
 *   format     num / money / shortDate
 */
(function (root) {
  'use strict';

  // First-run defaults per Mike (editable on the admin page; only used until a
  // config is saved to settings.lo_comp_plans).
  var DEFAULT_PLANS = {
    'sara.s@slacapital.com': 'model',
    'carl.davis@slacapital.com': 'model',
    'chance@slacapital.com': 'revenue',
    'jeremy@slacapital.com': 'revenue',
  };
  // Deploy 236.937 (Mike) — 'salary' = Salary Commission Structure (Jeremy).
  // Ported from his comp sheet, formula-for-formula:
  //   base       = 25 bps of loan amount
  //   multiplier = RTL/GUC only, stepped by NOTE RATE: 10%→0.8, 10.5%→0.9,
  //                11%→1.0, 11.5%→1.1, 12%→1.2, 12.5%→1.3, 13%→1.4 (off-step
  //                rates snap to the nearest half point, clamped 10–13 — matches
  //                the sheet's hand-fixed rows: 10.25→0.9, 10.99→1.0). DSCR = 1.
  //   point split (50/50 above the floor):
  //     RTL:  (points − 1.5)/100 × amount ÷ 2, never below 0
  //     DSCR: (points + TPO spread − 1.5)/100 × amount ÷ 2 — deficits are
  //           NEGATIVE and net against the payout (the sheet keeps them)
  //   total = (base + point split) × multiplier
  //   + $48,000/yr salary via payroll — displayed as a note, never in totals.
  var PLAN_LABEL = { model: 'Comp Model', flat50: 'Flat 50 bps', revenue: 'Revenue-based', salary: 'Salary + Commission' };
  var SALARY_PLAN_NOTE = 'Salary Commission Structure — plus $48,000/yr salary paid via payroll (not included in these totals).';

  function num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[$,%]/g, '')); return isFinite(n) ? n : 0; }
  // Deploy 236.938 (Mike) — a value WITH cents always shows both digits
  // ($857.90, not $857.9); whole dollars stay clean ($864, not $864.00).
  function money(n) {
    var r = Math.round(n * 100) / 100;
    var hasCents = Math.abs(Math.round(r * 100)) % 100 !== 0;
    return '$' + r.toLocaleString(undefined, { minimumFractionDigits: hasCents ? 2 : 0, maximumFractionDigits: 2 });
  }
  // Deploy 236.821 — "yyyy-MM-dd" (BILL's payment processDate) → M/D/YY.
  // Sliced rather than Date-parsed: a bare ISO date parses as UTC midnight and
  // would render a day early west of Greenwich.
  function shortDate(v) {
    var s = String(v || '').trim();
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
    if (!m) return s ? s.slice(0, 10) : '';
    return Number(m[2]) + '/' + Number(m[3]) + '/' + m[1].slice(2);
  }

  // The comp model's tier lookup (Assumptions sheet).
  // Deploy 236.951 (Mike: "add another tier to get a .5875 bps comp at 2.25-2.75%
  // and then the .65bps will kick in at 2.75-3.49. lets also add a .85 level at
  // 4.5+ ... This only applies to future closings not ones that have already
  // closed.") — the schedule is chosen by the loan's CLOSE DATE, newest first;
  // each tier is [upper bound (exclusive), bps]. A loan that closed before an
  // entry's effective date falls through to the older schedule, so nothing
  // already closed ever reprices. Add a new schedule at the TOP when tiers change.
  var TIER_SCHEDULES = [
    { effective: '2026-09-10', tiers: [[1.5, 35], [2.25, 50], [2.75, 58.75], [3.5, 65], [4.5, 70], [Infinity, 85]] },
    { effective: '0000-00-00', tiers: [[1.5, 35], [2.5, 50], [3.5, 65], [Infinity, 70]] },   // the original sheet
  ];
  function tierScheduleFor(closeDate) {
    var d = String(closeDate || '').slice(0, 10);
    for (var i = 0; i < TIER_SCHEDULES.length; i++) if (d >= TIER_SCHEDULES[i].effective) return TIER_SCHEDULES[i];
    return TIER_SCHEDULES[TIER_SCHEDULES.length - 1];
  }
  function tierBps(margin, closeDate) {
    if (!isFinite(margin)) return 0;
    var tiers = tierScheduleFor(closeDate).tiers;
    for (var i = 0; i < tiers.length; i++) if (margin < tiers[i][0]) return tiers[i][1];
    return tiers[tiers.length - 1][1];
  }

  // Margin per Mike: DSCR = points + TPO spread; RTL/GUC = points + (rate − buy rate).
  function marginOf(l) {
    var pts = num(l.points);
    var tool = String(l.toolType || '').toLowerCase();
    if (tool === 'dscr') {
      var tpo = num(l.tpoSpread) || num(l.tpo) || num(l.tpoPremium);
      return { margin: pts + tpo, parts: pts.toFixed(2) + ' pts + ' + tpo.toFixed(2) + ' TPO', missing: false };
    }
    // Deploy 236.941 (Mike) — the RTL base is the SIZER's engine rate, NOT the
    // investor buyRate ("they get paid more if the sizer starts at 11 and they
    // sell 11.25 — the investor buy rate doesn't affect their comp"). The sizer
    // snapshots its pre-override rate into _pricingOverrideOriginal whenever an
    // LO overrides pricing; no override on file means the loan sold AT the
    // sizer rate, so the markup is simply 0 — not a warning.
    var rate = num(l.rate);
    var ratePct = rate > 1 ? rate : rate * 100;
    var orig = l._pricingOverrideOriginal || (l.formData && l.formData._pricingOverrideOriginal) || null;
    var baseRaw = (orig && orig.rate != null) ? num(orig.rate) : num(l.compBaseRate);
    var basePct = baseRaw > 1 ? baseRaw : baseRaw * 100;
    if (basePct > 0 && ratePct > 0) {
      var spread = Math.max(0, ratePct - basePct);
      return { margin: pts + spread, parts: pts.toFixed(2) + ' pts + ' + spread.toFixed(2) + ' over sizer base', missing: false };
    }
    var overridden = !!(l._pricingOverrideAt || (l.formData && (l.formData._pricingOverrideAt || l.formData._rateOverride)));
    if (overridden) {
      // Rate was overridden but the sizer's original wasn't captured (legacy
      // saves) — the markup is unknowable without the base. Flag + click-fix.
      return { margin: pts, parts: pts.toFixed(2) + ' pts (rate overridden — sizer base unknown)', missing: true };
    }
    return { margin: pts, parts: pts.toFixed(2) + ' pts (sold at sizer rate — no markup)', missing: false };
  }

  // Closed/won — same rule as the SLA dashboard's Won bucket.
  function isClosedWon(l) {
    var d = String(l.disposition || '').toLowerCase();
    if (d) return true; // any disposition means it reached the closed book
    var s = String(l.status || '').toLowerCase();
    if (s === 'closed' || s === 'sold' || s === 'liquidated') return true;
    return String(l.processingStage || '').toLowerCase() === 'pp_closed';
  }

  // Deploy 236.953 (Mike: "Its important it doesnt get confused and think a
  // broker coming back again is a repeat borrower.") On a broker-submitted deal
  // the loan's primary CLIENT is the broker's book record (_isBroker) and the
  // real borrower lives on loan.borrowerName / loan.borrowerEmail. Keying repeat
  // detection on client.email would make every second deal a broker brings a
  // "repeat borrower". So: the identity for repeat purposes is the BORROWER —
  // the loan's borrowerEmail when the client acts as a broker for it, else the
  // client's own email. No borrower email on a broker deal = no key = never a
  // repeat and never anyone's "first" (a bonus is never guessed).
  function clientIsBrokerFor(client, loan) {
    if (!client) return false;
    if (client._isBroker === true || client._isBrokerPlaceholder === true) return true;
    var ce = String(client.email || '').toLowerCase().trim();
    var be = String((loan && loan.brokerEmail) || '').toLowerCase().trim();
    return !!(ce && be && ce === be);
  }
  function repeatKeyOf(client, loan) {
    if (clientIsBrokerFor(client, loan)) return String((loan && loan.borrowerEmail) || '').toLowerCase().trim();
    return String((client && client.email) || '').toLowerCase().trim();
  }
  // One row per closed loan across { ownerEmail: [client, ...] }, with the
  // repeat-borrower flag: an earlier CLOSED loan for the same borrower WITH THE
  // SAME LO makes every later one a repeat ("repeat for them" — per LO, so the
  // admin page and an LO's own page agree whatever scope they are given).
  function buildRows(byOwner) {
    var closed = [];
    Object.keys(byOwner || {}).forEach(function (owner) {
      (byOwner[owner] || []).forEach(function (c) {
        ((c && c.loans) || []).forEach(function (l) {
          if (!l || !l.id || !isClosedWon(l)) return;
          closed.push({ owner: String(owner).toLowerCase(), client: c, loan: l });
        });
      });
    });
    var byBorrower = {};
    closed.forEach(function (x) {
      var be = repeatKeyOf(x.client, x.loan);
      if (!be) return;
      var k = x.owner + '|' + be;   // 236.953 — per LO
      (byBorrower[k] = byBorrower[k] || []).push(x);
    });
    Object.keys(byBorrower).forEach(function (be) {
      byBorrower[be].sort(function (a, b) {
        return String(a.loan.fundingDate || '9999').localeCompare(String(b.loan.fundingDate || '9999'));
      });
      byBorrower[be].forEach(function (x, i) { x.isRepeat = i > 0; });
    });
    return closed.map(baseRow);
  }

  // One row from { owner, client, loan } — shared by the closed book and the
  // pending (approved, not yet closed) book so both compute the same way.
  function baseRow(x) {
      var l = x.loan;
      var m = marginOf(l);
      return {
        owner: x.owner,
        clientId: x.client.id,
        loanId: l.id,
        // 236.953 — on a broker deal the person is the borrower on the loan, not the broker record.
        borrower: (clientIsBrokerFor(x.client, l) && (l.borrowerName || l.borrowerEmail))
          ? String(l.borrowerName || l.borrowerEmail) + ' (via broker)'
          : (((x.client.firstName || '') + ' ' + (x.client.lastName || '')).trim() || x.client.email || ''),
        viaBroker: clientIsBrokerFor(x.client, l),
        address: l.address || '(no address)',
        tool: String(l.toolType || '').toUpperCase() || '?',
        amount: num(l.finalLoanAmount) || num(l.loanAmt),
        // Deploy 236.936 — the salary plan needs the raw pricing pieces, not
        // just the blended margin. Rate normalized to a percent-number
        // (0.105 and 10.5 both → 10.5); TPO spread resolved like marginOf.
        ratePct: (function () { var rr = num(l.rate); return rr > 1 ? rr : rr * 100; })(),
        points: num(l.points),
        tpoSpread: num(l.tpoSpread) || num(l.tpo) || num(l.tpoPremium),
        closeDate: l.fundingDate || '',
        margin: m.margin, marginParts: m.parts, marginMissing: m.missing,
        source: (String(l.commissionSource || '').toLowerCase() === 'company') ? 'company' : 'lo',
        referral: String(l.commissionReferral || '').toLowerCase() === 'yes',
        isRepeat: !!x.isRepeat,
        // Deploy 236.808 — BILL (bill.com) commission-bill stamp.
        billId: String(l.commissionBillId || ''),
        billedAt: String(l.commissionBilledAt || ''),
        // Deploy 236.818 — payment status read back from BILL by
        // { action:'sync-payments' }. PAID | UNPAID | PARTIALLY_PAID |
        // SCHEDULED | IN_PROCESS.
        payStatus: String(l.commissionPaymentStatus || ''),
        paidAt: String(l.commissionPaidAt || ''),
        // Deploy 236.821 — BILL's confirmation number for the payment that
        // covered this loan, so "where's my money" has an answer.
        payRef: String(l.commissionPaymentRef || ''),
      };
  }

  // ── Pending commissions (Deploy 236.960) ──────────────────────────
  // Mike: "show Pending Commissions for loans they have that have been approved
  // in the processing pipeline but havent closed yet … so they can anticipate
  // their future earnings." Same membership rule as the Processing Pipeline
  // board's columnFor(): approved / in a processing stage, not paused or dead,
  // and not yet in the closed book.
  var STAGE_LABEL = { new_loan: 'New Loan', processing: 'Processing', underwriting: 'Underwriting', pp_approved: 'Approved' };
  function isPendingApproved(l) {
    if (!l || isClosedWon(l)) return false;
    var s = String(l.status || '').toLowerCase().trim();
    if (s === 'on_hold' || s === 'denied' || s === 'cancelled' || s === 'sold' || s === 'liquidated' || s === 'closed') return false;
    var stage = String(l.processingStage || '').toLowerCase().trim();
    if (stage === 'processing' || stage === 'underwriting' || stage === 'pp_approved' || stage === 'new_loan') return true;
    return s === 'approved';
  }
  function todayISO() {
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  // Rows for every approved-not-closed loan, in the closed-row shape plus
  // { pending: true, stage, expectedCloseDate }. closeDate is the expected
  // close date or today — the loan closes in the future, so the tier schedule
  // in force NOW (or then) applies, never the pre-9/10/26 one. Repeat = the
  // same borrower already CLOSED with this LO (pending deals don't count yet).
  function buildPendingRows(byOwner) {
    var closedKeys = {};
    var pending = [];
    Object.keys(byOwner || {}).forEach(function (owner) {
      var o = String(owner).toLowerCase();
      (byOwner[owner] || []).forEach(function (c) {
        ((c && c.loans) || []).forEach(function (l) {
          if (!l || !l.id) return;
          if (isClosedWon(l)) { var k = repeatKeyOf(c, l); if (k) closedKeys[o + '|' + k] = true; return; }
          if (isPendingApproved(l)) pending.push({ owner: o, client: c, loan: l });
        });
      });
    });
    var today = todayISO();
    return pending.map(function (x) {
      var l = x.loan;
      var r = baseRow(x);
      var k = repeatKeyOf(x.client, l);
      var stage = String(l.processingStage || '').toLowerCase().trim();
      r.pending = true;
      r.amount = num(l.loanAmt) || r.amount;           // nothing is final yet
      r.expectedCloseDate = String(l.expectedCloseDate || '');
      r.closeDate = r.expectedCloseDate || today;
      r.stage = STAGE_LABEL[stage] || (stage ? stage : 'Approved');
      r.isRepeat = !!(k && closedKeys[x.owner + '|' + k]);
      r.billId = ''; r.billedAt = ''; r.payStatus = ''; r.paidAt = ''; r.payRef = '';
      return r;
    });
  }

  // ── Commission math per row (plan-aware) ──────────────────────────
  function computeRow(r, plan) {
    var out = { tier: 0, applied: 0, base: 0, bonus: 0, total: 0 };
    if (plan === 'revenue') return out;
    if (plan === 'salary') {
      // See the PLAN_LABEL comment for the sheet this ports, line by line.
      var isDscr = r.tool === 'DSCR';
      var mult = 1;
      if (!isDscr && r.ratePct > 0) {
        var snapped = Math.min(13, Math.max(10, Math.round(r.ratePct * 2) / 2));
        mult = Math.round((1 + (snapped - 11) * 0.2) * 10) / 10;
      }
      var split = isDscr
        ? (r.points + r.tpoSpread - 1.5) / 100 * r.amount / 2
        : (r.points > 1.5 ? (r.points - 1.5) / 100 * r.amount / 2 : 0);
      out.applied = Math.round(25 * mult * 10) / 10;   // effective bps on the base
      out.base = r.amount * 0.0025 * mult;
      out.bonus = split * mult;
      out.total = out.base + out.bonus;
      return out;
    }
    if (plan === 'flat50') {
      out.applied = 50;
      out.base = r.amount * 50 / 10000;
      out.total = out.base;
      return out;
    }
    out.tier = tierBps(r.margin, r.closeDate);   // 236.951 — schedule by close date
    out.applied = r.source === 'company' ? out.tier * 0.5 : out.tier;
    out.base = r.amount * out.applied / 10000;
    out.bonus = (r.isRepeat ? 250 : 0) + (r.referral ? 250 : 0);
    out.total = out.base + out.bonus;
    return out;
  }

  // Where a payout stands, from the stamps BILL and the admin page leave on the
  // loan. A bill existing and a bill being PAID are different facts.
  //   paid       — BILL says PAID, or hand-marked paid outside BILL (236.926)
  //   scheduled  — BILL has a payment scheduled / in process (date = when)
  //   billed     — a bill exists in BILL, no payment yet
  //   unbilled   — closed, nothing billed yet
  function payoutState(r) {
    var st = String(r.payStatus || '').toUpperCase();
    if (st === 'PAID') return { key: 'paid', label: r.billId ? 'Paid' : 'Paid (outside BILL)', date: r.paidAt || '' };
    if (!r.billId) return { key: 'unbilled', label: 'Not yet billed', date: '' };
    if (st === 'SCHEDULED' || st === 'IN_PROCESS') return { key: 'scheduled', label: st === 'IN_PROCESS' ? 'Payment in process' : 'Payment scheduled', date: r.paidAt || '' };
    if (st === 'PARTIALLY_PAID') return { key: 'scheduled', label: 'Partially paid', date: r.paidAt || '' };
    return { key: 'billed', label: 'Billed — awaiting payment', date: r.billedAt || '' };
  }

  var SLA_COMP = {
    DEFAULT_PLANS: DEFAULT_PLANS, PLAN_LABEL: PLAN_LABEL, SALARY_PLAN_NOTE: SALARY_PLAN_NOTE,
    num: num, money: money, shortDate: shortDate,
    TIER_SCHEDULES: TIER_SCHEDULES, tierScheduleFor: tierScheduleFor, tierBps: tierBps,
    marginOf: marginOf, isClosedWon: isClosedWon, buildRows: buildRows,
    clientIsBrokerFor: clientIsBrokerFor, repeatKeyOf: repeatKeyOf,
    isPendingApproved: isPendingApproved, buildPendingRows: buildPendingRows, STAGE_LABEL: STAGE_LABEL, todayISO: todayISO,
    computeRow: computeRow, payoutState: payoutState,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SLA_COMP;
  if (root) root.SLA_COMP = SLA_COMP;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
