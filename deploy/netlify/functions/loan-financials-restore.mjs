/**
 * loan-financials-restore.mjs — POST /api/loan-financials-restore
 *
 * Deploy 236.124 — restore the snapshotted original financial
 * values captured by loan-financials-edit. Copies each entry of
 * loan._originalValues back into the main field (and formData
 * mirror), wipes the snapshot + modified-fields tracking, and
 * re-stamps the stale-docs flag (because restoring back to the
 * original ALSO differs from whatever was last signed under the
 * edited values).
 *
 * Body: { clientId, loanId, owner? }
 * Response: { ok: true, loan, restored: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') }); }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId;
  const loanId   = body.loanId;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

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
  const clientKey = ownerKey + '/' + keySafe(clientId);
  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) return json(404, { error: 'Client has no loans array' });

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });

  const loan = client.loans[idx];
  const snapshot = loan._originalValues || {};
  const restored = Object.keys(snapshot);
  if (!restored.length) {
    return json(200, { ok: true, loan, restored: [], note: 'no snapshot to restore' });
  }

  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  const now = new Date().toISOString();

  const rows = [];
  loan.formData = loan.formData || {};
  for (const key of restored) {
    const from = loan[key];
    const to   = snapshot[key];
    loan[key] = to;
    loan.formData[key] = to;
    rows.push({ key, from, to });
  }
  delete loan._originalValues;
  loan._modifiedFields = [];
  // Mark docs stale again — restoring still moves values relative
  // to whatever was last signed under the modified state.
  loan._signedDocsStale = {
    at:     now,
    by:     user.email || '',
    byName: authorName,
    fields: restored,
    reason: 'financials_restored',
  };
  // Deploy 236.219 — invalidate the pricing snapshot on restore too.
  // Restoring is a data change and the next sizer open should
  // synthesize a fresh snapshot from the reverted loan record.
  if (loan.pricingSnapshot) delete loan.pricingSnapshot;
  if (loan.formData && loan.formData._pricingSnapshot) delete loan.formData._pricingSnapshot;
  loan.updatedAt = now;

  appendNoteEntry(loan, {
    kind:        'financials_restore',
    text:        'Loan financials restored to original (calculator-generated) values for: ' +
                 restored.join(', '),
    author:      authorName,
    authorEmail: user.email || '',
    meta:        { restored: rows },
  });

  client.loans[idx] = loan;
  client.updatedAt = now;

  try { await clientsStore.setJSON(clientKey, client); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, loan, restored });
}
