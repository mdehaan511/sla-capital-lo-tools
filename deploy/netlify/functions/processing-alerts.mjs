/**
 * processing-alerts.mjs — GET /api/processing-alerts
 *
 * Deploy 236.565 — "notifications wired to processing events" (owner
 * follow-up #2). Computes a small, per-user list of ACTIONABLE processing
 * alerts so the global notification bell (sla-notifications.js) can surface
 * them on any page — not just inside the Processing Pipeline.
 *
 * Deploy 237.206 (Mike) rewrote the list. What a LIVE alert is for: a condition that
 * is true right now and that someone should end by doing something. Anything that
 * happens at a MOMENT is a stored notification instead, so it can be read once and be
 * done with (condition added, cleared to close, loan assigned, task assigned).
 *
 * Alert kinds (scoped to loans assigned to the calling processor):
 *   stale — the loan has gone STALE_DAYS without an update. Mike: "if its gone 7+ days
 *           without an update." Measured from the loan's last write (updated_at),
 *           falling back to processingStageAt, and only for loans IN the processing
 *           pipeline -- a lead nobody has touched is not stalled, it is a lead.
 *
 * Manager add-on (admins only):
 *   unassigned — a loan has been in the pipeline UNASSIGNED_HOURS with no processor on
 *                it. Mike: "For Admins when a loan goes 24 hours without someone
 *                assigned." The clock starts when the loan ENTERS the pipeline, not when
 *                the record was created, or every lead ever taken would qualify forever.
 *
 * REMOVED in 237.206:
 *   closing_soon       — Mike: "Remove Closing Soon, people know that."
 *   unassigned_closing — replaced by the 24-hour rule above.
 *   conditions         — a standing "N open conditions" count was a state, not news.
 *                        Replaced by the condition_added notification.
 *
 * Auth: processor tier (processor / admin / super_admin). A plain LO gets a
 * 403; the bell only calls this when SLA.isProcessor(user) is true.
 *
 * The response is intentionally tiny (id/title/subtitle/link parts + severity)
 * so the bell can poll it on a slow cadence without a heavy payload. It reads
 * the `loans` table directly (no client join) — the same source the pipeline
 * loads, projected down to just the alert fields.
 */
import {
  handleOptions, json, requireAuth, normalizeEmail, isProcessor, isAdmin,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';

// Tunables.
const STALE_DAYS       = 7;   // no update in N days = "stale"  (Mike, 237.206)
const STALE_HIGH_DAYS  = 14;  // ≥ N days = high severity
const UNASSIGNED_HOURS = 24;  // in the pipeline this long with nobody on it
const MAX_ALERTS       = 60;  // hard cap on the returned list

// Stages/statuses that are done or dead — never ping about these.
const CLOSED_STAGE   = 'pp_closed';
const DEAD_STATUSES  = ['closed', 'cancelled', 'denied', 'sold', 'liquidated'];
// IN the processing pipeline and not finished. An empty stage means the loan is still a
// lead (loan-advance-status stamps 'new_loan' at handoff), and a lead has no business
// generating processing alerts -- that is how 237.204's flood of 403-day-old "close date
// passed" rows happened.
const ACTIVE_STAGES  = ['new_loan', 'processing', 'underwriting', 'pp_approved'];

const LOAN_SELECT = 'id,client_id,owner_email,address,status,processing_stage,' +
  'loan_amt,funding_date,updated_at,extra';

// Page through the loans table (cross-owner: a processor's assigned loans can
// belong to any LO). Same paging shape as quotes-list.mjs's _loansPG.
async function _allLoans() {
  const PAGE = 1000;
  const out = [];
  let offset = 0;
  for (;;) {
    const rows = await db.select('loans', { select: LOAN_SELECT, limit: PAGE, offset });
    out.push(...(rows || []));
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break; // safety valve
  }
  return out;
}

function _fmtDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return '1 day';
  return n + ' days';
}

function _stageLabel(stage) {
  switch (stage) {
    case 'new_loan':     return 'Intake';
    case 'processing':   return 'Processing';
    case 'underwriting': return 'Underwriting';
    case 'pp_approved':  return 'Cleared to Close';
    case 'pp_closed':    return 'Closed';
    default:             return 'Processing';
  }
}

