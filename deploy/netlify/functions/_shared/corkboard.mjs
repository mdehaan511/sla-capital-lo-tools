/**
 * _shared/corkboard.mjs — Deploy 237.191
 *
 * THE CORK BOARD. Dan's idea, by way of Mike: *"Do you think it would be
 * possible to have a virtual cork board in the armory? I was thinking it would
 * be cool if people could 'pin' photos or notes on a virtual cork board like
 * you'd see in an office."* Mike's shape: it REPLACES the Company News tab and
 * becomes Company & Team News — the regular cards (Closing Bell, Town Crier,
 * Celebrations, Herald's Board) pin themselves to the board automatically, and
 * everyone else gets the rest of the cork to pin notes and photos on, drag
 * around, resize, tilt and overlap. Anything pinned falls off after two weeks
 * unless someone says to keep it longer.
 *
 * Storage — the existing `armory` blob store (strong), one doc per pinned item:
 *
 *   board/<id>   { id, kind, text, caption, color, author, x, y, w, rot, z,
 *                  keep, createdAt, expiresAt, reactions, photo }
 *
 * One doc per item on purpose: two people dragging at the same time never
 * read-modify-write the same blob, which is exactly the mistake the scores
 * board avoided for the same reason.
 *
 * The four house cards are items too — ids `sys_bell`, `sys_crier`,
 * `sys_cele`, `sys_herald`. Their doc holds ONLY geometry; the content is
 * rendered client-side from the armory state that was already on the page.
 * That way a house card drags, tilts and stacks through exactly the same code
 * as a sticky note, and there is no second layout document to keep in sync.
 *
 * Photos live in their own store (`armory-board-photos`) as BASE64 TEXT, the
 * same way envelope PDFs are stored — never a Buffer. They are served by
 * armory-photo.mjs through a short-lived HMAC-signed URL, because an <img>
 * tag cannot send a bearer token (the broker one-pager learned this the hard
 * way with a plain <a>). The signature is over the id + expiry with
 * ESIGN_SEAL_SECRET, the same secret family as every other signed link here.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './auth.mjs';
import { touchPulse } from './armory.mjs';

const STORE = 'armory';
const PHOTO_STORE = 'armory-board-photos';

// Two weeks is the default life of a pin (Mike). Anything longer is a
// deliberate choice by whoever pinned it — a birthday card should outlive the
// lunch menu.
export const KEEP_OPTIONS = {
  '2w':      { label: '2 weeks',  days: 14 },
  '1m':      { label: '1 month',  days: 31 },
  '3m':      { label: '3 months', days: 92 },
  'forever': { label: 'Until I take it down', days: 0 },
};
export const DEFAULT_KEEP = '2w';

// The house cards. Fixed ids, never deleted, never expire.
export const SYSTEM_ITEMS = {
  sys_bell:   { title: 'The Closing Bell', defaults: { x: 24,  y: 20,  w: 360, rot: -1.2 } },
  sys_crier:  { title: 'The Town Crier',   defaults: { x: 24,  y: 470, w: 360, rot: 1.0 } },
  sys_cele:   { title: 'Celebrations',     defaults: { x: 410, y: 20,  w: 330, rot: 0.8 } },
  sys_herald: { title: "Herald's Board",   defaults: { x: 410, y: 340, w: 330, rot: -0.7 } },
};
export function isSystemId(id) { return Object.prototype.hasOwnProperty.call(SYSTEM_ITEMS, String(id || '')); }

const MAX_ITEMS = 160;          // a cork board, not a photo library
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;   // ~3MB of base64 after the client downscales
const REACTIONS = ['👍', '🔥', '😂', '🎉', '❤️'];
export const REACTION_SET = REACTIONS;

function _store()  { return getStore({ name: STORE, consistency: 'strong' }); }
function _photos() { return getStore({ name: PHOTO_STORE, consistency: 'strong' }); }

function _str(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function _num(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}
export function newItemId() { return 'pin_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex'); }

function _expiryFor(keep, from) {
  const k = KEEP_OPTIONS[keep] ? keep : DEFAULT_KEEP;
  if (!KEEP_OPTIONS[k].days) return '';                  // forever = no expiry
  const base = from ? new Date(from) : new Date();
  return new Date(base.getTime() + KEEP_OPTIONS[k].days * 86400000).toISOString();
}

// ── Signed photo URLs ─────────────────────────────────────────────
// <img src> cannot carry an Authorization header, so the photo endpoint is
// public and the URL itself is the credential: unguessable, and it stops
// working after PHOTO_URL_DAYS. The board re-signs on every read, so a photo
// on the wall never goes stale for someone with the page open.
const PHOTO_URL_DAYS = 7;
function _secret() { return process.env.ESIGN_SEAL_SECRET || ''; }
export function signPhoto(id, expMs) {
  const s = _secret();
  if (!s) return '';
  const exp = expMs || (Date.now() + PHOTO_URL_DAYS * 86400000);
  const sig = createHmac('sha256', s).update('board-photo:' + id + ':' + exp).digest('hex').slice(0, 32);
  return '/api/armory-photo?id=' + encodeURIComponent(id) + '&e=' + exp + '&s=' + sig;
}
export function verifyPhotoSig(id, exp, sig) {
  const s = _secret();
  if (!s) return false;
  const e = Number(exp);
  if (!isFinite(e) || e < Date.now()) return false;
  const want = createHmac('sha256', s).update('board-photo:' + id + ':' + e).digest('hex').slice(0, 32);
  const a = Buffer.from(String(sig || ''));
  const b = Buffer.from(want);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── Item shape ────────────────────────────────────────────────────
function _clean(raw) {
  const x = raw || {};
  const kind = (x.kind === 'photo' || x.kind === 'system') ? x.kind : 'note';
  const keep = KEEP_OPTIONS[x.keep] ? x.keep : DEFAULT_KEEP;
  const item = {
    id:        _str(x.id, 60),
    kind,
    text:      _str(x.text, 1200),
    caption:   _str(x.caption, 200),
    color:     _str(x.color, 20) || 'yellow',
    author:    {
      email: normalizeEmail((x.author && x.author.email) || ''),
      name:  _str((x.author && x.author.name) || '', 120),
      avatar: _str((x.author && x.author.avatar) || '', 40),
    },
    // Board coordinates are in the board's own pixel space (the client scales
    // the whole surface), so they survive any viewport.
    x:   _num(x.x, -200, 4000, 40),
    y:   _num(x.y, -200, 8000, 40),
    w:   _num(x.w, 120, 900, 240),
    rot: _num(x.rot, -14, 14, 0),
    z:   _num(x.z, 0, 99999, 1),
    keep,
    createdAt: _str(x.createdAt, 40) || new Date().toISOString(),
    updatedAt: _str(x.updatedAt, 40) || new Date().toISOString(),
    expiresAt: _str(x.expiresAt, 40),
    reactions: {},
    photo:     x.photo ? { w: _num(x.photo.w, 1, 8000, 800), h: _num(x.photo.h, 1, 8000, 600), type: _str(x.photo.type, 40) || 'image/jpeg' } : null,
  };
  // reactions: emoji -> [emails]
  const r = (x.reactions && typeof x.reactions === 'object') ? x.reactions : {};
  REACTIONS.forEach((emo) => {
    const list = Array.isArray(r[emo]) ? r[emo] : [];
    const seen = {};
    const clean = [];
    list.forEach((e) => { const n = normalizeEmail(e); if (n && !seen[n]) { seen[n] = 1; clean.push(n); } });
    if (clean.length) item.reactions[emo] = clean.slice(0, 200);
  });
  if (isSystemId(item.id)) item.kind = 'system';
  return item;
}

export function isExpired(item, now) {
  if (!item || !item.expiresAt) return false;
  return new Date(item.expiresAt).getTime() <= (now || Date.now());
}

/**
 * Everything currently on the board, oldest first (z decides paint order).
 * Expired pins are dropped from the answer AND deleted on the way past — a
 * lazy purge, so the board needs no cron of its own.
 */
