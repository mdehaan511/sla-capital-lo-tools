/**
 * baseline-borrowers-fetch.mjs — POST /api/baseline-borrowers-fetch
 *
 * Deploy 236.193 — chunked fetch phase for the Baseline borrower
 * import. Called by the dashboard in a loop until all details are
 * cached. Separates the slow external-API work from the materialize
 * step so we never hit the 26s function timeout.
 *
 * Body:
 *   { offset: number, limit: number }
 *
 * On the first call (offset=0), fetches the /borrower list from
 * Baseline and caches the id list to a temp blob so subsequent calls
 * don't re-list. Then fetches details for ids [offset..offset+limit)
 * in parallel (concurrency 6) and writes each to
 * baseline_borrowers_mirror.
 *
 * Response: { ok, total, processed, fetched, envelopeShape,
 *             rawPreview?, errors[] }
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody } from './_shared/auth.mjs';
import {
  fetchAllBorrowerList, fetchBorrowerDetail, saveMirroredBorrower,
} from './_shared/baseline-borrowers.mjs';
import { listMirroredLoans } from './_shared/baseline-mirror.mjs';

const CONCURRENCY = 6;
const TEMP_STORE = 'baseline_borrowers_fetch_state';
const LIST_KEY   = 'current_list';

// Deploy 236.195 — extract every unique Baseline borrower Id we can
// find on the loans we've already mirrored. The Baseline API token
// we have doesn't grant list-borrower scope (all 4 list probes 403),
// so we build the id list ourselves from Guarantor_1_Id /
// Guarantor_2_Id / Borrower_Id fields on each mirrored loan. GET
// /borrower/{Id} is scoped-in because that's how POST /borrower
// creates work, and Baseline routinely permits reads on records the
// token can write.
function _idsFromMirror(loans) {
  const ids = new Set();
  for (const loan of loans) {
    if (!loan) continue;
    const candidates = [
      loan.Guarantor_1_Id, loan.Guarantor_2_Id,
      loan.Borrower_Id,    loan.Vesting_Id,
      loan.Entity_Id,      loan.Guarantor_Id,
    ];
    for (const c of candidates) {
      if (c && typeof c === 'string') ids.add(c.trim());
      else if (c && typeof c === 'object' && c.Id) ids.add(String(c.Id).trim());
      else if (typeof c === 'number') ids.add(String(c));
    }
  }
  ids.delete('');
  return Array.from(ids);
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-borrowers-fetch error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const offset = Math.max(0, parseInt(body.offset || 0, 10) || 0);
  const limit  = Math.max(1, parseInt(body.limit  || 30, 10) || 30);

  const tempStore = getStore({ name: TEMP_STORE, consistency: 'strong' });

  // ── 1. Build or reuse the borrower id list. ─────────────────
  // Deploy 236.195 — Baseline's /borrower list endpoint 403s for
  // our token. Enumerate ids from our own loan mirror instead;
  // GET /borrower/{Id} works because the token can create borrowers
  // and Baseline generally permits reads on writable records.
  let listState = null;
  if (offset === 0) {
    const loans = await listMirroredLoans();
    let ids = _idsFromMirror(loans);
    let envelopeShape = 'from loan mirror';
    let probesTried = [];
    // Best-effort: still try Baseline's list endpoint in case the
    // token gets scope later or the mirror is empty. If it works and
    // gives us MORE ids than the mirror does, prefer that.
    if (ids.length === 0) {
      const listResp = await fetchAllBorrowerList();
      if (listResp.ok) {
        const raw = listResp.borrowers || [];
        for (const item of raw) {
          if (typeof item === 'string') ids.push(item);
          else if (item && typeof item === 'object' && item.Id) ids.push(String(item.Id));
        }
        envelopeShape = listResp.envelopeShape || '';
      } else {
        probesTried = listResp.probesTried || [];
        return json(500, {
          error: 'No borrower ids to fetch. Loan mirror is empty AND the Baseline /borrower list endpoint is not accessible.',
          probesTried,
        });
      }
    }
    listState = { ids, envelopeShape, startedAt: new Date().toISOString() };
    try { await tempStore.setJSON(LIST_KEY, listState); }
    catch (e) { /* non-fatal — we still have listState in memory */ }
  } else {
    listState = await tempStore.get(LIST_KEY, { type: 'json' }).catch(() => null);
    if (!listState) {
      return json(400, { error: 'No cached list — call with offset=0 first' });
    }
  }

  const ids   = listState.ids || [];
  const slice = ids.slice(offset, offset + limit);

  // ── 2. Fetch details in parallel and cache. ─────────────────
  const errors = [];
  let fetched = 0;
  for (let i = 0; i < slice.length; i += CONCURRENCY) {
    const chunk = slice.slice(i, i + CONCURRENCY);
    await Promise.all(chunk.map(async (id) => {
      try {
        const r = await fetchBorrowerDetail(id);
        if (!r || !r.ok || !r.borrower) {
          errors.push({ id, status: r && r.status, error: (r && r.error) || 'no borrower' });
          return;
        }
        await saveMirroredBorrower(id, r.borrower);
        fetched++;
      } catch (e) {
        errors.push({ id, error: (e && e.message) || 'unknown' });
      }
    }));
  }

  return json(200, {
    ok: true,
    total: ids.length,
    processedNext: offset + slice.length,
    fetched,
    envelopeShape: listState.envelopeShape || '',
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
}
