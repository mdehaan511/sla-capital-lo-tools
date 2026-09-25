/**
 * _shared/calendar-events.mjs — Deploy 237.271 (Mike, MY DESK step 2)
 *
 * Mike: "a calendar that shows key dates including closing dates and inspection schedules
 * for BPOs and Appraisals" … "For the calendar you dont need to add maturity dates but
 * Closings, Inspections, Rate Lock Expirations are all a great idea."
 *
 * The one place that turns a loan into calendar events, so the home calendar and the MY
 * DESK calendar can never disagree:
 *
 *   closing     loan.fundingDate (the Closing Date on Loan Details). Past closings stay on
 *               the calendar marked closed; a cancelled / denied loan has none.
 *   inspection  loan.valuationOrder.scheduledDate (the BPO / Appraisal order, 237.269).
 *   rate_lock   DSCR only: 45 days from loan.rateLockStart (legacy: borrowerInfoCompletedAt)
 *               — the SAME rule as the Loan Details lock counter (_rateLockInfo) and the
 *               pipeline badge; a dead or closed loan's lock is not an event.
 *
 * Each event names the people it belongs to — the LO who owns the loan and everyone on
 * its processing team — which is what the calendars' person toggles filter on.
 * Pure: rows in, events out.
 */
export const CAL_TYPES = ['closing', 'inspection', 'rate_lock'];
export const LOCK_DAYS = 45;
const NO_EVENTS = ['cancelled', 'denied'];
const LOCK_DEAD = ['closed', 'cancelled', 'denied', 'sold', 'liquidated', 'paid_off'];

const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
export function isYmd(s) { return ymdRe.test(String(s || '')); }

/** An instant → its calendar date in Pacific time (the company's working day). */
export function ymdPacific(ms) {
  const d = new Date(ms);
  if (!isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** DSCR lock expiry date ('YYYY-MM-DD'), or '' when there is none. */
export function rateLockExpiry(row) {
  if (String(row.toolType || '').toLowerCase() !== 'dscr') return '';
  if (LOCK_DEAD.indexOf(String(row.status || '').toLowerCase()) >= 0) return '';
  if (String(row.processingStage || '') === 'pp_closed') return '';
  const t = Date.parse(row.rateLockStart || row.borrowerInfoCompletedAt || '');
  if (!isFinite(t)) return '';
  return ymdPacific(t + LOCK_DAYS * 86400000);
}

function teamOf(row) {
  if (Array.isArray(row.assignedProcessors) && row.assignedProcessors.length) return row.assignedProcessors.filter((m) => m && m.email);
  if (row.assignedProcessor && row.assignedProcessor.email) return [Object.assign({ role: 'processor' }, row.assignedProcessor)];
  return [];
}
function program(row) {
  const t = String(row.toolType || '').toLowerCase();
  return t === 'dscr' ? 'DSCR' : t === 'guc' ? 'GUC' : t === 'rtl' ? 'RTL' : (t ? t.toUpperCase() : '');
}

/**
 * Plain loan row → its events inside [from, to] (inclusive 'YYYY-MM-DD').
 * row: { id, clientId, owner, address, status, processingStage, loanAmt, toolType, loanType,
 *        fundingDate, valuationOrder, rateLockStart, borrowerInfoCompletedAt,
 *        assignedProcessors, assignedProcessor, borrower }
 */
export function eventsForLoan(row, from, to) {
  if (!row || !row.id) return [];
  const status = String(row.status || '').toLowerCase();
  if (NO_EVENTS.indexOf(status) >= 0) return [];
  const team = teamOf(row).map((m) => ({ email: String(m.email).toLowerCase(), name: m.name || m.email, role: m.role || 'processor' }));
  const owner = String(row.owner || '').toLowerCase();
  const people = [owner].concat(team.map((m) => m.email)).filter((e, i, a) => e && a.indexOf(e) === i);
  const base = {
    loanId: row.id, clientId: row.clientId || '', owner, address: row.address || '',
    borrower: row.borrower || '', amount: Number(String(row.loanAmt || '').replace(/[^0-9.]/g, '')) || 0,
    program: program(row), stage: row.processingStage || '', status, team, people,
  };
  const inRange = (d) => isYmd(d) && d >= from && d <= to;
  const out = [];
  const closeDate = String(row.fundingDate || '').slice(0, 10);
  if (inRange(closeDate)) {
    const closed = status === 'closed' || base.stage === 'pp_closed' || status === 'sold' || status === 'liquidated';
    out.push(Object.assign({ id: 'closing_' + row.id, type: 'closing', date: closeDate, closed }, base));
  }
  const vo = row.valuationOrder && typeof row.valuationOrder === 'object' ? row.valuationOrder : null;
  if (vo && inRange(String(vo.scheduledDate || ''))) {
    out.push(Object.assign({ id: 'inspection_' + row.id, type: 'inspection', date: vo.scheduledDate,
      kind: vo.kind === 'appraisal' ? 'Appraisal' : 'BPO', vendor: String(vo.vendor || '') }, base));
  }
  const lock = rateLockExpiry(row);
  if (inRange(lock)) out.push(Object.assign({ id: 'rate_lock_' + row.id, type: 'rate_lock', date: lock }, base));
  return out;
}

/** Every event across rows, date order, closings before inspections before locks on a day. */
export function eventsFor(rows, from, to) {
  const order = { closing: 0, inspection: 1, rate_lock: 2 };
  const out = [];
  (rows || []).forEach((r) => { out.push(...eventsForLoan(r, from, to)); });
  out.sort((a, b) => (a.date !== b.date ? (a.date < b.date ? -1 : 1) : (order[a.type] - order[b.type]) || String(a.address).localeCompare(String(b.address))));
  return out;
}
