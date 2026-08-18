/**
 * loan-stage-drift-report.mjs — GET /api/loan-stage-drift-report
 *
 * Deploy 236.601 — READ-ONLY diagnostic. Reports loans whose SLA status (or
 * Baseline status) is terminal (the loan is done — closed / sold / liquidated /
 * paid off / servicing) but whose processingStage is still a PRE-close stage
 * (new_loan / processing / underwriting / pp_approved). That drift is the root of
 * the "showing in underwriting but also closed" cases: a loan closed in Baseline
 * but its processing stage was never advanced to pp_closed.
 *
 * The processing-pipeline display already self-heals (236.583 made status==='closed'
 * win over a stale stage), so borrowers/LOs see the right column. This report
 * quantifies the underlying DATA drift so a backfill can be scoped — it makes NO
 * changes.
 *
 * Auth: admin / super_admin (data-quality tooling).
 * Response: { ok, total, scannedLoans, byCombo, sample[], note }
 */
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';

// A loan is "done" when its SLA status is terminal...
const TERMINAL_STATUSES = ['closed', 'sold', 'liquidated'];
// ...or its Baseline status says so (some loans carry the terminal state only in
// baselineStatus until a read-back sync promotes it).
const TERMINAL_BASELINE = ['closed', 'sold', 'liquidated', 'paid off', 'servicing', 'in servicing'];
// Stages that should have advanced to pp_closed once the loan finished.
const PRECLOSE_STAGES = ['new_loan', 'processing', 'underwriting', 'pp_approved'];

const LOAN_SELECT = 'id,client_id,owner_email,address,status,processing_stage,updated_at,extra';

// Page through the loans table (same shape as processing-alerts.mjs _allLoans).
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

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-stage-drift-report error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  let loans;
  try {
    loans = await _allLoans();
  } catch (e) {
    console.error('loan-stage-drift-report loans read failed:', e && e.message);
    return json(500, { error: 'DB read failed: ' + (e && e.message) });
  }

  const drifts = [];
  const byCombo = {};

  for (const l of (loans || [])) {
    const stage = String(l.processing_stage || '').toLowerCase().trim();
    if (PRECLOSE_STAGES.indexOf(stage) < 0) continue; // stage isn't pre-close → no drift

    const status = String(l.status || '').toLowerCase().trim();
    const ex = (l.extra && typeof l.extra === 'object') ? l.extra : {};
    const baseline = String(ex.baselineStatus || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();

    const statusTerminal   = TERMINAL_STATUSES.indexOf(status) >= 0;
    const baselineTerminal = TERMINAL_BASELINE.indexOf(baseline) >= 0;
    if (!statusTerminal && !baselineTerminal) continue; // not a finished loan → no drift

    const reason = statusTerminal ? ('status=' + status) : ('baselineStatus=' + baseline);
    const combo = reason + ' + stage=' + stage;
    byCombo[combo] = (byCombo[combo] || 0) + 1;

    drifts.push({
      loanId:          l.id,
      clientId:        l.client_id || '',
      owner:           l.owner_email || '',
      address:         l.address || '',
      status:          status || '(none)',
      processingStage: stage,
      baselineStatus:  baseline || '',
      driftBy:         statusTerminal ? 'status' : 'baseline',
      updatedAt:       l.updated_at || '',
    });
  }

  drifts.sort((a, b) => String(a.owner + a.address).localeCompare(String(b.owner + b.address)));

  return json(200, {
    ok: true,
    total: drifts.length,
    scannedLoans: (loans || []).length,
    byCombo,
    sample: drifts.slice(0, 200), // cap the payload; total is the true count
    note: 'READ-ONLY dry run — nothing was modified. Lists loans whose SLA status ' +
          '(or Baseline status) is terminal (closed/sold/liquidated/paid off/servicing) ' +
          'but whose processingStage is still a pre-close stage ' +
          '(new_loan/processing/underwriting/pp_approved). These are candidates for a ' +
          'processingStage → pp_closed backfill.',
    _source: 'postgres',
  });
}
