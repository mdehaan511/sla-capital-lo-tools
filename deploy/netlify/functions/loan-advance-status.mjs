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
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
import { upsertClient, upsertClientStrict } from './_shared/clients-index.mjs'; // Deploy 236.341
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write
// Deploy 222 (Phase 3) — auto-fire Baseline sync when the LO manually
// advances a loan to approved (the safety-valve path for when the
// borrower-info auto-advance silently bailed). Same helper as
// advanceQuoteToInProcessing uses.
import { syncOnApproval as _baselineSyncOnApproval } from './_shared/baseline-sync.mjs';
// Deploy 226 — auto-write a "status" entry to the loan's audit log.
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.311 — Slack notification when a loan advances to
// 'submitted'. Routed to the 'submitted' channel so it can land in a
// different Slack channel than the "new loan application" post.
import { postSlack } from './_shared/slack.mjs';

// Non-admin callers can only push to 'approved' — the existing safety-
// valve use case (loan got stuck in awaiting_app, manually nudge it
// into In Processing). Deploy 227 — admins / super-admins can move to
// any valid status from the Loan Details "Change Loan Status" panel.
const ALLOWED_TARGETS_NORMAL = ['approved'];
const ALLOWED_TARGETS_ADMIN  = ['active', 'on_hold', 'submitted', 'awaiting_app', 'approved', 'closed', 'denied', 'cancelled'];

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
  // Deploy 227 — admins can move to any status; non-admins only 'approved'.
  const allowed = isAdmin(user) ? ALLOWED_TARGETS_ADMIN : ALLOWED_TARGETS_NORMAL;
  if (!body.newStatus || allowed.indexOf(body.newStatus) < 0) {
    return json(400, { error: 'newStatus must be one of: ' + allowed.join(', ') });
  }

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
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
  // Deploy 236.96 (Phase A.3) — auto-flow into the Processing Pipeline
  // on manual advance to 'approved'. Same defensive guard as the
  // borrower-info-sync auto-advance path: only stamp if processingStage
  // is empty, so a processor who has already moved the loan forward
  // doesn't lose their column.
  if (body.newStatus === 'approved' && !targetLoan.processingStage) {
    targetLoan.processingStage = 'new_loan';
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
  await upsertClientStrict(ownerKey, client);
  // allowDemotion (Phase C4): this endpoint's moves are explicit user
  // actions and already role-gated above (admins may set any status,
  // including terminal → active). Without the flag the DB trigger
  // would reject those legitimate demotions.
  await pgMirror.upsertClientWithLoansStrict(ownerKey, client, { allowDemotion: true });

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
  // Deploy 236.41 — set of every loanId that exists on this client right
  // now. Used to detect quotes whose loanId is STALE (points at a loan
  // that no longer exists on the record). Same-address two-loan
  // contamination is still impossible: that case has two valid loanIds,
  // both in this set, so neither quote falls through to the address
  // fallback.
  const validLoanIds = new Set((client.loans || []).map((l) => l && l.id).filter(Boolean));

  try {
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q) continue;
      // Deploy 236.21 / 236.41 — loanId match with safe legacy +
      // stale-loanId fallback. Strict loanId-only (236.13) was too
      // aggressive: it missed (a) pre-Deploy-236.7 quotes which had no
      // loanId at all, and (b) quotes whose stored loanId was stamped
      // incorrectly or pointed at a loan that no longer exists.
      // Mike: changed a declined loan back to active, pipeline briefly
      // showed it then reverted to declined — root cause was the
      // matching quote had a stale loanId so this sync silently
      // skipped it. The quote stayed at 'denied' and pipeline
      // (reading quote.status) kept showing it as declined.
      const matchById         = q.loanId === body.loanId;
      const quoteLoanIdIsStale = q.loanId && !validLoanIds.has(q.loanId);
      const addrMatches        = aggrNorm(q.address || '') === targetAddr;
      const matchByLegacy     = (!q.loanId || quoteLoanIdIsStale) && addrMatches;
      if (!matchById && !matchByLegacy) continue;
      // Opportunistic loanId stamp (or refresh) so future transitions
      // hit the strict-loanId path directly.
      if (matchByLegacy) q.loanId = body.loanId;
      // Update — but don't downgrade. If the quote is already at a
      // "further along" status (e.g. closed), leave it alone.
      //
      // Deploy 236.66 (bug fix) — rank guard now ONLY applies to
      // non-admin callers (who can only target 'approved' anyway,
      // making the guard mostly a safety net against
      // re-advancing already-closed loans). Admins explicitly pick
      // the target status from the Move Status dropdown and need to
      // be able to send a loan to side-track statuses (on_hold,
      // denied, cancelled) which aren't in the linear rank map.
      // The original code treated on_hold / denied / cancelled as
      // rank 0 because they weren't in the map, so any move from a
      // higher rank silently skipped the quote-side sync — leaving
      // the loan record correctly on_hold but the quote stuck on the
      // prior status, which is what the pipeline reads from for
      // column placement.
      if (!isAdmin(user)) {
        const RANK = { active: 0, submitted: 1, awaiting_app: 2, approved: 3, closed: 4 };
        const currentRank = RANK[q.status] || 0;
        const newRank     = RANK[body.newStatus] || 0;
        if (newRank < currentRank) continue;
      }
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

  // Deploy 236.311 — fire a Slack notification when a loan enters the
  // Processing Pipeline via 'submitted'. Non-blocking: any failure is
  // logged, never propagated. Routed to channel 'submitted' so it can
  // land in a different Slack channel than new-application posts.
  if (body.newStatus === 'submitted') {
    try {
      await notifySubmitted(client, targetLoan, ownerKey, selfEmail, prevStatus);
    } catch (e) {
      console.warn('loan-advance-status: submitted-slack notify threw, ignoring:', e && e.message);
    }
  }

  return json(200, {
    success: true,
    prevStatus,
    newStatus: body.newStatus,
    quotesUpdated,
  });
}

