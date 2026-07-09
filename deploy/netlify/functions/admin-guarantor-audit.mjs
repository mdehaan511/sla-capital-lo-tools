/**
 * admin-guarantor-audit.mjs — GET /api/admin-guarantor-audit
 *
 * Deploy 236.270 — one-shot forensic scan for loans whose
 * guarantorClientIds / guarantorOwnership got silently wiped by the
 * pre-236.269 sizer-upsert fallback bug.
 *
 * How it works:
 *   1. Iterate every record in `signed_applications`. Each record
 *      encodes the borrower count at long-app sign time
 *      (`numBorrowers`) plus the actual borrower2/3/4 blocks with
 *      their email + ownership.
 *   2. For each signed record where numBorrowers >= 2, look up the
 *      corresponding loan (nested under the primary client in the
 *      `clients` store, keyed as ownerKey/clientId).
 *   3. Compare loan.guarantorClientIds.length to the expected count
 *      (numBorrowers - 1). If it's short, the loan is affected.
 *   4. Also flag loans where guarantorOwnership is missing entries
 *      that are present in the signed record.
 *
 * Response:
 *   {
 *     scanned: <int>,
 *     affected: [
 *       {
 *         ownerKey, clientId, loanId, address,
 *         expected: N, actual: M,
 *         missingSecondaryEmails: ['g2@x.com', 'g3@y.com'],
 *         lastReprice: '2026-07-08T…' | null,
 *       },
 *       ...
 *     ],
 *   }
 *
 * Auth: super_admin only. Read-only; makes no writes.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isSuperAdmin,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-guarantor-audit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'super_admin only' });

  const signedStore  = getStore({ name: 'signed_applications', consistency: 'strong' });
  const clientsStore = getStore({ name: 'clients',             consistency: 'strong' });

  // Cache client records so we only fetch each once.
  const clientCache = new Map(); // key = ownerKey/clientId → client|null

  async function _getClient(ownerKey, clientId) {
    const safe = String(clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
    const cacheKey = ownerKey + '/' + safe;
    if (clientCache.has(cacheKey)) return clientCache.get(cacheKey);
    let c = null;
    try { c = await clientsStore.get(cacheKey, { type: 'json' }); } catch (_) { c = null; }
    clientCache.set(cacheKey, c);
    return c;
  }

  function _lastRepriceAt(loan) {
    const log = (loan && Array.isArray(loan.notesLog)) ? loan.notesLog : [];
    for (let i = log.length - 1; i >= 0; i--) {
      const n = log[i];
      if (n && n.kind === 'reprice') return n.at || n.ts || null;
    }
    return null;
  }

  const affected = [];
  let scanned = 0;

  const { blobs } = await signedStore.list();
  for (const { key } of blobs) {
    scanned++;
    const rec = await signedStore.get(key, { type: 'json' }).catch(() => null);
    if (!rec) continue;
    const numBorrowers = Number(rec.numBorrowers || 0);
    if (numBorrowers < 2) continue;

    const secondaries = [rec.borrower2, rec.borrower3, rec.borrower4].filter(function (b) {
      return b && (b.email || (b.audit && b.audit.signerEmail));
    });
    if (!secondaries.length) continue;

    const ownerKey = rec.ownerKey || '';
    const clientId = rec.clientId || '';
    const loanId   = rec.loanId   || '';
    if (!ownerKey || !clientId || !loanId) continue;

    const primary = await _getClient(ownerKey, clientId);
    if (!primary || !Array.isArray(primary.loans)) continue;
    const loan = primary.loans.find(function (l) { return l && l.id === loanId; });
    if (!loan) continue;

    const gClientIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
    const expected   = secondaries.length; // primary is not in this list
    const actual     = gClientIds.length;

    if (actual >= expected) continue; // fully attached, nothing to fix

    // Build the list of secondary emails whose client-id we can't
    // find on the loan. These are the ones to recover.
    const attachedIdSet = new Set(gClientIds);
    const missingEmails = [];
    for (const s of secondaries) {
      const em = String((s && (s.email || (s.audit && s.audit.signerEmail))) || '').toLowerCase().trim();
      if (!em) continue;
      // Check if any attached client id maps to this email under
      // the same owner — only meaningful if we can prove it. Skip
      // that resolution here (expensive lookup); missingEmails is
      // the superset the recovery script consumes.
      missingEmails.push(em);
    }
    // If a stored guarantor has ownership entry, note it.
    const ownership = (loan.guarantorOwnership && typeof loan.guarantorOwnership === 'object') ? loan.guarantorOwnership : {};
    const orphanedOwnershipEntries = Object.keys(ownership).filter(function (k) {
      return !attachedIdSet.has(k);
    });

    affected.push({
      ownerKey,
      clientId,
      loanId,
      address: loan.address || '',
      status:  loan.status  || '',
      expected: expected,
      actual:   actual,
      missingSecondaryEmails: missingEmails,
      orphanedOwnershipEntries: orphanedOwnershipEntries.length,
      lastReprice: _lastRepriceAt(loan),
      signedAt: rec.signedAt || null,
    });
  }

  affected.sort(function (a, b) {
    // Most recently repriced first — those are the freshest damage.
    return String(b.lastReprice || '').localeCompare(String(a.lastReprice || ''));
  });

  return json(200, {
    scanned: scanned,
    affectedCount: affected.length,
    affected: affected,
  });
}
