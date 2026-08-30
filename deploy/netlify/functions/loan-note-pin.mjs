/**
 * loan-note-pin.mjs — POST /api/loan-note-pin
 *
 * Deploy 236.800 — processors can PIN a note to the top of the Notes &
 * Activity section on Loan Details (and unpin it). Pinned entries render
 * above the chronological feed regardless of the note filter, so a
 * "read this first" instruction survives the stream of status entries.
 *
 * Sets/clears `pinned` + `pinnedAt` + `pinnedBy` on the notesLog entry.
 * Multiple notes may be pinned (most recently pinned first).
 *
 * Body: { clientId, loanId, owner?, noteId, pinned: true|false }
 * Auth: processor/admin (canOverrideOwner — same staff gate as the other
 * processing surfaces).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-note-pin error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId, loanId = body.loanId, noteId = body.noteId;
  const pinned = !!body.pinned;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (!noteId)   return json(400, { error: 'noteId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
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

  const loan = client.loans.find((l) => l && l.id === loanId);
  if (!loan) return json(404, { error: 'Loan not found on client' });
  if (!Array.isArray(loan.notesLog)) return json(404, { error: 'Note not found' });

  const note = loan.notesLog.find((n) => n && n.id === noteId);
  if (!note) return json(404, { error: 'Note not found' });

  const now = new Date().toISOString();
  if (pinned) {
    note.pinned = true;
    note.pinnedAt = now;
    note.pinnedBy = selfEmail;
  } else {
    delete note.pinned;
    delete note.pinnedAt;
    delete note.pinnedBy;
  }
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, noteId: noteId, pinned: pinned });
}
