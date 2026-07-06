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

const CONCURRENCY = 6;
const MIRROR_READ_CONCURRENCY = 10;
const TEMP_STORE = 'baseline_borrowers_fetch_state';
const LIST_KEY   = 'current_list';

// Deploy 236.196 — parallel walk of the loan mirror. The shared
// listMirroredLoans() is serial (~50-100ms per blob × 250 loans =
// past the 26s function timeout). We read the mirror ourselves here
// with concurrency 10 so offset=0 lands in a few seconds.
async function _walkLoanMirrorParallel() {
  const store = getStore({ name: 'baseline_loans_mirror', consistency: 'strong' });
  let blobs;
  try { blobs = (await store.list()).blobs || []; }
  catch (_) { return []; }
  const out = [];
  for (let i = 0; i < blobs.length; i += MIRROR_READ_CONCURRENCY) {
    const chunk = blobs.slice(i, i + MIRROR_READ_CONCURRENCY);
    const recs = await Promise.all(chunk.map(({ key }) =>
      store.get(key, { type: 'json' }).catch(() => null),
    ));
    for (const r of recs) if (r) out.push(r);
  }
  return out;
}

// Deploy 236.198 — Baseline loan records carry Borrower_Id (usually
// the vesting LLC) and Guarantor_Id (SINGULAR — the primary person
// borrower). NOT Guarantor_1_Id — that's just a denormalized view
// field for the guarantor's NAME, not an id. See baseline-sync.mjs
// L849: "1. Identity — Id, Name, Status, Borrower_Id, Guarantor_Id".
// Also probe common nested shapes ({Borrower: {Id}}, arrays, etc.)
// so we don't miss anything schema-y.
function _idsFromMirror(loans) {
  const ids = new Set();
  const fieldsProbed = new Set();
  for (const loan of loans) {
    if (!loan) continue;
    // Every top-level key on the loan record that LOOKS like an id
    // field (endsWith _Id, is an object with .Id, etc.). Best-effort
    // — this is a diagnostic pass to cover Baseline schema drift.
    for (const [k, v] of Object.entries(loan)) {
      if (k === 'Id') continue;      // that's the loan's own id
      if (k.startsWith('_')) continue; // our own metadata
      const looksLikeIdKey = /_Id$|_id$/.test(k) || /^(Borrower|Guarantor|Vesting|Entity|Owner)$/.test(k);
      if (!looksLikeIdKey) continue;
      fieldsProbed.add(k);
      if (typeof v === 'string' && v.trim()) ids.add(v.trim());
      else if (typeof v === 'number') ids.add(String(v));
      else if (v && typeof v === 'object') {
        if (v.Id) ids.add(String(v.Id).trim());
        else if (Array.isArray(v)) {
          for (const item of v) {
            if (typeof item === 'string') ids.add(item.trim());
            else if (item && item.Id) ids.add(String(item.Id).trim());
          }
        }
      }
    }
  }
  ids.delete('');
  return { ids: Array.from(ids), fieldsProbed: Array.from(fieldsProbed) };
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
  let extractDiag = null;
  if (offset === 0) {
    // Deploy 236.202 — enumerate borrower IDs from every source we
    // can. Baseline's list-borrower endpoint 403s and support said
    // there's no scope to enable, so we build the id list ourselves:
    //   1. Loan mirror — every Borrower_Id / Guarantor_Id / etc.
    //   2. SLA clients store — every client already tagged with a
    //      _baselineBorrowerId from prior syncs. Catches borrowers
    //      that were synced OUT to Baseline via the LO flow, not
    //      just ones on inbound loans.
    const loans = await _walkLoanMirrorParallel();
    const extract = _idsFromMirror(loans);
    const idsFromLoans = new Set(extract.ids);

    // Also pull ids from SLA clients that have already been tagged.
    const idsFromClients = new Set();
    try {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const { blobs: cb } = await clientsStore.list();
      for (let i = 0; i < cb.length; i += 10) {
        const chunk = cb.slice(i, i + 10);
        const clients = await Promise.all(chunk.map(({ key }) =>
          clientsStore.get(key, { type: 'json' }).catch(() => null),
        ));
        for (const c of clients) {
          if (!c) continue;
          if (c._baselineBorrowerId) idsFromClients.add(String(c._baselineBorrowerId));
          if (Array.isArray(c.companies)) {
            for (const co of c.companies) {
              if (co && co._baselineEntityId) idsFromClients.add(String(co._baselineEntityId));
            }
          }
        }
      }
    } catch (_) { /* non-fatal */ }

    const combined = new Set([...idsFromLoans, ...idsFromClients]);
    combined.delete('');
    let ids = Array.from(combined);
    let envelopeShape = 'from local sources';
    let probesTried = [];
    extractDiag = {
      loanCount: loans.length,
      fieldsProbed: extract.fieldsProbed,
      idsFromLoans: idsFromLoans.size,
      idsFromClients: idsFromClients.size,
      idsExtracted: ids.length,
      idsSample: ids.slice(0, 5),
      firstLoanKeys: loans.length && loans[0] ? Object.keys(loans[0]).filter((k) => !k.startsWith('_')).slice(0, 30) : [],
    };
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
    extractDiag,
    errorCount: errors.length,
    errors: errors.slice(0, 10),
  });
}