// ─── Slack: new loan submitted for processing ───────────────────────
// Mirrors the tidy label:value block-per-section layout used by
// prospects-save.mjs's notifySlack for apply submissions, but scoped
// to what matters when a loan crosses into In Processing.
async function notifySubmitted(client, loan, ownerKey, submitterEmail, prevStatus) {
  const tag = `[submit-slack loan=${loan.id || '?'}]`;
  const fmtMoney = (v) => (v || v === 0) ? '$' + Number(v).toLocaleString() : '';
  const humanizeLocalpart = (email) => {
    const local = String(email || '').split('@')[0];
    return local.split(/[._-]+/).filter(Boolean)
      .map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  };
  async function loDisplay(loEmail) {
    if (!loEmail) return 'Unassigned';
    try {
      const profiles = getStore({ name: 'profiles', consistency: 'eventual' });
      const p = await profiles.get(keySafe(loEmail), { type: 'json' });
      if (p && p.fullName && String(p.fullName).trim()) return String(p.fullName).trim();
    } catch (_) { /* fall through */ }
    return humanizeLocalpart(loEmail) || loEmail;
  }
  const humanizeProduct = (code) => {
    const c = String(code || '').toLowerCase();
    if (c === 'dscr')          return 'DSCR';
    if (c === 'fix_flip')      return 'Fix & Flip';
    if (c === 'bridge')        return 'Bridge';
    if (c === 'transactional') return 'Transactional Funding';
    if (c === 'rtl')           return 'RTL (Bridge / Fix & Flip)';
    if (c === 'new_construction' || c === 'nc') return 'New Construction';
    return code || '';
  };

  const borrowerName = String(client.name || `${client.firstName || ''} ${client.lastName || ''}`).trim();
  const borrowerEmail = client.email || '';
  const brokerName = client._isBroker ? borrowerName : (loan.brokerName || client.brokerName || '');
  const brokerCompany = loan.brokerCompany || client.brokerCompany || '';
  const brokerEmail = loan.brokerEmail || client.brokerEmail || '';
  const isBroker = !!(client._isBroker || brokerName || brokerEmail);

  // The loan's owning LO — the person whose namespace this record
  // lives under, not necessarily the submitter (an admin can advance
  // another LO's loan).
  const ownerEmail = String(loan._owner || '').trim() ||
                     String(client.loEmail || '').trim() ||
                     ''; // we only have ownerKey (email keysafed) here;
                         // fall through to displaying the key.
  const ownerDisplay = await loDisplay(ownerEmail || ownerKey.replace(/-/g, '.'));
  const submittedByDisplay = submitterEmail
    ? (submitterEmail === ownerEmail ? '' : await loDisplay(submitterEmail))
    : '';

  const line = (label, value) => {
    const v = value == null ? '' : String(value).trim();
    if (!v) return null;
    return `${label}: ${v}`;
  };
  const filterLines = (arr) => arr.filter(l => l != null && l !== '');

  const title = 'New Loan Submitted for Processing:';

  // ── Section 1: contact ───────────────────────────────────────
  const contactLines = filterLines([
    isBroker ? line('Broker', brokerName) : null,
    isBroker ? line('Broker Company', brokerCompany) : null,
    isBroker ? line('Broker Email', brokerEmail) : null,
    borrowerName ? line('Borrower', borrowerName) : null,
    borrowerEmail ? line('Borrower Email', borrowerEmail) : null,
    line('Assigned Loan Officer', ownerDisplay),
    submittedByDisplay ? line('Submitted By', submittedByDisplay) : null,
  ]);

  // ── Section 2: deal details ───────────────────────────────────
  const dealLines = filterLines([
    line('Address',   loan.address),
    line('Loan Type', humanizeProduct(loan.loanType || loan.product)),
    line('Loan Amount', fmtMoney(loan.loanAmt || loan.loanAmount)),
    line('Rate',        loan.rate ? String(loan.rate) + '%' : ''),
    line('Term',        loan.term),
    line('Previous Status', prevStatus || '—'),
  ]);

  const _ownerParam = ownerEmail
    ? `&owner=${encodeURIComponent(ownerEmail)}`
    : '';
  const detailsLink = `https://portal.slacapital.ai/loan-details/${encodeURIComponent(loan.id)}?fresh=1${_ownerParam}`;

  const blocks = [];
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `*${title}*\n${contactLines.join('\n')}` },
  });
  if (dealLines.length) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*Deal Details:*\n${dealLines.join('\n')}` },
    });
  }
  blocks.push({
    type: 'section',
    text: { type: 'mrkdwn', text: `Link to Deal: <${detailsLink}|${detailsLink}>` },
  });

  const fallbackText = `${title} · ${loan.address || ''} · ${fmtMoney(loan.loanAmt || loan.loanAmount)} · owner ${ownerDisplay}`;
  console.log(`${tag} posting to slack — owner=${ownerEmail || ownerKey} submitter=${submitterEmail}`);
  const result = await postSlack({ text: fallbackText, blocks }, { channel: 'submitted' });
  if (result && result.skipped) {
    console.log(`${tag} skipped: ${result.reason}`);
  } else if (result && result.ok) {
    console.log(`${tag} delivered (${result.status})`);
  } else {
    console.warn(`${tag} failed:`, result && (result.error || result.status));
  }
}
