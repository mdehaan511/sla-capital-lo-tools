/**
 * _shared/financial-audit.mjs — Deploy 237.135 (Mike)
 *
 * "Keep track of the expected money coming in and going out of the business
 * based on loan generation, initial wires, draws, payoffs, points and fees
 * collected, when loans are traded ... NOT loan payments (those go through
 * servicers)."
 *
 * The ledger is DERIVED, never stored: every row is rebuilt from the loan
 * records (Postgres), the Sitewire draw cache and the audit state on each
 * read, so a changed closing date / amount moves the forecast with it. What IS
 * stored (blob store `financial_audit`, key `state`) is only what people add:
 *   accounts        [{ id, name, last4, entity, roles[] }]
 *   settings        { trackFrom: 'YYYY-MM-DD' }
 *   verifications   { rowKey: { at, by, amount, date, note, expected } }
 *   loanOverrides   { loanId: { fundingType?, net? } }
 *   manual          [{ id, date, kind, amount, fromAccountId, fromLabel, toAccountId, toLabel, memo, loanId, loanLabel, at, by }]
 *   alerts          { rowKey: ISO }   (24h assignment alert sent)
 *
 * Money movement per funding type (Mike, 9/17):
 *   SLA funded        closing wire SLA -> title; points + fees title -> SLA
 *                     (or net-funded: one wire, toggle per loan); draws SLA;
 *                     trade proceeds buyer -> SLA; payoff -> SLA unless sold.
 *   KAF funded        closing wire + draws from KAF; points + fees -> SLA;
 *                     trade proceeds / payoff -> KAF.
 *   SLA -> KAF        SLA funds the closing, KAF wires SLA the FULL loan amount
 *                     at closing (alert Mike + Dan when unverified 24h after
 *                     closing); draws / trade / payoff on the KAF side.
 *   Stride            warehouse line: the closing wire comes off the line and
 *                     sale proceeds / payoffs pay it down.
 *   Third-party       (correspondent / table funded) only our points + fees.
 *   DSCR              table funded by the investor: points + TPO (+ fees on file).
 * Trades: the buyer wires UPB +/- per-diem interest; Colchis sends one wire for
 * every loan in a trade, so trade rows are GROUPED by buyer + sold date.
 * After a trade the payoff goes to the buyer, so it is not on the ledger.
 */
import { getStore } from '@netlify/blobs';
import { getRoles } from './auth.mjs';

// Admins + processors only (Mike). senior_lo is processor-tier elsewhere on the
// server, but this page is deliberately not theirs.
export function canUseFinancialAudit(user) {
  return getRoles(user).some((r) => r === 'processor' || r === 'admin' || r === 'super_admin');
}

export const STORE = 'financial_audit';
const STATE_KEY = 'state';
export const DEFAULT_TRACK_FROM = '2026-09-01';

export const ENTITIES = {
  sla: 'Sir Lends A Lot LLC',
  kaf: 'King Arthur Fund 1 LLC',
  stride: 'Stride (warehouse line)',
  other: 'Other',
};
export const ROLES = {
  funding: 'Loan funding',
  fees: 'Points & fees received',
  draws: 'Draws',
  trades: 'Trade proceeds',
  payoffs: 'Payoffs',
  broker: 'Broker fees',
};
export const FUNDING_TYPES = {
  sla: 'SLA funded',
  kaf: 'KAF funded',
  sla_to_kaf: 'SLA → assigned to KAF',
  stride: 'Stride warehouse',
  table: 'Third-party funded',
  dscr: 'DSCR (investor funded)',
};
export const KIND_LABELS = {
  fund: 'Closing wire',
  fees: 'Points + fees',
  broker: 'Broker fee',
  assign: 'Assignment to KAF',
  draw: 'Draw',
  draw_reimb: 'Draw reimbursement', // Deploy 237.141
  trade: 'Trade proceeds',
  payoff: 'Payoff',
  dscr_comp: 'DSCR points + TPO',
  manual: 'Manual entry',
};

// Mirror of closed-loans.html RTL_FLAT_FEES_TOTAL / loan-details.js LD_RTL_FLAT_FEES.
export const RTL_FLAT_FEES_TOTAL = 600 + 900 + 500 + 150;

