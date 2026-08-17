/**
 * loan-closing-save.mjs — POST /api/loan-closing-save
 *
 * Deploy 236.566 — processing-team rollout, owner follow-up #3: closing
 * coordination. Tracks the run-up to funding on a loan's Closing panel
 * (Loan Details, shown once the loan reaches Approved / Closed). Narrow,
 * per-action endpoint — one small write per checkbox/field so rapid toggles
 * never fight over a whole-client save.
 *
 * Body (one of):
 *   { clientId, loanId, owner?, step: <stepKey>, done: <bool> }   → toggle a
 *       milestone; the SERVER stamps at/by (never trust client timestamps).
 *   { clientId, loanId, owner?, fields: { titleCompany, titleContact,
 *       wireAmount, scheduledFundingDate, notes } }               → merge the
 *       free-text coordination fields.
 *
 * Stores on loan.closing:
 *   { steps: { <key>: { done, at, by } }, titleCompany, titleContact,
 *     wireAmount, scheduledFundingDate, notes, updatedAt, updatedBy }
 *
 * Auth: staff; cross-owner via canOverrideOwner (admin OR processor). Strict
 * PG-first writeClient — no fire-and-forget (strict-write discipline).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

// Milestone keys the closing panel tracks, in flow order. Whitelisted so a
// bad/renamed key can't write junk into the closing object. Labels live in
// the frontend (loan-details.js renderClosingPanel).
const CLOSING_STEPS  = ['cd_sent', 'docs_signed', 'wire_sent', 'funded', 'recorded'];
// Free-text coordination fields.
const CLOSING_FIELDS = ['titleCompany', 'titleContact', 'wireAmount', 'scheduledFundingDate', 'notes'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-closing-save error:', e);
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

  const hasStep   = typeof body.step === 'string' && body.step.length > 0;
  const hasFields = body.fields && typeof body.fields === 'object';
  if (!hasStep && !hasFields) return json(400, { error: 'Nothing to update: pass step+done or fields' });
  if (hasStep && CLOSING_STEPS.indexOf(body.step) < 0) {
    return json(400, { error: 'Unknown closing step: ' + body.step });
  }

  // Resolve owner (same pattern as loan-assign-processor).
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
  const closing = (loan.closing && typeof loan.closing === 'object') ? loan.closing : {};
  if (!closing.steps || typeof closing.steps !== 'object') closing.steps = {};

  if (hasStep) {
    const done = body.done === true;
    closing.steps[body.step] = done
      ? { done: true, at: now, by: selfEmail }
      : { done: false, at: '', by: '' };
  }

  if (hasFields) {
    for (const k of CLOSING_FIELDS) {
      if (Object.prototype.hasOwnProperty.call(body.fields, k)) {
        closing[k] = String(body.fields[k] == null ? '' : body.fields[k]).trim();
      }
    }
  }

  closing.updatedAt = now;
  closing.updatedBy = selfEmail;
  loan.closing = closing;
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, closing: loan.closing });
}
