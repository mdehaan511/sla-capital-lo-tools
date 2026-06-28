/**
 * loan-field-edit.mjs — POST /api/loan-field-edit
 *
 * Deploy 236.98 (Phase B.1) — narrow, controlled field-by-field
 * editor for the loan record. Lives BESIDE loan-update-from-sizer
 * (which carries a 100+ field merge plus pricing-preservation logic)
 * so the simple "edit this one value" path doesn't have to inherit
 * that complexity or risk a regression in the sizer flow.
 *
 * Body:
 *   {
 *     clientId: 'c_...',
 *     loanId:   'l_...',
 *     fields:   { fundingDate: '2026-07-15', ... },
 *     owner?:   'other@lo.com'
 *   }
 *
 * Allowed field set is intentionally narrow and expanded only when a
 * Loan Details edit-in-place feature needs it. Anything not on the
 * list is silently dropped. ALL accepted fields write a notesLog
 * audit entry so the trail is visible on Loan Details.
 *
 * Response: { ok: true, loan: <updated loan record>, applied: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

// Whitelist of fields the Loan Details inline editors are allowed to
// set. Expand as the unification work in Phase B continues.
const FIELD_LABELS = {
  fundingDate: 'Close Date',
  // Phase B.2/B.3 add: rate, points, loanAmt, ltc, ltarv, custom fees.
};

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-field-edit top-level error:', e);
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

  const clientId = body.clientId;
  const loanId   = body.loanId;
  const fields   = body.fields && typeof body.fields === 'object' ? body.fields : null;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (!fields)   return json(400, { error: 'fields object required' });

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
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });

  const loan = client.loans[idx];
  const applied = [];
  const meta = (user && user.user_metadata) || {};
  const author = meta.full_name || meta.fullName || user.email || '';

  Object.keys(fields).forEach((rawKey) => {
    const key = String(rawKey || '').trim();
    if (!FIELD_LABELS[key]) return; // silently ignore unknown fields

    const newVal = fields[key];
    const oldVal = loan[key];
    // Coerce to string for comparison + storage. Empty string means
    // "clear the field". null/undefined are treated as empty too.
    const newStr = newVal == null ? '' : String(newVal);
    const oldStr = oldVal == null ? '' : String(oldVal);
    if (newStr === oldStr) return;

    loan[key] = newStr;
    applied.push({ key, label: FIELD_LABELS[key], from: oldStr, to: newStr });
  });

  if (applied.length === 0) {
    return json(200, { ok: true, loan, applied: [], note: 'No changes' });
  }

  loan.updatedAt = new Date().toISOString();
  const textParts = applied.map((c) =>
    c.label + ': ' + (c.from || '(blank)') + ' → ' + (c.to || '(blank)'));
  appendNoteEntry(loan, {
    kind:        'field_edit',
    text:        textParts.join('; '),
    author,
    authorEmail: user.email || '',
    meta:        { changes: applied },
  });

  client.loans[idx] = loan;
  client.updatedAt = new Date().toISOString();

  try { await clientsStore.setJSON(clientKey, client); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, loan, applied });
}
