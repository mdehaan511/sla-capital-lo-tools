/**
 * _shared/mail-store.mjs — Deploy 236.995 (Mike, mail room)
 *
 * Storage + vocabulary for the portal's mail room (Processing → Mail).
 *
 * Blob store `mail_items`:
 *   m/<id>                       the mail record (JSON)
 *   img/<id>/envelope|scan       our copy of Stable's images (Stable URLs expire)
 *   p/unsorted/<ts>_<id>         pointer: waiting for the office assistant
 *   p/all/<ts>_<id>              pointer: chronological history
 *   p/loan/<loanId>/<ts>_<id>    pointer: filed to a loan
 *   p/pending/<ts>_<id>          pointer: a Stable action is still processing
 *   p/needsai/<ts>_<id>          pointer: suggestion not computed yet
 *   meta/sync, meta/alerts, meta/tags
 *
 * Pointers carry the id in the KEY (<ts> = receivedAt compacted, so keys sort
 * chronologically), which means listing a view costs a key listing plus one
 * read per row actually shown — never a full-store walk.
 */
import { getStore } from '@netlify/blobs';

// Kept deliberately short (Mike: "don't go too overboard").
export const MAIL_CATEGORIES = [
  ['recorded_instrument', 'Recorded Deed of Trust / Mortgage'],
  ['title_policy',        'Final Title Policy'],
  ['closing_originals',   'Original Note / Closing Originals'],
  ['check_payment',       'Check / Payment'],
  ['tax_insurance',       'Tax or Insurance Notice'],
  ['servicer_payoff',     'Servicer / Payoff Correspondence'],
  ['legal_notice',        'Legal / Government Notice'],
  ['general',             'General Correspondence'],
  ['junk',                'Junk / Marketing'],
];
export const CATEGORY_LABEL = Object.fromEntries(MAIL_CATEGORIES);

// Where the physical piece is right now.
export const MAIL_LOCATIONS = [
  ['at_stable',  'At Stable mailbox'],
  ['in_transit', 'In transit (forwarded)'],
  ['sla_office', 'At SLA office'],
  ['custodian',  'With custodian'],
  ['investor',   'Sent to investor / servicer'],
  ['shredded',   'Shredded'],
  ['deposited',  'Check deposited'],
  ['returned',   'Returned to sender'],
];
export const LOCATION_LABEL = Object.fromEntries(MAIL_LOCATIONS);

// Categories that ARE collateral documents → the loan's Collateral tracking
// fields (Deploy 236.622: <prefix>Date / <prefix>Location / <prefix>Tracking).
export const COLLATERAL_FOR_CATEGORY = {
  recorded_instrument: { prefix: 'recordedDot',     label: 'Recorded DOT' },
  title_policy:        { prefix: 'titlePolicy',     label: 'Final Title Policy' },
  closing_originals:   { prefix: 'signedOriginals', label: 'Signed Originals' },
};

// Unsorted this long → escalate to super admins.
export const OVERDUE_HOURS = 24;

export function mailStore() {
  return getStore({ name: 'mail_items', consistency: 'strong' });
}

export function safeId(id) {
  return String(id || '').replace(/[^A-Za-z0-9_-]/g, '_');
}

function compactTs(iso) {
  const t = Date.parse(iso || '');
  const d = t > 0 ? new Date(t) : new Date();
  return d.toISOString().replace(/[^0-9]/g, '').slice(0, 14);
}

/** receivedAt (ISO) recovered from a pointer key's <ts> segment. */
export function tsFromPointerKey(key) {
  const seg = String(key || '').split('/').pop() || '';
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})_/.exec(seg);
  return m ? (m[1] + '-' + m[2] + '-' + m[3] + 'T' + m[4] + ':' + m[5] + ':' + m[6] + 'Z') : '';
}

export function pointerKey(kind, item, loanId) {
  const leaf = compactTs(item.receivedAt) + '_' + safeId(item.id);
  if (kind === 'loan') return 'p/loan/' + safeId(loanId) + '/' + leaf;
  return 'p/' + kind + '/' + leaf;
}

