/**
 * baseline-discover-statuses.mjs — GET /api/baseline-discover-statuses
 *
 * Deploy 236.547 — Phase 1 DISCOVERY step for the loan-processing-stage
 * migration (parallel read-only mirror of Baseline's loan Status; full cutover
 * is the eventual goal). SUPER-ADMIN, READ-ONLY.
 *
 * Calls Baseline's GET /loan list (via the existing fetchAllLoanList helper,
 * which already returns the sparse list view: Id, Name, Status, Substatus, …)
 * and returns the DISTINCT `Status` + `Substatus` values actually in use, with
 * counts + a few sample loan names. That gives us Baseline's real stage
 * vocabulary so the SLA stage mapping is built on ground truth instead of a
 * guess — and it doubles as the connectivity smoke-test for the read-back sync
 * we'll build next.
 *
 * No writes, no schema changes — purely informational.
 */
import { handleOptions, json, requireAuth, isSuperAdmin } from './_shared/auth.mjs';
import { fetchAllLoanList } from './_shared/baseline-mirror.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-discover-statuses error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  const res = await fetchAllLoanList();
  if (!res.ok) {
    return json(502, {
      ok: false,
      error: 'Baseline loan list failed: ' + (res.error || ('HTTP ' + res.status)),
      baselineHttpStatus: res.status || 0,
    });
  }
  const loans = res.loans || [];

  // Tally distinct Status + Substatus, plus the Status×Substatus cross (so we
  // can see e.g. how RTL vs DSCR loans distribute across stages).
  const statusMap = {}; // status -> { status, count, samples[] }
  const subMap = {};    // substatus -> count
  const crossMap = {};  // "status | substatus" -> count
  for (const l of loans) {
    const st  = _s(l.Status    != null ? l.Status    : l.status);
    const sub = _s(l.Substatus != null ? l.Substatus : (l.Sub_Status != null ? l.Sub_Status : l.substatus));
    const name = _s(l.Name || l.Address_Street1 || l.Id || l._Id) || '(unnamed)';
    if (st) {
      if (!statusMap[st]) statusMap[st] = { status: st, count: 0, samples: [] };
      statusMap[st].count += 1;
      if (statusMap[st].samples.length < 4) statusMap[st].samples.push(name);
    }
    if (sub) subMap[sub] = (subMap[sub] || 0) + 1;
    if (st) {
      const ck = st + '  |  ' + (sub || '—');
      crossMap[ck] = (crossMap[ck] || 0) + 1;
    }
  }
  const byCount = (a, b) => b.count - a.count;

  return json(200, {
    ok: true,
    totalLoans: loans.length,
    distinctStatuses: Object.values(statusMap).sort(byCount),
    distinctSubstatuses: Object.keys(subMap).map((k) => ({ substatus: k, count: subMap[k] })).sort(byCount),
    statusSubstatusCross: Object.keys(crossMap).map((k) => ({ combo: k, count: crossMap[k] })).sort(byCount),
  });
}

function _s(v) { return (v == null ? '' : String(v)).trim(); }
