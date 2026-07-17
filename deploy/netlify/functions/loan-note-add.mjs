/**
 * loan-note-add.mjs — POST /api/loan-note-add
 *
 * Deploy 226 — appends a single entry to a loan's notesLog audit trail.
 * Used by the manual "Add Note" box on Loan Details, and by the
 * pipeline pre-discussed submit flow for the long-form details capture.
 *
 * Body: { clientId, loanId, text, kind?, meta?, owner? }
 *   - kind defaults to 'manual'
 *   - owner is admin-only override (route to another LO's record)
 *
 * Returns: { ok: true, entry, loan }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write

const ALLOWED_KINDS = new Set([
  'manual', 'submit', 'pre_discussed', 'reprice',
  'decision', 'decline', 'app_sent', 'app_received',
  'status', 'system',
]);

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-note-add error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Body required' });
  if (!body.clientId || !body.loanId) return json(400, { error: 'clientId and loanId required' });

  const text = String(body.text || '').trim();
  if (!text) return json(400, { error: 'text required' });
  if (text.length > 8000) return json(400, { error: 'text too long (max 8000 chars)' });

  const kind = body.kind || 'manual';
  if (!ALLOWED_KINDS.has(kind)) return json(400, { error: 'Invalid kind' });

  // Resolve owner — admin can override, otherwise it's the caller.
  let owner = normalizeEmail(user.email);
  if (body.owner && body.owner !== owner) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
    owner = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(owner);
  const key = `${ownerKey}/${keySafe(body.clientId)}`;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client;
  try {
    client = await clientsStore.get(key, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to load client' });
  }
  if (!client) return json(404, { error: 'Client not found' });

  const loans = Array.isArray(client.loans) ? client.loans : [];
  const idx = loans.findIndex((l) => l && l.id === body.loanId);
  if (idx < 0) return json(404, { error: 'Loan not found' });
  const loan = loans[idx];

  // Best-effort author display name from the Netlify Identity user metadata.
  const meta = (user && user.user_metadata) || {};
  const author = meta.full_name || meta.fullName || user.email || '';

  const entry = appendNoteEntry(loan, {
    kind,
    text,
    author,
    authorEmail: user.email || '',
    meta: body.meta && typeof body.meta === 'object' ? body.meta : undefined,
  });
  loan.updatedAt = new Date().toISOString();

  try {
    await clientsStore.setJSON(key, client);
  } catch (e) {
    return json(500, { error: 'Failed to save client' });
  }
  pgMirror.upsertClientWithLoans(owner, client).catch(() => {});

  return json(200, { ok: true, entry, loan });
}
