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
 *   { clientId, loanId, owner?, hold: true }   → status → 'on_hold'
 *   { clientId, loanId, owner?, hold: false }  → status → prior status (or 'approved')
 *
 * Strict PG-first writeClient (no fire-and-forget). Mirrors loan-assign-processor.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

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

  const now = new Date().toISOString();
  const priorStatus = String(loan.status || '');

  if (hold) {
    if (priorStatus === 'on_hold') return json(200, { ok: true, status: 'on_hold', noChange: true });
    // Remember what to restore to (default 'approved' = In Processing).
    loan._holdFromStatus = priorStatus || 'approved';
    loan.status = 'on_hold';
    loan._heldAt = now;
    loan._heldBy = selfEmail;
  } else {
    if (priorStatus !== 'on_hold') return json(200, { ok: true, status: priorStatus, noChange: true });
    loan.status = loan._holdFromStatus || 'approved';
    delete loan._holdFromStatus;
    loan._resumedAt = now;
    loan._resumedBy = selfEmail;
  }
  loan.updatedAt = now;

  const meta = (user && user.user_metadata) || {};
  appendNoteEntry(loan, {
    kind: 'status',
    text: hold
      ? ('Status ' + (priorStatus || '(none)') + ' → on_hold (On Hold via Processing Pipeline)')
      : ('Status on_hold → ' + loan.status + ' (resumed via Processing Pipeline)'),
    author:      meta.full_name || meta.fullName || user.email || '',
    authorEmail: user.email || '',
    meta: { from: priorStatus, to: loan.status, via: 'processing_hold' },
  });

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, status: loan.status });
}
