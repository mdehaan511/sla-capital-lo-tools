/**
 * _shared/user-notifications.mjs — Deploy 237.050 (Mike)
 *
 * Per-user in-app notifications. ONE JSON doc per user in the `user_notifications`
 * blob store, keyed keySafe(email):
 *
 *   { email, updatedAt, items: [ { id, kind, createdAt, readAt, ...payload } ] }
 *
 * Newest first, capped at MAX_ITEMS and pruned past MAX_AGE_DAYS on every read/write.
 * Single-doc-per-user so the bell's 60s poll costs exactly one blob read.
 *
 * Deploy 237.197 (Mike, the notifications page) -- **READ/UNREAD, NOT DELETE.**
 * The tick on a bell item used to DELETE the notification, which is why there was no
 * history to show and nothing to mark unread again. It now stamps `readAt`; an item
 * without one is unread. Deleting still exists (dismissUserNotifications) but is a
 * deliberate act, not the everyday one.
 *
 * Retention grew with the purpose: 30 days / 100 items was a bell's memory, not a
 * record. The bell asks for UNREAD ONLY so its poll does not start shipping six
 * months of history to the browser every minute.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

const STORE = 'user_notifications';
const MAX_ITEMS = 400;                       // Deploy 237.197 -- was 100
const MAX_AGE_MS = 180 * 86400000;           // Deploy 237.197 -- was 30 days

function _store() { return getStore({ name: STORE, consistency: 'strong' }); }
function _key(email) { return keySafe(normalizeEmail(email)); }
function _prune(items) {
  const cutoff = Date.now() - MAX_AGE_MS;
  return (Array.isArray(items) ? items : [])
    .filter((it) => it && it.id && new Date(it.createdAt || 0).getTime() >= cutoff)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))
    .slice(0, MAX_ITEMS);
}

export function makeNotificationId() {
  return 'nt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

/**
 * @param opts.unreadOnly  the bell passes this; the page does not
 */
export async function listUserNotifications(email, opts) {
  const doc = await _store().get(_key(email), { type: 'json' }).catch(() => null);
  const items = _prune(doc && doc.items);
  return (opts && opts.unreadOnly) ? items.filter((it) => !it.readAt) : items;
}

/** How many are unread — the number on the bell. */
export async function unreadCount(email) {
  const items = await listUserNotifications(email, { unreadOnly: true });
  return items.length;
}

/**
 * Mark items read (or unread again). Deploy 237.197.
 * @param ids    ids to change; ignored when `all` is true
 * @param all    every item
 * @param unread true = mark UNREAD instead of read
 * @returns { changed, unread }
 */
export async function markUserNotifications(email, { ids, all, unread } = {}) {
  const store = _store();
  const key = _key(email);
  const doc = (await store.get(key, { type: 'json' }).catch(() => null)) || {};
  const items = _prune(doc.items);
  const want = new Set((Array.isArray(ids) ? ids : []).map(String));
  const stamp = unread ? '' : new Date().toISOString();
  let changed = 0;
  for (const it of items) {
    if (!all && !want.has(String(it.id))) continue;
    const was = it.readAt || '';
    if (unread) { if (!was) continue; delete it.readAt; changed++; }
    else { if (was) continue; it.readAt = stamp; changed++; }
  }
  if (changed) {
    await store.setJSON(key, { email: normalizeEmail(email), items, updatedAt: new Date().toISOString() });
  }
  return { changed, unread: items.filter((it) => !it.readAt).length };
}

export async function pushUserNotification(email, item) {
  const store = _store();
  const key = _key(email);
  const doc = (await store.get(key, { type: 'json' }).catch(() => null)) || {};
  const entry = Object.assign({ id: makeNotificationId(), createdAt: new Date().toISOString() }, item || {});
  const items = _prune([entry].concat(Array.isArray(doc.items) ? doc.items : []));
  await store.setJSON(key, { email: normalizeEmail(email), items, updatedAt: new Date().toISOString() });
  return entry;
}

export async function dismissUserNotifications(email, ids, all) {
  const store = _store();
  const key = _key(email);
  const doc = (await store.get(key, { type: 'json' }).catch(() => null)) || {};
  const before = _prune(doc.items);
  const drop = new Set((Array.isArray(ids) ? ids : []).map(String));
  const items = all ? [] : before.filter((it) => !drop.has(String(it.id)));
  await store.setJSON(key, { email: normalizeEmail(email), items, updatedAt: new Date().toISOString() });
  return { removed: before.length - items.length, remaining: items.length };
}
