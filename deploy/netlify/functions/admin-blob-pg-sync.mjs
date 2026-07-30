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
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { projectClient, projectLoan } from './_shared/pg-projections.mjs';
// Deploy 236.432 (C5): the scan+diff moved to _shared/blob-pg-drift.mjs
// so the daily bake-off cron (drift-report-cron) and this repair tool
// share one diff implementation.
import { computeDrift } from './_shared/blob-pg-drift.mjs';

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

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false; // default true
  const ownerFilter = body.owner ? keySafe(normalizeEmail(body.owner)) : null;
  const deleteOrphans = body.deleteOrphansInPg === true;

  const startedAt = Date.now();

  // ── 1-3. Scan + diff (shared with drift-report-cron since C5) ──
  let drift;
  try {
    drift = await computeDrift({ ownerFilter });
  } catch (e) {
    return json(500, { error: 'Drift scan failed: ' + (e && e.message) });
  }
  const { scanned, missingClients, missingLoans, orphanClientIds, orphanLoanIds } = drift;

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

  // ── Deploy 236.479 — enrich the orphan-client report so a dryRun is
  // actually actionable. An opaque id list can't tell a junk shell from
  // a real client, which is why the "35 orphan clients" nag went
  // undiagnosed for days. Pull a few identifying columns for each orphan
  // (bounded) so they can be classified at a glance — most importantly
  // whether they're broker placeholder rows (is_broker_placeholder),
  // which are loanless by nature and the likeliest source of a stable
  // "N orphan clients / 0 orphan loans" drift.
  if (orphanClientIds.length) {
    const idsToFetch = orphanClientIds.slice(0, 200);
    try {
      const rows = await db.select('clients', {
        select: 'id,owner_email,first_name,last_name,email,is_broker,is_broker_placeholder,created_at,updated_at',
        in: { id: idsToFetch },
      });
      result.pgOrphans.clientDetails = rows || [];
      // Deploy 236.482 — break the flags out PROPERLY. The old summary
      // lumped is_broker with is_broker_placeholder under one label,
      // which mis-classified real broker records as placeholders. Report
      // each flag separately plus owner + created-date grouping so the
      // orphans' origin (a migration? a purged LO?) is obvious in one run.
      let isBroker = 0, isPlaceholder = 0, neither = 0, withNameOrEmail = 0;
      const byOwner = {};
      let minCreated = null, maxCreated = null;
      for (const r of (rows || [])) {
        if (r.is_broker_placeholder) isPlaceholder++;
        else if (r.is_broker) isBroker++;
        else neither++;
        if (r.first_name || r.last_name || r.email) withNameOrEmail++;
        const o = r.owner_email || '(none)';
        byOwner[o] = (byOwner[o] || 0) + 1;
        if (r.created_at) {
          if (!minCreated || r.created_at < minCreated) minCreated = r.created_at;
          if (!maxCreated || r.created_at > maxCreated) maxCreated = r.created_at;
        }
      }
      result.pgOrphans.summary = {
        total: orphanClientIds.length,
        detailed: (rows || []).length,
        isBroker,
        isBrokerPlaceholder: isPlaceholder,
        neither,
        withNameOrEmail,
        byOwner,
        createdRange: { min: minCreated, max: maxCreated },
      };
    } catch (e) {
      result.errors.push({ phase: 'orphan detail fetch', message: (e && e.message) });
    }
  }

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
    // Deploy 236.481 — safety filter. When onlyBrokerPlaceholders is set,
    // restrict client deletion to orphans confirmed as broker placeholder
    // husks (is_broker_placeholder), using the details fetched above. This
    // protects a REAL client that is transiently PG-only (in the sub-second
    // window between writeClient's PG write and its blob mirror) from being
    // swept — such a client is never a broker placeholder. Use this when
    // clearing the known broker-placeholder backlog.
    let clientIdsToDelete = orphanClientIds;
    if (body.onlyBrokerPlaceholders === true) {
      const details = result.pgOrphans.clientDetails || [];
      const phSet = new Set(
        details.filter((r) => r && r.is_broker_placeholder).map((r) => r.id)
      );
      clientIdsToDelete = orphanClientIds.filter((id) => phSet.has(id));
      result.deleteFilter = {
        onlyBrokerPlaceholders: true,
        eligible: clientIdsToDelete.length,
        skippedNonPlaceholder: orphanClientIds.length - clientIdsToDelete.length,
      };
    }
    // Delete loans first (FK constraint — loans reference clients).
    for (const id of orphanLoanIds) {
      try {
        await db.del('loans', { id });
        result.deleted.loans++;
      } catch (e) {
        result.errors.push({ phase: 'loan delete', id, message: (e && e.message) });
      }
    }
    for (const id of clientIdsToDelete) {
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
