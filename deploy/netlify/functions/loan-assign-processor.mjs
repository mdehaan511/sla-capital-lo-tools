/**
 * loan-assign-processor.mjs — POST /api/loan-assign-processor
 *
 * Deploy 236.559 — processing-team rollout, slice 1b. Assigns (or unassigns) a
 * PROCESSOR to a loan so the team can pull/distribute work on the Processing
 * Pipeline. Mirrors loan-processing-stage's auth + strict-write pattern.
 *
 * Body:
 *   { clientId, loanId, owner?, processorEmail, processorName }  → assign
 *   { clientId, loanId, owner?, unassign: true }                 → clear
 *
 * Auth: any authenticated staff member; cross-owner (a processor acting on
 * another LO's loan — the normal case) requires admin OR processor via
 * canOverrideOwner (Deploy 236.266). Writes the whole client via the PG-first
 * strict writeClient — no fire-and-forget (strict-write discipline).
 *
 * Stores loan.assignedProcessor = { email, name, at, by }.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-assign-processor error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId, loanId = body.loanId;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  // Resolve owner. A processor working another LO's loan passes owner=<LO>;
  // canOverrideOwner allows admin OR processor. Otherwise it's own-owner only.
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = client.loans[idx];

  const now = new Date().toISOString();
  if (body.unassign === true || !body.processorEmail) {
    delete loan.assignedProcessor;
  } else {
    const email = normalizeEmail(body.processorEmail);
    const name  = String(body.processorName || '').trim() || email;
    loan.assignedProcessor = { email, name, at: now, by: selfEmail };
  }
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, assignedProcessor: loan.assignedProcessor || null });
}
