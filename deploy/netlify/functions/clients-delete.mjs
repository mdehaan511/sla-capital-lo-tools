/**
 * clients-delete.js — POST /api/clients-delete
 *
 * Body options:
 *   { clientId }                   → delete entire client record
 *   { clientId, loanId }           → delete a single loan from a client
 *   { clientId, _owner }           → admin: target another LO's client
 */
import { getStore } from '@netlify/blobs';
// Deploy 236.341 — write-through the clients-index blob.
import { upsertClient, upsertClientStrict, removeClient, removeClientStrict } from './_shared/clients-index.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write
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
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) {
    owner = normalizeEmail(body._owner);
  }

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(owner);
  const key = `${ownerKey}/${keySafe(body.clientId)}`;

  try {
    const existing = await store.get(key, { type: 'json' });
    if (!existing) return json(404, { error: 'Client not found' });

    // Ownership check: non-admins can only delete their own
    if (!isAdmin(user) && existing.createdBy && normalizeEmail(existing.createdBy) !== owner) {
      return json(403, { error: 'Not authorized' });
    }

    // Delete a single loan only
    if (body.loanId) {
      const before = (existing.loans || []).length;
      existing.loans = (existing.loans || []).filter((l) => l.id !== body.loanId);
      if (existing.loans.length === before) {
        return json(404, { error: 'Loan not found' });
      }
      existing.updatedAt = new Date().toISOString();
      await store.setJSON(key, existing);
      await upsertClientStrict(ownerKey, existing);
      await pgMirror.upsertClientWithLoansStrict(ownerKey, existing);
      return json(200, { ok: true, client: existing });
    }

    // Otherwise delete the whole client
    await store.delete(key);
    await removeClientStrict(ownerKey, body.clientId);
    await pgMirror.deleteClientStrict(body.clientId);
    return json(200, { ok: true, deleted: body.clientId });
  } catch (e) {
    console.error('clients-delete error:', e);
    return json(500, { error: 'Failed to delete' });
  }
};
