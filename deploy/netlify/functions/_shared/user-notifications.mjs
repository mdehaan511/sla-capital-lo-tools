/**
 * _shared/user-notifications.mjs — Deploy 237.050 (Mike)
 *
 * Per-user in-app notifications (today: @-mentions in loan notes; the bell
 * renders them under "Mentions"). ONE JSON doc per user in the
 * `user_notifications` blob store, keyed keySafe(email):
 *
 *   { email, updatedAt, items: [ { id, kind: 'mention', createdAt,
 *       fromEmail, fromName, loanId, clientId, owner, address, borrower,
 *       noteId, snippet } ] }
 *
 * Newest first, capped at MAX_ITEMS and pruned past MAX_AGE_DAYS on every
 * read/write; dismiss = delete. Single-doc-per-user so the notification
 * bell's 60s poll costs exactly one blob read (no list + N gets).
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

const STORE = 'user_notifications';
const MAX_ITEMS = 100;
const MAX_AGE_MS = 30 * 86400000;

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

export async function listUserNotifications(email) {
  const doc = await _store().get(_key(email), { type: 'json' }).catch(() => null);
  return _prune(doc && doc.items);
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
