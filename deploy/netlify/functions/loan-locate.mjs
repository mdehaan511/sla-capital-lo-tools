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

  const selfKey = keySafe(normalizeEmail(user.email));
  const isStaff = canOverrideOwner(user).ok;

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
          return json(200, {
            found: true,
            ownerKey,
            clientId: client.id,
            loanId,
            address: loan.address || '',
            status:  loan.status  || '',
          });
        }
      }
    }
  }

  return json(200, { found: false });
}
