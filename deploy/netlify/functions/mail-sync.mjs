/**
 * mail-sync.mjs — POST /api/mail-sync   (+ runSync, used by the cron + webhook)
 *
 * Deploy 236.995 (Mike, mail room). Pulls mail from Stable into the portal:
 *
 *   1. NEW items (createdAt after our watermark, 2h overlap) → a mail record,
 *      our own copy of the envelope image (Stable's URLs expire), the OCR text,
 *      and — when Stable has already opened it — the content scan. Lands in the
 *      Unsorted queue (p/unsorted) for the office assistant.
 *   2. PENDING items (a scan / forward / shred / deposit still processing) are
 *      re-read so status, tracking numbers and "where it's been" stay current.
 *   3. SUGGESTIONS: items flagged needsAi get a suggested loan + category
 *      (_shared/mail-match.mjs). Suggestion only; a person confirms.
 *
 * Time-budgeted: a function has ~26s, an AI call takes seconds, and a busy
 * mail day can bring dozens of pieces. Work stops at the budget and the rest
 * waits for the next run (every 15 minutes) — the watermark only advances past
 * items actually stored, and suggestions are a separate resumable queue.
 *
 * Body: { dryRun?: bool (default false), sinceDays?: number (first run window) }
 * Auth: mail-room access (office assistant / processor / admin).
 */
import {
  handleOptions, json, requireAuth, readJsonBody, canWorkMail, normalizeEmail,
} from './_shared/auth.mjs';
import { stableConfigured, listMailItems, getMailItem, fetchTemp } from './_shared/stable-api.mjs';
import {
  mailStore, getItem, putItem, setPointer, delPointer, listPointers, pushEvent, safeId,
} from './_shared/mail-store.mjs';
import { loadCandidateLoans, suggestForItem } from './_shared/mail-match.mjs';

const MAX_IMG_BYTES = 8 * 1024 * 1024;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('mail-sync error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canWorkMail(user)) return json(403, { error: 'Mail room access required' });
  if (!stableConfigured()) return json(503, { error: 'STABLE_API_KEY is not set on this site yet — add it in Netlify to connect the Stable mailbox.' });
  const body = (await readJsonBody(req)) || {};
  const result = await runSync({
    dryRun: body.dryRun === true,
    sinceDays: Number(body.sinceDays) > 0 ? Number(body.sinceDays) : 30,
    budgetMs: 20000,
    actor: normalizeEmail(user.email),
  });
  return json(200, Object.assign({ ok: true }, result));
}

// ── Node → record helpers ─────────────────────────────────────────────
function str(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'object') return String(v.name || v.text || v.fullName || '');
  return String(v);
}

