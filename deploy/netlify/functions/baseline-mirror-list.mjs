/**
 * baseline-mirror-list.mjs — GET /api/baseline-mirror-list
 *
 * Deploy 232 (Mirror Phase 1 — Step 4). Admin-only read endpoint for
 * the dashboard (Phase 2). Returns whatever's in the local mirror
 * blob store without touching Baseline's API.
 *
 * Query params:
 *   ?summary=1  — return summary stats only (counts by status,
 *                 total $ by status, last mirror time) instead of
 *                 the full loan list. Useful for the eventual
 *                 dashboard header strip.
 *   ?status=X   — filter to a single Status value
 *   ?limit=N    — cap returned list (no offset for now; sortable
 *                 client-side since the dataset is small)
 *
 * Returns: {
 *   ok,
 *   count,
 *   loans?:   Array,             // full list (unless summary=1)
 *   summary?: { byStatus, totalLoanAmount, lastMirroredAt }
 * }
 */
import {
  handleOptions, json, requireAuth,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.170
import { listMirroredLoans } from './_shared/baseline-mirror.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-mirror-list error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canListAllClients(user).ok) return json(403, { error: 'Admin only' });

  const url = new URL(req.url);
  const summary = url.searchParams.get('summary') === '1';
  const statusFilter = url.searchParams.get('status') || '';
  const limit = parseInt(url.searchParams.get('limit') || '0', 10);

  const all = await listMirroredLoans();
  let loans = all;
  if (statusFilter) {
    loans = loans.filter((l) => (l && l.Status) === statusFilter);
  }

  if (summary) {
    const byStatus = {};
    let totalLoanAmount = 0;
    let lastMirroredAt = '';
    for (const l of all) {
      const s = (l && l.Status) || '(unknown)';
      const sub = (l && l.Substatus) || '';
      const key = sub ? (s + ' · ' + sub) : s;
      if (!byStatus[key]) byStatus[key] = { count: 0, totalLoanAmount: 0 };
      byStatus[key].count += 1;
      const amt = parseFloat(String((l && l.Loan_Amount) || 0).replace(/[$,]/g, ''));
      if (isFinite(amt)) {
        byStatus[key].totalLoanAmount += amt;
        totalLoanAmount += amt;
      }
      if (l && l._mirroredAt && l._mirroredAt > lastMirroredAt) lastMirroredAt = l._mirroredAt;
    }
    return json(200, {
      ok: true,
      count: all.length,
      summary: { byStatus, totalLoanAmount, lastMirroredAt },
    });
  }

  if (limit > 0 && loans.length > limit) loans = loans.slice(0, limit);
  return json(200, {
    ok: true,
    count: loans.length,
    totalInMirror: all.length,
    loans,
  });
}
