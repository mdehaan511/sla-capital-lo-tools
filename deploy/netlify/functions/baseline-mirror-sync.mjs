/**
 * baseline-mirror-sync.mjs — POST /api/baseline-mirror-sync
 *
 * Deploy 232 (Mirror Phase 1 — Step 3). Chunked sync from Baseline
 * into our local mirror blob store. Each invocation processes one
 * slice of [offset, offset+limit] so the work fits inside Netlify's
 * 10s function timeout. Frontend loops by calling repeatedly with the
 * returned `nextOffset` until `done` is true.
 *
 * Discovery confirmed:
 *   - GET /loan returns ~253 loans in the list view (no pagination).
 *   - List view is sparse — only Id, Name, Status, Substatus,
 *     Created_Date, Account_Owners, _Id. For dashboard data we need
 *     to GET /loan/{Id} per loan.
 *   - 253 × ~300ms = ~75s of detail fetches. Chunking is required.
 *
 * Optimization: skip the detail fetch when our mirror already has
 * this loan AND the list-view Status+Substatus match what's mirrored.
 * After the first full sync, incremental syncs touch only changed
 * loans + new loans — typically a handful per call.
 *
 * Body (optional, also accepted as query params):
 *   { offset: 0, limit: 25, force: false }
 *
 * Returns: {
 *   ok, totalCount, offset, limit, nextOffset, done,
 *   synced, skipped, errors: [{ id, error }]
 * }
 */
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
} from './_shared/auth.mjs';
import {
  fetchAllLoanList, fetchLoanDetail,
  loadMirroredLoan, saveMirroredLoan,
} from './_shared/baseline-mirror.mjs';

const DEFAULT_CHUNK_LIMIT = 25;   // ~25 × 300ms = 7.5s, leaves headroom
const MAX_CHUNK_LIMIT     = 50;   // sane upper bound

// Deploy 236.35 — pipeline loans always get a forced detail refresh
// (date fields can shift without a Status change). Terminal loans
// keep the Status+Substatus skip optimization.
const TERMINAL_STATUSES = new Set([
  'closed', 'sold', 'funded',
  'in_servicing', 'servicing',
  'liquidated',
  'archived', 'lost', 'declined', 'denied', 'withdrawn', 'cancelled',
]);
function isTerminalStatus(s) {
  return TERMINAL_STATUSES.has(String(s || '').toLowerCase());
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-mirror-sync error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  // Body OR query params for the offset/limit/force triple.
  const body = (await readJsonBody(req)) || {};
  const url = new URL(req.url);
  const qOffset = parseInt(url.searchParams.get('offset') || body.offset || '0', 10);
  const qLimit  = parseInt(url.searchParams.get('limit')  || body.limit  || DEFAULT_CHUNK_LIMIT, 10);
  const qForce  = String(url.searchParams.get('force') || body.force || '0').toLowerCase() === '1'
               || body.force === true;
  const offset = Math.max(0, isFinite(qOffset) ? qOffset : 0);
  const limit  = Math.max(1, Math.min(MAX_CHUNK_LIMIT, isFinite(qLimit) ? qLimit : DEFAULT_CHUNK_LIMIT));

  // 1. Fetch the full list. Cheap: single call, ~300ms.
  const list = await fetchAllLoanList();
  if (!list.ok) {
    return json(502, { error: 'Baseline list fetch failed: ' + (list.error || ('HTTP ' + list.status)) });
  }
  const totalCount = list.loans.length;
  const slice = list.loans.slice(offset, offset + limit);

  let synced  = 0;
  let skipped = 0;
  const errors = [];

  for (const stub of slice) {
    const id = stub && stub.Id;
    if (!id) continue;

    // Skip detail fetch when nothing's changed since last mirror.
    // Deploy 236.35 — only skip TERMINAL loans this way. Pipeline
    // loans always get a fresh detail fetch so silent date-field
    // updates (Origination, etc.) propagate.
    if (!qForce) {
      const existing = await loadMirroredLoan(id);
      if (existing
          && isTerminalStatus(stub.Status)
          && existing.Status    === stub.Status
          && existing.Substatus === stub.Substatus) {
        skipped += 1;
        continue;
      }
    }

    const detail = await fetchLoanDetail(id);
    if (!detail.ok) {
      errors.push({ id, error: detail.error || ('HTTP ' + detail.status) });
      continue;
    }
    try {
      await saveMirroredLoan(id, detail.loan);
      synced += 1;
    } catch (e) {
      errors.push({ id, error: 'mirror write failed: ' + (e && e.message) });
    }
  }

  const nextOffset = offset + slice.length;
  const done = nextOffset >= totalCount;

  return json(200, {
    ok: true,
    totalCount,
    offset, limit, nextOffset, done,
    synced, skipped,
    errors,
  });
}
