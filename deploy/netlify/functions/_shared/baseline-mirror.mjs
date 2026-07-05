/**
 * _shared/baseline-mirror.mjs — Read-side mirror of Baseline's loan store.
 *
 * Deploy 232 (Mirror Phase 1 — Step 2). Phase 1 of the planned admin
 * dashboard work: pull loans from Baseline into a local blob store so
 * subsequent dashboard / forecasting / yield-spread features can read
 * fast without round-tripping to Baseline's API on every page load.
 *
 * Architecture:
 *   - `baseline_loans_mirror` blob store, keyed by Baseline external Id
 *     (e.g. "SLA-20251208-0061"). Values are the full loan detail JSON
 *     from `GET /loan/{Id}` plus a `_mirroredAt` ISO timestamp.
 *   - `fetchAllLoanList()`   — GET /loan, returns the 6-field list view
 *     (~253 entries as of 5/26/26). Cheap, single call.
 *   - `fetchLoanDetail(id)`  — GET /loan/{Id}, returns full schema.
 *     Used for everything beyond the list-view fields.
 *   - `loadMirroredLoan(id)` / `saveMirroredLoan(...)` — blob CRUD.
 *
 * Phase 2 (dashboard.html) and later layer on top of this. Webhooks
 * (Phase 5) will write to the same blob store directly, replacing the
 * polling sync this file enables.
 */
import { getStore } from '@netlify/blobs';

const DEFAULT_BASE_URL = 'https://production.baselinesoftware.com/production/api';

function baseUrl() {
  return (process.env.BASELINE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function authHeader() {
  return 'Token ' + (process.env.BASELINE_API_KEY || '');
}

/**
 * GET /loan — returns the full list (~253 as of 5/26). Each entry has
 * sparse fields (Id, Name, Status, Substatus, Created_Date, _Id,
 * Account_Owners) so we use it for change detection only and detail-
 * fetch loans whose Status/Substatus we don't already have mirrored.
 *
 * Returns: { ok, loans: Array, status, error? }
 */
export async function fetchAllLoanList() {
  if (!process.env.BASELINE_API_KEY) {
    return { ok: false, loans: [], status: 0, error: 'BASELINE_API_KEY not configured' };
  }
  const url = baseUrl() + '/loan';
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': authHeader(),
        'Accept': 'application/json',
      },
    });
    const text = await resp.text().catch(() => '');
    let body; try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text.slice(0, 500) }; }
    if (!resp.ok) return { ok: false, loans: [], status: resp.status, error: body.error || ('HTTP ' + resp.status) };
    const loans = Array.isArray(body.loans) ? body.loans : (Array.isArray(body) ? body : []);
    return { ok: true, loans, status: resp.status };
  } catch (e) {
    return { ok: false, loans: [], status: 0, error: e && e.message };
  }
}

/**
 * GET /loan/{Id} — full schema for a single loan. Uses the external
 * SLA-YYYYMMDD-NNNN id (NOT Baseline's internal numeric `_Id`).
 *
 * Returns: { ok, loan, status, error? }
 */
export async function fetchLoanDetail(externalId) {
  if (!externalId) return { ok: false, loan: null, status: 0, error: 'externalId required' };
  if (!process.env.BASELINE_API_KEY) {
    return { ok: false, loan: null, status: 0, error: 'BASELINE_API_KEY not configured' };
  }
  const url = baseUrl() + '/loan/' + encodeURIComponent(externalId);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': authHeader(),
        'Accept': 'application/json',
      },
    });
    const text = await resp.text().catch(() => '');
    let body; try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text.slice(0, 500) }; }
    if (!resp.ok) return { ok: false, loan: null, status: resp.status, error: body.error || ('HTTP ' + resp.status) };
    // Baseline POST/PATCH responses wrap as { loan: {...} } — list and
    // detail GETs may do the same, may not. Handle either shape.
    const loan = (body && body.loan && typeof body.loan === 'object') ? body.loan : body;
    return { ok: true, loan, status: resp.status };
  } catch (e) {
    return { ok: false, loan: null, status: 0, error: e && e.message };
  }
}

// ── Mirror blob store (key: external Baseline Id) ──────────────────

function mirrorStore() {
  return getStore({ name: 'baseline_loans_mirror', consistency: 'strong' });
}

/** Sanitize an external Id for use as a blob key. Baseline IDs are
 *  already URL-safe ("SLA-20251208-0061") but defense-in-depth. */
function keyForLoan(externalId) {
  return String(externalId || '').replace(/[^a-zA-Z0-9_.-]/g, '_');
}

export async function loadMirroredLoan(externalId) {
  try {
    return await mirrorStore().get(keyForLoan(externalId), { type: 'json' });
  } catch (_) { return null; }
}

export async function saveMirroredLoan(externalId, loan) {
  const record = Object.assign({}, loan, { _mirroredAt: new Date().toISOString() });
  await mirrorStore().setJSON(keyForLoan(externalId), record);
  return record;
}

// Deploy 236.176 — remove a mirror entry. Used by the "delete
// ghost" flow when Baseline 404s on the Id — meaning the loan no
// longer exists in Baseline and the mirror row is a fossil.
export async function deleteMirroredLoan(externalId) {
  try {
    await mirrorStore().delete(keyForLoan(externalId));
    return true;
  } catch (e) {
    console.warn('deleteMirroredLoan error:', e && e.message);
    return false;
  }
}

/** Walk the entire mirror. Returns array of loan records. */
export async function listMirroredLoans() {
  const out = [];
  try {
    const { blobs } = await mirrorStore().list();
    for (const { key } of blobs) {
      const rec = await mirrorStore().get(key, { type: 'json' });
      if (rec) out.push(rec);
    }
  } catch (e) {
    console.warn('listMirroredLoans error:', e && e.message);
  }
  return out;
}
