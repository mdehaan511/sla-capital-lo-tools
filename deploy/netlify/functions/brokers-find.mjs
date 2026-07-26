/**
 * brokers-find.mjs — GET /api/brokers-find?email=X
 *
 * Deploy 236.224 (Broker Phase A). Searches the unified clients store
 * for a broker-flagged record with the given email under the caller's
 * owner (admin can override with ?owner=). Falls back to the legacy
 * brokers store for un-migrated records.
 *
 * Response: { broker: <legacy-broker-shape record> | null }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { isBrokerClient, clientAsBroker } from './_shared/broker-client.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const email = String(url.searchParams.get('email') || '').toLowerCase().trim();
  if (!email) return json(400, { error: 'email required' });

  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  try {
    // Prefer unified clients store.
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' });
      if (!isBrokerClient(c)) continue;
      if (String(c.email || '').toLowerCase().trim() === email) {
        return json(200, { broker: clientAsBroker(c) });
      }
    }
    // Fallback: legacy brokers store.
    const legacyStore = getStore({ name: 'brokers', consistency: 'strong' });
    const { blobs: lb } = await legacyStore.list({ prefix: ownerKey + '/' });
    for (const { key } of lb) {
      const rec = await legacyStore.get(key, { type: 'json' });
      if (rec && String(rec.email || '').toLowerCase() === email) {
        return json(200, { broker: rec });
      }
    }
    return json(200, { broker: null });
  } catch (e) {
    console.error('brokers-find error:', e);
    return json(500, { error: 'Failed to search brokers' });
  }
};
