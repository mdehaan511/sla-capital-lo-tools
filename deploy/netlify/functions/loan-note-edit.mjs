/**
 * loan-note-edit.mjs — POST /api/loan-note-edit
 *
 * Deploy 236.818 — notes on a loan can be EDITED (Mike). Scope:
 *   - Only free-form notes (kind 'manual') are editable. System/status/audit
 *     entries are the platform's record of what happened and stay immutable.
 *   - The note's author can edit their own note; processors/admins can edit
 *     any manual note (same staff gate as pinning).
 *   - Prior text is preserved on the entry's editHistory[] so the audit trail
 *     survives the edit; the UI shows an "(edited)" marker.
 *
 * Body: { clientId, loanId, owner?, noteId, text }
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
    console.error('loan-note-edit error:', e);
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
  const clientId = body.clientId, loanId = body.loanId, noteId = body.noteId;
  const newText = String(body.text == null ? '' : body.text).trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (!noteId)   return json(400, { error: 'noteId required' });
  if (!newText)  return json(400, { error: 'Note text cannot be empty' });
  if (newText.length > 20000) return json(400, { error: 'Note too long' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  const isStaff   = canOverrideOwner(user).ok;
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    // Editing a note on another LO's loan requires the staff gate.
    if (!isStaff) return json(403, { error: 'Owner override requires admin/processor' });
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

  const loan = (client.loans || []).find((l) => l && l.id === loanId);
  if (!loan) return json(404, { error: 'Loan not found on client' });
  if (!Array.isArray(loan.notesLog)) return json(404, { error: 'Note not found' });

  const note = loan.notesLog.find((n) => n && n.id === noteId);
  if (!note) return json(404, { error: 'Note not found' });

  // Only free-form notes are editable — everything else is the platform's
  // immutable record of events (status flips, reprices, system entries).
  const kind = String(note.kind || 'manual');
  if (kind !== 'manual') {
    return json(400, { error: 'Only free-form notes can be edited — this is a ' + kind + ' entry.' });
  }
  // Author OR staff.
  const authorEmail = normalizeEmail(note.authorEmail || '');
  if (!isStaff && authorEmail && authorEmail !== selfEmail) {
    return json(403, { error: 'Only the note author or a processor/admin can edit this note' });
  }
  if (String(note.text || '').trim() === newText) {
    return json(200, { ok: true, noteId, unchanged: true });
  }

  const now = new Date().toISOString();
  if (!Array.isArray(note.editHistory)) note.editHistory = [];
  note.editHistory.push({ ts: note.editedAt || note.ts || '', text: String(note.text || ''), by: note.editedBy || authorEmail });
  note.text = newText;
  note.editedAt = now;
  note.editedBy = selfEmail;
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, noteId, text: newText, editedAt: now, editedBy: selfEmail });
}
