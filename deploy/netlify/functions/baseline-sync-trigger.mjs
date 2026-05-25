/**
 * baseline-sync-trigger.mjs — POST /api/baseline-sync-trigger
 *
 * Manually fire a Baseline sync for one loan. Powers the "Retry
 * Baseline sync" / "Send to Baseline" button on Loan Details.
 *
 * Auth: loan owner OR admin (admin may pass `owner` to act on another
 * LO's loan, same pattern as the other write endpoints).
 *
 * Body:  { clientId, loanId, owner? }
 *
 * Flow:
 *   1. Load the client record from the `clients` blob store.
 *   2. Find the matching loan inside client.loans[].
 *   3. Load the per-loan borrower_info from the `borrower_info` blob
 *      store (key: ownerKey/clientId/loanId — per Deploy 168).
 *   4. Call syncLoanToBaseline(...).
 *   5. Persist the resulting refs (baselineEntityId, baselineGuarantor1Id,
 *      baselineGuarantor2Id, baselineLoanId) + status fields back onto
 *      the loan record so a subsequent retry skips already-synced steps.
 *   6. Return the sync result.
 *
 * Phase 1 note: syncLoanToBaseline currently force-runs in dry-run mode,
 * so this endpoint is safe to wire up to the UI right now — no calls
 * reach Baseline. The audit log will fill with dry-run entries showing
 * exactly what would have been sent.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe, readJsonBody,
} from './_shared/auth.mjs';
import { syncLoanToBaseline } from './_shared/baseline-sync.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId || !body.loanId) {
    return json(400, { error: 'clientId and loanId required' });
  }

  // Owner resolution. Admins may target another LO's loan via body.owner.
  const selfEmail = normalizeEmail(user.email);
  let ownerEmail = selfEmail;
  if (body.owner && body.owner !== selfEmail) {
    if (!isAdmin(user)) {
      return json(403, { error: 'Owner override requires admin' });
    }
    ownerEmail = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(ownerEmail);

  // ── Load the client and locate the loan ────────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(body.clientId);

  let client;
  try {
    client = await clientsStore.get(clientKey, { type: 'json' });
  } catch (e) {
    console.error('baseline-sync-trigger: client read failed', e);
    return json(500, { error: 'Failed to load client' });
  }
  if (!client) return json(404, { error: 'Client not found' });

  const loans = Array.isArray(client.loans) ? client.loans : [];
  const loanIdx = loans.findIndex((l) => l && l.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = loans[loanIdx];

  // ── Load borrower_info for this specific (client, loan) ────────
  // Key shape: ownerKey/clientId/loanId   (per Deploy 168, per-loan)
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const biKey = ownerKey + '/' + keySafe(body.clientId) + '/' + keySafe(body.loanId);

  let borrowerInfo = null;
  try {
    borrowerInfo = await biStore.get(biKey, { type: 'json' });
  } catch (e) {
    console.warn('baseline-sync-trigger: borrower_info read failed (continuing without)', e && e.message);
  }

  // ── Run the orchestrator ───────────────────────────────────────
  const result = await syncLoanToBaseline(loan, client, borrowerInfo, {
    triggerUserEmail: selfEmail,
    triggerReason: 'manual_trigger',
    ownerKey,
  });

  // ── Persist refs + summary back onto the loan ──────────────────
  //
  // Even on failure we update the partial refs (e.g. entity created
  // but guarantor failed) so a retry can pick up where we left off.
  // Status field convention:
  //   'synced'  — all steps ok
  //   'partial' — some steps ok, then a failure stopped the sequence
  //   'failed'  — first step failed, nothing usable created
  //   'pending' — never set here (reserved for Phase 3 auto-trigger
  //               where we kick off async)
  const summaryStatus = result.ok
    ? 'synced'
    : ((result.refs.baselineEntityId || result.refs.baselineGuarantor1Id) ? 'partial' : 'failed');

  const now = new Date().toISOString();
  const updatedLoan = {
    ...loan,
    _baselineEntityId:     result.refs.baselineEntityId      || loan._baselineEntityId      || null,
    _baselineGuarantor1Id: result.refs.baselineGuarantor1Id  || loan._baselineGuarantor1Id  || null,
    _baselineGuarantor2Id: result.refs.baselineGuarantor2Id  || loan._baselineGuarantor2Id  || null,
    _baselineLoanId:       result.refs.baselineLoanId        || loan._baselineLoanId        || null,
    _baselineSyncStatus:   summaryStatus,
    _baselineSyncMode:     result.mode,
    _baselineSyncedAt:     result.ok ? now : (loan._baselineSyncedAt || null),
    _baselineLastAttemptAt: now,
    _baselineLastAttemptBy: selfEmail,
    _baselineLastError:    result.ok ? null : (result.error || 'unknown'),
  };

  const updatedClient = {
    ...client,
    loans: loans.map((l, i) => (i === loanIdx ? updatedLoan : l)),
    updatedAt: now,
  };

  try {
    await clientsStore.setJSON(clientKey, updatedClient);
  } catch (e) {
    console.error('baseline-sync-trigger: client write failed', e);
    // The Baseline calls already happened (or were dry-run); the audit
    // log captured them. Returning 500 here would mislead the UI. Best
    // we can do is surface the persistence error in the response so the
    // LO knows their loan record wasn't updated.
    return json(200, { ...result, persistError: 'failed_to_save_loan_refs' });
  }

  return json(200, { ...result, loanStatus: summaryStatus });
};
