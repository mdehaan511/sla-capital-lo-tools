/**
 * processing-alerts.mjs — GET /api/processing-alerts
 *
 * Deploy 236.565 — "notifications wired to processing events" (owner
 * follow-up #2). Computes a small, per-user list of ACTIONABLE processing
 * alerts so the global notification bell (sla-notifications.js) can surface
 * them on any page — not just inside the Processing Pipeline.
 *
 * Alert kinds (all scoped to loans assigned to the calling processor):
 *   closing_soon — funding date is within CLOSING_WINDOW days (or already
 *                  past and the loan hasn't closed). "Your loan closes soon."
 *   aging        — the loan has sat in Processing/Underwriting longer than
 *                  AGING_DAYS (uses loan.processingStageAt, stamped by
 *                  loan-processing-stage.mjs on a real stage change; falls
 *                  back to updatedAt).
 *   conditions   — the loan has open (uncleared) conditions
 *                  (loan.openConditions, denormalized by loan-reviews-save
 *                  in 236.564).
 *
 * Manager add-on (admins only):
 *   unassigned_closing — a loan with NO assigned processor is closing within
 *                        the window. "Nobody is on this."
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
const CLOSING_WINDOW_DAYS = 5;   // funding within N days = "closing soon"
const AGING_DAYS          = 7;   // in Processing/UW ≥ N days = "aging"
const AGING_HIGH_DAYS     = 14;  // ≥ N days = high severity
const MAX_ALERTS          = 60;  // hard cap on the returned list

// Stages/statuses that are done or dead — never ping about these.
const CLOSED_STAGE   = 'pp_closed';
const DEAD_STATUSES  = ['closed', 'cancelled', 'denied', 'sold', 'liquidated'];
const AGING_STAGES   = ['processing', 'underwriting'];

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
    case 'new_loan':     return 'Lead';
    case 'processing':   return 'Processing';
    case 'underwriting': return 'Underwriting';
    case 'pp_approved':  return 'Approved';
    case 'pp_closed':    return 'Closed';
    default:             return 'Processing';
  }
}

// Whole-day delta between a date-ish value and now (positive = future).
function _daysUntil(value, now) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (!isFinite(t)) return null;
  return Math.ceil((t - now) / 86400000);
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

    // ── Alerts for loans assigned to me ──────────────────────────
    if (mine) {
      // closing_soon
      const du = _daysUntil(l.funding_date, now);
      if (du != null && du <= CLOSING_WINDOW_DAYS) {
        const overdue = du < 0;
        alerts.push(Object.assign({}, base, {
          kind: 'closing_soon',
          id: 'pa_closing_' + l.id,
          subtitle: overdue
            ? ('Close date passed ' + _fmtDays(Math.abs(du)) + ' ago')
            : ('Closes in ' + _fmtDays(du)),
          dateIso: l.funding_date || '',
          severity: (overdue || du <= 2) ? 'high' : 'normal',
        }));
      }

      // aging
      if (AGING_STAGES.indexOf(stage) >= 0) {
        const stageAt = ex.processingStageAt || l.updated_at;
        const dis = _daysSince(stageAt, now);
        if (dis != null && dis >= AGING_DAYS) {
          alerts.push(Object.assign({}, base, {
            kind: 'aging',
            id: 'pa_aging_' + l.id,
            subtitle: dis + ' days in ' + _stageLabel(stage),
            dateIso: stageAt || '',
            severity: dis >= AGING_HIGH_DAYS ? 'high' : 'normal',
          }));
        }
      }

      // conditions
      const openC = Number(ex.openConditions) || 0;
      if (openC > 0) {
        alerts.push(Object.assign({}, base, {
          kind: 'conditions',
          id: 'pa_cond_' + l.id,
          subtitle: openC + (openC === 1 ? ' open condition' : ' open conditions'),
          dateIso: l.updated_at || '',
          severity: 'normal',
        }));
      }
    }

    // ── Manager add-on: unassigned loans closing soon ────────────
    if (manager && !assignee) {
      const du = _daysUntil(l.funding_date, now);
      if (du != null && du <= CLOSING_WINDOW_DAYS) {
        alerts.push(Object.assign({}, base, {
          kind: 'unassigned_closing',
          id: 'pa_unassigned_' + l.id,
          subtitle: 'Unassigned · ' + (du < 0
            ? ('close date passed ' + _fmtDays(Math.abs(du)) + ' ago')
            : ('closes in ' + _fmtDays(du))),
          dateIso: l.funding_date || '',
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
