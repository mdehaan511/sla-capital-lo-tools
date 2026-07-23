/**
 * loan-locate.mjs — GET /api/loan-locate?loanId=<id>
 *
 * Deploy 236.356 — find where a loan currently lives. Used by
 * loan-details.html when a bookmarked URL 404s so it can auto-
 * redirect to the loan's new location instead of dead-ending
 * on "loan not found."
 *
 * Cause of orphaned URLs: reassignments. Both loan-assign-lo
 * (LO reassign, Deploy 236.187) and loan-reassign (client
 * reassign / Change Primary Guarantor, Deploy 236.81) move a
 * loan under a NEW clientId (and possibly a new ownerKey).
 * Any URL that referenced the OLD (clientId, ownerKey) still
 * has the correct loanId — enough to find the new home.
 *
 * Strategy: consult the materialized clients-index blob (Deploy
 * 236.341). Every client's loans array (summary-projected) has
 * the loan IDs. One blob read, walk the map, done.
 *
 * Scope:
 *   - LO callers see only their own loans (owner-scoped).
 *   - Admin / processor see any loan (cross-owner).
 *
 * Response:
 *   200 { found: true, ownerKey, clientId, loanId, address, status }
 *   200 { found: false }        — no loan with that id in scope
 *   400 { error }               — missing loanId
 *   401 { error }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { readIndex, rebuildIndex, upsertClient as indexUpsertClient } from './_shared/clients-index.mjs';
// Deploy 236.405 (C3 slice 2): Postgres answers the locate by primary
// key — one query instead of an index scan.
import { db } from './_shared/supabase-db.mjs';
// Deploy 236.357 — one-blob-read redirect map. Reassignments write
// (old → new) here so subsequent locates are O(1) instead of an
// index walk.
import { resolve as resolveRedirect, record as recordLoanRedirect } from './_shared/loan-redirects.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-locate error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const loanId = String(url.searchParams.get('loanId') || '').trim();
  if (!loanId) return json(400, { error: 'loanId required' });
  // Optional stale (owner, client) tuple from the caller. When
  // provided we can hit the by-source key directly, which is even
  // faster than the by-loan lookup (skips the chain-follow loop).
  const oldOwner  = String(url.searchParams.get('oldOwnerKey') || '').trim();
  const oldClient = String(url.searchParams.get('oldClientId') || '').trim();

  const selfKey = keySafe(normalizeEmail(user.email));
  const isStaff = canOverrideOwner(user).ok;

  // Deploy 236.363 — if the caller passed the stale tuple that just
  // 404'd, never resolve back to it. Guards against a redirect loop
  // where the index still shows a client that was actually deleted
  // (e.g. clients-merge-manual pre-236.363 didn't sync the index —
  // the loser lingered in the byOwner map with its old loans, so
  // loan-locate returned the loser tuple, loan-details redirected
  // right back to the URL that failed to load, forever).
  function _isStaleTuple(ownerKey, clientId) {
    return !!(oldOwner && oldClient
      && ownerKey === oldOwner && clientId === oldClient);
  }

  // Deploy 236.357 — fast path via the redirect map. If a reassign
  // recorded this loan's new home, one blob read gets us the answer
  // — no index scan. Only trust the redirect when the caller has
  // permission to see the target (owner-scoped for LOs).
  const hit = await resolveRedirect({ loanId, oldOwnerKey: oldOwner || undefined, oldClientId: oldClient || undefined });
  if (hit && hit.ownerKey && hit.clientId && !_isStaleTuple(hit.ownerKey, hit.clientId)) {
    if (isStaff || hit.ownerKey === selfKey) {
      return json(200, {
        found:    true,
        ownerKey: hit.ownerKey,
        clientId: hit.clientId,
        loanId,
        source:   'redirect',
      });
    }
    // LO scope + redirect points at another owner: fall through to
    // the index scan (which will also miss for a non-admin), so the
    // caller gets a clean 'not found in your scope' response.
  }

  // Deploy 236.405 (C3 slice 2) — Postgres answers the locate by
  // primary key: one indexed query on the same rows every write
  // commits to (C2), so the answer can't be stale the way the
  // materialized index could. Hit → done. Miss or error → fall
  // through to the legacy index/walk recovery below, which stays
  // until the index machinery is deleted.
  try {
    const row = await db.first('loans', {
      select: 'id,client_id,owner_email,address,status',
      eq: { id: loanId },
    });
    if (row && row.client_id) {
      const pgOwnerKey = keySafe(normalizeEmail(row.owner_email || ''));
      if (!_isStaleTuple(pgOwnerKey, row.client_id)) {
        if (isStaff || pgOwnerKey === selfKey) {
          return json(200, {
            found:    true,
            ownerKey: pgOwnerKey,
            clientId: row.client_id,
            loanId,
            address:  row.address || '',
            status:   row.status  || '',
            source:   'postgres',
          });
        }
        // Loan exists but belongs to another LO — same answer the
        // index scan would give a non-staff caller.
        return json(200, { found: false });
      }
      // PG points at the tuple the caller says just 404'd — odd
      // enough to let the legacy scan double-check.
    }
    // PG miss: fall through too. Post-C2 this "can't happen" for
    // real loans, but locate is a recovery endpoint — let the index
    // scan + blob walk have the final word until they're retired.
  } catch (e) {
    console.warn('loan-locate: PG lookup failed, falling back to index:', e && e.message);
  }

  // One index read. If the index is missing (never built or version
  // drift), build inline before we scan — much cheaper than the
  // caller having to fall back to a full-store walk.
  let { index, exists } = await readIndex();
  if (!exists || !index || !index.byOwner) {
    try {
      await rebuildIndex();
      const fresh = await readIndex();
      index = fresh && fresh.index;
    } catch (e) {
      console.warn('loan-locate: inline rebuild failed:', e && e.message);
    }
  }
  if (!index || !index.byOwner) {
    return json(200, { found: false });
  }

  const ownersToScan = isStaff
    ? Object.keys(index.byOwner)
    : [selfKey];

  // Wrap the scan so we can retry it after an inline rebuild if the
  // first pass misses AND the caller passed a stale tuple (which
  // hints that the index is out of date — the URL is real, the
  // caller expected to find it, but the index doesn't show it).
  function _scanIndex(idx) {
    if (!idx || !idx.byOwner) return null;
    for (const ownerKey of ownersToScan) {
      const clients = idx.byOwner[ownerKey] || [];
      for (const client of clients) {
        if (!client || !Array.isArray(client.loans)) continue;
        if (_isStaleTuple(ownerKey, client.id)) continue;
        for (const loan of client.loans) {
          if (loan && loan.id === loanId) {
            return { ownerKey, client, loan };
          }
        }
      }
    }
    return null;
  }

  let scanHit = _scanIndex(index);

  // Deploy 236.363 → 236.364 — direct blob-store walk as the
  // last-resort fallback when the index misses AND the caller
  // supplied a stale-tuple hint (which implies the loan exists,
  // the index just doesn't know yet). Replaces the earlier rebuild-
  // then-rescan approach — the rebuild was timing out in some
  // cases and never returning, leaving the caller stuck on the
  // "checking loan location…" screen. Direct walk is O(N) blob
  // reads but always finds the loan if it exists, no dependency
  // on index freshness. We also opportunistically upsert the found
  // client into the index so the very next locate is O(1) again.
  //
  // Skip when the caller didn't pass a stale tuple — an unhinted
  // miss usually means the loan really doesn't exist, and there's
  // no need to pay the O(N) cost per probe.
  if (!scanHit && oldOwner && oldClient) {
    try {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const scanOwners = isStaff ? null : selfKey; // null = all owners
      const listOpts = scanOwners ? { prefix: scanOwners + '/' } : {};
      const { blobs } = await clientsStore.list(listOpts);
      const CHUNK = 25;
      outer: for (let i = 0; i < blobs.length; i += CHUNK) {
        const slice = blobs.slice(i, i + CHUNK);
        const recs = await Promise.all(slice.map(async ({ key }) => {
          const slash = key.indexOf('/');
          if (slash < 0) return null;
          const ownerKey = key.slice(0, slash);
          if (_isStaleTuple(ownerKey, key.slice(slash + 1))) return null;
          const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
          return rec ? { ownerKey, rec } : null;
        }));
        for (const item of recs) {
          if (!item || !item.rec || !Array.isArray(item.rec.loans)) continue;
          if (_isStaleTuple(item.ownerKey, item.rec.id)) continue;
          for (const loan of item.rec.loans) {
            if (loan && loan.id === loanId) {
              scanHit = { ownerKey: item.ownerKey, client: item.rec, loan };
              // Heal the index for next time. Fire-and-forget — a
              // failed index write here doesn't affect this response.
              indexUpsertClient(item.ownerKey, item.rec).catch(() => {});
              break outer;
            }
          }
        }
      }
    } catch (e) {
      console.warn('loan-locate: direct-walk fallback failed:', e && e.message);
    }
  }

  if (scanHit) {
    const { ownerKey, client, loan } = scanHit;
    // Deploy 236.357 — seed the redirect map from a successful index
    // scan. Covers loans moved BEFORE the redirect writer shipped
    // (or where the write failed): first locate pays the index cost,
    // every subsequent locate is O(1). Only write when the caller
    // supplied a stale tuple (otherwise there's no OLD side to remember).
    if (oldOwner && oldClient
      && (oldOwner !== ownerKey || oldClient !== client.id)) {
      recordLoanRedirect({
        loanId,
        fromOwnerKey: oldOwner,
        fromClientId: oldClient,
        toOwnerKey:   ownerKey,
        toClientId:   client.id,
        via:          'loan_locate:seed',
      }).catch(() => {});
    }
    return json(200, {
      found:    true,
      ownerKey,
      clientId: client.id,
      loanId,
      address:  loan.address || '',
      status:   loan.status  || '',
      source:   'index',
    });
  }

  return json(200, { found: false });
}
