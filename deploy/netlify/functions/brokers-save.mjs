/**
 * brokers-save.mjs — POST /api/brokers-save
 *
 * Deploy 236.224 (Broker Phase A). Now writes to the unified `clients`
 * store with `_isBroker: true`. The response shape stays as the legacy
 * broker record so existing frontend (brokers.html, sizer autocomplete)
 * doesn't need to change.
 *
 * Body:
 *   {
 *     id?,        // existing broker/client id; omit to create
 *     name,       // required — split into firstName/lastName on write
 *     company?,
 *     email?,
 *     phone?,
 *     notes?,
 *     _owner?,    // admin-only cross-LO override
 *   }
 *
 * Returns: { ok: true, broker: <legacy-shape record> }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { splitBrokerName, clientAsBroker } from './_shared/broker-client.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !String(body.name || '').trim()) {
    return json(400, { error: 'name required' });
  }

  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) owner = normalizeEmail(body._owner);
  const ownerKey = keySafe(owner);

  const now = new Date().toISOString();
  const id = String(body.id || '').trim()
          || ('b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(id);
  const existing = await clientsStore.get(key, { type: 'json' }).catch(() => null);

  const { firstName, lastName } = splitBrokerName(body.name);
  const record = Object.assign({}, existing || {}, {
    id,
    firstName: existing && existing.firstName ? existing.firstName : firstName,
    lastName:  existing && existing.lastName  ? existing.lastName  : lastName,
    email:     String(body.email   || (existing && existing.email)   || '').toLowerCase().trim(),
    phone:     String(body.phone   || (existing && existing.phone)   || '').trim(),
    entityName: String(body.company || (existing && existing.entityName) || '').trim(),
    notes:     String(body.notes   || (existing && existing.notes)   || '').trim(),
    displayName: String(body.name || '').trim(),
    _isBroker: true,
    _brokerCompany: String(body.company || '').trim(),
    createdAt: (existing && existing.createdAt) || now,
    updatedAt: now,
    createdBy: (existing && existing.createdBy) || owner,
    loans:     (existing && Array.isArray(existing.loans))    ? existing.loans    : [],
    companies: (existing && Array.isArray(existing.companies)) ? existing.companies : [],
  });

  try {
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
    await writeClient(ownerKey, record, { clientsStore });
  } catch (e) {
    console.error('brokers-save error:', e);
    return json(500, { error: 'Failed to save broker' });
  }

  // Best-effort: if a legacy broker record still exists for this id,
  // delete it so we don't dual-list.
  try {
    const legacyStore = getStore({ name: 'brokers', consistency: 'strong' });
    await legacyStore.delete(key);
  } catch (_) { /* non-fatal */ }

  return json(200, { ok: true, broker: clientAsBroker(record) });
};
