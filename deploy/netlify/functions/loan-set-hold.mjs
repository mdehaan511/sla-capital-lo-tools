/**
 * loan-set-hold.mjs — POST /api/loan-set-hold
 *
 * Deploy 236.572 — put a loan On Hold (or take it off hold) from the Processing
 * Pipeline's drag drop-bar. On Hold is a loan STATUS, not a processing stage, so
 * it can't go through loan-processing-stage; and loan-advance-status only lets
 * ADMINS set on_hold. The pipeline is processor-accessible, so this narrow
 * endpoint lets any staff member (canOverrideOwner = admin OR processor) toggle
 * hold while preserving the loan's processingStage (so resuming restores its
 * column position).
 *
 * Body:
 *   { clientId, loanId, owner?, hold: true, reason, note?, resumeBy? }
 *                                              → status → 'on_hold' (+ _holdReason / _holdNote /
 *                                                _holdResumeBy; reason is one of HOLD_REASONS)
 *   { clientId, loanId, owner?, hold: false, newStage? }
 *                                              → status → prior status (or 'approved'); newStage
 *                                                (an active processing stage) moves the file in the
 *                                                same write, which is what a drop out of the On
 *                                                Hold column onto a stage column does
 *
 * Deploy 237.265 (Dee: "add a dedicated ON-HOLD column ... strictly for active files
 * temporarily paused due to specific, actionable roadblocks"; Mike: "ensure it doesn't become a
 * graveyard again") -- the reason + note + expected resume date ride on the loan so the column
 * can show them and processing-alerts can nag once a hold goes stale.
 *
 * Strict PG-first writeClient (no fire-and-forget). Mirrors loan-assign-processor.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

// Deploy 237.265 -- the reasons Dee named, plus Other. The label is stored beside the key
// so every reader (tile, Loan Details, the bell) prints the same words.
export const HOLD_REASONS = {
  borrower_doc: 'Waiting on a borrower document',
  third_party:  'Third-party delay (title, appraisal, insurance)',
  restructure:  'Restructure requested',
  other:        'Other',
};
const ACTIVE_STAGES = ['new_loan', 'processing', 'underwriting', 'pp_approved'];
const STAGE_LABELS  = { new_loan: 'Intake', processing: 'Processing', underwriting: 'Underwriting', pp_approved: 'Cleared to Close' };

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-set-hold error:', e);
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
  const clientId = body.clientId, loanId = body.loanId;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  const hold = body.hold !== false; // default = put on hold
  // Deploy 237.265 -- why, what exactly, and when it should come back.
  const reason   = String(body.reason || '').trim().toLowerCase();
  const note     = String(body.note || '').trim().slice(0, 300);
  const resumeBy = /^\d{4}-\d{2}-\d{2}$/.test(String(body.resumeBy || '')) ? String(body.resumeBy) : '';
  if (hold && !HOLD_REASONS[reason]) {
    return json(400, { error: 'A hold needs a reason: ' + Object.keys(HOLD_REASONS).join(', ') });
  }
  const newStage = String(body.newStage || '').trim().toLowerCase();
  if (!hold && newStage && ACTIVE_STAGES.indexOf(newStage) < 0) {
    return json(400, { error: 'newStage must be one of ' + ACTIVE_STAGES.join(', ') });
  }

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = client.loans[idx];
  const _alBefore = Object.assign({}, loan);  // Deploy 236.773 — audit-log snapshot

  const now = new Date().toISOString();
  const priorStatus = String(loan.status || '');

  if (hold) {
    if (priorStatus === 'on_hold') return json(200, { ok: true, status: 'on_hold', noChange: true });
    // Remember what to restore to (default 'approved' = In Processing).
    loan._holdFromStatus = priorStatus || 'approved';
    loan.status = 'on_hold';
    loan._heldAt = now;
    loan._heldBy = selfEmail;
    loan._holdReason      = reason;                // Deploy 237.265
    loan._holdReasonLabel = HOLD_REASONS[reason];
    loan._holdNote        = note;
    loan._holdResumeBy    = resumeBy;
  } else {
    if (priorStatus !== 'on_hold') return json(200, { ok: true, status: priorStatus, noChange: true });
    loan.status = loan._holdFromStatus || 'approved';
    delete loan._holdFromStatus;
    loan._resumedAt = now;
    loan._resumedBy = selfEmail;
    // Deploy 237.265 -- the hold's own fields go with it (the note below keeps the story)
    delete loan._holdReason; delete loan._holdReasonLabel; delete loan._holdNote; delete loan._holdResumeBy;
  }
  // Deploy 237.265 -- a drop out of On Hold onto a stage column resumes AND moves in one write.
  let stageNote = '';
  const priorStage = String(loan.processingStage || '').toLowerCase();
  if (!hold && newStage && newStage !== priorStage) {
    loan.processingStage = newStage;
    loan.processingStageAt = now;
    stageNote = ' and moved to ' + STAGE_LABELS[newStage];
  }
  const heldDays = (!hold && loan._heldAt) ? Math.max(0, Math.round((Date.now() - new Date(loan._heldAt).getTime()) / 86400000)) : null;
  loan.updatedAt = now;

  const meta = (user && user.user_metadata) || {};
  appendNoteEntry(loan, {
    kind: 'status',
    text: hold
      ? ('On Hold — ' + HOLD_REASONS[reason] + (note ? ': ' + note : '') + (resumeBy ? ' · expected to resume by ' + resumeBy : '') +
         ' (status ' + (priorStatus || '(none)') + ' → on_hold, via Processing Pipeline)')
      : ('Resumed from On Hold' + stageNote + (heldDays != null ? ' after ' + heldDays + ' day' + (heldDays === 1 ? '' : 's') : '') +
         ' (status on_hold → ' + loan.status + ', via Processing Pipeline)'),
    author:      meta.full_name || meta.fullName || user.email || '',
    authorEmail: user.email || '',
    meta: { from: priorStatus, to: loan.status, via: 'processing_hold', reason: hold ? reason : '', resumeBy: hold ? resumeBy : '', newStage: (!hold && newStage) ? newStage : '' },
  });

  // Deploy 237.102 (Mike) -- approved -> on_hold is a deliberate move by a processor/admin, but the
  // PG RPC's loans_no_demotion guard blocked it ("terminal status. Intentional moves must
  // pass allowDemotion"). Same escape hatch loan-advance-status / reinstate already use.
  try { await writeClient(ownerKey, client, { clientsStore, allowDemotion: true }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  // Deploy 236.773 — audit log (best-effort; must never fail the save).
  try {
    const _alActor = normalizeEmail(user.email);
    await recordLoanChanges({
      ownerKey, clientId: clientId, loanId: loanId,
      actor: _alActor, actorName: user.name || _alActor,
      source: 'Status', changes: diffLoan(_alBefore, loan),
    });
  } catch (e) { console.warn('loan-set-hold: change log failed (non-fatal):', e && e.message); }

  return json(200, {
    ok: true, status: loan.status,
    processingStage: loan.processingStage || '', // Deploy 237.265
    hold: hold ? { reason, label: HOLD_REASONS[reason], note, resumeBy, heldAt: loan._heldAt } : null,
  });
}
