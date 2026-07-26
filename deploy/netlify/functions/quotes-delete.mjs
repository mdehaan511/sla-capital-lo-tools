/**
 * quotes-delete.mjs — POST /api/quotes-delete
 * Body: { quoteId, _owner? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { quotesIndex } from './_shared/quotes-index.mjs'; // Deploy 236.428

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.quoteId) return json(400, { error: 'quoteId required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);

  // Deploy 236.428: q_ln_ ids are synthetic — loan rows projected into
  // quote shape by quotes-list (D2). There is no store record to
  // delete; the deal IS the loan. Pipeline bulk-delete handles the
  // loan deletion on its own separate path, so a clear error here
  // beats a confusing 404.
  if (/^q_ln_/.test(String(body.quoteId))) {
    return json(400, { error: 'This card is a loan, not a saved draft. Delete or cancel the loan from Loan Details.' });
  }

  const store = getStore({ name: 'quotes', consistency: 'strong' });
  const ownerKey = keySafe(owner);
  const key = `${ownerKey}/${keySafe(body.quoteId)}`;

  try {
    const existing = await store.get(key, { type: 'json' });
    if (!existing) {
      // Deploy 236.428: idempotent delete + ghost self-heal. Deletes
      // before this deploy removed the blob but never the quotes-index
      // entry, and the D2 orphan merge renders index entries whose
      // loanId is unknown — so an already-deleted draft could live on
      // as an undeletable ghost tile (404 forever). Clean the index
      // entry and report success: retrying the delete on a ghost now
      // erases it for good.
      await quotesIndex.removeRecord(ownerKey, body.quoteId);
      return json(200, { ok: true, deleted: body.quoteId, alreadyGone: true });
    }
    if (!isAdmin(user) && existing.createdBy && normalizeEmail(existing.createdBy) !== owner) {
      return json(403, { error: 'Not authorized' });
    }
    await store.delete(key);
    // Deploy 236.428: keep the index in step with the store — the
    // missing half of 236.343 (save got upsertRecord, delete got
    // nothing). removeRecord never throws; it warns and moves on.
    await quotesIndex.removeRecord(ownerKey, body.quoteId);
    return json(200, { ok: true, deleted: body.quoteId });
  } catch (e) {
    console.error('quotes-delete error:', e);
    return json(500, { error: 'Failed to delete' });
  }
};