export const num = (v) => {
  const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, ''));
  return isFinite(n) ? n : 0;
};
export const ymd = (v) => {
  const s = String(v || '').trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[0];
  const d = new Date(s);
  return isNaN(d) ? '' : d.toISOString().slice(0, 10);
};
const round2 = (n) => Math.round(n * 100) / 100;

// Deploy 237.141 (Mike's closing sheet) -- prepaid interest is the interest from the
// funding date through the end of that month, the same formula the UW tab uses
// (loan-uw-calc.js): loan x rate / 365 x days. Keep the two in step.
export function prepaidInterestOf(l) {
  const amt = num(l.finalLoanAmount) || num(l.loanAmt);
  const rate = num(l.rate);
  const d = ymd(l.fundingDate);
  if (!(amt > 0) || !(rate > 0) || !d) return 0;
  const y = +d.slice(0, 4), m = +d.slice(5, 7), day = +d.slice(8, 10);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const days = daysInMonth - day + 1;   // funding day through month end, inclusive
  const r = rate > 1 ? rate / 100 : rate;
  return round2(amt * r / 365 * days);
}
// The sheet's note: "Prepaid Interest is only collected at closing on KAF and SLA
// Funded Loans. All other loans Prepaid interest and Impounds are net funded."
export const ppiCollectedAtClosing = (ft) => ft === 'sla' || ft === 'kaf' || ft === 'sla_to_kaf';
// Mike: draw reimbursements "occur at the end of the week that draws are approved".
export function weekEndOf(dateStr) {
  const d = ymd(dateStr);
  if (!d) return '';
  const t = Date.parse(d + 'T12:00:00Z');
  if (!isFinite(t)) return '';
  const dow = new Date(t).getUTCDay();          // 0 Sun .. 6 Sat
  return new Date(t + ((5 - dow + 7) % 7) * 86400000).toISOString().slice(0, 10); // that week's Friday
}
// "RTL - Stride" / "DSCR - DIYA" -- the sheet's Loan Type - Funding Source column.
const FUNDING_SOURCE_LABEL = { sla: 'SLA', kaf: 'KAF', sla_to_kaf: 'KAF', stride: 'Stride' };
export function productOf(l) {
  const t = String(l.toolType || '').toLowerCase();
  return t === 'dscr' ? 'DSCR' : t === 'guc' ? 'GUC' : 'RTL';
}
export function fundingLabelOf(l, ft) {
  const src = (ft === 'dscr' || ft === 'table')
    ? (cleanBuyer(l.investorName) || 'Correspondent')
    : (FUNDING_SOURCE_LABEL[ft] || ft || '');
  return productOf(l) + (src ? ' - ' + src : '');
}
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export function holderOfName(name) {
  const n = String(name || '').toLowerCase();
  if (/king\s*arthur|\bkaf\b/.test(n)) return 'kaf';
  if (/sir\s*lends|\bsla\b/.test(n)) return 'sla';
  if (/stride/.test(n)) return 'stride';
  return '';
}
const cleanBuyer = (name) => String(name || '').replace(/\s*\(.*\)\s*$/, '').trim();

export function isRtlLike(l) {
  const t = String(l.toolType || '').toLowerCase();
  if (t === 'rtl' || t === 'guc') return true;
  if (t === 'dscr') return false;
  const lt = String(l.loanType || '').toLowerCase();
  return /bridge|flip|rehab|ground|guc|construction|rtl/.test(lt);
}

export function holdbackOf(l) {
  const v = num(l.rehabBudget) || num(l.fdRehabBudget);
  if (v > 0) return v;
  const raw = l._baselineRaw;
  if (!raw) return 0;
  try {
    const b = typeof raw === 'string' ? JSON.parse(raw) : raw;
    for (const c of [b.Holdback, b.Rehab_Cost, b.Address_Total_Rehab]) { const n = parseFloat(c); if (isFinite(n) && n > 0) return n; }
  } catch (_) {}
  return 0;
}
export const amountOf = (l) => num(l.finalLoanAmount) || num(l.loanAmt);
export const feesOf = (l) => (l.closingFees != null && String(l.closingFees).trim() !== '') ? num(l.closingFees) : RTL_FLAT_FEES_TOTAL;
export function brokerFeeOf(l, amt) {
  const v = num(l.brokerFee);
  if (!(v > 0)) return 0;
  return v <= 10 ? round2(v / 100 * amt) : v; // "2" / "1.5" are points; bigger numbers are dollars
}
export function tpoOf(l) {
  for (const k of ['tpoSpread', 'tpo', 'tpoPremium']) {
    if (l[k] != null && String(l[k]).trim() !== '') return num(l[k]);
  }
  return null;
}