export async function getItem(id, store) {
  return (store || mailStore()).get('m/' + safeId(id), { type: 'json' }).catch(() => null);
}

export async function putItem(item, store) {
  item.updatedAt = new Date().toISOString();
  await (store || mailStore()).setJSON('m/' + safeId(item.id), item);
  return item;
}

export async function setPointer(kind, item, loanId, store) {
  await (store || mailStore()).set(pointerKey(kind, item, loanId), '1');
}

export async function delPointer(kind, item, loanId, store) {
  try { await (store || mailStore()).delete(pointerKey(kind, item, loanId)); } catch (_) { /* already gone */ }
}

/**
 * Pointer keys under a prefix, sorted. Returns [{ key, safeId, receivedAt }].
 * newestFirst for history views; oldest first for the work queue.
 */
export async function listPointers(prefix, opts, store) {
  opts = opts || {};
  const { blobs } = await (store || mailStore()).list({ prefix });
  const rows = (blobs || []).map((b) => {
    const leaf = String(b.key).split('/').pop() || '';
    const us = leaf.indexOf('_');
    return { key: b.key, safeId: us >= 0 ? leaf.slice(us + 1) : leaf, receivedAt: tsFromPointerKey(b.key) };
  });
  rows.sort((a, b) => a.key.localeCompare(b.key));
  if (opts.newestFirst) rows.reverse();
  return rows;
}

export function pushEvent(item, type, fields) {
  item.events = Array.isArray(item.events) ? item.events : [];
  item.events.push(Object.assign({ at: new Date().toISOString(), type }, fields || {}));
  if (item.events.length > 200) item.events = item.events.slice(-200);
}

/** List-row projection (no OCR text, no candidates). */
// Deploy 237.257 (Mike: the second Stable address, 2261 Market Street #94354, "we will plan
// to start having all mail sent there and will wind down the current seattle address").
// The sync has always pulled every location on the account (no locationId filter; the
// Spokane box proved it), but nothing in the portal SAID which box a piece arrived at.
// A short label for the list, the full line for the detail pane and the email.
export function mailboxOf(item) {
  const a = String((item && item.locationAddress) || '');
  if (!a) return '';
  if (/san francisco|94114|2261 market/i.test(a)) return 'San Francisco';
  if (/seattle/i.test(a)) return 'Seattle';
  if (/spokane/i.test(a)) return 'Spokane';
  const parts = a.split(',').map((x) => x.trim()).filter(Boolean);
  return parts.length >= 3 ? parts[parts.length - 3] : parts[0];
}

export function slimItem(item) {
  if (!item) return null;
  const s = item.suggestion || {};
  return {
    id: item.id,
    mailbox: mailboxOf(item),                       // Deploy 237.257
    mailboxAddress: item.locationAddress || '',
    receivedAt: item.receivedAt,
    from: item.from || '',
    recipient: item.recipientName || item.recipientLine1 || '',
    sort: item.sort || 'unsorted',
    category: item.category || '',
    categoryLabel: CATEGORY_LABEL[item.category] || '',
    location: item.location || 'at_stable',
    locationLabel: LOCATION_LABEL[item.location || 'at_stable'] || '',
    hasEnvelope: !!item.hasEnvelope,
    hasScan: !!item.hasScan,
    scanStatus: (item.stable && item.stable.scanStatus) || '',
    trackingNumber: (item.stable && item.stable.forwardTrackingNumber) || '',
    checkCount: (item.stable && Array.isArray(item.stable.checks)) ? item.stable.checks.length : 0,
    assignment: item.assignment || null,
    suggestion: item.sort === 'unsorted' ? {
      loanId: s.loanId || '', address: s.address || '', borrower: s.borrower || '',
      confidence: s.confidence || '', category: s.category || '', pending: !!item.needsAi,
    } : null,
  };
}
