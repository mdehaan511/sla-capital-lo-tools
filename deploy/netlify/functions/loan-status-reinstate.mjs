/**
 * loan-status-reinstate.mjs — POST /api/loan-status-reinstate
 *
 * Deploy 236.770 — remove a DENIED or CANCELLED tag from a loan at any
 * point in the loan process (Mike: a nearly-closed loan was stuck
 * invisible on the Processing Pipeline behind a stale 'denied' status,
 * and nothing in the UI could clear it — decisions.html is read-only
 * and the decide flow demands a submission round-trip).
 *
 * The loan returns to:
 *   - 'approved' when it has a processingStage (it was handed off to
 *     processing — that's the status the handoff stamps), else
 *   - 'active'  (back to the Sales pipeline).
 *
 * This is a terminal→non-terminal move, which the PG trigger
 * trg_loans_no_demotion blocks by design — so the write passes
 * allowDemotion, the documented escape hatch for explicit
 * user-intended restores.
 *
 * Body: { clientId, loanId, owner? }
 * Auth: the loan's OWNER may reinstate their own; cross-owner requires
 * processor/admin (standard owner-override pattern).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

const REMOVABLE = ['denied', 'cancelled'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-status-reinstate error:', e);
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

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && normalizeEmail(body.owner) !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires processor or admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);
  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found' });
  if (!Array.isArray(client.loans)) client.loans = [];

  const loan = client.loans.find((l) => l && l.id === loanId);
  if (!loan) return json(404, { error: 'Loan not found on client' });

  const prev = String(loan.status || '').toLowerCase();
  if (!REMOVABLE.includes(prev)) {
    return json(400, { error: 'Loan is not denied or cancelled (status: ' + (loan.status || 'unset') + ')' });
  }

  const hasStage = !!String(loan.processingStage || '').trim();
  const next = hasStage ? 'approved' : 'active';
  const now = new Date().toISOString();
  loan.status = next;
  loan.updatedAt = now;
  appendNoteEntry(loan, {
    kind:        'status',
    text:        'Status: ' + prev + ' → ' + next + ' (the ' + prev + ' tag was removed / loan reinstated' +
                 (hasStage ? '; loan keeps its processing stage' : '') + ')',
    author:      selfEmail,
    authorEmail: selfEmail,
    meta:        { from: prev, to: next, via: 'loan-status-reinstate' },
  });

  // allowDemotion — terminal→non-terminal is exactly what the PG
  // no-demotion trigger exists to block on ACCIDENTAL writes; this is
  // the explicit, user-confirmed restore it carves out.
  try { await writeClient(ownerKey, client, { clientsStore, allowDemotion: true }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, from: prev, status: next, processingStage: loan.processingStage || '' });
}
