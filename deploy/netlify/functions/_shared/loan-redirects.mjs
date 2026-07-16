/**
 * _shared/loan-redirects.mjs — persistent redirect map so stale URLs
 * for reassigned loans always land at the new location without an
 * index scan.
 *
 * Deploy 236.357 — Mike's frustration with the "search for the loan
 * every single time" behavior after 236.356. The locate endpoint
 * walks the materialized clients-index each call; O(1) vs O(N),
 * but still work per click. This module remembers each move so the
 * second hit is a single blob read.
 *
 * Two entry points:
 *
 *   record({ loanId, fromOwnerKey, fromClientId,
 *            toOwnerKey,   toClientId })
 *     Called AFTER a successful move by loan-assign-lo / loan-reassign
 *     / (future) loan-merge-manual. Writes:
 *       - `by-loan/<loanId>` — canonical current home of the loan
 *       - `by-source/<fromOwnerKey>/<fromClientId>/<loanId>` — stale
 *         URL → new URL map. Used when a bookmarked URL comes in
 *         with the OLD (owner, client) tuple.
 *
 *   resolve({ loanId, oldOwnerKey?, oldClientId? })
 *     Cheap lookup. Prefers by-source if the OLD tuple was passed,
 *     otherwise by-loan. Returns null if no redirect on file.
 *     Follows chained redirects (A→B→C) up to a small hop cap.
 *
 * Failure philosophy: NEVER throws. A failed write is logged; the
 * primary reassign is unaffected. A failed read returns null so the
 * caller falls back to a full index scan.
 */
import { getStore } from '@netlify/blobs';

const STORE_NAME = 'loan_redirects';
const HOP_CAP    = 8; // chained-move safety

function _store() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function _byLoanKey(loanId)                       { return 'by-loan/' + String(loanId); }
function _bySourceKey(ownerKey, clientId, loanId) { return 'by-source/' + String(ownerKey) + '/' + String(clientId) + '/' + String(loanId); }

export async function record({
  loanId,
  fromOwnerKey, fromClientId,
  toOwnerKey,   toClientId,
  via,
}) {
  if (!loanId || !toOwnerKey || !toClientId) return false;
  const now = new Date().toISOString();
  const target = { loanId, ownerKey: toOwnerKey, clientId: toClientId, updatedAt: now, via: via || '' };
  try {
    const store = _store();
    // Canonical current home.
    await store.setJSON(_byLoanKey(loanId), target);
    // Stale-URL → new-URL map, keyed by the OLD tuple. Only write when
    // the OLD tuple differs from the new one (a same-owner client
    // reassign writes both; a cross-owner LO reassign writes both;
    // a hypothetical no-op wouldn't).
    if (fromOwnerKey && fromClientId
      && (fromOwnerKey !== toOwnerKey || fromClientId !== toClientId)) {
      await store.setJSON(_bySourceKey(fromOwnerKey, fromClientId, loanId), target);
    }
    return true;
  } catch (e) {
    console.warn('loan-redirects: record failed (non-fatal):', e && e.message);
    return false;
  }
}

export async function resolve({ loanId, oldOwnerKey, oldClientId }) {
  if (!loanId) return null;
  const store = _store();
  let hops = 0;
  // Prefer by-source when the caller has the stale tuple — it's the
  // exact match. Fall back to by-loan for the "some URL just has the
  // loanId" case.
  let key = (oldOwnerKey && oldClientId)
    ? _bySourceKey(oldOwnerKey, oldClientId, loanId)
    : _byLoanKey(loanId);
  let target = null;
  try {
    target = await store.get(key, { type: 'json' }).catch(() => null);
    if (!target) {
      // Fallback path: no source-keyed entry, try canonical.
      if (key !== _byLoanKey(loanId)) {
        target = await store.get(_byLoanKey(loanId), { type: 'json' }).catch(() => null);
      }
    }
    if (!target) return null;
    // Chain-follow: if the target itself was later moved, keep going.
    // Bounded at HOP_CAP to defend against redirect cycles from
    // corrupted data.
    while (hops++ < HOP_CAP) {
      const next = await store.get(
        _bySourceKey(target.ownerKey, target.clientId, loanId),
        { type: 'json' },
      ).catch(() => null);
      if (!next) break;
      if (next.ownerKey === target.ownerKey && next.clientId === target.clientId) break; // no progress
      target = next;
    }
    return {
      loanId,
      ownerKey: target.ownerKey,
      clientId: target.clientId,
      updatedAt: target.updatedAt || null,
    };
  } catch (e) {
    console.warn('loan-redirects: resolve failed:', e && e.message);
    return null;
  }
}