export function isClosedLoan(l) {
  const st = String(l.status || '').toLowerCase();
  if (st === 'denied' || st === 'cancelled') return false;
  return st === 'closed' || st === 'sold' || st === 'liquidated' || !!String(l.disposition || '').trim();
}
export function inPipeline(l) {
  const st = String(l.status || '').toLowerCase();
  if (isClosedLoan(l)) return false;
  if (st === 'denied' || st === 'cancelled' || st === 'on_hold') return false;
  return !!String(l.processingStage || '').trim();
}

/** Funding type: per-loan override, then the Funding Plan, then the holder on file. */
export function fundingTypeOf(l, override) {
  if (override && FUNDING_TYPES[override]) return override;
  if (!isRtlLike(l)) return 'dscr';
  const src = String(l.fundingSource || '').toLowerCase();
  const heldByKaf = holderOfName(l.assignedToEntity) === 'kaf' || holderOfName(l.investorName) === 'kaf';
  if (src === 'king_arthur') return 'kaf';
  if (src === 'stride') return 'stride';
  if (src === 'correspondent' || src === 'other') return 'table';
  if (src === 'sla_capital') return heldByKaf ? 'sla_to_kaf' : 'sla';
  // Legacy loans (no Funding Plan): a loan "sold" to KAF is an SLA -> KAF assignment.
  return heldByKaf ? 'sla_to_kaf' : 'sla';
}
const FUNDER = { sla: 'sla', kaf: 'kaf', sla_to_kaf: 'sla', stride: 'stride' };
const HOLDER = { sla: 'sla', kaf: 'kaf', sla_to_kaf: 'kaf', stride: 'stride' };
const DRAW_FUNDER = { sla: 'sla', kaf: 'kaf', sla_to_kaf: 'kaf', stride: 'sla' };

/** Close moment: closedAt when the loan was marked closed, else 5pm Pacific on the closing date. */
export function closeTsOf(l) {
  const t = Date.parse(l.closedAt || '');
  if (isFinite(t)) return t;
  const d = ymd(l.fundingDate);
  return d ? Date.parse(d + 'T17:00:00-07:00') : null;
}

export function resolveAccount(accounts, entity, role) {
  const list = Array.isArray(accounts) ? accounts : [];
  return list.find((a) => a.entity === entity && Array.isArray(a.roles) && a.roles.indexOf(role) !== -1)
    || list.find((a) => a.entity === entity && (!Array.isArray(a.roles) || !a.roles.length))
    || null;
}
function endpoint(accounts, spec) {
  if (spec.accountId) {
    const a = (accounts || []).find((x) => x.id === spec.accountId);
    if (a) return { entity: a.entity, accountId: a.id, label: a.name, last4: a.last4 || '' };
  }
  if (spec.entity) {
    const a = resolveAccount(accounts, spec.entity, spec.role);
    return a
      ? { entity: spec.entity, accountId: a.id, label: a.name, last4: a.last4 || '' }
      : { entity: spec.entity, accountId: '', label: ENTITIES[spec.entity] || spec.entity, last4: '', unassigned: true };
  }
  return { entity: '', accountId: '', label: spec.label || 'External', last4: '' };
}
function flowOf(from, to) {
  if (from.entity && to.entity) return 'transfer';
  return to.entity ? 'in' : 'out';
}

/**
 * Build every ledger row.
 *   loans   plain loan objects (camelCase) + _clientId / _owner / _borrower
 *   draws   Sitewire byLoanNumber map (org-draws cache) or null
 *   state   the audit state (see header)
 *   now     ms (tests)
 */
