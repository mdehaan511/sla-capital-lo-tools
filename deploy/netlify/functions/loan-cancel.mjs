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
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.880
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';

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

  const user = await requireAuth(context, req);
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
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.880 - was isAdmin-only; processors work other LOs loans (Beth cancelling Randy's loan got a 403)
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
    // Deploy 236.575 \u2014 allow cancel from ANY non-terminal status (matches the
    // client's _canEndLoan gate). New / early / empty-status loans were blocked
    // here, so LOs deleted the whole contact just to clear a dead lead. Cancel
    // only sets status \u2192 'cancelled' (keeps the loan + client), so the address
    // survives as a cancelled loan and the contact is retained for marketing.
    const _terminalCancel = ['cancelled', 'denied', 'closed', 'sold', 'liquidated'];
    if (_terminalCancel.indexOf(String(prevStatus).toLowerCase()) >= 0) {
      return json(400, {
        error: 'Loan is already \u201c' + (prevStatus || 'terminal') + '\u201d and cannot be cancelled.',
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
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient.
    // allowDemotion on restore only (Phase C4): un-cancelling moves
    // cancelled → _cancelledFrom (often 'active'), a terminal → non-
    // terminal demotion the DB trigger would otherwise reject. The
    // cancel direction is a promotion and keeps the default.
    await writeClient(ownerKey, client, { clientsStore, allowDemotion: isRestore });
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  // Deploy 236.426 (D3): quote sweep retired \u2014 /api/quotes renders from
  // loans (D2), so store copies no longer need freshening.
  const newStatus = targetLoan.status;

  return json(200, {
    success: true,
    prevStatus,
    newStatus,
    loan: targetLoan,
    quotesUpdated: 0, // D3 (236.426): quote sweeps retired — display reads loans
  });
}
