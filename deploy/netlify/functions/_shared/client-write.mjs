/**
 * _shared/client-write.mjs — THE client write path.
 * Hardening Phase C2 (Deploy 236.401): Postgres becomes the single
 * write authority. Every mutation endpoint funnels through here.
 *
 * Write order — and why it matters:
 *
 *   1. Postgres FIRST (authoritative). One atomic RPC
 *      (upsert_client_with_loans, migration 002/003): client upsert +
 *      loan upserts + stale-loan reconcile, all-or-nothing, with the
 *      CHECK constraints and the terminal-status demotion trigger
 *      standing guard. If the database says no — constraint veto,
 *      blocked demotion, outage — we throw HERE and NOTHING else has
 *      mutated. Under the old blob-first order a PG rejection left
 *      blob already written: two stores disagreeing until a repair.
 *   2. Blob mirror. Still read by legacy paths and blob-fallbacks;
 *      becomes pure cache as C3/C5 retire those readers.
 *   3. clients-index blob. Pipeline's materialized index — C3 deletes
 *      this layer entirely; until then it stays write-through.
 *
 * All steps awaited, all throw on failure (strict-write discipline —
 * see memory/PLATFORM_HARDENING.md). The caller's try/catch turns
 * failures into 500s, which fire the Phase A Slack alert.
 *
 * Rollback levers:
 *   PG_MIRROR_DISABLED=true  — skips step 1 (pg-mirror honors it);
 *                              blob-first behavior restored, writes
 *                              survive a PG outage.
 *
 * opts:
 *   allowDemotion    — pass true ONLY for explicit user-intended
 *                      terminal-status demotions (restore, admin
 *                      moves, curated merges). See C4.
 *   clientsStore     — reuse the caller's store handle (optional).
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { mirror as pgMirror } from './pg-mirror.mjs';

export async function writeClient(ownerKey, client, opts) {
  opts = opts || {};
  if (!ownerKey || !client || !client.id) {
    throw new Error('writeClient: ownerKey and client.id required');
  }

  // 1. Postgres — the authority. Throws before any mirror mutates.
  await pgMirror.upsertClientWithLoansStrict(ownerKey, client, {
    allowDemotion: !!opts.allowDemotion,
  });

  // 2. Blob mirror.
  const store = opts.clientsStore || getStore({ name: 'clients', consistency: 'strong' });
  await store.setJSON(ownerKey + '/' + keySafe(client.id), client);

  // 3. clients-index — RETIRED (Deploy 236.417, Hardening C3 deletion
  //    slice). The write-through was a read-modify-write of a multi-
  //    megabyte blob on EVERY client mutation — the single most
  //    expensive operation in the write path, and the accumulation
  //    that pushed multi-guarantor borrower signings and Add Guarantor
  //    past gateway timeouts. Nothing hot reads the index since C3
  //    slice 1-2 (Pipeline/clients/locate serve from Postgres; the
  //    index survives only as an emergency fallback that clients-list
  //    can rebuild inline on demand).

  // 4. Quote-store sync — RETIRED. Deploy 236.426 (D3): quote sweep
  //    retired — /api/quotes renders from loans (D2), so store copies
  //    no longer need freshening. (opts.loanForQuoteSync is ignored.)
}
