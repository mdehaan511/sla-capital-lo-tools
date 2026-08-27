/**
 * loan-set-disposition.mjs — POST /api/loan-set-disposition
 *
 * Deploy 236.611 — servicing tracking. Sets a closed loan's servicing
 * DISPOSITION so staff can move it between the Closed Loans buckets:
 *   post_close | servicing | pending_sale | sold | paid_off
 * Deploy 236.624 — added post_close (freshly-closed loans land here until
 * staff "Close Out"; that action moves them to pending_sale).
 *
 * Body: { clientId, loanId, owner?, disposition }
 *
 * Auth: staff only (admin OR processor via canOverrideOwner — servicing is a
 * back-office function). Writes the whole client via the PG-first strict
 * writeClient (strict-write discipline — no fire-and-forget). Stores
 * loan.disposition (+ dispositionAt / dispositionBy for audit). dispositionOf()
 * on the Closed Loans page treats this manual value as the source of truth,
 * overriding the baselineStatus-derived default.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';

const VALID = { post_close: 1, servicing: 1, pending_sale: 1, sold: 1, paid_off: 1 };

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-set-disposition error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  // Servicing is back-office — admin OR processor only. canOverrideOwner.ok is
  // exactly that check (admin || processor), and it's what the Closed Loans page
  // gates itself on.
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId, loanId = body.loanId;
  const disposition = String(body.disposition || '').toLowerCase().trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (!VALID[disposition]) return json(400, { error: 'Invalid disposition' });

  // Resolve owner (byOwner keys are the LO email; keySafe leaves emails intact).
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
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
  const _alBefore = Object.assign({}, loan);  // Deploy 236.773 — audit-log snapshot

  const now = new Date().toISOString();
  loan.disposition   = disposition;
  loan.dispositionAt = now;
  loan.dispositionBy = selfEmail;
  loan.updatedAt     = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  // Deploy 236.773 — audit log (best-effort; must never fail the save).
  try {
    const _alActor = normalizeEmail(user.email);
    await recordLoanChanges({
      ownerKey, clientId: clientId, loanId: loanId,
      actor: _alActor, actorName: user.name || _alActor,
      source: 'Disposition', changes: diffLoan(_alBefore, loan),
    });
  } catch (e) { console.warn('loan-set-disposition: change log failed (non-fatal):', e && e.message); }

  return json(200, { ok: true, disposition: loan.disposition });
}
