/**
 * _shared/billcom.mjs — BILL (bill.com) v3 API client.
 *
 * Deploy 236.808 — LO commission bills. Env vars (Netlify):
 *   BILL_DEV_KEY   — developer key (BILL web app → Settings → Sync &
 *                    Integrations → Manage Developer Keys)
 *   BILL_USERNAME  — BILL sign-in email (dedicated service user preferred)
 *   BILL_PASSWORD  — its password
 *   BILL_ORG_ID    — organization id (begins with 008)
 *   BILL_API_BASE  — optional override; defaults to PRODUCTION.
 *                    Sandbox: https://gateway.stage.bill.com/connect
 *
 * Sessions live ~35 minutes; we log in per request (each admin action is
 * one login + a couple of calls — no session caching needed).
 */

const BASE = () => (process.env.BILL_API_BASE || 'https://gateway.prod.bill.com/connect').replace(/\/$/, '');

export function billConfigured() {
  return !!(process.env.BILL_DEV_KEY && process.env.BILL_USERNAME &&
            process.env.BILL_PASSWORD && process.env.BILL_ORG_ID);
}
export function billMissingVars() {
  return ['BILL_DEV_KEY', 'BILL_USERNAME', 'BILL_PASSWORD', 'BILL_ORG_ID']
    .filter((k) => !process.env[k]);
}

async function _req(path, { method = 'GET', headers = {}, body } = {}) {
  const resp = await fetch(BASE() + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = { raw: text }; }
  if (!resp.ok) {
    // Deploy 236.815 — BILL returns 4XX/5XX as a BARE JSON ARRAY of BdcError
    // ({ code, message, detail, params, help }), which is what its OpenAPI spec
    // documents ("4XX: List of errors"). The original parse only looked at
    // `data.message` and `data.errors`, so every BILL error collapsed to a bare
    // "HTTP 400" and the actual reason was thrown away — which is exactly how a
    // failing commission bill reported nothing useful.
    const one = (e) => [e && e.code, e && e.message, e && e.detail]
      .map((x) => (typeof x === 'string' ? x.trim() : '')).filter(Boolean).join(': ');
    let msg = '';
    if (Array.isArray(data)) msg = data.map(one).filter(Boolean).join(' | ');
    else if (data && Array.isArray(data.errors)) msg = data.errors.map(one).filter(Boolean).join(' | ');
    else if (data) msg = one(data);
    // Last resort: never swallow the body again. A truncated raw payload beats
    // a status code with no explanation.
    if (!msg) msg = 'HTTP ' + resp.status + (text ? ' — ' + text.slice(0, 400) : '');

    const err = new Error('BILL ' + method + ' ' + path + ' → ' + msg);
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

// POST /v3/login → { sessionId, ... }. Returns the auth headers for
// subsequent calls.
export async function billLogin() {
  const data = await _req('/v3/login', {
    method: 'POST',
    body: {
      devKey:         process.env.BILL_DEV_KEY,
      username:       process.env.BILL_USERNAME,
      password:       process.env.BILL_PASSWORD,
      organizationId: process.env.BILL_ORG_ID,
    },
  });
  if (!data || !data.sessionId) throw new Error('BILL login returned no sessionId');
  return { sessionId: data.sessionId, devKey: process.env.BILL_DEV_KEY, organizationId: data.organizationId || '' };
}

function _authHeaders(session) {
  return { sessionId: session.sessionId, devKey: session.devKey };
}

// List vendors (paged). Returns up to `cap` vendors.
export async function listVendors(session, cap = 500) {
  const out = [];
  let page = '';
  for (let i = 0; i < Math.ceil(cap / 100); i++) {
    const qs = '?max=100' + (page ? '&page=' + encodeURIComponent(page) : '');
    const data = await _req('/v3/vendors' + qs, { headers: _authHeaders(session) });
    const results = (data && data.results) || [];
    out.push(...results);
    if (!data || !data.nextPage || results.length === 0) break;
    page = data.nextPage;
  }
  return out;
}

// Find a vendor by email (preferred) or exact name (case-insensitive).
export async function findVendor(session, email, name) {
  const e = String(email || '').toLowerCase().trim();
  const n = String(name || '').toLowerCase().trim();
  const vendors = await listVendors(session);
  let hit = e ? vendors.find((v) => String(v.email || '').toLowerCase().trim() === e) : null;
  if (!hit && n) hit = vendors.find((v) => String(v.name || '').toLowerCase().trim() === n);
  return hit || null;
}

// Create a minimal vendor for an LO. BILL requires an address — we use the
// SLA office as a placeholder (edit in BILL before the first check payment;
// ePayments via the BILL network don't use it once the vendor connects).
const PLACEHOLDER_ADDRESS = {
  line1: 'c/o SLA Capital',
  city: 'Spokane',
  stateOrProvince: 'WA',
  zipOrPostalCode: '99201',
  country: 'US',
};
export async function createVendor(session, { name, email }) {
  return _req('/v3/vendors', {
    method: 'POST',
    headers: _authHeaders(session),
    body: {
      name: String(name || email).slice(0, 100),
      email: email || undefined,
      address: PLACEHOLDER_ADDRESS,
    },
  });
}

// Create a bill. lineItems: [{ amount, description }]. Duplicate invoice
// numbers are REJECTED (allowDuplicateInvoiceNumber:false) — the invoice
// number is the idempotency backstop for a whole commission run.
export async function createBill(session, { vendorId, invoiceNumber, invoiceDate, dueDate, description, lineItems }) {
  // Deploy 236.816 — BILL caps invoiceNumber at 21 chars (BDC_1143). This used
  // to slice to 100, which both hid the limit and would silently corrupt the
  // idempotency key if it ever did truncate. Refuse instead: the CALLER owns
  // shortening, because only it knows how to stay unique per LO + period.
  const inv = String(invoiceNumber == null ? '' : invoiceNumber);
  if (inv.length > 21) {
    throw new Error('BILL invoiceNumber must be 21 characters or fewer (got ' + inv.length + ': "' + inv + '")');
  }
  return _req('/v3/bills', {
    method: 'POST',
    headers: _authHeaders(session),
    body: {
      vendorId,
      invoice: { invoiceNumber: inv, invoiceDate },
      dueDate,
      description: description ? String(description).slice(0, 4000) : undefined,
      allowDuplicateInvoiceNumber: false,
      billLineItems: lineItems.map((li) => ({
        amount: Math.round(Number(li.amount) * 100) / 100,
        description: li.description ? String(li.description).slice(0, 4000) : undefined,
      })),
    },
  });
}
