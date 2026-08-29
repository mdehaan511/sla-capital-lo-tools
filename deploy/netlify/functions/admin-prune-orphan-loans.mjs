/**
 * admin-prune-orphan-loans.mjs — POST /api/admin-prune-orphan-loans
 *
 * Deploy 236.792 (Mike) — clean up Postgres `loans` rows for loans that were
 * DELETED from their client record but whose PG row survived.
 *
 * Why these exist: until 236.791, clients-delete removed the loan from the
 * client blob and called upsertClientWithLoans, which prunes vanished loan
 * rows — but fires those deletes WITHOUT awaiting them. Lambda freezes the
 * container the instant we respond, so the pending delete often never ran.
 * The row stayed in PG, and quotes-list synthesizes a `q_ln_<loanId>` card
 * straight off the PG loans table — so a deleted loan kept drawing a ghost
 * tile in the Pipeline with no Loan Details page behind it.
 *
 * 236.791 stops NEW orphans. This endpoint cleans up the backlog.
 *
 * Direction matters: this tool treats the CLIENT BLOB as truth and prunes PG.
 * admin-client-repair-loans does the opposite (PG is truth, rewrite the blob).
 * Use this one when a loan was intentionally deleted; use that one when a
 * client blob lost loans it should still have.
 *
 * Body:
 *   { loanIds: ['l_...','l_...'], dryRun }   targeted — verify + delete these
 *   { scan: true, offset, limit, apply }     paged sweep over the loans table
 *
 * Classification per row (never deletes anything it can't prove):
 *   orphan_loan_removed   — client blob EXISTS and does not list this loanId.
 *                           Safe to delete; this is the bug's fingerprint.
 *   orphan_client_missing — no client blob at the expected key. Reported only;
 *                           delete requires alsoMissingClients:true, because a
 *                           reassigned loan can legitimately live under a
 *                           different owner key than the row's owner_email.
 *   ok                    — the client blob lists the loan. Left alone.
 *
 * dryRun defaults TRUE. Nothing is deleted without an explicit dryRun:false
 * (targeted) or apply:true (scan).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs';
import { deleteQuotesForLoan } from './_shared/quote-sync.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('admin-prune-orphan-loans error:', e);
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
  const store = getStore({ name: 'clients', consistency: 'strong' });

  // One blob read per client, reused across every loan row for that client.
  // A scan window of 500 rows usually touches far fewer clients than rows.
  const clientCache = new Map();
  async function loadClient(ownerEmail, clientId) {
    const ownerKey = keySafe(normalizeEmail(ownerEmail || ''));
    const cacheKey = ownerKey + '/' + clientId;
    if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);
    const rec = ownerKey && clientId
      ? await store.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null)
      : null;
    clientCache.set(cacheKey, rec);
    return rec;
  }

  // Classify one PG loans row against its client blob.
  async function classify(row) {
    const rec = await loadClient(row.owner_email, row.client_id);
    if (!rec) {
      return { loanId: row.id, clientId: row.client_id, owner: row.owner_email,
               address: row.address || '', status: row.status || '',
               verdict: 'orphan_client_missing' };
    }
    const listed = (rec.loans || []).some((l) => l && l.id === row.id);
    return { loanId: row.id, clientId: row.client_id, owner: row.owner_email,
             address: row.address || '', status: row.status || '',
             verdict: listed ? 'ok' : 'orphan_loan_removed' };
  }

  const alsoMissing = !!body.alsoMissingClients;
  function deletable(v) {
    return v.verdict === 'orphan_loan_removed'
        || (alsoMissing && v.verdict === 'orphan_client_missing');
  }

  // ---------- Targeted mode ----------
  if (Array.isArray(body.loanIds) && body.loanIds.length) {
    const dryRun = body.dryRun !== false; // default TRUE
    const ids = body.loanIds.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 200);
    const results = [];
    let deleted = 0;

    // Optional owner hint, needed when the PG row is already gone (verdict
    // not_in_pg) but the loan's quote ghosts are still on the board — there's
    // no row left to read owner_email off of.
    const ownerHint = body.owner ? keySafe(normalizeEmail(String(body.owner))) : '';

    for (const id of ids) {
      const row = await db.first('loans', { select: 'id,client_id,owner_email,address,status', eq: { id } });
      const v = row ? await classify(row) : { loanId: id, verdict: 'not_in_pg' };
      if (!dryRun && row && deletable(v)) {
        try { await pgMirror.deleteLoanStrict(id); v.deleted = true; deleted++; }
        catch (e) { v.deleteError = (e && e.message) || 'delete failed'; }
      }

      // Deploy 236.794 — the PG row is only half the ghost. The loan's quote
      // records (blob + materialized index) draw their own Pipeline cards, so
      // purge them for anything we just deleted AND for loans whose PG row was
      // already gone but whose quotes were never cleaned up (every loan deleted
      // before 236.790). Never purge on an 'ok' verdict — that loan is alive.
      if (!dryRun && v.verdict !== 'ok') {
        const ownerK = ownerHint || keySafe(normalizeEmail(row ? (row.owner_email || '') : ''));
        if (ownerK) {
          try {
            const q = await deleteQuotesForLoan(ownerK, id);
            v.quotesDeleted = q.deleted;
            if (q.ids.length) v.quoteIds = q.ids;
            if (q.indexOnly.length) v.quoteIndexOnly = q.indexOnly;
          } catch (e) { v.quotePurgeError = (e && e.message) || 'quote purge failed'; }
        } else {
          v.quotePurgeSkipped = 'no owner known — pass { owner: "lo@slacapital.com" }';
        }
      }
      results.push(v);
    }

    return json(200, { ok: true, mode: 'targeted', dryRun, checked: results.length, deleted, results });
  }

  // ---------- Scan mode ----------
  if (body.scan) {
    const apply  = !!body.apply;
    const offset = Math.max(0, parseInt(body.offset, 10) || 0);
    const limit  = Math.min(1000, Math.max(1, parseInt(body.limit, 10) || 500));

    // Stable ordering by id so paging with offset is deterministic across
    // calls even while rows are being written (same trick the FCI reconcile
    // uses — an unordered slice(0,limit) re-reads the same window forever).
    const rows = await db.select('loans', {
      select: 'id,client_id,owner_email,address,status',
      order: { id: 'asc' },
      limit, offset,
    }) || [];

    const orphans = [];
    let ok = 0, deleted = 0;
    for (const row of rows) {
      const v = await classify(row);
      if (v.verdict === 'ok') { ok++; continue; }
      if (apply && deletable(v)) {
        try { await pgMirror.deleteLoanStrict(row.id); v.deleted = true; deleted++; }
        catch (e) { v.deleteError = (e && e.message) || 'delete failed'; }
      }
      orphans.push(v);
    }

    return json(200, {
      ok: true, mode: 'scan', apply, offset, limit,
      scanned: rows.length, clean: ok,
      orphanCount: orphans.length, deleted,
      // rows.length < limit means we reached the end of the table.
      done: rows.length < limit,
      nextOffset: offset + rows.length,
      orphans,
    });
  }

  return json(400, { error: 'Pass either { loanIds: [...] } or { scan: true }' });
}
