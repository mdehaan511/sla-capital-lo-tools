/**
 * brokers-migrate-to-clients.mjs — POST /api/brokers-migrate-to-clients
 *
 * Deploy 236.224 — Broker Phase A one-shot migration. Walks the
 * legacy `brokers` blob store and sweeps every broker into `clients`
 * with `_isBroker: true`:
 *
 *   1. If a client with the same email already exists under the same
 *      owner → gap-fill broker fields onto that client + stamp
 *      _isBroker.
 *   2. Otherwise create a new client under the owner using the same id
 *      the broker record had (so any loan.brokerId reference keeps
 *      resolving).
 *
 * Dry-run default (as with every 236.x migration endpoint).
 *
 * Body: { dryRun?: boolean (default TRUE), deleteBrokerRecords?: boolean }
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe,
} from './_shared/auth.mjs';
import { brokerToClient, mergeBrokerIntoClient } from './_shared/broker-client.mjs';

const READ_CONCURRENCY = 10;
const WRITE_CONCURRENCY = 10;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('brokers-migrate-to-clients error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;
  const deleteBrokerRecords = body.deleteBrokerRecords === true;

  const brokersStore = getStore({ name: 'brokers', consistency: 'strong' });
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // ── 1. Walk brokers store ────────────────────────────────────
  let brokerBlobs;
  try { brokerBlobs = (await brokersStore.list()).blobs || []; }
  catch (e) { return json(500, { error: 'brokers store list failed: ' + (e && e.message) }); }

  const brokerRecords = []; // { key, ownerKey, brokerId, broker }
  for (let i = 0; i < brokerBlobs.length; i += READ_CONCURRENCY) {
    const chunk = brokerBlobs.slice(i, i + READ_CONCURRENCY);
    const results = await Promise.all(chunk.map(async ({ key }) => {
      const slash = key.indexOf('/');
      if (slash < 0) return null;
      const ownerKey = key.slice(0, slash);
      const brokerId = key.slice(slash + 1);
      const rec = await brokersStore.get(key, { type: 'json' }).catch(() => null);
      return rec ? { key, ownerKey, brokerId, broker: rec } : null;
    }));
    for (const r of results) if (r) brokerRecords.push(r);
  }

  // ── 2. For each broker: match/create the client ──────────────
  let matchedExisting = 0;
  let createdNew = 0;
  let deletedBrokerRecords = 0;
  const samples = [];
  const errors = [];

  for (const rec of brokerRecords) {
    try {
      const owner   = rec.ownerKey;
      const brokerId = rec.brokerId;
      const broker  = rec.broker;
      const email   = String(broker.email || '').toLowerCase().trim();

      // Prefer: existing client under this owner whose id matches
      // brokerId (deterministic upgrade path). Fall back to email
      // match if the ids differ.
      const idKey = owner + '/' + brokerId;
      let existingClient = await clientsStore.get(idKey, { type: 'json' }).catch(() => null);
      let matchedByEmail = false;
      if (!existingClient && email) {
        // Walk this owner's clients looking for an email match.
        const { blobs: ownerBlobs } = await clientsStore.list({ prefix: owner + '/' });
        for (const { key } of ownerBlobs) {
          const c = await clientsStore.get(key, { type: 'json' }).catch(() => null);
          if (c && String(c.email || '').toLowerCase().trim() === email) {
            existingClient = c;
            matchedByEmail = true;
            break;
          }
        }
      }

      let action;
      let targetKey;
      let outClient;
      if (existingClient) {
        outClient = mergeBrokerIntoClient(existingClient, broker);
        targetKey = owner + '/' + keySafe(existingClient.id);
        matchedExisting++;
        action = matchedByEmail ? 'merged_by_email' : 'merged_by_id';
      } else {
        outClient = brokerToClient(broker);
        targetKey = owner + '/' + brokerId;
        createdNew++;
        action = 'created';
      }

      if (!dryRun) {
        await clientsStore.setJSON(targetKey, outClient);
        if (deleteBrokerRecords) {
          try { await brokersStore.delete(rec.key); deletedBrokerRecords++; }
          catch (_) { /* non-fatal */ }
        }
      }

      if (samples.length < 30) {
        samples.push({
          brokerId,
          ownerKey: owner,
          action,
          brokerName: broker.name || '',
          brokerCompany: broker.company || '',
          targetClientId: outClient.id,
        });
      }
    } catch (e) {
      errors.push({ key: rec.key, error: (e && e.message) || 'unknown' });
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    brokerRecordCount: brokerRecords.length,
    matchedExisting,
    createdNew,
    deletedBrokerRecords,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
    samples,
  });
}
