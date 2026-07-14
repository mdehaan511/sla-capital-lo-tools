/**
 * dashboard-public.mjs — GET /api/dashboard-public
 *
 * Deploy 236.334 — public-safe view of the baseline mirror for the
 * home-page dashboards (Performance Stats, Upcoming Closings, Loans
 * by State, Loans table). Same data as /api/baseline-mirror-list but:
 *   - Auth = any signed-in user (LOs, processors, admins). No
 *     canListAllClients gate.
 *   - Per-loan commission fields (Origination_Points, Origination)
 *     are stripped so LOs can't see peers' revenue math.
 * Everything else — Loan_Amount, Rate, address, borrower, state,
 * dates, status — passes through unchanged so the widgets can render
 * the same shapes as the admin dashboard.
 *
 * Returns: {
 *   ok, count, loans: [ … ]
 * }
 */
import {
  handleOptions, json, requireAuth,
} from './_shared/auth.mjs';
import { listMirroredLoans } from './_shared/baseline-mirror.mjs';

// Fields the home page shows or aggregates. Anything not on this
// allowlist gets dropped BEFORE we send it — belt-and-suspenders
// against future mirror shape changes leaking new sensitive fields.
const PUBLIC_FIELDS = new Set([
  'Id', 'Name', 'Status', 'Substatus',
  'Loan_Amount', 'Rate',
  'Address_State', 'Address_City', 'Address_Zip', 'Address_Street',
  'Estimated_Close_Date', 'Close_Date',
  'Loan_Type', 'Loan_Product',
  'Created_Date', 'Updated_Date',
  '_mirroredAt', '_baselineId',
]);

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

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const all = await listMirroredLoans();
  const stripped = all.map((l) => {
    if (!l || typeof l !== 'object') return l;
    const out = {};
    for (const k of Object.keys(l)) {
      if (PUBLIC_FIELDS.has(k)) out[k] = l[k];
    }
    return out;
  });

  return json(200, {
    ok: true,
    count: stripped.length,
    loans: stripped,
  });
}
