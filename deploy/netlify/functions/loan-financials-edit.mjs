/**
 * loan-financials-edit.mjs — POST /api/loan-financials-edit
 *
 * Deploy 236.124 (Phase B.2/B.3) — Loan Financials inline editor.
 * Lets Loan Details patch a narrow set of pricing-related fields
 * while preserving an audit trail of what was manually changed,
 * snapshotting the original values for restore, and flagging the
 * signed Rate Sheet / Loan App as stale so the LO knows they may
 * need re-signing.
 *
 * Body:
 *   {
 *     clientId, loanId,
 *     fields: { rate?, points?, purchasePrice?, rehabBudget?,
 *               arv?, fico?, loanType?, experience?, brokerFee? },
 *     owner?: 'other@lo.com'
 *   }
 *
 * Behavior:
 *   1. Validates fields against the whitelist below.
 *   2. SNAPSHOT (one-time): copies the prior values of any
 *      whitelist field into loan._originalValues if it's not
 *      already set there. Subsequent edits keep adding to the
 *      modified-fields list but never overwrite the snapshot.
 *   3. Applies the patch.
 *   4. Updates loan._modifiedFields (unique union of all fields
 *      that currently differ from _originalValues).
 *   5. Sets loan._signedDocsStale = { at, by, fields, reason }
 *      so the envelopes panel + Rate Sheet PDF render can
 *      surface a "may need re-signing" warning.
 *   6. Appends a notesLog entry (kind = 'financials_edit').
 *
 * Response: { ok: true, loan, applied: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';

// Whitelist of fields the inline editor can patch + how to coerce them.
// Values not on the list are silently dropped.
const FIELDS = {
  rate:          { label: 'Rate',           coerce: toNumber, format: (v) => (v * 1).toFixed(3) + '%' },
  points:        { label: 'Points',         coerce: toNumber, format: (v) => (v * 1).toFixed(3) + ' pts' },
  purchasePrice: { label: 'Purchase Price', coerce: toNumber, format: (v) => '$' + Math.round(v).toLocaleString() },
  rehabBudget:   { label: 'Rehab Budget',   coerce: toNumber, format: (v) => '$' + Math.round(v).toLocaleString() },
  arv:           { label: 'ARV',            coerce: toNumber, format: (v) => '$' + Math.round(v).toLocaleString() },
  fico:          { label: 'FICO',           coerce: toInt,    format: (v) => String(v) },
  loanType:      { label: 'Loan Type',      coerce: toStr,    format: (v) => String(v) },
  experience:    { label: 'Experience',     coerce: toInt,    format: (v) => String(v) },
  brokerFee:     { label: 'Broker Fee',     coerce: toNumber, format: (v) => (v * 1).toFixed(3) + ' pts' },
};

function toNumber(v) {
  if (v == null || v === '') return null;
  const n = Number(String(v).replace(/[$,\s%]/g, ''));
  return isFinite(n) ? n : null;
}
function toInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(String(v).replace(/[,\s]/g, ''), 10);
  return isFinite(n) ? n : null;
}
function toStr(v) { return v == null ? '' : String(v).trim(); }

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-financials-edit top-level error:', e);
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
  if (!Array.isArray(client.loans)) return json(404, { error: 'Client has no loans array' });

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client. clientId=' + clientId + ' loanId=' + loanId });

  const loan = client.loans[idx];
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  const now = new Date().toISOString();

  // Snapshot originals on first edit. Once set, never overwritten —
  // so "restore" always returns to the calculator-generated baseline.
  loan._originalValues = loan._originalValues || {};

  const applied = [];
  const changeRows = [];
  for (const key of Object.keys(fields)) {
    const spec = FIELDS[key];
    if (!spec) continue; // not on whitelist — drop silently
    const next = spec.coerce(fields[key]);
    if (next === null) continue; // invalid value — skip
    const prior = loan[key];
    // formData mirror: many fields ALSO live on loan.formData (the
    // sizer form-state snapshot). Update both so downstream code
    // that reads from formData sees the edit.
    loan.formData = loan.formData || {};
    // Skip no-ops so we don't churn _modifiedFields with same value.
    if (String(prior) === String(next)) continue;
    if (!(key in loan._originalValues)) {
      loan._originalValues[key] = prior;
    }
    loan[key] = next;
    loan.formData[key] = next;
    applied.push(key);
    changeRows.push({ key, label: spec.label, from: prior, to: next });
  }

  if (!applied.length) {
    return json(200, { ok: true, loan, applied: [], note: 'no whitelisted fields with changes' });
  }

  // Compute current _modifiedFields = fields that still differ from
  // their snapshot. If an edit RESTORES a field to its original
  // value, drop it from the modified list (and drop the snapshot
  // entry too, so a second cycle of edit-restore-edit still works
  // cleanly).
  loan._modifiedFields = loan._modifiedFields || [];
  applied.forEach((k) => {
    const snap = loan._originalValues[k];
    const curr = loan[k];
    if (String(snap) === String(curr)) {
      delete loan._originalValues[k];
      loan._modifiedFields = loan._modifiedFields.filter((x) => x !== k);
    } else if (loan._modifiedFields.indexOf(k) < 0) {
      loan._modifiedFields.push(k);
    }
  });

  // Stale-docs flag for the signed Rate Sheet + Loan App. Carries
  // the latest fields that triggered the staleness + when + who.
  // Cleared by signed-app-regenerate and rate-sheet-regenerate
  // (or by a successful re-sign of the envelope).
  loan._signedDocsStale = {
    at:        now,
    by:        user.email || '',
    byName:    authorName,
    fields:    applied,
    reason:    'financials_edited',
  };

  loan.updatedAt = now;

  // Audit entry for the notesLog timeline.
  appendNoteEntry(loan, {
    kind:        'financials_edit',
    text:        'Loan financials edited: ' +
                 changeRows.map((c) => c.label + ' ' + _fmtFromTo(c)).join(', '),
    author:      authorName,
    authorEmail: user.email || '',
    meta:        { changes: changeRows },
  });

  client.loans[idx] = loan;
  client.updatedAt = now;

  try { await clientsStore.setJSON(clientKey, client); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, loan, applied });
}

function _fmtFromTo(c) {
  const f = c.from == null || c.from === '' ? '(empty)' : String(c.from);
  const t = c.to   == null || c.to   === '' ? '(empty)' : String(c.to);
  return f + ' → ' + t;
}
