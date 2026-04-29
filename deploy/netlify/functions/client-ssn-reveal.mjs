/**
 * client-ssn-reveal.mjs — POST /api/client-ssn-reveal
 *
 * LO-authed endpoint. Returns the decrypted SSN for a client record.
 * Body: { clientId, owner? }
 *
 * Audit-trail: each call is logged so we can investigate misuse later.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { decryptField } from './_shared/crypto.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('client-ssn-reveal error:', e);
    return json(500, { error: 'Server error' });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });

  let owner = normalizeEmail(user.email);
  if (body.owner && isAdmin(user)) owner = normalizeEmail(body.owner);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = `${ownerKey}/${body.clientId.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  let client = null;
  try { client = await store.get(clientKey, { type: 'json' }); } catch (_) {}
  if (!client) return json(404, { error: 'Client not found' });
  if (!client.ssn_enc) return json(404, { error: 'No SSN on file' });

  let ssn;
  try { ssn = decryptField(client.ssn_enc); }
  catch (e) { return json(500, { error: 'Decrypt failed' }); }

  // Audit trail (best-effort, non-blocking)
  console.log('[ssn-reveal] user=', user.email, 'clientId=', body.clientId, 'at=', new Date().toISOString());

  return json(200, { ssn });
}