export function buildLedger(loans, draws, state, now) {
  const st = normalizeState(state);
  const nowMs = now || Date.now();
  const today = new Date(nowMs - 7 * 3600 * 1000).toISOString().slice(0, 10); // Pacific-ish
  const accounts = st.accounts;
  const rows = [];
  const trades = new Map();
  const undated = [];
  const closings = []; // Deploy 237.141

  const push = (r) => {
    r.from = endpoint(accounts, r.fromSpec);
    r.to = endpoint(accounts, r.toSpec);
    delete r.fromSpec; delete r.toSpec;
    r.flow = flowOf(r.from, r.to);
    r.amount = round2(r.amount);
    r.kindLabel = KIND_LABELS[r.kind] || r.kind;
    rows.push(r);
  };

  for (const l of loans || []) {
    if (!l || !l.id) continue;
    const closed = isClosedLoan(l);
    const pipeline = !closed && inPipeline(l);
    if (!closed && !pipeline) continue;
    const ov = st.loanOverrides[l.id] || {};
    const ft = fundingTypeOf(l, ov.fundingType);
    const close = ymd(l.fundingDate) || (closed ? ymd(l.closedAt) : '');
    const amt = amountOf(l);
    if (!(amt > 0)) continue;
    if (!close) { if (pipeline) undated.push({ loanId: l.id, address: l.address || '' }); continue; }
    const base = {
      loanId: l.id, clientId: l._clientId || '', owner: l._owner || '', address: l.address || '',
      borrower: l._borrower || '', slaId: l.slaDisplayId || '', fundingType: ft,
      fundingTypeLabel: FUNDING_TYPES[ft], fundingTypeOverridden: !!(ov.fundingType && FUNDING_TYPES[ov.fundingType]),
      pipeline, loanStatus: l.status || '', disposition: l.disposition || '',
    };
    const atClose = { date: close, forecast: pipeline || close > today };
    // Deploy 237.141 -- one row per closing for the Closings tab, shaped like Mike's
    // sheet: fees collected at the table, the rehab holdback, and (on an SLA -> KAF
    // assignment) the transfer block on the right.
    if (!pipeline) {
      const _hb = holdbackOf(l);
      const _orig = round2(num(l.points) / 100 * amt);
      const _other = (ft === 'dscr') ? num(l.closingFees) : feesOf(l);
      const _ppi = prepaidInterestOf(l);
      const _ppiIn = ppiCollectedAtClosing(ft);
      const _dscrTpo = (ft === 'dscr') ? round2((tpoOf(l) || 0) / 100 * amt) : 0;
      closings.push({
        loanId: l.id, clientId: base.clientId, owner: base.owner,
        slaNumber: l.slaDisplayId || '', address: base.address, borrower: base.borrower || '',
        closeDate: close, fundingType: ft, fundingLabel: fundingLabelOf(l, ft), product: productOf(l),
        loanAmount: amt,
        originationFee: _orig + _dscrTpo, otherFees: _other,
        prepaidInterest: _ppi, ppiCollected: _ppiIn,
        // Deploy 237.143 (Mike) -- what actually funded at the table. The Loan Terms
        // field wins when it is filled in; otherwise the loan less the rehab holdback.
        initialAdvance: num(l.initialAdvance) || round2(amt - _hb),
        rehabFunds: _hb, impounds: 0,
        totalCollected: round2(_orig + _dscrTpo + _other + (_ppiIn ? _ppi : 0)),
        // "Trades to KAF" on the sheet: what KAF wires SLA when the loan is assigned.
        kaf: ft === 'sla_to_kaf' ? {
          upb: round2(amt - _hb), remainingHoldback: _hb,
          fees: round2(_orig + _other), ppi: _ppi,
          total: round2(_orig + _other + _ppi), transferDate: close,
        } : null,
      });
    }
    const disp = String(l.disposition || '').toLowerCase();
    const buyerName = cleanBuyer(l.investorName);
    const buyerHolder = holderOfName(l.investorName);
    const soldToThirdParty = disp === 'sold' && isRtlLike(l) && !!buyerName && !buyerHolder && !!ymd(l.soldDate);
    const soldDate = soldToThirdParty ? ymd(l.soldDate) : '';

    if (ft === 'dscr') {
      const tpo = tpoOf(l);
      const pts = num(l.points);
      const fees = (l.closingFees != null && String(l.closingFees).trim() !== '') ? num(l.closingFees) : 0;
      const val = (pts + (tpo || 0)) / 100 * amt + fees;
      if (val > 0) {
        push(Object.assign({}, base, atClose, {
          key: l.id + ':dscr_comp', kind: 'dscr_comp', amount: val,
          fromSpec: { label: buyerName || 'Investor / title' }, toSpec: { entity: 'sla', role: 'fees' },
          detail: pts.toFixed(2) + ' pts + ' + (tpo == null ? 'TPO not set' : tpo.toFixed(2) + ' TPO') + ' on ' + money(amt) + (fees ? ' + ' + money(fees) + ' fees' : ''),
        }));
      }
      continue;
    }

    const hold = holdbackOf(l);
    const ptsD = round2(num(l.points) / 100 * amt);
    const fees = feesOf(l);
    const net = !!ov.net;

    if (ft !== 'table') {
      const wire = amt - hold - (net ? ptsD + fees : 0);
      push(Object.assign({}, base, atClose, {
        key: l.id + ':fund', kind: 'fund', amount: wire, net, canNet: true,
        fromSpec: { entity: FUNDER[ft], role: 'funding' }, toSpec: { label: 'Title / closing' },
        detail: money(amt) + ' loan' + (hold ? ' − ' + money(hold) + ' rehab holdback' : '') +
          (net ? ' − ' + money(ptsD + fees) + ' points + fees (net funded)' : ''),
      }));
    }
    if (!net || ft === 'table') {
      push(Object.assign({}, base, atClose, {
        key: l.id + ':fees', kind: 'fees', amount: ptsD + fees,
        fromSpec: { label: 'Title / closing' }, toSpec: { entity: 'sla', role: 'fees' },
        detail: num(l.points).toFixed(2) + ' pts (' + money(ptsD) + ') + ' + money(fees) + ' fees' +
          ((l.closingFees == null || String(l.closingFees).trim() === '') ? ' (standard fees — not set on the loan)' : ''),
      }));
    }
    const bf = brokerFeeOf(l, amt);
    if (bf > 0) {
      push(Object.assign({}, base, atClose, {
        key: l.id + ':broker', kind: 'broker', amount: bf,
        // Deploy 237.143 (Mike) -- paid on the HUD: settled at closing, so it is not a
        // separate wire out of SLA and there is nothing to match in the bank.
        canHud: true, onHud: !!ov.brokerOnHud, settled: !!ov.brokerOnHud,
        fromSpec: { entity: 'sla', role: 'broker' }, toSpec: { label: l.brokerName || 'Broker' },
        detail: (num(l.brokerFee) <= 10 ? num(l.brokerFee).toFixed(2) + ' pts' : 'flat') + ' broker fee',
      }));
    }
    if (ft === 'sla_to_kaf') {
      const ts = closeTsOf(l);
      push(Object.assign({}, base, atClose, {
        key: l.id + ':assign', kind: 'assign', amount: amt, closeTs: ts,
        alertDue: closed && ts ? ts + 24 * 3600 * 1000 : null,
        fromSpec: { entity: 'kaf', role: 'funding' }, toSpec: { entity: 'sla', role: 'funding' },
        detail: 'KAF buys the note at closing — full loan amount',
      }));
    }

    // Draws (Sitewire approved), funded by whoever holds the note; after a
    // third-party trade the buyer funds them, so those drop off.
    let drawnBeforeSale = 0;
    const sw = draws && l.slaDisplayId ? draws[String(l.slaDisplayId).trim().toUpperCase()] : null;
    if (sw && Array.isArray(sw.draws) && ft !== 'table') {
      for (const d of sw.draws) {
        if (!d || d.status !== 'approved' || !(d.approvedCents > 0)) continue;
        const dd = ymd(d.updatedAt);
        if (!dd) continue;
        if (soldDate && dd > soldDate) continue;
        if (soldDate) drawnBeforeSale += d.approvedCents / 100;
        push(Object.assign({}, base, {
          key: l.id + ':draw:' + d.id, kind: 'draw', date: dd, forecast: false, amount: d.approvedCents / 100,
          fromSpec: { entity: DRAW_FUNDER[ft], role: 'draws' }, toSpec: { label: 'Borrower (draw)' },
          detail: (d.name || ('Draw ' + (d.number || ''))) + (d.historical ? ' (historical)' : '') + ' — Sitewire approved',
        }));
        // Deploy 237.141 (Mike: "draws and draw reimbursements which occur at the end
        // of the week that draws are approved") -- when the party that FRONTS the draw
        // is not the party that holds the loan, the holder reimburses them that Friday.
        // Today that is the Stride warehouse line: SLA advances, the line pays it back.
        if (DRAW_FUNDER[ft] !== HOLDER[ft]) {
          const rd = weekEndOf(dd);
          push(Object.assign({}, base, {
            key: l.id + ':drawreimb:' + d.id, kind: 'draw_reimb', date: rd, forecast: rd > today,
            amount: d.approvedCents / 100,
            fromSpec: { entity: HOLDER[ft], role: 'draws' }, toSpec: { entity: DRAW_FUNDER[ft], role: 'draws' },
            detail: 'Reimburses the ' + (d.name || ('draw ' + (d.number || ''))) + ' approved ' + dd + ' (end of that week)',
          }));
        }
      }
    }

    if (soldToThirdParty && ft !== 'table') {
      const upb = num(l.upb) || (amt - hold + drawnBeforeSale);
      const holder = HOLDER[ft];
      const gk = 'trade:' + soldDate + ':' + slug(buyerName) + ':' + holder;
      if (!trades.has(gk)) {
        trades.set(gk, {
          key: gk, kind: 'trade', date: soldDate, forecast: soldDate > today, amount: 0, loans: [],
          loanId: '', address: '', borrower: '', buyer: buyerName, fundingType: '',
          fromSpec: { label: buyerName }, toSpec: { entity: holder, role: 'trades' },
        });
      }
      const g = trades.get(gk);
      g.amount += upb;
      g.loans.push({ loanId: l.id, clientId: base.clientId, owner: base.owner, address: base.address,
        borrower: base.borrower, slaId: base.slaId, upb: round2(upb), upbOnFile: !!num(l.upb) });
    }

    const payoff = ymd(l.payoffDate);
    if (payoff && disp === 'paid_off' && !soldToThirdParty && ft !== 'table' && num(l.payoffAmount) > 0) {
      push(Object.assign({}, base, {
        key: l.id + ':payoff', kind: 'payoff', date: payoff, forecast: payoff > today, amount: num(l.payoffAmount),
        fromSpec: { label: 'Title / payoff' }, toSpec: { entity: HOLDER[ft], role: 'payoffs' },
        detail: 'Payoff to the note holder',
      }));
    }
  }

  for (const g of trades.values()) {
    g.detail = g.loans.length + ' loan' + (g.loans.length === 1 ? '' : 's') + ' — UPB ± per-diem interest';
    push(g);
  }

  for (const m of st.manual) {
    push({
      key: 'manual:' + m.id, kind: 'manual', manualId: m.id, date: ymd(m.date), forecast: ymd(m.date) > today,
      amount: num(m.amount), loanId: m.loanId || '', address: m.loanLabel || '', borrower: '',
      fromSpec: m.fromAccountId ? { accountId: m.fromAccountId } : { label: m.fromLabel || 'External' },
      toSpec: m.toAccountId ? { accountId: m.toAccountId } : { label: m.toLabel || 'External' },
      detail: m.memo || '', memo: m.memo || '', by: m.by || '',
    });
  }

  // Status + verification.
  for (const r of rows) {
    const v = st.verifications[r.key];
    if (v) {
      r.verified = v;
      r.status = (v.expected != null && Math.abs(num(v.expected) - r.amount) > 1) ? 'changed' : 'verified';
    } else if (r.settled) r.status = 'settled'; // Deploy 237.143 -- nothing to match
    else if (r.date > today) r.status = 'upcoming';
    else if (r.date === today) r.status = 'due';
    else r.status = 'overdue';
    if (r.kind === 'assign' && !v && r.alertDue && r.alertDue < nowMs) r.late24h = true;
  }
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : (a.key < b.key ? -1 : 1)));
  closings.sort((a, b) => (a.closeDate < b.closeDate ? -1 : a.closeDate > b.closeDate ? 1 : 0));
  return { rows, undated, today, closings };
}

