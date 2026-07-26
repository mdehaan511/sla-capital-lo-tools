/**
 * admin-fix-broker-fks.mjs — POST /api/admin-fix-broker-fks
 *
 * Cleans up orphaned brokerId references on loans. A loan carries a
 * brokerId pointing at a client record (typically a broker-flagged
 * one). Historically some loans got a brokerId written that pointed
 * at a client that no longer exists — either the broker client was
 * deleted, or it was never written to the primary clients store to
 * begin with (broker-picker minted an id without persisting the
 * client). That's harmless when reads went to blob, but now that PG
 * has an FK constraint (`loans.broker_id references clients(id)`),
 * any strict write of such a loan fails with:
 *   HTTP 409: insert violates foreign key constraint "loans_broker_id_fkey"
 *
 * This endpoint:
 *   1. Reads every client blob (so we know every valid client id).
 *   2. Walks every loan in every client and every loan row in PG.
 *   3. For any loan whose brokerId points at nothing → null it out
 *      in both blob and PG (write-through the strict path so both
 *      stay in sync).
 *   4. Reports what was fixed.
 *
 * Body: { dryRun?: true, owner?: string }
 *   dryRun default true.
 *   owner scopes to one namespace; otherwise sweeps everything.
 *
 * Response: {
 *   ok, dryRun,
 *   scanned: { clientsInBlob, loansInBlob, loansInPg },
 *   brokenBlobLoans: [{ loanId, clientId, ownerKey, badBrokerId }],
 *   brokenPgLoans:   [{ loanId, badBrokerId }],
 *   fixed: { blob, pg },
 *   errors, durationMs,
 * }
 *
 * Admin only. Timeout 26s.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';

const PAGE = 1000;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-fix-broker-fks error:', e);
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
  const dryRun = body.dryRun !== false;
  const ownerFilter = body.owner ? keySafe(normalizeEmail(body.owner)) : null;

  const startedAt = Date.now();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // ── 1. Read every client (to build the "valid ids" set) ────────
  const validClientIds = new Set();
  const blobClients = []; // { ownerKey, key, record }
  try {
    const listOpts = ownerFilter ? { prefix: ownerFilter + '/' } : {};
    const { blobs } = await clientsStore.list(listOpts);
    const CHUNK = 50;
    for (let i = 0; i < blobs.length; i += CHUNK) {
      const chunk = blobs.slice(i, i + CHUNK);
      const recs = await Promise.all(chunk.map(async ({ key }) => {
        const slash = key.indexOf('/');
        if (slash < 0) return null;
        const ownerKey = key.slice(0, slash);
        const record = await clientsStore.get(key, { type: 'json' }).catch(() => null);
        return record ? { ownerKey, key, record } : null;
      }));
      for (const item of recs) {
        if (!item || !item.record || !item.record.id) continue;
        validClientIds.add(item.record.id);
        blobClients.push(item);
      }
    }
  } catch (e) {
    return json(500, { error: 'Blob client scan failed: ' + (e && e.message) });
  }

  // ── 2. Walk every loan in blob, find broken brokerId ───────────
  const brokenBlobLoans = [];
  const dirtyClientKeys = new Set(); // clients that need re-write
  const dirtyClientMap = new Map();  // clientKey → { ownerKey, record }
  for (const { ownerKey, key, record } of blobClients) {
    if (!Array.isArray(record.loans)) continue;
    for (const loan of record.loans) {
      if (!loan || !loan.brokerId) continue;
      if (validClientIds.has(loan.brokerId)) continue;
      brokenBlobLoans.push({
        loanId: loan.id,
        clientId: record.id,
        ownerKey,
        badBrokerId: loan.brokerId,
      });
      if (!dryRun) {
        loan.brokerId = '';
        dirtyClientKeys.add(key);
        dirtyClientMap.set(key, { ownerKey, record });
      }
    }
  }

  // ── 3. Walk PG loans, find broken broker_id ────────────────────
  const brokenPgLoans = [];
  let loansInPg = 0;
  try {
    let offset = 0;
    while (true) {
      const rows = await db.select('loans', {
        select: 'id,broker_id',
        limit: PAGE,
        offset,
      });
      const n = (rows || []).length;
      for (const r of (rows || [])) {
        loansInPg++;
        if (!r || !r.broker_id) continue;
        if (!validClientIds.has(r.broker_id)) {
          brokenPgLoans.push({ loanId: r.id, badBrokerId: r.broker_id });
        }
      }
      if (n < PAGE) break;
      offset += PAGE;
      if (offset > 200000) break;
    }
  } catch (e) {
    return json(500, { error: 'PG loans scan failed: ' + (e && e.message) });
  }

  const result = {
    ok: true,
    dryRun,
    scanned: {
      clientsInBlob: validClientIds.size,
      loansInBlob: blobClients.reduce((n, c) => n + ((c.record.loans && c.record.loans.length) || 0), 0),
      loansInPg,
    },
    brokenBlobLoans,
    brokenPgLoans,
    fixed: { blob: 0, pg: 0 },
    errors: [],
    durationMs: 0,
  };

  if (dryRun) {
    result.durationMs = Date.now() - startedAt;
    return json(200, result);
  }

  // ── 4. Write repaired client blobs ─────────────────────────────
  for (const [key, { record }] of dirtyClientMap.entries()) {
    try {
      record.updatedAt = new Date().toISOString();
      await clientsStore.setJSON(key, record);
      result.fixed.blob++;
    } catch (e) {
      result.errors.push({ phase: 'blob rewrite', key, message: e && e.message });
    }
  }

  // ── 5. Update PG loans directly with broker_id = null ──────────
  for (const { loanId } of brokenPgLoans) {
    try {
      await db.update('loans', { id: loanId }, { broker_id: null });
      result.fixed.pg++;
    } catch (e) {
      result.errors.push({ phase: 'pg update', loanId, message: e && e.message });
    }
  }

  result.durationMs = Date.now() - startedAt;
  return json(200, result);
}
