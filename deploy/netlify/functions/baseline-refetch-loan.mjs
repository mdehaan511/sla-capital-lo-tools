/**
 * baseline-refetch-loan.mjs — POST /api/baseline-refetch-loan
 *
 * Deploy 236.175 — per-loan diagnostic tool for the mirror.
 *
 * The mirror is populated by baseline-mirror-sync which walks the
 * whole loan list. When Mike sees a specific loan showing wrong
 * status ("says LEAD when it's not" / "missing loans that ARE in
 * LEAD"), the two possible causes are:
 *
 *   A) Baseline's API returned wrong data at last sync. The mirror
 *      is faithful to what Baseline said, but Baseline lied.
 *   B) The mirror is stale; a resync would fix it.
 *
 * This endpoint distinguishes the two. It:
 *   1. Fetches the loan detail from Baseline RIGHT NOW.
 *   2. Loads the current mirror record.
 *   3. Diffs the two on a focused set of fields (Status,
 *      Substatus, Origination, Loan_Amount, Rate,
 *      Origination_Points).
 *   4. Optionally saves the fresh detail to the mirror when the
 *      caller passes `save: true`.
 *
 * Body: { id, save?: boolean }
 *   id     - external SLA-YYYYMMDD-NNNN loan Id
 *   save   - true to overwrite the mirror with the fresh fetch
 * Response:
 *   {
 *     ok: true,
 *     baseline: <raw Baseline detail JSON>,
 *     mirror:   <what we had before this call, or null>,
 *     diffs:    { <field>: { mirror, baseline, changed: bool }, ... },
 *     saved:    boolean,
 *     savedAt:  ISO or null,
 *   }
 * Auth: admin only.
 */
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
} from './_shared/auth.mjs';
import {
  fetchLoanDetail, loadMirroredLoan, saveMirroredLoan,
} from './_shared/baseline-mirror.mjs';

// Fields worth surfacing in the diff panel. Not exhaustive — the
// full raw response is returned too so the frontend can render
// every field if the LO expands. This shortlist is what admins
// need at-a-glance to answer "did Baseline change or did we?".
const KEY_FIELDS = [
  'Status', 'Substatus', 'Loan_Amount', 'Rate', 'Origination_Points',
  'Origination', 'Created_Date', 'Estimated_Close_Date', 'Address_State',
  'Archived', 'Is_Archived',
];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-refetch-loan error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = await readJsonBody(req);
  if (!body || !body.id) return json(400, { error: 'id required' });
  const id = String(body.id).trim();
  const save = body.save === true;

  const detail = await fetchLoanDetail(id);
  if (!detail.ok) {
    return json(502, {
      error: 'Baseline fetch failed: ' + (detail.error || ('HTTP ' + detail.status)),
    });
  }
  const baseline = detail.loan || {};
  const mirror   = await loadMirroredLoan(id);

  const diffs = {};
  for (const k of KEY_FIELDS) {
    const m = mirror ? mirror[k] : undefined;
    const b = baseline[k];
    diffs[k] = {
      mirror:   m === undefined ? null : m,
      baseline: b === undefined ? null : b,
      changed:  _stringy(m) !== _stringy(b),
    };
  }

  let saved = false;
  let savedAt = null;
  if (save) {
    try {
      await saveMirroredLoan(id, baseline);
      saved = true;
      savedAt = new Date().toISOString();
    } catch (e) {
      return json(500, { error: 'Fetch OK but save failed: ' + (e && e.message) });
    }
  }
  return json(200, { ok: true, baseline, mirror, diffs, saved, savedAt });
}

function _stringy(v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v.trim();
  return String(v);
}