function money(n) { return '$' + Math.round(num(n)).toLocaleString('en-US'); }

// ── State ───────────────────────────────────────────────────────────────
export function normalizeState(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    accounts: Array.isArray(o.accounts) ? o.accounts : [],
    settings: Object.assign({ trackFrom: DEFAULT_TRACK_FROM }, o.settings || {}),
    verifications: o.verifications && typeof o.verifications === 'object' ? o.verifications : {},
    loanOverrides: o.loanOverrides && typeof o.loanOverrides === 'object' ? o.loanOverrides : {},
    manual: Array.isArray(o.manual) ? o.manual : [],
    alerts: o.alerts && typeof o.alerts === 'object' ? o.alerts : {},
  };
}
const _store = () => getStore({ name: STORE, consistency: 'strong' });
export async function readState() {
  const got = await _store().get(STATE_KEY, { type: 'json' }).catch(() => null);
  return normalizeState(got);
}
/** Read-modify-write with an etag guard (retries when another save landed first). */
export async function mutateState(fn) {
  const store = _store();
  for (let i = 0; i < 5; i++) {
    const got = await store.getWithMetadata(STATE_KEY, { type: 'json' }).catch(() => null);
    const state = normalizeState(got && got.data);
    const out = await fn(state);
    const opts = got && got.etag ? { onlyIfMatch: got.etag } : { onlyIfNew: true };
    const res = await store.setJSON(STATE_KEY, state, opts);
    if (!res || res.modified !== false) return { state, out };
  }
  throw new Error('Could not save — the ledger was being edited at the same time. Try again.');
}

