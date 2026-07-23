/**
 * brokers-delete.mjs — POST /api/brokers-delete
 *
 * Deploy 236.224 (Broker Phase A). "Delete broker" now clears the
 * `_isBroker` flag on the unified client record — turning the broker
 * back into a plain contact rather than nuking data. If the client
 * has never had any loans linked and only exists as a broker record
 * (rare), the entry is fully removed. Also cleans up the legacy
 * brokers store entry for the same id.
 *
 * Body: { id, _owner? }
 * Returns: { ok, mode: 'untagged' | 'deleted' }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write (kept for deleteClientStrict)
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.id) return json(400, { error: 'id required' });

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const legacyStore  = getStore({ name: 'brokers', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(body.id);

  try {
    const existing = await clientsStore.get(key, { type: 'json' }).catch(() => null);
    let mode = 'untagged';
    if (existing) {
      const hasLoans = Array.isArray(existing.loans) && existing.loans.length > 0;
      // Purely-broker-shaped record with no loan history → safe to
      // delete outright. Otherwise keep it as a contact by clearing
      // the broker flag.
      const looksBrokerOnly = existing._isBroker && !hasLoans && !existing.firstName && !existing.lastName;
      if (looksBrokerOnly) {
        await clientsStore.delete(key);
        await pgMirror.deleteClientStrict(body.id);
        mode = 'deleted';
      } else {
        delete existing._isBroker;
        delete existing._brokerCompany;
        existing.updatedAt = new Date().toISOString();
        // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
        await writeClient(ownerKey, existing, { clientsStore });
      }
    }
    // Clean up any lingering legacy broker record too.
    try { await legacyStore.delete(key); } catch (_) {}
    return json(200, { ok: true, mode });
  } catch (e) {
    console.error('brokers-delete error:', e);
    return json(500, { error: 'Failed to delete broker' });
  }
};