// Whole hours since a date-ish value, or null when there is nothing to measure from.
// Deploy 237.206 -- the unassigned rule is in hours, and rounding it to days would make
// "24 hours" mean anything from one day to two.
// Deploy 237.208 -- `now` here is Date.now(), a NUMBER, exactly as _daysSince above
// takes it. This subtracted now.getTime() and threw on the first unassigned loan.
function _hoursSince(value, now) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!isFinite(t)) return null;
  return Math.floor((now - t) / 3600000);
}

function _fmtHours(h) {
  if (h < 48) return h + (h === 1 ? ' hour' : ' hours');
  return _fmtDays(Math.floor(h / 24));
}
function _daysSince(value, now) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!isFinite(t)) return null;
  return Math.floor((now - t) / 86400000);
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('processing-alerts error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const selfEmail = normalizeEmail(user.email);
  const manager = isAdmin(user);
  const now = Date.now();

  let loans;
  try {
    loans = await _allLoans();
  } catch (e) {
    console.error('processing-alerts loans read failed:', e && e.message);
    return json(500, { error: 'DB read failed: ' + (e && e.message) });
  }

  const alerts = [];

  for (const l of (loans || [])) {
    const stage  = l.processing_stage || '';
    const status = String(l.status || '').toLowerCase();
    if (stage === CLOSED_STAGE) continue;         // already closed
    if (DEAD_STATUSES.indexOf(status) >= 0) continue; // dead/terminal

    const ex = (l.extra && typeof l.extra === 'object') ? l.extra : {};
    const assignee = (ex.assignedProcessor && ex.assignedProcessor.email)
      ? normalizeEmail(ex.assignedProcessor.email) : '';
    const mine = assignee && assignee === selfEmail;

    const base = {
      loanId:   l.id,
      clientId: l.client_id || '',
      owner:    l.owner_email || '',
      title:    l.address || 'Loan',
      dateIso:  '',
    };

    // Only loans actually in the pipeline can be stalled or unassigned. Deploy 237.206.
    const inPipeline = ACTIVE_STAGES.indexOf(stage) >= 0;

    // ── Stale: assigned to me and nobody has touched it ──────────
    // Mike: "Again if its gone 7+ days without an update." Measured from the last write,
    // not from the stage change: a loan can sit in Underwriting for a month and be worked
    // on every day, and that is not what anyone means by stalled.
    if (mine && inPipeline) {
      const lastTouch = l.updated_at || ex.processingStageAt;
      const dis = _daysSince(lastTouch, now);
      if (dis != null && dis >= STALE_DAYS) {
        alerts.push(Object.assign({}, base, {
          kind: 'stale',
          id: 'pa_stale_' + l.id,
          subtitle: 'No update in ' + _fmtDays(dis) + ' · ' + _stageLabel(stage),
          dateIso: lastTouch || '',
          severity: dis >= STALE_HIGH_DAYS ? 'high' : 'normal',
        }));
      }
    }

    // ── Manager add-on: nobody is on this ────────────────────────
    // Mike: "For Admins when a loan goes 24 hours without someone assigned." The clock
    // runs from when the loan ENTERED the pipeline (processingStageAt, stamped at the
    // handoff), falling back to the last write for loans that predate that stamp.
    if (manager && !assignee && inPipeline) {
      const since = ex.processingStageAt || l.updated_at;
      const hrs = _hoursSince(since, now);
      if (hrs != null && hrs >= UNASSIGNED_HOURS) {
        alerts.push(Object.assign({}, base, {
          kind: 'unassigned',
          id: 'pa_unassigned_' + l.id,
          subtitle: 'Nobody assigned · ' + _fmtHours(hrs) + ' in ' + _stageLabel(stage),
          dateIso: since || '',
          severity: 'high',
        }));
      }
    }
  }

  // High severity first, then soonest date.
  const rank = { high: 0, normal: 1 };
  alerts.sort(function (a, b) {
    const r = (rank[a.severity] || 1) - (rank[b.severity] || 1);
    if (r !== 0) return r;
    return String(a.dateIso || '').localeCompare(String(b.dateIso || ''));
  });

  return json(200, { alerts: alerts.slice(0, MAX_ALERTS), _source: 'postgres' });
}
