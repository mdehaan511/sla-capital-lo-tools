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
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

// Whitelist of fields the Loan Details inline editors are allowed to
// set. Expand as the unification work in Phase B continues.
// Each value may be a string (= label, default string handling) or an
// object with { label, type } where type controls coercion:
//   'string'    (default) — string-stored, string-compared
//   'array'     — array of plain values (e.g. vesting LLC strings or
//                 { name, ein } objects); JSON-compared
//   'object'    — bag of key/value (e.g. guarantorOwnership map);
//                 JSON-compared
const FIELD_LABELS = {
  fundingDate:        'Close Date',
  // Deploy 236.126 (Contacts tab restructure):
  //   vestingLLCs        — [{ name, ein? }] of LLCs holding title.
  //                        Auto-populated from the primary client's
  //                        entityName on first render; editable for
  //                        multi-LLC scenarios.
  //   guarantorOwnership — { [clientId]: ownershipPct } map. Primary
  //                        + each linked guarantor's % stake in the
  //                        vesting LLC. Total < 51% triggers a
  //                        "Check Guarantor Ownership %" banner.
  vestingLLCs:        { label: 'Vesting LLCs',        type: 'array' },
  guarantorOwnership: { label: 'Guarantor Ownership', type: 'object' },
};

function _specFor(key) {
  const raw = FIELD_LABELS[key];
  if (!raw) return null;
  if (typeof raw === 'string') return { label: raw, type: 'string' };
  return raw;
}
function _coerce(value, type) {
  if (type === 'array')  return Array.isArray(value) ? value : null;
  if (type === 'object') return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  return value == null ? '' : String(value);
}
function _serializeForCompare(value, type) {
  if (type === 'array' || type === 'object') {
    try { return JSON.stringify(value || (type === 'array' ? [] : {})); } catch (_) { return ''; }
  }
  return value == null ? '' : String(value);
}
function _renderForNote(value, type) {
  if (type === 'array')  return Array.isArray(value) ? value.map((v) => typeof v === 'string' ? v : (v && (v.name || JSON.stringify(v)) || '')).join(', ') || '(empty)' : '(empty)';
  if (type === 'object') {
    if (!value || typeof value !== 'object') return '(empty)';
    const keys = Object.keys(value);
    if (!keys.length) return '(empty)';
    return keys.map((k) => k.slice(0, 12) + ':' + value[k]).join(', ');
  }
  return value == null || value === '' ? '(blank)' : String(value);
}

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

  const user = await requireAuth(context, req);
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
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
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
    const spec = _specFor(key);
    if (!spec) return; // silently ignore unknown fields

    const newVal = _coerce(fields[key], spec.type);
    if (newVal === null) return; // invalid shape for this type — skip
    const oldVal = loan[key];

    const newCmp = _serializeForCompare(newVal, spec.type);
    const oldCmp = _serializeForCompare(oldVal, spec.type);
    if (newCmp === oldCmp) return;

    loan[key] = newVal;
    applied.push({
      key,
      label:  spec.label,
      type:   spec.type,
      from:   _renderForNote(oldVal, spec.type),
      to:     _renderForNote(newVal, spec.type),
    });
  });

  if (applied.length === 0) {
    return json(200, { ok: true, loan, applied: [], note: 'No changes' });
  }

  loan.updatedAt = new Date().toISOString();
  const textParts = applied.map((c) => c.label + ': ' + c.from + ' → ' + c.to);
  appendNoteEntry(loan, {
    kind:        'field_edit',
    text:        textParts.join('; '),
    author,
    authorEmail: user.email || '',
    meta:        { changes: applied },
  });

  client.loans[idx] = loan;
  client.updatedAt = new Date().toISOString();

  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  // Deploy 236.834 — field-level Audit Log entry. This endpoint predates the
  // 236.771 audit-log rollout and only wrote the Notes & Activity line, so
  // edits made through it (Close Date from the dashboard drilldowns, etc.)
  // were missing from the Audit Log modal. Best-effort; never fails the save.
  try {
    const { recordLoanChanges } = await import('./_shared/loan-change-log.mjs');
    await recordLoanChanges({
      ownerKey, clientId: client.id, loanId: loan.id,
      actor: selfEmail, actorName: author || selfEmail,
      source: 'Field edit',
      changes: applied.map((c) => ({ field: c.key, label: c.label, from: c.from, to: c.to })),
    });
  } catch (e) { console.warn('loan-field-edit: change log failed (non-fatal):', e && e.message); }

  return json(200, { ok: true, loan, applied });
}
