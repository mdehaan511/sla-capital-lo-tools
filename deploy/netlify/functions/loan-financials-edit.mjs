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
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.222 Phase 5 — keep the QuoteStore in sync with the loan.
// (Kept non-strict: the sweep is best-effort and its count feeds the
// quotesSynced response field.)
import { syncLoanToQuoteStore } from './_shared/quote-sync.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';

// Whitelist of fields the inline editor can patch + how to coerce them.
// Values not on the list are silently dropped.
// `modifiable: false` means the field rides along (FICO + Experience
// display labels) but doesn't itself trigger snapshot / modified-
// tracking — it's metadata mirroring the primary value.
// Also: fico is `toStr` (not `toInt`) because the DSCR sizer stores
// fico as a string range like "740-759"; RTL stores it as a numeric
// string like "740". Either round-trips fine as a string.
const FIELDS = {
  rate:             { label: 'Rate',           coerce: toNumber, modifiable: true,  format: (v) => (v * 1).toFixed(3) + '%' },
  points:           { label: 'Points',         coerce: toNumber, modifiable: true,  format: (v) => (v * 1).toFixed(3) + ' pts' },
  purchasePrice:    { label: 'Purchase Price', coerce: toNumber, modifiable: true,  format: (v) => '$' + Math.round(v).toLocaleString() },
  rehabBudget:      { label: 'Rehab Budget',   coerce: toNumber, modifiable: true,  format: (v) => '$' + Math.round(v).toLocaleString() },
  arv:              { label: 'ARV',            coerce: toNumber, modifiable: true,  format: (v) => '$' + Math.round(v).toLocaleString() },
  fico:             { label: 'FICO',           coerce: toStr,    modifiable: true,  format: (v) => String(v) },
  ficoLabel:        { label: 'FICO',           coerce: toStr,    modifiable: false, format: (v) => String(v) },
  loanType:         { label: 'Loan Type',      coerce: toStr,    modifiable: true,  format: (v) => String(v) },
  experience:       { label: 'Experience',     coerce: toStr,    modifiable: true,  format: (v) => String(v) },
  experienceLabel:  { label: 'Experience',     coerce: toStr,    modifiable: false, format: (v) => String(v) },
  brokerFee:        { label: 'Broker Fee',     coerce: toNumber, modifiable: true,  format: (v) => (v * 1).toFixed(3) + ' pts' },
  // Deploy 236.133 — DSCR-specific inline editors.
  monthlyRent:      { label: 'Monthly Rent',      coerce: toNumber, modifiable: true, format: (v) => '$' + Math.round(v).toLocaleString() },
  monthlyTaxes:     { label: 'Monthly Taxes',     coerce: toNumber, modifiable: true, format: (v) => '$' + Math.round(v).toLocaleString() },
  monthlyInsurance: { label: 'Monthly Insurance', coerce: toNumber, modifiable: true, format: (v) => '$' + Math.round(v).toLocaleString() },
  monthlyHoa:       { label: 'Monthly HOA',       coerce: toNumber, modifiable: true, format: (v) => '$' + Math.round(v).toLocaleString() },
  appraisedValue:   { label: 'Appraised Value',   coerce: toNumber, modifiable: true, format: (v) => '$' + Math.round(v).toLocaleString() },
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

  const applied = [];           // every field actually written (primary + label mirrors)
  const modifiableApplied = [];  // only the primary fields that count toward _modifiedFields
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
    // Only PRIMARY (modifiable) fields get snapshotted. Mirror
    // labels (ficoLabel / experienceLabel) ride along with their
    // primary write and are never used for restore.
    if (spec.modifiable && !(key in loan._originalValues)) {
      loan._originalValues[key] = prior;
    }
    loan[key] = next;
    loan.formData[key] = next;
    // Deploy 236.135 — also write sizer-side mirror fields so
    // reopening the sizer after an inline edit picks up the new
    // value. Without these mirrors the sizer's loadQuoteIntoForm
    // reads from formData._finalRate / formData._points / formData
    // .rent / formData.taxes / etc., NOT from the canonical names
    // the inline editor writes — so edits looked like they had
    // vanished the moment the LO clicked back into the sizer.
    _mirrorForSizer(loan, key, next);
    applied.push(key);
    if (spec.modifiable) modifiableApplied.push(key);
    changeRows.push({ key, label: spec.label, from: prior, to: next });
  }

  if (!applied.length) {
    return json(200, { ok: true, loan, applied: [], note: 'no whitelisted fields with changes' });
  }

  // Compute current _modifiedFields = primary fields that still
  // differ from their snapshot. If an edit RESTORES a field to its
  // original value, drop it from the modified list (and drop the
  // snapshot entry too, so a second cycle of edit-restore-edit
  // still works cleanly).
  loan._modifiedFields = loan._modifiedFields || [];
  modifiableApplied.forEach((k) => {
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

  // Deploy 236.219 — Phase 2 of Mike's "Loan Details is the point
  // of truth" refactor. When any rate-sheet-affecting field is
  // edited, invalidate the saved pricingSnapshot on both loan and
  // loan.formData so the next sizer open synthesizes a fresh
  // snapshot from the canonical loan record. Without this,
  // window._loadedLoanPricingSnapshot in the sizer stays the old
  // saved snap and the "Download Rate Sheet" / "Send for Signature"
  // auto-download paths print the pre-edit rate/points/loan-amount
  // even though the LO's Loan-Details edit went through.
  const SNAPSHOT_INVALIDATING = new Set([
    'rate', 'points', 'purchasePrice', 'rehabBudget', 'arv',
    'fico', 'loanType', 'experience', 'brokerFee',
    'monthlyRent', 'monthlyTaxes', 'monthlyInsurance', 'monthlyHoa',
    'appraisedValue',
  ]);
  if (applied.some((k) => SNAPSHOT_INVALIDATING.has(k))) {
    if (loan.pricingSnapshot) delete loan.pricingSnapshot;
    if (loan.formData && loan.formData._pricingSnapshot) delete loan.formData._pricingSnapshot;
  }

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

  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to write client: ' + (e.message || 'unknown') }); }

  // Deploy 236.222 Phase 5 — mirror the loan's editable fields onto
  // any QuoteStore entries. Non-fatal on failure — a stale quote is
  // a UX gripe, not a data-integrity issue.
  let quotesSynced = 0;
  try {
    const sync = await syncLoanToQuoteStore(ownerKey, loan);
    quotesSynced = sync.updated || 0;
  } catch (e) {
    console.warn('loan-financials-edit: quote sync failed (non-fatal):', e && e.message);
  }

  return json(200, { ok: true, loan, applied, quotesSynced });
}

function _fmtFromTo(c) {
  const f = c.from == null || c.from === '' ? '(empty)' : String(c.from);
  const t = c.to   == null || c.to   === '' ? '(empty)' : String(c.to);
  return f + ' → ' + t;
}

// Deploy 236.135 — sizer-side mirror writes. Both dscr-sizer.html
// and rtl-sizer.html hydrate their forms from sizer-specific
// formData keys (set by save flow): `_finalRate` for rate display,
// `_points` for points display (with " pts" suffix), and the short
// names `rent` / `taxes` / `insurance` / `hoa` for monthly
// expenses. The inline editor writes the canonical names — the
// mirrors below keep the sizer round-trip working without
// touching the sizer code itself.
function _mirrorForSizer(loan, key, next) {
  loan.formData = loan.formData || {};
  switch (key) {
    case 'rate':
      // Sizer reads _finalRate first, formats with .toFixed(3).
      // Inline editor passes percent (e.g. 8.625).
      loan.formData._finalRate = (next * 1).toFixed(3);
      // Deploy 236.154 — also flag this as a manual override so
      // the sizer's load path (loadQuoteIntoForm → window.
      // _dscrOverrides) treats the Loan-Details-edited value as
      // an override and applies it during rate-sheet rendering.
      // Without this mirror, the sizer recomputed from defaults
      // and the rate sheet PDF reverted to the pre-edit value.
      // _rateOverride is stored as DECIMAL (e.g. 0.08625).
      loan.formData._rateOverride = String(next / 100);
      return;
    case 'points':
      // Sizer reads _points first; saved as "1.50 pts" string.
      loan.formData._points = (next * 1).toFixed(2) + ' pts';
      // Deploy 236.154 — same as rate above: mirror the value
      // as a sizer override so the next rate-sheet print /
      // signature-handoff honors it. Per Mike: "if the
      // Origination points are edited in the Loan Details
      // page then they should also change in the Sizer"
      // (and "the Origination Points defaults back to 1 point"
      // on print, which was the symptom of this exact gap).
      // _pointsOverride is stored as raw points (e.g. 1.5).
      loan.formData._pointsOverride = String(next);
      return;
    // Deploy 236.138 — monthly fields written under BOTH naming
    // schemes at the LOAN level AND in formData. The codebase has
    // legacy field names (rent/taxes/insurance/hoa) that the
    // sizer's save path uses + new names (monthlyRent/Taxes/
    // Insurance/Hoa) that test-create-loan + Loan Details inline
    // editor use. Mirroring both keeps every consumer in sync
    // regardless of which schema they read from.
    case 'monthlyRent':
      loan.rent = next;
      loan.formData.rent = next; return;
    case 'monthlyTaxes':
      loan.taxes = next;
      loan.formData.taxes = next; return;
    case 'monthlyInsurance':
      loan.insurance = next;
      loan.formData.insurance = next; return;
    case 'monthlyHoa':
      loan.hoa = next;
      loan.formData.hoa = next; return;
    // purchasePrice / rehabBudget / arv / fico / loanType /
    // experience / brokerFee / appraisedValue already use the
    // canonical name the sizer reads — no mirror needed.
    default: return;
  }
}