function ocrToText(bytes, contentType) {
  if (!bytes || !bytes.length) return '';
  const raw = bytes.toString('utf8');
  const ct = String(contentType || '').toLowerCase();
  if (ct.indexOf('json') >= 0 || /^\s*[[{]/.test(raw)) {
    try {
      const parts = [];
      const walk = (v, k) => {
        if (typeof v === 'string') { if (!k || /text|content|value|line|word|description/i.test(k)) parts.push(v); }
        else if (Array.isArray(v)) v.forEach((x) => walk(x, k));
        else if (v && typeof v === 'object') Object.keys(v).forEach((kk) => walk(v[kk], kk));
      };
      walk(JSON.parse(raw), '');
      return parts.join(' ').replace(/\s+/g, ' ').trim();
    } catch (_) { /* fall through to plain text */ }
  }
  if (ct.indexOf('image/') === 0 || ct === 'application/pdf') return '';
  return raw.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

async function readOcr(urls, limit) {
  const out = [];
  let len = 0;
  for (const u of (Array.isArray(urls) ? urls : []).slice(0, 4)) {
    try {
      const got = await fetchTemp(u, 2 * 1024 * 1024);
      const t = got && got.bytes ? ocrToText(got.bytes, got.contentType) : '';
      if (t) { out.push(t); len += t.length; }
      if (len >= limit) break;
    } catch (e) { console.warn('[mail-sync] OCR fetch failed:', e && e.message); }
  }
  return out.join('\n').slice(0, limit);
}

function stableBlock(node) {
  const sd = node.scanDetails || {};
  const fd = node.forwardDetails || {};
  const dd = node.depositDetails || {};
  const sh = node.shredDetails || {};
  return {
    scanStatus: sd.status || '',
    scanNoticeType: sd.scanNoticeType || '',
    forwardStatus: fd.status || '',
    forwardId: fd.id || '',
    forwardTrackingNumber: fd.trackingNumber || '',
    forwardCostCents: fd.cost != null ? fd.cost : null,
    shredStatus: sh.status || '',
    depositStatus: dd.status || '',
    depositTrackingNumber: dd.trackingNumber || '',
    isReturnedToSender: !!node.isReturnedToSender,
    archivedAt: node.archivedAt || '',
    readAt: node.readAt || '',
    clearAt: node.clearAt || '',
    tags: (Array.isArray(node.tags) ? node.tags : []).map((t) => ({ id: t.id, name: t.name })),
    checks: (Array.isArray(node.checks) ? node.checks : []).map((c) => ({
      amount: c.amount != null ? c.amount : null,
      currency: c.currency || '',
      checkNumber: c.checkNumber || '',
      payer: str(c.payer),
      payee: str(c.payee),
      status: c.status || '',
    })),
  };
}

function isPending(item) {
  const s = item.stable || {};
  return ['scanStatus', 'forwardStatus', 'shredStatus', 'depositStatus'].some((k) => s[k] === 'processing');
}

async function storeImage(store, item, kind, url) {
  if (!url) return null;
  try {
    const got = await fetchTemp(url, MAX_IMG_BYTES);
    if (!got || !got.bytes) return null;
    await store.set('img/' + safeId(item.id) + '/' + kind, got.bytes, { metadata: { contentType: got.contentType || 'application/octet-stream' } });
    if (kind === 'envelope') item.hasEnvelope = true;
    if (kind === 'scan') item.hasScan = true;
    return got;
  } catch (e) {
    console.warn('[mail-sync] ' + kind + ' image download failed for ' + item.id + ':', e && e.message);
    return null;
  }
}

async function ingestNew(store, node) {
  const now = new Date().toISOString();
  const r = node.recipients || {};
  const loc = node.location || {};
  const la = loc.address || {};
  const item = {
    id: node.id,
    barcodeId: node.barcodeId || '',
    from: str(node.from),
    recipientLine1: (r.line1 && r.line1.text) || '',
    recipientLine2: (r.line2 && r.line2.text) || '',
    recipientName: (r.business && r.business.name) ||
      ((r.individual && ((r.individual.firstName || '') + ' ' + (r.individual.lastName || '')).trim()) || ''),
    locationId: loc.id || '',
    locationAddress: [la.line1, la.line2, la.city, la.state, la.postalCode].filter(Boolean).join(', '),
    receivedAt: node.createdAt || now,
    firstSeenAt: now,
    sort: 'unsorted',
    location: node.isReturnedToSender ? 'returned' : 'at_stable',
    category: '',
    stable: stableBlock(node),
    scanSummary: (node.scanDetails && node.scanDetails.summary) || '',
    events: [],
    needsAi: true,
  };
  pushEvent(item, 'received', { note: 'Received at Stable' + (item.locationAddress ? ' (' + item.locationAddress + ')' : '') });
  await storeImage(store, item, 'envelope', node.imageUrl);
  item.ocrText = await readOcr(node.ocrResultUrls, 6000);
  if (item.stable.scanStatus === 'completed' && node.scanDetails && node.scanDetails.imageUrl) {
    await storeImage(store, item, 'scan', node.scanDetails.imageUrl);
    item.scanOcrText = await readOcr(node.scanDetails.ocrResultUrls, 8000);
    pushEvent(item, 'scanned', { note: 'Opened and scanned at Stable' });
  }
  await putItem(item, store);
  await setPointer('unsorted', item, null, store);
  await setPointer('all', item, null, store);
  await setPointer('needsai', item, null, store);
  if (isPending(item)) await setPointer('pending', item, null, store);
  return item;
}

/** Fold a fresh Stable node into an existing record. Returns true if anything changed. */
async function applyRefresh(store, item, node) {
  const prev = item.stable || {};
  const next = stableBlock(node);
  let changed = JSON.stringify(prev) !== JSON.stringify(next);

  if (next.scanStatus === 'completed' && prev.scanStatus !== 'completed') {
    pushEvent(item, 'scanned', { note: 'Opened and scanned at Stable' });
    if (node.scanDetails && node.scanDetails.imageUrl) await storeImage(store, item, 'scan', node.scanDetails.imageUrl);
    item.scanSummary = (node.scanDetails && node.scanDetails.summary) || item.scanSummary || '';
    item.scanOcrText = await readOcr(node.scanDetails && node.scanDetails.ocrResultUrls, 8000);
    if (item.sort === 'unsorted') { item.needsAi = true; await setPointer('needsai', item, null, store); }
    changed = true;
  }
  if (next.forwardStatus && next.forwardStatus !== prev.forwardStatus) {
    if (next.forwardStatus === 'processing') {
      pushEvent(item, 'forward_requested', { note: 'Forwarding requested at Stable' });
      item.location = 'in_transit';
    } else if (next.forwardStatus === 'completed') {
      pushEvent(item, 'forward_shipped', { note: 'Shipped by Stable', trackingNumber: next.forwardTrackingNumber || '' });
      item.location = 'in_transit';
    }
    changed = true;
  }
  if (next.forwardTrackingNumber && next.forwardTrackingNumber !== prev.forwardTrackingNumber) {
    pushEvent(item, 'tracking', { note: 'Tracking number issued', trackingNumber: next.forwardTrackingNumber });
    item.location = 'in_transit';
    changed = true;
  }
  if (next.shredStatus === 'completed' && prev.shredStatus !== 'completed') {
    pushEvent(item, 'shredded', { note: 'Shredded at Stable' });
    item.location = 'shredded';
    changed = true;
  }
  if (next.depositStatus === 'completed' && prev.depositStatus !== 'completed') {
    pushEvent(item, 'deposited', { note: 'Check deposited', trackingNumber: next.depositTrackingNumber || '' });
    item.location = 'deposited';
    changed = true;
  }
  if (next.isReturnedToSender && !prev.isReturnedToSender) {
    pushEvent(item, 'returned', { note: 'Returned to sender' });
    item.location = 'returned';
    changed = true;
  }
  item.stable = next;
  return changed;
}

async function loadMedia(store, item) {
  const media = {};
  for (const kind of ['envelope', 'scan']) {
    try {
      const got = await store.getWithMetadata('img/' + safeId(item.id) + '/' + kind, { type: 'arrayBuffer' });
      if (got && got.data) media[kind] = { bytes: Buffer.from(got.data), contentType: (got.metadata && got.metadata.contentType) || '' };
    } catch (_) { /* no image stored */ }
  }
  return media;
}

// ── The sync ─────────────────────────────────────────────────────────
export async function runSync(opts) {
  opts = opts || {};
  const t0 = Date.now();
  const budgetMs = opts.budgetMs || 20000;
  const dryRun = !!opts.dryRun;
  const store = mailStore();
  const runStart = new Date().toISOString();
  const meta = (await store.get('meta/sync', { type: 'json' }).catch(() => null)) || {};
  const since = meta.lastCreatedAt
    ? new Date(Date.parse(meta.lastCreatedAt) - 2 * 3600 * 1000).toISOString()
    : new Date(Date.now() - (opts.sinceDays || 30) * 86400 * 1000).toISOString();

  const out = { dryRun, since, fetched: 0, created: 0, updated: 0, unchanged: 0, pendingRefreshed: 0, suggested: 0, errors: [], budgetStopped: false };

  // 1. Page through new items.
  const nodes = [];
  let after = null;
  for (let page = 0; page < (opts.maxPages || 6); page++) {
    const r = await listMailItems({ createdAfter: since, first: 50, after });
    nodes.push.apply(nodes, r.items);
    if (!r.pageInfo || !r.pageInfo.hasNextPage || !r.pageInfo.endCursor) break;
    after = r.pageInfo.endCursor;
    if (Date.now() - t0 > budgetMs / 3) break;
  }
  out.fetched = nodes.length;
  nodes.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));

  let watermark = meta.lastCreatedAt || '';
  let sawCreatedAt = false;
  for (const node of nodes) {
    if (Date.now() - t0 > budgetMs) { out.budgetStopped = true; break; }
    try {
      const existing = await getItem(node.id, store);
      if (!existing) {
        if (!dryRun) await ingestNew(store, node);
        out.created += 1;
      } else if (dryRun) {
        out.unchanged += 1;
      } else {
        const changed = await applyRefresh(store, existing, node);
        if (changed) {
          await putItem(existing, store);
          if (isPending(existing)) await setPointer('pending', existing, null, store);
          else await delPointer('pending', existing, null, store);
          out.updated += 1;
        } else out.unchanged += 1;
      }
      if (node.createdAt) { sawCreatedAt = true; if (node.createdAt > watermark) watermark = node.createdAt; }
    } catch (e) {
      out.errors.push({ id: node.id, error: (e && e.message) || String(e) });
    }
  }

  // 2. Refresh anything with a Stable action still processing.
  if (!dryRun && !out.budgetStopped) {
    const pend = await listPointers('p/pending/', {}, store);
    for (const p of pend.slice(0, 40)) {
      if (Date.now() - t0 > budgetMs * 0.6) break;
      try {
        const item = await getItem(p.safeId, store);
        if (!item) { await store.delete(p.key).catch(() => {}); continue; }
        const node = await getMailItem(item.id);
        if (node && await applyRefresh(store, item, node)) {
          await putItem(item, store);
          out.pendingRefreshed += 1;
        }
        if (!isPending(item)) await store.delete(p.key).catch(() => {});
      } catch (e) {
        out.errors.push({ id: p.safeId, error: 'pending refresh: ' + ((e && e.message) || '') });
      }
    }
  }

  // 3. Suggestions.
  if (!dryRun) {
    const queue = await listPointers('p/needsai/', {}, store);
    let loans = null;
    for (const p of queue) {
      if (Date.now() - t0 > budgetMs) { out.budgetStopped = true; break; }
      try {
        const item = await getItem(p.safeId, store);
        if (!item || item.sort !== 'unsorted') { await store.delete(p.key).catch(() => {}); continue; }
        if (!loans) loans = await loadCandidateLoans();
        item.suggestion = await suggestForItem(item, await loadMedia(store, item), loans);
        item.needsAi = false;
        await putItem(item, store);
        await store.delete(p.key).catch(() => {});
        out.suggested += 1;
      } catch (e) {
        out.errors.push({ id: p.safeId, error: 'suggestion: ' + ((e && e.message) || '') });
      }
    }
  }

  if (!dryRun) {
    await store.setJSON('meta/sync', {
      // No createdAt on the nodes at all → fall back to the run start so the
      // window still moves forward (the 2h overlap covers the listing gap).
      lastCreatedAt: sawCreatedAt ? watermark : (out.budgetStopped ? (meta.lastCreatedAt || '') : runStart),
      lastRunAt: runStart,
      lastResult: Object.assign({}, out, { errors: out.errors.slice(0, 10) }),
      actor: opts.actor || 'auto:mail-sync',
    });
  }
  out.ms = Date.now() - t0;
  return out;
}
