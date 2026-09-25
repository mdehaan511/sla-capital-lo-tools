/**
 * calendar-events.mjs — GET /api/calendar-events?from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Deploy 237.271 (Mike, MY DESK step 2): the key-dates feed behind the home calendar and
 * the MY DESK calendar — closings, BPO / Appraisal inspections, DSCR rate-lock expirations
 * (_shared/calendar-events.mjs decides what each loan contributes).
 *
 * Scope: staff who may list every LO's loans (canListAllClients — admin, processor tier)
 * get every loan; everyone else gets the loans they own or are on the team of. The page's
 * person toggles narrow from there; the server never widens past this.
 *
 * Reads the loans table directly (lean: promoted columns + four JSON paths + the client's
 * name), the same source processing-alerts reads. Window capped at 70 days.
 *
 * → { from, to, events: [...], people: [{ email, name }] }
 */
import { handleOptions, json, requireAuth, normalizeEmail } from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs';
import { db } from './_shared/supabase-db.mjs';
import { eventsFor, isYmd } from './_shared/calendar-events.mjs';

const SELECT = 'id,client_id,owner_email,address,status,processing_stage,loan_amt,tool_type,loan_type,funding_date,' +
  'valuation_order:extra->valuationOrder,rate_lock_start:extra->>rateLockStart,' +
  'borrower_info_completed_at:extra->>borrowerInfoCompletedAt,' +
  'assigned_processors:extra->assignedProcessors,assigned_processor:extra->assignedProcessor,' +
  'clients!client_id(first_name,last_name,entity_name)';

/** PG row → the plain shape eventsForLoan takes. Pure. */
export function rowToCal(r) {
  const c = (r && r.clients) || {};
  return {
    id: r.id, clientId: r.client_id, owner: r.owner_email, address: r.address, status: r.status,
    processingStage: r.processing_stage, loanAmt: r.loan_amt, toolType: r.tool_type, loanType: r.loan_type,
    fundingDate: r.funding_date, valuationOrder: r.valuation_order, rateLockStart: r.rate_lock_start,
    borrowerInfoCompletedAt: r.borrower_info_completed_at,
    assignedProcessors: r.assigned_processors, assignedProcessor: r.assigned_processor,
    borrower: String(c.entity_name || ((c.first_name || '') + ' ' + (c.last_name || '')).trim()),
  };
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('calendar-events error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const from = String(url.searchParams.get('from') || ''), to = String(url.searchParams.get('to') || '');
  if (!isYmd(from) || !isYmd(to) || from > to) return json(400, { error: 'from and to must be dates, from first' });
  if ((Date.parse(to) - Date.parse(from)) / 86400000 > 70) return json(400, { error: 'At most 70 days at a time' });

  const self = normalizeEmail(user.email || '');
  const all = canListAllClients(user).ok;
  const rows = [];
  for (let offset = 0; offset < 100000; offset += 1000) {
    const page = await db.select('loans', { select: SELECT, limit: 1000, offset });
    rows.push(...(page || []));
    if (!page || page.length < 1000) break;
  }
  let loans = rows.map(rowToCal);
  if (!all) {
    loans = loans.filter((l) => String(l.owner || '').toLowerCase() === self ||
      (Array.isArray(l.assignedProcessors) && l.assignedProcessors.some((m) => m && String(m.email || '').toLowerCase() === self)) ||
      (l.assignedProcessor && String(l.assignedProcessor.email || '').toLowerCase() === self));
  }
  const events = eventsFor(loans, from, to);
  const names = {};
  events.forEach((e) => {
    if (e.owner && !names[e.owner]) names[e.owner] = '';
    e.team.forEach((m) => { if (!names[m.email]) names[m.email] = m.name || ''; });
  });
  const people = Object.keys(names).map((email) => ({ email, name: names[email] || '' }));
  return json(200, { from, to, scope: all ? 'all' : 'mine', events, people });
}
