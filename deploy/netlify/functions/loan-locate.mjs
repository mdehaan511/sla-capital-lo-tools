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
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { readIndex, rebuildIndex } from './_shared/clients-index.mjs';
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

  // Deploy 236.357 — fast path via the redirect map. If a reassign
  // recorded this loan's new home, one blob read gets us the answer
  // — no index scan. Only trust the redirect when the caller has
  // permission to see the target (owner-scoped for LOs).
  const hit = await resolveRedirect({ loanId, oldOwnerKey: oldOwner || undefined, oldClientId: oldClient || undefined });
  if (hit && hit.ownerKey && hit.clientId) {
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

  for (const ownerKey of ownersToScan) {
    const clients = index.byOwner[ownerKey] || [];
    for (const client of clients) {
      if (!client || !Array.isArray(client.loans)) continue;
      for (const loan of client.loans) {
        if (loan && loan.id === loanId) {
          // Deploy 236.357 — seed the redirect map from a successful
          // index scan. Covers loans that were moved BEFORE the
          // redirect writer shipped (or where the write failed):
          // first locate pays the index cost, every subsequent
          // locate is O(1). Only write when the caller supplied a
          // stale tuple (otherwise there's no OLD side to remember).
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
            found: true,
            ownerKey,
            clientId: client.id,
            loanId,
            address: loan.address || '',
            status:  loan.status  || '',
            source:  'index',
          });
        }
      }
    }
  }

  return json(200, { found: false });
}
