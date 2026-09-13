/**
 * _shared/stable-api.mjs — Deploy 236.995 (Mike, mail room)
 *
 * Thin client for Stable (usestable.com), SLA's virtual mailbox provider.
 * REST at https://api.usestable.com/v1, auth = `x-api-key` header
 * (STABLE_API_KEY env var, minted in Stable's dashboard → Settings → API keys).
 *
 * What the API can do today (docs.usestable.com, Sept 2026):
 *   READ   mail items (envelope image, OCR, scan image/OCR, check transcription,
 *          forward/scan/shred/deposit status) — cursor-paginated list + get.
 *   WRITE  tags (create, assign/remove on mail items) and shipments (physical
 *          forwarding). Open-and-scan, shred and check deposit are STATUS ONLY —
 *          those are dashboard actions, so the portal deep-links to Stable.
 *
 * Every image/OCR URL Stable returns is TEMPORARY — anything we keep is
 * downloaded and stored on our side at sync time (see mail-sync.mjs).
 */
const BASE = 'https://api.usestable.com/v1';

export function stableConfigured() {
  return !!process.env.STABLE_API_KEY;
}

// The API returns no web link for a mail item; the dashboard URL shape is
// configurable so it can be corrected without a deploy if Stable changes it.
export function stableDashboardUrl(id) {
  const tpl = process.env.STABLE_DASHBOARD_URL_TEMPLATE || 'https://dashboard.usestable.com/mail/{id}';
  return tpl.replace('{id}', encodeURIComponent(String(id || '')));
}

async function _req(method, path, opts) {
  opts = opts || {};
  const key = process.env.STABLE_API_KEY;
  if (!key) throw new Error('STABLE_API_KEY is not set');
  const qs = opts.qs ? '?' + new URLSearchParams(opts.qs).toString() : '';
  const headers = { 'x-api-key': key, Accept: 'application/json' };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const resp = await fetch(BASE + path + qs, {
    method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await resp.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }
  if (!resp.ok) {
    const msg = (data && (data.message || data.error)) || text || '';
    const err = new Error('Stable ' + method + ' ' + path + ' → HTTP ' + resp.status + (msg ? ': ' + String(msg).slice(0, 300) : ''));
    err.status = resp.status;
    err.data = data;
    throw err;
  }
  return data;
}

/** One page of mail items. createdAfter = ISO timestamp (createdAt_gt). */
export async function listMailItems(opts) {
  opts = opts || {};
  const qs = { first: String(opts.first || 50) };
  if (opts.after) qs.after = opts.after;
  if (opts.createdAfter) qs.createdAt_gt = opts.createdAfter;
  if (opts.locationId) qs.locationId = opts.locationId;
  const d = await _req('GET', '/mail-items', { qs });
  const edges = (d && Array.isArray(d.edges)) ? d.edges : [];
  return {
    items: edges.map((e) => e && e.node).filter(Boolean),
    pageInfo: (d && d.pageInfo) || {},
    totalCount: d && d.totalCount,
  };
}

export function getMailItem(id) {
  return _req('GET', '/mail-items/' + encodeURIComponent(String(id)));
}

/** Download one of Stable's temporary URLs. Returns { bytes, contentType }. */
export async function fetchTemp(url, maxBytes) {
  if (!url) return null;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error('temp URL fetch → HTTP ' + resp.status);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (maxBytes && buf.length > maxBytes) return { bytes: null, contentType: resp.headers.get('content-type') || '', tooLarge: buf.length };
  return { bytes: buf, contentType: String(resp.headers.get('content-type') || '').split(';')[0].trim() };
}

// ── Tags ──────────────────────────────────────────────────────────────
function _tagArray(d) {
  if (Array.isArray(d)) return d;
  if (d && Array.isArray(d.tags)) return d.tags;
  if (d && Array.isArray(d.edges)) return d.edges.map((e) => e && e.node).filter(Boolean);
  if (d && Array.isArray(d.data)) return d.data;
  return [];
}

export async function listTags() {
  return _tagArray(await _req('GET', '/tags'));
}

export async function createTag(name) {
  const d = await _req('POST', '/tags', { body: { tags: [{ name: String(name) }] } });
  return _tagArray(d)[0] || null;
}

/** tags: [{ id, isApplied: true|false }] */
export function setMailItemTags(mailItemIds, tags) {
  return _req('POST', '/mail-items/tags', { body: { mailItemIds, tags } });
}

// ── Forwarding ────────────────────────────────────────────────────────
export function shippingMethods(body) {
  return _req('POST', '/shipping-methods', { body: body || {} });
}

export function createShipment(body) {
  return _req('POST', '/shipments', { body });
}
