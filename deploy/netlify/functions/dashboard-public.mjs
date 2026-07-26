/**
 * dashboard-public.mjs — GET /api/dashboard-public
 *
 * Deploy 236.334 — view of the baseline mirror for the home-page
 * dashboards (Performance / Upcoming Closings / Loans by State /
 * Loans). Same shape as /api/baseline-mirror-list but auth is
 * loosened from `canListAllClients` (admin+processor only) to any
 * signed-in user, so LOs can see the same numbers on the home page
 * they'd see on the admin Dashboard.
 *
 * Deploy 236.335 — dropped the field allowlist per Mike; home page
 * now mirrors admin dashboard 1:1 (including per-loan commission
 * fields needed to compute Est. Revenue).
 *
 * Returns: { ok, count, loans: [ … ] }
 */
import {
  handleOptions, json, requireAuth,
} from './_shared/auth.mjs';
import { listMirroredLoans } from './_shared/baseline-mirror.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('dashboard-public error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const loans = await listMirroredLoans();
  return json(200, {
    ok: true,
    count: loans.length,
    loans,
  });
}
