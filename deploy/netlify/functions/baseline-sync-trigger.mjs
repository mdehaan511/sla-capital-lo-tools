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
import { postSlack } from './_shared/slack.mjs';

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
  // Deploy 204 (Phase 2.7 hotfix): dry-run never produces real Baseline
  // records, so it can't be 'synced' regardless of whether all the
  // dry-run steps "succeeded". Distinct branch keeps the LO's panel
  // honest after a dry-run test:
  //   synced     — live, all steps ok
  //   partial    — live, some steps got real refs back, then a failure stopped
  //   failed     — live, first real step failed → no usable refs created
  //   not_synced — dry-run (default), or never attempted
  let summaryStatus;
  if (result.mode === 'dry-run') {
    summaryStatus = 'not_synced';
  } else if (result.ok) {
    summaryStatus = 'synced';
  } else {
    summaryStatus = (result.refs.baselineEntityId || result.refs.baselineGuarantor1Id) ? 'partial' : 'failed';
  }

  const now = new Date().toISOString();
  // Compact step summary: { step, ok, status?, error? } — small enough
  // to embed on the loan record so the UI can render per-step badges
  // without re-fetching the audit log. The full request/response bodies
  // stay in baseline-sync-log; this is just the LED-strip view.
  const stepsSummary = (result.steps || []).map((s) => ({
    step:   s.step,
    ok:     !!s.ok,
    status: s.status || null,
    error:  s.error  || null,
  }));

  // Deploy 204 (Phase 2.7 hotfix): only persist Baseline IDs when the
  // sync ran in LIVE mode. Dry-run "IDs" are fake (__DRYRUN__-prefixed)
  // — persisting them onto the loan record would cause the next live
  // retry to skip every step because the refs are already populated.
  // We still persist status / lastAttempt / lastSteps in both modes so
  // the panel and audit log reflect every attempt.
  const persistRefs = (result.mode === 'live');
  const updatedLoan = {
    ...loan,
    _baselineEntityId:     persistRefs ? (result.refs.baselineEntityId      || loan._baselineEntityId      || null) : (loan._baselineEntityId      || null),
    _baselineGuarantor1Id: persistRefs ? (result.refs.baselineGuarantor1Id  || loan._baselineGuarantor1Id  || null) : (loan._baselineGuarantor1Id  || null),
    _baselineGuarantor2Id: persistRefs ? (result.refs.baselineGuarantor2Id  || loan._baselineGuarantor2Id  || null) : (loan._baselineGuarantor2Id  || null),
    _baselineLoanId:       persistRefs ? (result.refs.baselineLoanId        || loan._baselineLoanId        || null) : (loan._baselineLoanId        || null),
    _baselineSyncStatus:   summaryStatus,
    _baselineSyncMode:     result.mode,
    _baselineSyncedAt:     (result.ok && persistRefs) ? now : (loan._baselineSyncedAt || null),
    _baselineLastAttemptAt: now,
    _baselineLastAttemptBy: selfEmail,
    _baselineLastError:    result.ok ? null : (result.error || 'unknown'),
    _baselineLastSteps:    stepsSummary,
    // Deploy 207 (Phase 2.7.3): persist the orchestrator's debug
    // bundle (rawRefsFromLoan + refsAfterFilter) onto the loan so
    // the panel can render it directly. Lets us debug without
    // needing to capture the trigger response in DevTools.
    _baselineLastDebug:    result._debug || null,
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

  // ── Slack alert on LIVE failure ─────────────────────────────────
  //
  // Fire-and-forget — never block the response on Slack. Skipped when
  // the sync was dry-run (no real failure to alert about) or when no
  // Slack webhook is configured (the helper short-circuits).
  if (!result.ok && result.mode === 'live') {
    const siteUrl = (process.env.URL || 'https://slaloantools.netlify.app').replace(/\/+$/, '');
    const loanLink = siteUrl +
      '/loan-details.html?clientId=' + encodeURIComponent(body.clientId) +
      '&loanId='   + encodeURIComponent(body.loanId) +
      (ownerEmail !== selfEmail ? '&owner=' + encodeURIComponent(ownerEmail) : '');
    const failingStep = (stepsSummary.find((s) => !s.ok) || { step: result.error || 'unknown' });
    const text = ':warning: Baseline sync failed — ' + (loan.address || body.loanId);
    const message = {
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: '*Baseline sync failed*\n*Loan:* ' + (loan.address || body.loanId) +
                '\n*Owner:* ' + ownerEmail +
                '\n*Failing step:* `' + failingStep.step + '`' +
                (failingStep.error ? '\n*Error:* ' + failingStep.error : '') +
                (failingStep.status ? ' (HTTP ' + failingStep.status + ')' : '') +
                '\n*Triggered by:* ' + selfEmail +
                '\n<' + loanLink + '|Open loan details>',
        }},
      ],
    };
    // Don't await — alert shouldn't slow the response.
    postSlack(message).catch((e) => console.warn('Slack alert failed (silently):', e && e.message));
  }

  return json(200, { ...result, loanStatus: summaryStatus });
};
