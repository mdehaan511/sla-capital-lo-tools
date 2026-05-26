/**
 * loan-advance-status.mjs — POST /api/loan-advance-status
 *
 * Manually advance (or set) a loan's status. Built for the case where the
 * automatic transition broke down — e.g. borrower completed the loan
 * application but advanceQuoteToInProcessing() silently bailed (address
 * mismatch, missing loanId on the borrower-info record, etc.) leaving
 * the loan stuck at awaiting_app.
 *
 * Body: { clientId, loanId, newStatus, owner? }
 *   newStatus — currently only 'approved' is supported. Pipeline labels
 *               this column "In Processing". Other transitions
 *               (active → submitted, etc.) already have their own
 *               dedicated endpoints (quotes-decide, etc.) — this is
 *               specifically for breaking loans out of `awaiting_app`.
 *   owner    — admin cross-LO override; same pattern as elsewhere.
 *
 * Updates both the client.loans[*] record and the matching quote(s) in
 * the quotes blob store. Stamps audit fields:
 *   _manualAdvanceAt   - timestamp
 *   _manualAdvanceBy   - LO email
 *   _manualAdvanceFrom - prior status
 *
 * Returns: { success, prevStatus, newStatus, quotesUpdated }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 222 (Phase 3) — auto-fire Baseline sync when the LO manually
// advances a loan to approved (the safety-valve path for when the
// borrower-info auto-advance silently bailed). Same helper as
// advanceQuoteToInProcessing uses.
import { syncOnApproval as _baselineSyncOnApproval } from './_shared/baseline-sync.mjs';
// Deploy 226 — auto-write a "status" entry to the loan's audit log.
import { appendNoteEntry } from './_shared/notes-log.mjs';

const ALLOWED_TARGETS = ['approved'];

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-advance-status top-level error:', e);
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
  if (!body.newStatus || ALLOWED_TARGETS.indexOf(body.newStatus) < 0) {
    return json(400, { error: 'newStatus must be one of: ' + ALLOWED_TARGETS.join(', ') });
  }

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

  // Update the loan record on the client
  targetLoan.status = body.newStatus;
  targetLoan.updatedAt = now;
  targetLoan._manualAdvanceAt   = now;
  targetLoan._manualAdvanceBy   = selfEmail;
  targetLoan._manualAdvanceFrom = prevStatus;

  // Deploy 226 — audit-log the status change.
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(targetLoan, {
      kind:        'status',
      text:        'Manually advanced status: ' + (prevStatus || '—') + ' → ' + body.newStatus,
      author,
      authorEmail: user.email || '',
      meta:        { from: prevStatus, to: body.newStatus, via: 'manual_advance' },
    });
  }

  // If the loan is being advanced to "approved" from "awaiting_app",
  // stamp borrowerInfoCompletedAt as a defensive measure — the loan
  // record uses this to know when the borrower finished the app.
  // We don't have the real completedAt here so use now; the borrower-
  // info record itself still has the accurate timestamp.
  if (body.newStatus === 'approved' && !targetLoan.borrowerInfoCompletedAt) {
    targetLoan.borrowerInfoCompletedAt = now;
  }

  // Deploy 222 (Phase 3) — auto-fire Baseline sync when this manual
  // advance lands at 'approved'. Same helper as the borrower-info
  // auto-advance path. Mutates targetLoan in place so the single
  // setJSON below persists both the status change and the Baseline
  // refs atomically. Never throws.
  if (body.newStatus === 'approved') {
    try {
      await _baselineSyncOnApproval(client, targetLoan, ownerKey, selfEmail);
    } catch (e) {
      console.error('loan-advance-status: baseline sync threw, ignoring:', e && e.message);
    }
  }

  try {
    await clientsStore.setJSON(clientKey, client);
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  // Now sync the matching quote(s). We're more permissive than
  // borrower-info-save's auto-transition: we match by loanAmt + address
  // and tolerate normalization quirks. Update ALL quotes that match
  // (typically just one, but in case of duplicates from older bugs).
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  let quotesUpdated = 0;

  // Address normalization that's more aggressive than borrower-info-save:
  // strips ", USA"/", US" tails, normalizes Street/St, Avenue/Ave, etc.
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
      const qAddr = aggrNorm(q.address || '');
      if (qAddr !== targetAddr) continue;
      // Update — but don't downgrade. If the quote is already at a
      // "further along" status (e.g. closed), leave it alone.
      const RANK = { active: 0, submitted: 1, awaiting_app: 2, approved: 3, closed: 4 };
      const currentRank = RANK[q.status] || 0;
      const newRank     = RANK[body.newStatus] || 0;
      if (newRank < currentRank) continue;
      q.status = body.newStatus;
      q.updatedAt = now;
      q._manualAdvanceAt   = now;
      q._manualAdvanceBy   = selfEmail;
      q._manualAdvanceFrom = q.status === body.newStatus ? prevStatus : q.status;
      if (body.newStatus === 'approved' && !q.borrowerInfoCompletedAt) {
        q.borrowerInfoCompletedAt = now;
      }
      await quotesStore.setJSON(key, q);
      quotesUpdated += 1;
    }
  } catch (e) {
    // Quote sync failure is non-fatal — the client.loans record is
    // already updated, which is what Pipeline reads from for its
    // column placement. Surface a warning in the response so the LO
    // knows the quote may need a manual touch.
    console.warn('loan-advance-status: quote sync failed:', e);
    return json(200, {
      success: true,
      prevStatus,
      newStatus: body.newStatus,
      quotesUpdated,
      warning: 'Loan record updated, but quote sync failed: ' + (e.message || 'unknown'),
    });
  }

  return json(200, {
    success: true,
    prevStatus,
    newStatus: body.newStatus,
    quotesUpdated,
  });
}
