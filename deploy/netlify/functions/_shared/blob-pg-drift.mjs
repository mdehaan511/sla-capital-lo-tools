/**
 * _shared/blob-pg-drift.mjs — the blob↔PG presence diff.
 * Deploy 236.432 (Hardening C5): extracted from admin-blob-pg-sync so
 * the daily bake-off cron (drift-report-cron.mjs) and the manual
 * repair tool share ONE diff implementation — a drift definition that
 * exists twice will itself drift.
 *
 * Walks every client blob (optionally scoped to one owner), snapshots
 * the id sets Postgres holds, and reports both directions:
 *   pg missing  — blob records PG never got (a failed mirror write)
 *   pg orphans  — PG rows whose blob equivalent is gone (a failed
 *                 blob delete, or writes that bypassed writeClient)
 *
 * Presence-only by design: deep field equality is admin-pg-diff's job.
 * The C5 bake-off criterion is "no NEW presence drift for a week",
 * which this measures exactly.
 *
 * Returns: {
 *   scanned:  { owners, clients, loans },
 *   missingClients: [{ id, ownerKey, record }],   // full record — the
 *   missingLoans:   [{ id, clientId, ownerKey, loan }], // repair tool
 *   orphanClientIds: [id],                        // writes from these
 *   orphanLoanIds:   [id],
 *   durationMs,
 * }
 */
import { getStore } from '@netlify/blobs';
import { db } from './supabase-db.mjs';

const CLIENT_CHUNK = 50;

export async function computeDrift(opts) {
  opts = opts || {};
  const ownerFilter = opts.ownerFilter || null;
  const startedAt = Date.now();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // ── 1. Walk the blob store ─────────────────────────────────────
  const blobClients = [];   // { ownerKey, record }
  const blobLoanIds = new Set();
  const listOpts = ownerFilter ? { prefix: ownerFilter + '/' } : {};
  const { blobs } = await clientsStore.list(listOpts);
  for (let i = 0; i < blobs.length; i += CLIENT_CHUNK) {
    const chunk = blobs.slice(i, i + CLIENT_CHUNK);
    const recs = await Promise.all(chunk.map(async ({ key }) => {
      const slash = key.indexOf('/');
      if (slash < 0) return null;
      const ownerKey = key.slice(0, slash);
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      return rec ? { ownerKey, record: rec } : null;
    }));
    for (const item of recs) {
      if (!item || !item.record || !item.record.id) continue;
      blobClients.push(item);
      if (Array.isArray(item.record.loans)) {
        for (const l of item.record.loans) {
          if (l && l.id) blobLoanIds.add(l.id);
        }
      }
    }
  }

  const scanned = {
    owners: new Set(blobClients.map((c) => c.ownerKey)).size,
    clients: blobClients.length,
    loans: blobLoanIds.size,
  };

  // ── 2. Snapshot what PG currently has ──────────────────────────
  // Ids only — full rows for thousands would blow the time budget.
  // PostgREST caps single responses at ~1000 rows regardless of
  // `limit`, so paginate until a short page signals the end.
  const PAGE = 1000;
  async function _selectAllIds(table) {
    const ids = new Set();
    let offset = 0;
    while (true) {
      const rows = await db.select(table, {
        select: 'id',
        ...(ownerFilter ? { eq: { owner_email: ownerFilter } } : {}),
        limit: PAGE,
        offset,
      });
      const n = (rows || []).length;
      for (const r of (rows || [])) if (r && r.id) ids.add(r.id);
      if (n < PAGE) break; // short page = end
      offset += PAGE;
      if (offset > 200000) break; // sanity ceiling
    }
    return ids;
  }
  const pgClientIds = await _selectAllIds('clients');
  const pgLoanIds   = await _selectAllIds('loans');

  // ── 3. Diff both directions ────────────────────────────────────
  const missingClients = [];
  const missingLoans = [];
  const blobClientIds = new Set();
  for (const { ownerKey, record } of blobClients) {
    blobClientIds.add(record.id);
    if (!pgClientIds.has(record.id)) {
      missingClients.push({ id: record.id, ownerKey, record });
    }
    if (Array.isArray(record.loans)) {
      for (const l of record.loans) {
        if (!l || !l.id) continue;
        if (!pgLoanIds.has(l.id)) {
          missingLoans.push({ id: l.id, clientId: record.id, ownerKey, loan: l });
        }
      }
    }
  }
  // Set-based orphan check — the original .some() scan inside a
  // filter was O(clients²) across thousands of records.
  const orphanClientIds = [...pgClientIds].filter((id) => !blobClientIds.has(id));
  const orphanLoanIds = [...pgLoanIds].filter((id) => !blobLoanIds.has(id));

  return {
    scanned,
    missingClients,
    missingLoans,
    orphanClientIds,
    orphanLoanIds,
    durationMs: Date.now() - startedAt,
  };
}