// ── Loans from Postgres ─────────────────────────────────────────────────
const EXTRA_KEYS = ['fundingSource', 'assignedToEntity', 'investorName', 'finalLoanAmount', 'closingFees',
  'brokerFee', 'brokerName', 'disposition', 'soldDate', 'upb', 'payoffDate', 'payoffAmount', 'closedAt',
  'tpo', 'tpoSpread', 'tpoPremium', 'initialAdvance', '_baselineRaw']; // Deploy 237.143
export const LOAN_SELECT = 'id,client_id,owner_email,address,status,processing_stage,tool_type,loan_type,loan_amt,points,' +
  'rehab_budget,funding_date,sla_display_id,rate,fdRehabBudget:form_data->>rehabBudget,' +
  EXTRA_KEYS.map((k) => k + ':extra->>' + k).join(',') +
  ',clients!client_id(first_name,last_name,entity_name)';

export function pgRowToLoan(r) {
  const c = r.clients || {};
  const person = ((c.first_name || '') + ' ' + (c.last_name || '')).replace(/\s+/g, ' ').trim();
  const l = {
    id: r.id, _clientId: r.client_id, _owner: r.owner_email || '',
    _borrower: c.entity_name || person || '',
    address: r.address, status: r.status, processingStage: r.processing_stage,
    toolType: r.tool_type, loanType: r.loan_type, loanAmt: r.loan_amt, points: r.points, rate: r.rate,
    rehabBudget: r.rehab_budget, fdRehabBudget: r.fdRehabBudget, fundingDate: r.funding_date,
    slaDisplayId: r.sla_display_id,
  };
  EXTRA_KEYS.forEach((k) => { l[k] = r[k]; });
  return l;
}

export async function loadLedgerLoans(pgGet) {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await pgGet('loans', 'select=' + LOAN_SELECT + '&status=not.in.(denied,cancelled)&order=funding_date.asc.nullslast&limit=1000&offset=' + offset);
    page.forEach((r) => out.push(pgRowToLoan(r)));
    if (page.length < 1000) break;
  }
  return out;
}

export async function loadDrawCache() {
  try {
    const c = await getStore({ name: 'sitewire-cache', consistency: 'strong' }).get('org-draws-v1', { type: 'json' });
    return c ? { byLoanNumber: c.byLoanNumber || {}, fetchedAt: c.fetchedAt || '' } : { byLoanNumber: null, fetchedAt: '' };
  } catch (_) { return { byLoanNumber: null, fetchedAt: '' }; }
}
