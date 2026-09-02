/**
 * clients-delete.js — POST /api/clients-delete
 *
 * Body options:
 *   { clientId }                   → delete entire client record
 *   { clientId, loanId }           → delete a single loan from a client
 *   { clientId, _owner }           → admin: target another LO's client
 */
import { getStore } from '@netlify/blobs';
// Deploy 236.417 (C3 deletion slice) — clients-index write-through
// retired; see _shared/client-write.mjs for the rationale.
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write
import { deleteQuotesForLoan } from './_shared/quote-sync.mjs'; // Deploy 236.790
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
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
      // Deploy 236.417 (C3 deletion slice): clients-index write-through
      // retired — see _shared/client-write.mjs.
      await pgMirror.upsertClientWithLoansStrict(ownerKey, existing);
      // Deploy 236.791 (Mike) — explicitly DELETE the loan's Postgres row, awaited.
      // upsertClientWithLoans does prune rows that vanished from client.loans, but
      // it fires those deletes without awaiting them — and Lambda freezes the
      // container the moment we respond, so the delete often never ran. The row
      // survived, and quotes-list (which reads the PG loans table) kept
      // synthesizing a `q_ln_<loanId>` tile for it — a deleted loan still sitting
      // in the Pipeline as an orphan card.
      await pgMirror.deleteLoanStrict(body.loanId);
      // Deploy 236.790 (Mike) — ALSO purge the loan's quotes. Without this the
      // quote entries survived the delete and the Pipeline kept drawing them as
      // "Loan record missing" orphans — one deleted loan showed up three times
      // (q_<tool>_, q_ln_ and syn_ all reference the same loanId). The delete
      // confirm has always promised "any saved quote will be deleted"; now it is.
      let quotesDeleted = 0;
      try {
        const qres = await deleteQuotesForLoan(ownerKey, body.loanId);
        quotesDeleted = qres.deleted;
      } catch (e) {
        console.warn('clients-delete: quote purge failed (loan already deleted):', e && e.message);
      }
      return json(200, { ok: true, client: existing, quotesDeleted });
    }

    // Deploy 236.790 — deleting the WHOLE client orphans every one of its loans'
    // quotes the same way, so purge them all before the client goes.
    try {
      for (const l of (existing.loans || [])) {
        if (l && l.id) await deleteQuotesForLoan(ownerKey, l.id);
      }
    } catch (e) {
      console.warn('clients-delete: quote purge (full client) failed:', e && e.message);
    }

    // Otherwise delete the whole client
    await store.delete(key);
    // (236.417: index removeClient retired with the write-through.)
    await pgMirror.deleteClientStrict(body.clientId);
    return json(200, { ok: true, deleted: body.clientId });
  } catch (e) {
    console.error('clients-delete error:', e);
    return json(500, { error: 'Failed to delete' });
  }
};
