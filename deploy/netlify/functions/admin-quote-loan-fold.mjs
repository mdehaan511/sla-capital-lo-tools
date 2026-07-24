/**
 * admin-quote-loan-fold.mjs — POST /api/admin-quote-loan-fold
 * Phase D1: THE quote→loan fold migration (Deploy 236.421).
 *
 * For every quote (batched, resumable):
 *   1. Resolve its loan — by loanId, else by same-owner normalized
 *      address (the audit's 165 + 38). Orphans are only REPORTED
 *      (triage stays human — 23 records; use /orphaned-sizers.html).
 *   2. FOLD onto the loan anything the quote uniquely holds:
 *      - formData sizer snapshot (only if the loan has none — loans
 *        saved since 236.249 usually already carry their own)
 *      - close/decision fields (finalLoanAmount, commissionRate/
 *        Amount, closedAt/By, closeNotes, decidedAt/By, decisionNotes,
 *        submittedAt, originalLoanAmt) — loan wins where both exist
 *      - loan._quoteId audit stamp
 *   3. HEAL linkage: address-matched quotes get quote.loanId stamped
 *      (quotes store + quotes-index) so every remaining quote reader
 *      resolves deterministically until D4 retires the store.
 *   4. Mark quote._foldedAt/_foldedIntoLoanId — re-runs skip.
 *
 * Client writes go through writeClient (PG-first, atomic). Batched:
 * `limit` quotes per call (default 8 — each fold that changes a
 * client costs a strict write; 8 keeps the invocation far under the
 * platform timeout), `cursor` = last processed "owner/quoteId".
 *
 * Body: { dryRun?: true, limit?: 8, cursor?: '' }
 * Response: per-batch actions + nextCursor (null when done).
 * Admin only. Idempotent. Loan/client side always wins conflicts.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { quotesIndex } from './_shared/quotes-index.mjs';

const CLOSE_DECISION_FIELDS = [
  'finalLoanAmount', 'commissionRate', 'commissionAmount',
  'closedAt', 'closedBy', 'closeNotes',
  'decidedAt', 'decidedBy', 'decisionNotes',
  'submittedAt', 'originalLoanAmt',
];

function aggrNorm(s) {
  let x = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  x = x.replace(/,\s*(usa|us|united states)\.?$/i, '');
  x = x.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
       .replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
       .replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
       .replace(/\bcourt\b/g, 'ct').replace(/\bcircle\b/g, 'cir')
       .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy')
       .replace(/\btrail\b/g, 'trl').replace(/\bterrace\b/g, 'ter');
  return x.replace(/[.,]/g, '').trim();
}

async function _allLoansPG() {
  const PAGE = 1000;
  const out = [];
  let offset = 0;
  for (;;) {
    const rows = await db.select('loans', {
      select: 'id,client_id,owner_email,address',
      limit: PAGE, offset,
    });
    out.push(...(rows || []));
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break;
  }
  return out;
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });

    const body = (await readJsonBody(req)) || {};
    const dryRun = body.dryRun !== false; // default TRUE
    const limit = Math.min(Math.max(parseInt(body.limit, 10) || 8, 1), 25);
    const cursor = String(body.cursor || '');

    const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

    // Stable ordering for the cursor: full sorted key list each call
    // (cheap — list() is one paginated API call, no per-blob gets).
    const { blobs } = await quotesStore.list();
    const keys = blobs.map((b) => b.key).filter((k) => k.indexOf('/') > 0).sort();
    const startIdx = cursor ? keys.findIndex((k) => k > cursor) : 0;
    if (startIdx < 0) {
      return json(200, { done: true, nextCursor: null, note: 'cursor past end' });
    }

    // Loan lookup maps (PG, two paginated selects max at current size).
    const loans = await _allLoansPG();
    const loanById = new Map();
    const loansByOwnerAddr = new Map();
    for (const l of loans) {
      loanById.set(l.id, l);
      const ow = normalizeEmail(l.owner_email || '');
      if (!loansByOwnerAddr.has(ow)) loansByOwnerAddr.set(ow, new Map());
      const na = aggrNorm(l.address);
      if (na) loansByOwnerAddr.get(ow).set(na, l);
    }

    const report = {
      dryRun, cursor, batchKeys: [],
      folded: 0, healedLinkage: 0, skippedAlreadyFolded: 0,
      noChangeNeeded: 0, orphans: [], errors: [],
      actions: [],
    };

    // Per-request client cache so multiple quotes folding into the
    // same client cost one read + one write.
    const clientCache = new Map(); // key -> { client, dirty }

    let processed = 0;
    let lastKey = cursor;
    for (let i = startIdx; i < keys.length && processed < limit; i++) {
      const qKey = keys[i];
      lastKey = qKey;
      processed++;
      report.batchKeys.push(qKey);
      const ownerKey = qKey.slice(0, qKey.indexOf('/'));
      const ow = normalizeEmail(ownerKey);

      let quote;
      try { quote = await quotesStore.get(qKey, { type: 'json' }); }
      catch (e) { report.errors.push({ qKey, error: 'quote read: ' + e.message }); continue; }
      if (!quote) continue;

      if (quote._foldedAt) { report.skippedAlreadyFolded++; continue; }

      // Resolve the loan.
      let loanRow = quote.loanId ? loanById.get(quote.loanId) : null;
      let how = loanRow ? 'loanId' : null;
      if (!loanRow) {
        const na = aggrNorm(quote.address || (quote.formData && quote.formData.address));
        const om = loansByOwnerAddr.get(ow);
        if (na && om && om.has(na)) { loanRow = om.get(na); how = 'address'; }
      }
      if (!loanRow) {
        report.orphans.push({ qKey, quoteId: quote.id, address: quote.address || '', status: quote.status || '', updatedAt: quote.updatedAt || '' });
        continue;
      }

      // Load the client (cached per request).
      const cKey = ownerKey + '/' + keySafe(loanRow.client_id);
      let entry = clientCache.get(cKey);
      if (!entry) {
        let client = null;
        try { client = await clientsStore.get(cKey, { type: 'json' }); } catch (_) {}
        // Cross-owner loans (rare): derive key from the LOAN's owner.
        if (!client) {
          const altKey = keySafe(normalizeEmail(loanRow.owner_email || '')) + '/' + keySafe(loanRow.client_id);
          if (altKey !== cKey) {
            try { client = await clientsStore.get(altKey, { type: 'json' }); } catch (_) {}
            if (client) entry = { key: altKey, client, dirty: false };
          }
        } else {
          entry = { key: cKey, client, dirty: false };
        }
        if (!entry) { report.errors.push({ qKey, error: 'client blob missing for loan ' + loanRow.id }); continue; }
        clientCache.set(entry.key, entry);
      }
      const loan = (entry.client.loans || []).find((l) => l && l.id === loanRow.id);
      if (!loan) { report.errors.push({ qKey, error: 'loan ' + loanRow.id + ' not on client blob' }); continue; }

      // ── Fold ──
      const act = { qKey, quoteId: quote.id, loanId: loanRow.id, matchedBy: how, changes: [] };
      if (quote.formData && typeof quote.formData === 'object' && Object.keys(quote.formData).length &&
          (!loan.formData || typeof loan.formData !== 'object' || Object.keys(loan.formData).length === 0)) {
        act.changes.push('formData');
        if (!dryRun) loan.formData = quote.formData;
      }
      for (const f of CLOSE_DECISION_FIELDS) {
        const qv = quote[f];
        if (qv !== undefined && qv !== null && qv !== '' &&
            (loan[f] === undefined || loan[f] === null || loan[f] === '')) {
          act.changes.push(f);
          if (!dryRun) loan[f] = qv;
        }
      }
      if (!loan._quoteId) {
        act.changes.push('_quoteId');
        if (!dryRun) loan._quoteId = quote.id;
      }

      if (act.changes.length) {
        report.folded++;
        if (!dryRun) { loan.updatedAt = new Date().toISOString(); entry.dirty = true; }
      } else {
        report.noChangeNeeded++;
      }

      // ── Heal linkage + mark folded on the quote ──
      const needsLink = how === 'address' && quote.loanId !== loanRow.id;
      if (needsLink) { report.healedLinkage++; act.changes.push('quote.loanId=' + loanRow.id); }
      if (!dryRun) {
        if (needsLink) quote.loanId = loanRow.id;
        quote._foldedAt = new Date().toISOString();
        quote._foldedIntoLoanId = loanRow.id;
        try {
          await quotesStore.setJSON(qKey, quote);
          await quotesIndex.upsertRecord(ow, quote);
        } catch (e) {
          report.errors.push({ qKey, error: 'quote mark write: ' + e.message });
        }
      }
      report.actions.push(act);
    }

    // Flush dirty clients (grouped — one strict write per client).
    if (!dryRun) {
      for (const [key, entry] of clientCache) {
        if (!entry.dirty) continue;
        const ownerOfKey = key.slice(0, key.indexOf('/'));
        try { await writeClient(ownerOfKey, entry.client, { clientsStore }); }
        catch (e) { report.errors.push({ clientKey: key, error: 'client write: ' + e.message }); }
      }
    }

    const done = (startIdx + processed) >= keys.length;
    return json(200, {
      ...report,
      processed,
      totalQuotes: keys.length,
      nextCursor: done ? null : lastKey,
      done,
    });
  } catch (e) {
    console.error('admin-quote-loan-fold error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
