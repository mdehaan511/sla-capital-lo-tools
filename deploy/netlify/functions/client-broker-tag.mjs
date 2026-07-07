/**
 * client-broker-tag.mjs — POST /api/client-broker-tag
 *
 * Deploy 236.226 — Broker Phase C. Tags or untags a client as a
 * broker by setting/clearing `_isBroker` on the client record. When
 * tagging, also stamps `_brokerCompany` from the client's entityName
 * so brokers.html renders the same "company" field it used to.
 *
 * Body: { clientId, isBroker: bool, owner?: string }
 * Returns: { ok: true, client }
 *
 * Auth: any authenticated user for their own clients; admin can pass
 * `owner` to tag on behalf of another LO.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('client-broker-tag error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  if (!body.clientId) return json(400, { error: 'clientId required' });
  if (typeof body.isBroker !== 'boolean') return json(400, { error: 'isBroker (bool) required' });

  let owner = normalizeEmail(user.email);
  if (body.owner && body.owner !== owner) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    owner = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(owner);
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(body.clientId);
  const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
  if (!client) return json(404, { error: 'Client not found' });

  const priorFlag = !!client._isBroker;
  const now = new Date().toISOString();
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';

  if (body.isBroker) {
    client._isBroker = true;
    if (!client._brokerCompany && client.entityName) {
      client._brokerCompany = client.entityName;
    }
    if (!priorFlag) {
      appendNoteEntry(client, {
        kind: 'status',
        text: 'Tagged as Broker. Now appears in the Broker Book.',
        author: authorName,
        authorEmail: user.email || '',
        meta: { via: 'client-broker-tag' },
      });
    }
  } else {
    delete client._isBroker;
    delete client._brokerCompany;
    if (priorFlag) {
      appendNoteEntry(client, {
        kind: 'status',
        text: 'Removed Broker tag. No longer in the Broker Book.',
        author: authorName,
        authorEmail: user.email || '',
        meta: { via: 'client-broker-tag' },
      });
    }
  }
  client.updatedAt = now;

  try { await clientsStore.setJSON(key, client); }
  catch (e) { return json(500, { error: 'Failed to save client: ' + (e && e.message) }); }

  return json(200, { ok: true, client });
}
