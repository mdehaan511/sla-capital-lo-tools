/**
 * loan-cancel.mjs — POST /api/loan-cancel
 *
 * Deploy 195: cancel a loan that\u2019s in awaiting_app or approved status.
 * For loans that were approved but ended up not closing \u2014 borrower
 * backed out, financing fell through, deal dried up. The cancellation
 * is a terminal state separate from `closed` (closed = funded with us)
 * and from `denied` (we declined to lend).
 *
 * Eligibility: only loans currently in `awaiting_app` or `approved` can
 * be cancelled. A loan in `active` (Quoted) hasn\u2019t reached the
 * cancellation-worthy stage yet, and `submitted` loans should move
 * through underwriting decisioning before they can be cancelled.
 * Closed loans don\u2019t get cancelled \u2014 they\u2019re already done.
 *
 * Un-cancel: pass `restore: true` to revert a cancelled loan back to
 * `approved`. Useful when the LO mis-clicked or the deal restarts.
 *
 * Body: { clientId, loanId, reason?, restore?, owner? }
 *
 * Returns: { success, prevStatus, newStatus, loan }
 */
import { getStore } from '@netlify/blobs';
// Deploy 236.373 — clients-index write-through, so a cancel actually
// disappears from the Pipeline (which reads the materialized index).
import { upsertClient } from './_shared/clients-index.mjs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write

// Deploy 196: widened from {awaiting_app, approved} to all non-terminal
// statuses. LOs reported needing to drop dead Quoted leads without
// going through Decline (which implies SLA-driven denial; Cancel is
// for borrower-/deal-driven drop-off). Terminal statuses (closed,
// denied, cancelled) remain ineligible.
// Deploy 236.371 (hotfix): added 'on_hold' — same gap as loan-decline.
// on_hold is NOT terminal, but it was absent from this list, so cancelling
// an on-hold loan 400'd behind a misleading "already terminal" toast.
const CANCEL_FROM = ['active', 'on_hold', 'submitted', 'awaiting_app', 'approved'];
const RESTORE_TO  = 'approved';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-cancel top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (!body.clientId) return json(400, { error: 'clientId required' });
  if (!body.loanId)   return json(400, { error: 'loanId required' });

  const isRestore = !!body.restore;
  const reason    = String(body.reason || '').trim().slice(0, 500);

  // Owner resolution (admin cross-LO override allowed).
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(body.clientId);

  let client;
  try {
    client = await clientsStore.get(clientKey, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to read client record: ' + (e.message || 'unknown') });
  }
  if (!client) return json(404, { error: 'Client not found' });
  if (!Array.isArray(client.loans)) return json(400, { error: 'Client has no loans array' });

  const targetLoan = client.loans.find((l) => l.id === body.loanId);
  if (!targetLoan) return json(404, { error: 'Loan not found on client' });

  const prevStatus = targetLoan.status || '';
  const now = new Date().toISOString();

  // Apply the transition
  if (isRestore) {
    // Restore path \u2014 only valid from cancelled
    if (prevStatus !== 'cancelled') {
      return json(400, { error: 'Loan is not cancelled. Current status: ' + prevStatus });
    }
    // Restore to where the loan was BEFORE it was cancelled, if we
    // stored that. Otherwise fall back to `approved` (the most common
    // pre-cancel state).
    const restoreTo = targetLoan._cancelledFrom || RESTORE_TO;
    targetLoan.status = restoreTo;
    targetLoan.updatedAt = now;
    targetLoan._restoredAt = now;
    targetLoan._restoredBy = selfEmail;
    // Keep the cancellation history (don\u2019t wipe _cancelledAt etc.)
    // so audit trail is preserved \u2014 just clear the active marker.
    delete targetLoan._cancelledFrom; // no longer needed
  } else {
    // Cancel path
    if (CANCEL_FROM.indexOf(prevStatus) < 0) {
      return json(400, {
        error: 'Loan cannot be cancelled from status \u201c' + prevStatus + '\u201d. ' +
               'Only Quoted, Submitted, Awaiting Application, or In Processing loans can be cancelled.',
      });
    }
    targetLoan.status = 'cancelled';
    targetLoan.updatedAt = now;
    targetLoan._cancelledAt = now;
    targetLoan._cancelledBy = selfEmail;
    targetLoan._cancelledFrom = prevStatus;
    if (reason) targetLoan._cancelReason = reason;
  }

  try {
    await clientsStore.setJSON(clientKey, client);
    upsertClient(ownerKey, client).catch(() => {}); // Deploy 236.373
    await pgMirror.upsertClientWithLoansStrict(ownerKey, client); // Phase 2 dual-write
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  // Mirror the status change onto matching quotes (best-effort). Same
  // address-aware fuzzy match as loan-advance-status. Failure is
  // non-fatal \u2014 the client.loans record is what Pipeline/Loans read
  // from, so the LO sees the change immediately even if quote sync lags.
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  let quotesUpdated = 0;
  const newStatus = targetLoan.status;
  const aggrNorm = (s) => {
    let x = String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    x = x.replace(/,\s*(usa|us|united states)\.?$/i, '');
    x = x.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave')
         .replace(/\bboulevard\b/g, 'blvd').replace(/\bdrive\b/g, 'dr')
         .replace(/\broad\b/g, 'rd').replace(/\blane\b/g, 'ln')
         .replace(/\bcourt\b/g, 'ct').replace(/\bcircle\b/g, 'cir')
         .replace(/\bplace\b/g, 'pl').replace(/\bparkway\b/g, 'pkwy')
         .replace(/\btrail\b/g, 'trl').replace(/\bterrace\b/g, 'ter');
    x = x.replace(/[.,]/g, '');
    return x.trim();
  };
  const targetAddr = aggrNorm(targetLoan.address || '');
  // Deploy 236.41 — see loan-advance-status.mjs for the rationale.
  const validLoanIds = new Set((client.loans || []).map((l) => l && l.id).filter(Boolean));

  try {
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q) continue;
      // Deploy 236.21 / 236.41 — loanId match plus legacy + stale
      // loanId fallback. Same logic as loan-advance-status.
      const matchById         = q.loanId === body.loanId;
      const quoteLoanIdIsStale = q.loanId && !validLoanIds.has(q.loanId);
      const addrMatches        = aggrNorm(q.address || '') === targetAddr;
      const matchByLegacy     = (!q.loanId || quoteLoanIdIsStale) && addrMatches;
      if (!matchById && !matchByLegacy) continue;
      if (matchByLegacy) q.loanId = body.loanId;
      q.status = newStatus;
      q.updatedAt = now;
      if (isRestore) {
        q._restoredAt = now;
        q._restoredBy = selfEmail;
      } else {
        q._cancelledAt = now;
        q._cancelledBy = selfEmail;
        q._cancelledFrom = prevStatus;
        if (reason) q._cancelReason = reason;
      }
      await quotesStore.setJSON(key, q);
      quotesUpdated += 1;
    }
  } catch (e) {
    console.warn('loan-cancel: quote sync failed:', e);
    return json(200, {
      success: true,
      prevStatus,
      newStatus,
      loan: targetLoan,
      quotesUpdated,
      warning: 'Loan updated, but quote sync failed: ' + (e.message || 'unknown'),
    });
  }

  return json(200, {
    success: true,
    prevStatus,
    newStatus,
    loan: targetLoan,
    quotesUpdated,
  });
}
