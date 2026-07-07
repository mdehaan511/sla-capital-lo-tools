/**
 * clients-bulk-delete.mjs — POST /api/clients-bulk-delete
 *
 * Deploy 236.230 — bulk delete for the Clients page. Body:
 *   { clientIds: [id1, id2, ...], owner? }
 *
 * Each client under the owner is deleted, plus its associated
 * borrower_info + signed_applications entries. Loans in the client
 * record die with it (they're nested inside the client). Quotes /
 * loan_reviews / loan_access grants tied by loanId are left in place
 * — they'd be orphaned but harmless, and cleaning them up would slow
 * a bulk delete considerably. A future sweep endpoint can prune them.
 *
 * Response: { ok, deleted: [{clientId, ok, error?}, ...] }
 * Auth: LO owns the clients (or admin owner-override).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('clients-bulk-delete error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  const ids = Array.isArray(body.clientIds) ? body.clientIds.filter(Boolean) : [];
  if (!ids.length) return json(400, { error: 'clientIds required' });
  if (ids.length > 200) return json(413, { error: 'Max 200 per call' });

  let owner = normalizeEmail(user.email);
  if (body.owner && body.owner !== owner) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    owner = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(owner);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const biStore      = getStore({ name: 'borrower_info', consistency: 'strong' });
  const appStore     = getStore({ name: 'signed_applications', consistency: 'strong' });

  const deleted = [];
  for (const id of ids) {
    const cid = String(id).trim();
    const key = ownerKey + '/' + keySafe(cid);
    try {
      const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!client) { deleted.push({ clientId: cid, ok: false, error: 'not_found' }); continue; }
      // Clean up per-loan borrower_info + signed_applications entries.
      if (Array.isArray(client.loans)) {
        for (const l of client.loans) {
          if (!l || !l.id) continue;
          try { await biStore.delete(ownerKey + '/' + keySafe(cid) + '/' + keySafe(l.id)); } catch (_) {}
          try { await biStore.delete(ownerKey + '/' + keySafe(cid)); } catch (_) {}
          try { await appStore.delete(ownerKey + '/' + keySafe(cid) + '/' + keySafe(l.id)); } catch (_) {}
        }
      }
      await clientsStore.delete(key);
      deleted.push({ clientId: cid, ok: true, loanCount: (client.loans || []).length });
    } catch (e) {
      deleted.push({ clientId: cid, ok: false, error: (e && e.message) || 'unknown' });
    }
  }

  return json(200, { ok: true, deleted });
}
