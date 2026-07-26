/**
 * baseline-mirror-purge-ghosts.mjs — POST /api/baseline-mirror-purge-ghosts
 *
 * Deploy 236.176 — bulk ghost detection + purge.
 *
 * Fetches Baseline's current loan list. Walks the mirror. Any
 * mirror entry whose Id is NOT in Baseline's list is a ghost —
 * a fossil from a prior sync of a loan Baseline has since deleted
 * or renamed. Optionally purges them so the dashboard stops
 * showing statuses like LEAD for loans that no longer exist.
 *
 * Body: { dryRun?: bool } — default TRUE for safety. Pass
 *                            dryRun:false to actually delete.
 * Response: {
 *   ok, mirrorCount, baselineListCount, ghostCount, purged,
 *   ghosts: [{ id, mirroredAt, status, substatus, address }, ...]
 * }
 * Auth: admin only.
 */
import { handleOptions, json, requireAuth, isAdmin, readJsonBody } from './_shared/auth.mjs';
import {
  fetchAllLoanList, listMirroredLoans, deleteMirroredLoan,
} from './_shared/baseline-mirror.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-mirror-purge-ghosts error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  // Fail-safe default: dryRun=true. Caller must explicitly opt
  // in with dryRun:false to actually delete.
  const dryRun = body.dryRun !== false;

  const list = await fetchAllLoanList();
  if (!list.ok) return json(502, { error: 'Baseline list fetch failed: ' + (list.error || ('HTTP ' + list.status)) });
  const baselineIds = new Set(list.loans.map((l) => l && l.Id).filter(Boolean));

  const mirror = await listMirroredLoans();
  const ghosts = [];
  for (const rec of mirror) {
    const id = rec && rec.Id;
    if (!id) continue;
    if (baselineIds.has(id)) continue;
    ghosts.push({
      id,
      mirroredAt: rec._mirroredAt || null,
      status:     rec.Status      || '',
      substatus:  rec.Substatus   || '',
      address:    rec.Name        || rec.Address || '',
      loanAmount: rec.Loan_Amount || null,
    });
  }

  let purged = 0;
  if (!dryRun && ghosts.length) {
    for (const g of ghosts) {
      const ok = await deleteMirroredLoan(g.id);
      if (ok) purged += 1;
    }
  }

  return json(200, {
    ok:                true,
    mirrorCount:       mirror.length,
    baselineListCount: baselineIds.size,
    ghostCount:        ghosts.length,
    purged,
    dryRun,
    ghosts,
  });
}
