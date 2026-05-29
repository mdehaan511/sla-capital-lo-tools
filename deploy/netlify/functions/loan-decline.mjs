/**
 * loan-decline.mjs — POST /api/loan-decline
 *
 * Deploy 196: SLA declines to lend on a loan. Distinct from `cancelled`
 * (deal fell through / borrower backed out) and from `closed` (loan
 * funded). Decline is OUR decision; cancel is the borrower's or the
 * deal's. Both are terminal — but they tell different stories and live
 * on different review pages (decisions.html vs cancelled.html).
 *
 * Modeled directly on loan-cancel.mjs (Deploy 195). Same shape: owner
 * resolution, strong-consistency client store read-modify-write, quote
 * sync for downstream pipeline reads.
 *
 * Eligibility: any active (Quoted) / submitted / awaiting_app / approved
 * loan can be declined. Terminal statuses (closed / cancelled / denied)
 * can't be declined again. The LO can decline their own loans without
 * admin approval — same self-service pattern as quotes-decide for
 * declining a single quote (see auth note there).
 *
 * Un-decline (restore): pass `restore: true` to revert a denied loan
 * back to whatever status it had right before the decline. Useful when
 * an LO clicks Decline by mistake.
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
// Deploy 226 — audit log entry on decline / restore.
import { appendNoteEntry } from './_shared/notes-log.mjs';

const DECLINE_FROM = ['active', 'submitted', 'awaiting_app', 'approved'];
// Fallback when _declinedFrom was never written (e.g. a hand-edited
// record). Approved is the safest restore target since it's the latest
// stage a normal decline flow would have come from.
const RESTORE_TO   = 'approved';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-decline top-level error:', e);
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

  const umeta = (user && user.user_metadata) || {};
  const actorName = umeta.full_name || umeta.fullName || user.email || '';
  if (isRestore) {
    // Restore path — only valid from denied
    if (prevStatus !== 'denied') {
      return json(400, { error: 'Loan is not declined. Current status: ' + prevStatus });
    }
    const restoreTo = targetLoan._declinedFrom || RESTORE_TO;
    targetLoan.status = restoreTo;
    targetLoan.updatedAt = now;
    targetLoan._restoredAt = now;
    targetLoan._restoredBy = selfEmail;
    // Audit trail kept; just clear the active marker so future decline
    // flows record fresh _declinedFrom / _declinedAt values.
    delete targetLoan._declinedFrom;
    // Deploy 226 — audit log entry on restore.
    appendNoteEntry(targetLoan, {
      kind:        'status',
      text:        'Loan restored from Declined → ' + restoreTo,
      author:      actorName,
      authorEmail: user.email || '',
      meta:        { from: 'denied', to: restoreTo, via: 'restore' },
    });
  } else {
    if (DECLINE_FROM.indexOf(prevStatus) < 0) {
      return json(400, {
        error: 'Loan cannot be declined from status “' + prevStatus + '”. ' +
               'Only Quoted, Submitted, Awaiting Application, or In Processing loans can be declined.',
      });
    }
    targetLoan.status = 'denied';
    targetLoan.updatedAt = now;
    targetLoan._declinedAt = now;
    targetLoan._declinedBy = selfEmail;
    targetLoan._declinedFrom = prevStatus;
    if (reason) targetLoan._declineReason = reason;
    // Deploy 226 — audit log entry on decline.
    appendNoteEntry(targetLoan, {
      kind:        'decline',
      text:        'Loan declined' + (reason ? ' — ' + reason : ''),
      author:      actorName,
      authorEmail: user.email || '',
      meta:        { from: prevStatus, to: 'denied', reason: reason || '' },
    });
  }

  try {
    await clientsStore.setJSON(clientKey, client);
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  // Mirror onto quotes (best-effort). Pipeline + Submissions read from
  // the quotes store, so this is what makes the decline visible there
  // immediately. Failure is non-fatal — the client.loans record is
  // authoritative for the Loans / Loan Details views.
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

  try {
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q) continue;
      // Deploy 236.21 — loanId match with safe legacy-address fallback
      // (see loan-advance-status.mjs / borrower-info-sync.mjs for the
      // full rationale).
      const matchById     = q.loanId === body.loanId;
      const matchByLegacy = !q.loanId && aggrNorm(q.address || '') === targetAddr;
      if (!matchById && !matchByLegacy) continue;
      if (matchByLegacy && !q.loanId) q.loanId = body.loanId;
      q.status = newStatus;
      q.updatedAt = now;
      if (isRestore) {
        q._restoredAt = now;
        q._restoredBy = selfEmail;
      } else {
        q._declinedAt = now;
        q._declinedBy = selfEmail;
        q._declinedFrom = prevStatus;
        if (reason) q._declineReason = reason;
      }
      await quotesStore.setJSON(key, q);
      quotesUpdated += 1;
    }
  } catch (e) {
    console.warn('loan-decline: quote sync failed:', e);
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
