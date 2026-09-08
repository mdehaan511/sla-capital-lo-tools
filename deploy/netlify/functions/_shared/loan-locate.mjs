/**
 * _shared/loan-locate.mjs — Deploy 236.897 (Mike)
 *
 * Find a loan when the clientId you were handed may be stale.
 *
 * "The status update for the extension isnt showing correctly in the Closed
 * Loans table." The extension marker is written by (clientId, loanId). Between
 * sending 3602 24th Ave W for signature and the borrower signing it six days
 * later, that client was MERGED — `c_bl_mr8mdovz_kqybhg` no longer exists and
 * the loan moved to `c_lo_1788375942940_mk12zt`. envelope-sign looked up the
 * old id, found nothing, and returned early, so the loan never got its marker
 * and the servicing row never showed a chip.
 *
 * Loan IDs are immutable and never reused (CLAUDE.md); client IDs are not
 * stable — merge, reassign and promote all move a loan to a different parent.
 * So anything long-lived that has to come back and find a loan later must key
 * off the LOAN id. This is the same lesson as the audit log in 236.861, which
 * had history stranded by the same movement.
 *
 * Cheap path first: try the clientId we were given. If that misses, ASK
 * POSTGRES which client holds the loan — `loans.id` is the primary key there
 * and the row carries client_id + owner_email, so it is one indexed lookup.
 *
 * The first version of this walked the owner's blob book instead and took the
 * endpoint past its timeout on a large book (HTTP 504). Same lesson as
 * reference_profiles_store_slow: don't scan a blob store, read an index and
 * then fetch by key. The blob walk survives only as a last resort behind an
 * explicit flag, for the case where PG has not mirrored the loan.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { db } from './supabase-db.mjs';

/**
 * @returns {Promise<{client:object, loan:object, clientId:string,
 *                    ownerKey:string, moved:boolean}|null>}
 *   `moved` is true when the loan was found somewhere other than the
 *   clientId the caller passed — worth logging, it means an id went stale.
 */
export async function locateLoan({ ownerKey, clientId, loanId, clientsStore, allowScan = false }) {
  if (!loanId) return null;
  const store = clientsStore || getStore({ name: 'clients', consistency: 'strong' });

  const read = async (oKey, cId) => {
    if (!oKey || !cId) return null;
    try {
      const client = await store.get(oKey + '/' + keySafe(cId), { type: 'json' });
      const loan = client && Array.isArray(client.loans)
        ? client.loans.find((l) => l && l.id === loanId) : null;
      return loan ? { client, loan } : null;
    } catch (_) { return null; }
  };

  // 1. The ids we were given — right in the overwhelming majority of cases.
  const direct = await read(ownerKey, clientId);
  if (direct) return { ...direct, clientId, ownerKey, moved: false };

  // 2. Ask Postgres who holds it now. One primary-key lookup.
  try {
    const row = await db.first('loans', {
      select: 'id,client_id,owner_email',
      eq: { id: loanId },
    });
    if (row && row.client_id) {
      const oKey = keySafe(String(row.owner_email || '').toLowerCase()) || ownerKey;
      const hit = await read(oKey, row.client_id);
      if (hit) {
        return { ...hit, clientId: row.client_id, ownerKey: oKey, moved: true };
      }
    }
  } catch (e) {
    console.warn('[loan-locate] PG lookup failed for ' + loanId + ':', e && e.message);
  }

  // 3. Last resort: walk the owner's book. Off by default — on a large book
  //    this is slow enough to blow a function's timeout, which is how the
  //    236.897 repair first failed. Only for callers that can afford it and
  //    have a reason to think PG is behind.
  if (allowScan && ownerKey) {
    const found = await _scanOwner(store, ownerKey, loanId);
    if (found) return found;
  }

  return null;
}

async function _scanOwner(store, ownerKey, loanId) {
  let blobs;
  try {
    const listing = await store.list({ prefix: ownerKey + '/' });
    blobs = listing.blobs || [];
  } catch (_) { return null; }

  for (const b of blobs) {
    let client;
    try { client = await store.get(b.key, { type: 'json' }); }
    catch (_) { continue; }
    if (!client || !Array.isArray(client.loans)) continue;
    const loan = client.loans.find((l) => l && l.id === loanId);
    if (loan) {
      return {
        client, loan,
        clientId: client.id || String(b.key).split('/').slice(1).join('/'),
        ownerKey,
        moved: true,
      };
    }
  }
  return null;
}
