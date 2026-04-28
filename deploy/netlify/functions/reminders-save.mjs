/**
 * reminders-save.mjs — POST /api/reminders-save
 *
 * Upsert a reminder. Body: full reminder object (must include loanId).
 * One active reminder per loan: if a non-completed reminder already exists
 * for the same loanId, it's replaced. The id stays stable across edits so
 * the in-app notification dropdown doesn't flicker.
 *
 * Body fields (all required unless marked):
 *   loanId, clientId?, address?, borrower?, note, dueDate (YYYY-MM-DD),
 *   completed? (default false)
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.loanId) return json(400, { error: 'loanId required' });
  if (!body.note || !String(body.note).trim()) return json(400, { error: 'note required' });
  if (!body.dueDate) return json(400, { error: 'dueDate required' });

  // Owner: default to current user. Admins may override via _owner.
  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'reminders', consistency: 'strong' });

  // One-per-loan: scan existing for a match on loanId, reuse its id and key
  let existingId = null;
  try {
    const { blobs } = await store.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const r = await store.get(key, { type: 'json' });
      if (r && r.loanId === body.loanId && !r.completed) {
        existingId = r.id;
        break;
      }
    }
  } catch (e) { console.warn('reminders-save existing-scan failed:', e); }

  const id = existingId || body.id || ('r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6));
  const now = new Date().toISOString();
  const record = {
    id,
    loanId: body.loanId,
    clientId: body.clientId || '',
    ownerKey,
    address: body.address || '',
    borrower: body.borrower || '',
    note: String(body.note).trim().slice(0, 500),
    dueDate: String(body.dueDate),
    completed: !!body.completed,
    createdAt: body.createdAt || now,
    updatedAt: now,
    completedAt: body.completed ? (body.completedAt || now) : null,
    createdBy: body.createdBy || user.email || '',
  };

  const key = `${ownerKey}/${keySafe(id)}`;
  try {
    await store.setJSON(key, record);
    return json(200, { ok: true, reminder: record });
  } catch (e) {
    console.error('reminders-save error:', e);
    return json(500, { error: 'Failed to save reminder' });
  }
};