export async function listBoard() {
  const store = _store();
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix: 'board/', cursor });
    (page && page.blobs || []).forEach((b) => { if (b && b.key) keys.push(b.key); });
    cursor = page && page.cursor;
  } while (cursor);

  const docs = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)));
  const now = Date.now();
  const live = [];
  const dead = [];
  docs.forEach((d) => {
    if (!d || !d.id) return;
    const item = _clean(d);
    if (isExpired(item, now)) dead.push(item); else live.push(item);
  });
  if (dead.length) {
    // Best-effort sweep; a failure here just means it gets another go next read.
    await Promise.all(dead.map((it) => removeItem(it.id).catch(() => null)));
  }
  live.sort((a, b) => (a.z - b.z) || String(a.createdAt).localeCompare(String(b.createdAt)));
  return live.map((it) => (it.kind === 'photo' ? Object.assign({}, it, { photoUrl: signPhoto(it.id) }) : it));
}

export async function getItem(id) {
  const doc = await _store().get('board/' + _str(id, 60), { type: 'json' }).catch(() => null);
  return doc && doc.id ? _clean(doc) : null;
}

async function _put(item) {
  item.updatedAt = new Date().toISOString();
  await _store().setJSON('board/' + item.id, item);
  return item;
}

export async function countItems() {
  const items = await listBoard();
  return items.filter((i) => i.kind !== 'system').length;
}

