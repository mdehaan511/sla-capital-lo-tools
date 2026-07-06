/**
 * baseline-borrowers.mjs — helpers for pulling Baseline borrower
 * records (people + entities) and caching them in a mirror store.
 *
 * Deploy 236.192 — added alongside the existing loan mirror helpers.
 * The loan mirror gives us Guarantor_1_* / Entity_Name / etc. as
 * denormalized strings; this file adds proper Baseline borrower Ids
 * so we can link SLA clients (and companies) back to their canonical
 * Baseline records.
 *
 * Baseline concepts:
 *   Is_Company: false → Person   (First_Name, Last_Name, Email, ...)
 *   Is_Company: true  → Entity   (Name, Address_*, Tax_ID via Custom_Fields)
 *
 * Storage stores:
 *   baseline_borrowers_mirror — raw borrower payload keyed by Baseline Id
 *   baseline_borrower_link    — Baseline Id → { ownerKey, clientId, companyId? }
 */
import { getStore } from '@netlify/blobs';

const DEFAULT_BASE_URL = 'https://production.baselinesoftware.com/production/api';
function baseUrl() { return (process.env.BASELINE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, ''); }
function authHeader() { return 'Token ' + (process.env.BASELINE_API_KEY || ''); }

/**
 * GET /borrower — list all borrowers (both people and entities).
 * Baseline's list shape isn't documented for us; try the common
 * envelopes ({borrowers}, array, {data}).
 */
export async function fetchAllBorrowerList() {
  if (!process.env.BASELINE_API_KEY) {
    return { ok: false, borrowers: [], status: 0, error: 'BASELINE_API_KEY not configured' };
  }
  const url = baseUrl() + '/borrower';
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    const text = await resp.text().catch(() => '');
    let body; try { body = text ? JSON.parse(text) : {}; } catch (_) { body = { raw: text.slice(0, 500) }; }
    if (!resp.ok) return { ok: false, borrowers: [], status: resp.status, error: (body && body.error) || ('HTTP ' + resp.status), rawPreview: text.slice(0, 500) };
    const borrowers = Array.isArray(body.borrowers) ? body.borrowers
      : Array.isArray(body) ? body
      : Array.isArray(body.data) ? body.data
      : Array.isArray(body.results) ? body.results
      : [];
    return { ok: true, borrowers, status: resp.status, envelopeShape: Array.isArray(body) ? 'array' : Object.keys(body || {}).slice(0, 6).join(',') };
  } catch (e) {
    return { ok: false, borrowers: [], status: 0, error: (e && e.message) || 'fetch failed' };
  }
}

/**
 * GET /borrower/{Id} — full borrower detail. Same envelope tolerance
 * as the list endpoint.
 */
export async function fetchBorrowerDetail(id) {
  if (!id) return { ok: false, borrower: null, status: 0, error: 'id required' };
  if (!process.env.BASELINE_API_KEY) return { ok: false, borrower: null, status: 0, error: 'BASELINE_API_KEY not configured' };
  const url = baseUrl() + '/borrower/' + encodeURIComponent(id);
  try {
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Authorization: authHeader(), Accept: 'application/json' },
    });
    const text = await resp.text().catch(() => '');
    let body; try { body = text ? JSON.parse(text) : {}; } catch (_) { body = {}; }
    if (!resp.ok) return { ok: false, borrower: null, status: resp.status, error: (body && body.error) || ('HTTP ' + resp.status) };
    const borrower = (body && body.borrower && typeof body.borrower === 'object') ? body.borrower : body;
    return { ok: true, borrower, status: resp.status };
  } catch (e) {
    return { ok: false, borrower: null, status: 0, error: (e && e.message) || 'fetch failed' };
  }
}

// ── Mirror store (raw payload) ────────────────────────────────────
function mirrorStore() { return getStore({ name: 'baseline_borrowers_mirror', consistency: 'strong' }); }
function safeKey(id) { return String(id || '').replace(/[^a-zA-Z0-9_.-]/g, '_'); }

export async function saveMirroredBorrower(id, borrower) {
  const record = Object.assign({}, borrower, { _mirroredAt: new Date().toISOString() });
  await mirrorStore().setJSON(safeKey(id), record);
  return record;
}
export async function loadMirroredBorrower(id) {
  try { return await mirrorStore().get(safeKey(id), { type: 'json' }); } catch (_) { return null; }
}
export async function listMirroredBorrowers() {
  const out = [];
  try {
    const { blobs } = await mirrorStore().list();
    for (const { key } of blobs) {
      const rec = await mirrorStore().get(key, { type: 'json' }).catch(() => null);
      if (rec) out.push(rec);
    }
  } catch (_) {}
  return out;
}

// ── Borrower link store (Baseline Id → SLA location) ─────────────
const LINK_STORE = 'baseline_borrower_link';
function linkStore() { return getStore({ name: LINK_STORE, consistency: 'strong' }); }
export async function getBorrowerLink(id) {
  if (!id) return null;
  try { return await linkStore().get(safeKey(id), { type: 'json' }); } catch (_) { return null; }
}
export async function setBorrowerLink(id, link) {
  if (!id || !link) return;
  await linkStore().setJSON(safeKey(id), Object.assign({}, link, { updatedAt: new Date().toISOString() }));
}
export async function clearBorrowerLink(id) {
  if (!id) return;
  try { await linkStore().delete(safeKey(id)); } catch (_) {}
}
