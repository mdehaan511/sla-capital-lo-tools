/**
 * admin-pricing-drift-report.mjs — GET /api/admin-pricing-drift-report
 *
 * Deploy 236.834 — find loans whose CANONICAL rate/points disagree with the
 * pricing snapshot saved at sizer time (Mike; prompted by Carl's Valparaiso
 * loan, where loan.points had been rewritten to 2 while the snapshot — and
 * the term sheet printed from it — said 1.5). Both sizer saves and Loan
 * Details inline edits rewrite the snapshot alongside the canonical fields,
 * so a persistent mismatch means some flow rewrote one without the other.
 *
 * Read-only. Walks the PG loans table (extra JSONB carries pricingSnapshot).
 * Skips loans without a snapshot (Baseline imports, pre-snapshot saves).
 *
 * Auth: admin only.
 * Response: { ok, scanned, withSnapshot, mismatches: [{ loanId, owner,
 *   clientId, address, status, field, loanValue, snapValue }], truncated }
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';

const MAX_ROWS = 200;

// Normalize a points value ('2', '1.50 pts', 1.5) → number or null.
function normPts(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  return isFinite(n) ? n : null;
}
// Normalize a rate to PERCENT. Loan rates are percent strings ('11.25') but
// Baseline-era fractions (0.1125) exist; snapshot.finalRate is a decimal
// fraction. No real rate is below 1%, so (0,1) = fraction.
function normRatePct(v) {
  if (v === null || v === undefined || v === '') return null;
  let n = parseFloat(String(v).replace(/[^0-9.]/g, ''));
  if (!isFinite(n) || n <= 0) return null;
  if (n < 1) n = n * 100;
  return n;
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });

    const SELECT = 'id,client_id,owner_email,address,status,tool_type,rate,points,extra';
    const PAGE = 500;
    let offset = 0, scanned = 0, withSnapshot = 0;
    const mismatches = [];
    for (;;) {
      const rows = await db.select('loans', { select: SELECT, limit: PAGE, offset });
      for (const r of (rows || [])) {
        scanned++;
        const ex = r.extra || {};
        const snap = ex.pricingSnapshot;
        if (!snap || typeof snap !== 'object') continue;
        withSnapshot++;

        const base = {
          loanId: r.id, owner: String(r.owner_email || '').toLowerCase(),
          clientId: r.client_id, address: r.address || '',
          status: r.status || '', toolType: r.tool_type || '',
        };
        // Points: snapshot.points is numeric (from the Origination card).
        const lp = normPts(r.points);
        const sp = normPts(snap.points);
        if (lp !== null && sp !== null && Math.abs(lp - sp) > 0.011 && mismatches.length < MAX_ROWS) {
          mismatches.push(Object.assign({}, base, { field: 'points', loanValue: lp, snapValue: sp }));
        }
        // Rate: snapshot.finalRate is a decimal fraction.
        const lr = normRatePct(r.rate);
        const sr = normRatePct(snap.finalRate);
        if (lr !== null && sr !== null && Math.abs(lr - sr) > 0.011 && mismatches.length < MAX_ROWS) {
          mismatches.push(Object.assign({}, base, { field: 'rate', loanValue: lr, snapValue: sr }));
        }
      }
      if (!rows || rows.length < PAGE) break;
      offset += PAGE;
      if (offset > 100000) break;
    }
    return json(200, {
      ok: true, scanned, withSnapshot,
      mismatchCount: mismatches.length, truncated: mismatches.length >= MAX_ROWS,
      mismatches,
    });
  } catch (e) {
    console.error('admin-pricing-drift-report error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
