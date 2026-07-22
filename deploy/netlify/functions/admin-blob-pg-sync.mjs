/**
 * admin-blob-pg-sync.mjs — POST /api/admin-blob-pg-sync
 *
 * Bulk repair tool. Scans every client blob across every owner
 * namespace (or a specified subset), compares each to what Postgres
 * has, and fills in whatever PG is missing.
 *
 * Why this exists: pg-mirror was fire-and-forget from Phase 2 landing
 * until today. If a PG write silently failed for ANY reason (FK
 * violation, transient network, schema hiccup), the blob write still
 * succeeded and the user saw success — but PG never got the record.
 * Phase 4 made reads PG-first, so those "invisible" blob records now
 * appear to have vanished from Pipeline / Clients / Loans / Details.
 *
 * This endpoint sweeps the whole blob store, upserts every client
 * (and its nested loans) into PG, and reports the diff. Deletions
 * in PG that no longer exist in blob are also reconciled (optional).
 *
 * Body: {
 *   dryRun?: true,          // default true — report only, don't write
 *   owner?: string,         // optional — scope to one owner
 *   deleteOrphansInPg?: true, // default false — delete PG rows not in blob
 * }
 *
 * Response: {
 *   ok, dryRun,
 *   scanned: { owners, clients, loans },
 *   pgMissing: {
 *     clients: [{id, ownerKey, ...}],
 *     loans:   [{id, clientId, ownerKey, ...}],
 *   },
 *   pgOrphans: {   // PG rows with no blob equivalent
 *     clients: [id, ...],
 *     loans:   [id, ...],
 *   },
 *   wrote: { clients, loans },     // when dryRun=false
 *   deleted: { clients, loans },   // when deleteOrphansInPg=true
 *   errors: [{...}],
 *   durationMs,
 * }
 *
 * Admin only. Timeout 26s (set in netlify.toml).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { projectClient, projectLoan } from './_shared/pg-projections.mjs';

// Chunk sizes tuned for the free-tier Netlify function limits + Supabase's
// default request timeout. Small enough that a slow query doesn't stall
// the whole run.
const CLIENT_CHUNK = 50;
const LOAN_CHUNK   = 100;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-blob-pg-sync error:', e);
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
  const dryRun = body.dryRun !== false; // default true
  const ownerFilter = body.owner ? keySafe(normalizeEmail(body.owner)) : null;
  const deleteOrphans = body.deleteOrphansInPg === true;

  const startedAt = Date.now();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // ── 1. Walk the blob store ─────────────────────────────────────
  const blobClients = [];   // { ownerKey, record }
  const blobLoanIds = new Set();
  try {
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
  } catch (e) {
    return json(500, { error: 'Blob scan failed: ' + (e && e.message) });
  }

  const scanned = {
    owners: new Set(blobClients.map((c) => c.ownerKey)).size,
    clients: blobClients.length,
    loans: blobLoanIds.size,
  };

  // ── 2. Snapshot what PG currently has ──────────────────────────
  // Just the ids — fetching full rows for thousands would blow the
  // function's memory + time budget. We compare by presence, not
  // deep equality; deep drift can be repaired via admin-pg-diff on
  // a per-client basis.
  let pgClientIds = new Set();
  let pgLoanIds = new Set();
  try {
    const clientRows = await db.select('clients', {
      select: 'id',
      ...(ownerFilter ? { eq: { owner_email: ownerFilter } } : {}),
      limit: 20000,
    });
    for (const r of (clientRows || [])) if (r && r.id) pgClientIds.add(r.id);
    const loanRows = await db.select('loans', {
      select: 'id',
      ...(ownerFilter ? { eq: { owner_email: ownerFilter } } : {}),
      limit: 20000,
    });
    for (const r of (loanRows || [])) if (r && r.id) pgLoanIds.add(r.id);
  } catch (e) {
    return json(500, { error: 'PG snapshot failed: ' + (e && e.message) });
  }

  // ── 3. Diff ────────────────────────────────────────────────────
  const missingClients = [];
  const missingLoans = [];
  const missingClientOwnerByClientId = new Map();
  for (const { ownerKey, record } of blobClients) {
    if (!pgClientIds.has(record.id)) {
      missingClients.push({ id: record.id, ownerKey, record });
    }
    missingClientOwnerByClientId.set(record.id, ownerKey);
    if (Array.isArray(record.loans)) {
      for (const l of record.loans) {
        if (!l || !l.id) continue;
        if (!pgLoanIds.has(l.id)) {
          missingLoans.push({ id: l.id, clientId: record.id, ownerKey, loan: l });
        }
      }
    }
  }
  const orphanClientIds = [...pgClientIds].filter((id) => {
    // A PG client is orphaned if no blob client with that id exists.
    return !blobClients.some((c) => c.record.id === id);
  });
  const orphanLoanIds = [...pgLoanIds].filter((id) => !blobLoanIds.has(id));

  const result = {
    ok: true,
    dryRun,
    scanned,
    pgMissing: {
      clients: missingClients.map((c) => ({ id: c.id, ownerKey: c.ownerKey })),
      loans:   missingLoans.map((l) => ({ id: l.id, clientId: l.clientId, ownerKey: l.ownerKey })),
    },
    pgOrphans: {
      clients: orphanClientIds,
      loans:   orphanLoanIds,
    },
    wrote: { clients: 0, loans: 0 },
    deleted: { clients: 0, loans: 0 },
    errors: [],
    durationMs: 0,
  };

  if (dryRun) {
    result.durationMs = Date.now() - startedAt;
    return json(200, result);
  }

  // ── 4. Write missing clients + loans to PG (chunked) ───────────
  if (missingClients.length) {
    const rows = missingClients
      .map((m) => projectClient(m.record, m.ownerKey))
      .filter(Boolean);
    for (let i = 0; i < rows.length; i += CLIENT_CHUNK) {
      const chunk = rows.slice(i, i + CLIENT_CHUNK);
      try {
        await db.upsert('clients', chunk, { onConflict: 'id' });
        result.wrote.clients += chunk.length;
      } catch (e) {
        result.errors.push({ phase: 'clients upsert', chunkStart: i, message: (e && e.message) });
      }
    }
  }

  if (missingLoans.length) {
    const rows = missingLoans
      .map((m) => projectLoan(m.loan, m.clientId, m.ownerKey))
      .filter(Boolean);
    for (let i = 0; i < rows.length; i += LOAN_CHUNK) {
      const chunk = rows.slice(i, i + LOAN_CHUNK);
      try {
        await db.upsert('loans', chunk, { onConflict: 'id' });
        result.wrote.loans += chunk.length;
      } catch (e) {
        result.errors.push({ phase: 'loans upsert', chunkStart: i, message: (e && e.message) });
      }
    }
  }

  // ── 5. Optional: delete PG rows that no longer exist in blob ───
  if (deleteOrphans) {
    // Delete loans first (FK constraint — loans reference clients).
    for (const id of orphanLoanIds) {
      try {
        await db.del('loans', { id });
        result.deleted.loans++;
      } catch (e) {
        result.errors.push({ phase: 'loan delete', id, message: (e && e.message) });
      }
    }
    for (const id of orphanClientIds) {
      try {
        await db.del('clients', { id });
        result.deleted.clients++;
      } catch (e) {
        result.errors.push({ phase: 'client delete', id, message: (e && e.message) });
      }
    }
  }

  result.durationMs = Date.now() - startedAt;
  return json(200, result);
}
