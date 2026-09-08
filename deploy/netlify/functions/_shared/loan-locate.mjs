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
 * Cheap path first: try the clientId we were given. Only if that misses do we
 * walk the owner's book, then (optionally) every owner.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';

/**
 * @returns {Promise<{client:object, loan:object, clientId:string,
 *                    ownerKey:string, moved:boolean}|null>}
 *   `moved` is true when the loan was found somewhere other than the
 *   clientId the caller passed — worth logging, it means an id went stale.
 */
export async function locateLoan({ ownerKey, clientId, loanId, clientsStore, searchAllOwners = false }) {
  if (!loanId) return null;
  const store = clientsStore || getStore({ name: 'clients', consistency: 'strong' });

  // 1. The id we were given — right in the overwhelming majority of cases.
  if (ownerKey && clientId) {
    try {
      const client = await store.get(ownerKey + '/' + keySafe(clientId), { type: 'json' });
      const loan = client && Array.isArray(client.loans)
        ? client.loans.find((l) => l && l.id === loanId) : null;
      if (loan) return { client, loan, clientId, ownerKey, moved: false };
    } catch (_) { /* fall through to the search */ }
  }

  // 2. The same owner's book. A merge keeps the loan under its owner.
  if (ownerKey) {
    const found = await _scanOwner(store, ownerKey, loanId);
    if (found) return found;
  }

  // 3. Every owner — a reassign moves the loan across books. Off by default
  //    because it is a full walk; callers that can afford it opt in.
  if (searchAllOwners) {
    const owners = new Set();
    try {
      const listing = await store.list();
      for (const b of (listing.blobs || [])) {
        const k = String(b.key || '');
        const slash = k.indexOf('/');
        if (slash > 0) owners.add(k.slice(0, slash));
      }
    } catch (_) { return null; }
    for (const o of owners) {
      if (o === ownerKey) continue;   // already scanned
      const found = await _scanOwner(store, o, loanId);
      if (found) return found;
    }
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
