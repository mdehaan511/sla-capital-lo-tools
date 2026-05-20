/**
 * loan-update-from-sizer.mjs — POST /api/loan-update-from-sizer
 *
 * Deploy 192: bypass the brittle email-then-address matching in
 * Clients.upsert when the sizer has a known (clientId, loanId). Direct
 * ID-based update: read the client record, find the loan by ID,
 * Object.assign the incoming loanData, save.
 *
 * Used by both DSCR and RTL sizers when window._editingLoanId AND
 * window._editingClientId are set (i.e. the LO opened an existing
 * loan to edit, not a brand-new quote). New quotes still go through
 * the legacy upsert path so the client + loan get auto-created.
 *
 * Body:
 *   {
 *     clientId: 'c_...',
 *     loanId: 'l_...',
 *     loanData: { ... merged loan record from buildLoanFromSizer ... },
 *     owner?: 'other@lo.com'  (admin cross-LO override)
 *   }
 *
 * Response: { ok: true, loan: <updated loan record> }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-update-from-sizer top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (!body.clientId) return json(400, { error: 'clientId required' });
  if (!body.loanId)   return json(400, { error: 'loanId required' });
  if (!body.loanData || typeof body.loanData !== 'object') {
    return json(400, { error: 'loanData required' });
  }

  // Resolve owner key. Admin cross-LO override allowed.
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(body.clientId);

  let client;
  try {
    client = await clientsStore.get(clientKey, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to read client record: ' + (e.message || 'unknown') });
  }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === body.loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client. clientId=' + body.clientId + ' loanId=' + body.loanId });

  const prior = client.loans[idx];
  const incoming = body.loanData;

  // Merge: spread incoming, then preserve specific server-side fields
  // that the sizer should never overwrite. Don\u2019t let the sizer
  // change the loan\u2019s id/createdAt/createdBy. Preserve LO-edited
  // app-section fields (so a re-size doesn\u2019t wipe them).
  const now = new Date().toISOString();
  const merged = Object.assign({}, incoming, {
    id: prior.id,
    createdAt: prior.createdAt || incoming.createdAt || now,
    updatedAt: now,
    // Preserve loan amount when LO has locked it (manual override on
    // Loan Details). If not locked, take the incoming value.
    loanAmt:       prior.loanAmtLocked ? prior.loanAmt : incoming.loanAmt,
    loanAmtLocked: prior.loanAmtLocked || false,
    // Preserve LO-edited app-section fields if the sizer didn\u2019t
    // explicitly set them this round.
    bedrooms:    incoming.bedrooms    || prior.bedrooms,
    bathrooms:   incoming.bathrooms   || prior.bathrooms,
    sqft:        incoming.sqft        || prior.sqft,
    projectDescription: incoming.projectDescription || prior.projectDescription || '',
    notes:       incoming.notes       || prior.notes || '',
    // Preserve status: a save shouldn\u2019t demote a Submitted loan back
    // to Active. If the sizer doesn\u2019t explicitly send a status, keep
    // the prior status. If it does, only accept if prior was active.
    status: (prior.status && prior.status !== 'active' && prior.status !== 'on_hold')
      ? prior.status
      : (incoming.status || prior.status || 'active'),
  });

  // Strip transient meta fields that shouldn\u2019t persist.
  delete merged._editingLoanId;
  delete merged._editingClientId;

  client.loans[idx] = merged;
  client.updatedAt = now;

  try {
    await clientsStore.setJSON(clientKey, client);
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  return json(200, { ok: true, loan: merged, clientId: client.id });
}