/** Create a note or a photo card. */
export async function createItem(user, body, photoBase64) {
  const count = await countItems();
  if (count >= MAX_ITEMS) {
    throw new Error('The board is full (' + MAX_ITEMS + ' pins). Take something down first.');
  }
  const id = newItemId();
  const kind = body && body.kind === 'photo' ? 'photo' : 'note';
  if (kind === 'photo') {
    const b64 = String(photoBase64 || '');
    if (!b64) throw new Error('No photo received');
    if (b64.length > MAX_PHOTO_BYTES) throw new Error('That photo is too large even after resizing — try a smaller one.');
    await _photos().set(id, b64);          // BASE64 TEXT, never a Buffer
  } else if (!_str(body && body.text, 1200)) {
    throw new Error('Write something on the note first');
  }
  const item = _clean({
    id,
    kind,
    text:    body && body.text,
    caption: body && body.caption,
    color:   body && body.color,
    author:  { email: user.email, name: (body && body.authorName) || '', avatar: (body && body.avatar) || '' },
    x: body && body.x, y: body && body.y, w: body && body.w, rot: body && body.rot, z: body && body.z,
    keep: body && body.keep,
    photo: body && body.photo,
  });
  item.expiresAt = _expiryFor(item.keep);
  await _put(item);
  await touchPulse('board', (item.author.name || 'Someone') + ' pinned something to the cork board');
  return item;
}

/**
 * Geometry only: x / y / w / rot / z. ANYONE on the team may rearrange the
 * board — it is a shared wall in a shared office, and locking pins to their
 * author would make tidying up impossible. Content and lifespan are a
 * different matter (see editItem).
 */
export async function moveItem(user, body) {
  const id = _str(body && body.id, 60);
  if (!id) throw new Error('id required');
  let item = await getItem(id);
  if (!item) {
    // A house card that has never been dragged has no doc yet — mint it at the
    // position it was dropped.
    if (!isSystemId(id)) throw new Error('That pin is no longer on the board');
    item = _clean({ id, kind: 'system', keep: 'forever' });
  }
  ['x', 'y', 'w', 'rot', 'z'].forEach((k) => { if (body[k] !== undefined && body[k] !== null) item[k] = body[k]; });
  const cleaned = _clean(item);
  cleaned.expiresAt = isSystemId(id) ? '' : item.expiresAt;
  cleaned.movedBy = normalizeEmail(user.email);
  return _put(cleaned);
}

/** Text, caption, colour and lifespan — author or admin only. */
export async function editItem(user, body, isAdminUser) {
  const id = _str(body && body.id, 60);
  const item = await getItem(id);
  if (!item) throw new Error('That pin is no longer on the board');
  if (isSystemId(id)) throw new Error('House cards are not editable');
  const me = normalizeEmail(user.email);
  if (item.author.email !== me && !isAdminUser) throw new Error('Only the person who pinned it (or an admin) can change it');
  if (body.text !== undefined)    item.text = body.text;
  if (body.caption !== undefined) item.caption = body.caption;
  if (body.color !== undefined)   item.color = body.color;
  const cleaned = _clean(item);
  if (body.keep !== undefined && KEEP_OPTIONS[body.keep]) {
    cleaned.keep = body.keep;
    // Measure the new life from NOW, so "keep this up" on a pin about to fall
    // off does the obvious thing.
    cleaned.expiresAt = _expiryFor(body.keep);
  }
  return _put(cleaned);
}

/** Toggle one of the fixed reaction stamps. */
export async function reactToItem(user, body) {
  const id = _str(body && body.id, 60);
  const emo = String((body && body.emoji) || '');
  if (REACTIONS.indexOf(emo) < 0) throw new Error('Unknown reaction');
  const item = await getItem(id);
  if (!item) throw new Error('That pin is no longer on the board');
  const me = normalizeEmail(user.email);
  const list = item.reactions[emo] || [];
  const at = list.indexOf(me);
  if (at >= 0) list.splice(at, 1); else list.push(me);
  if (list.length) item.reactions[emo] = list; else delete item.reactions[emo];
  return _put(item);
}

/** Internal delete — no permission check, used by the expiry sweep. */
export async function removeItem(id) {
  const key = _str(id, 60);
  await _store().delete('board/' + key).catch(() => null);
  await _photos().delete(key).catch(() => null);
}

/** Take a pin down — author or admin. House cards stay put. */
export async function deleteItem(user, id, isAdminUser) {
  const item = await getItem(id);
  if (!item) return true;
  if (isSystemId(item.id)) throw new Error('House cards cannot be taken down');
  const me = normalizeEmail(user.email);
  if (item.author.email !== me && !isAdminUser) throw new Error('Only the person who pinned it (or an admin) can take it down');
  await removeItem(item.id);
  return true;
}

/** The raw base64 for one photo (armory-photo.mjs serves it). */
export async function readPhoto(id) {
  return _photos().get(_str(id, 60), { type: 'text' }).catch(() => null);
}
