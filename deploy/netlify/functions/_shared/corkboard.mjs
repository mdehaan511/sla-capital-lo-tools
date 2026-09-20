/**
 * _shared/corkboard.mjs — Deploy 237.191, reworked 237.192
 *
 * THE CORK BOARD. Dan's idea, by way of Mike: *"Do you think it would be
 * possible to have a virtual cork board in the armory? I was thinking it would
 * be cool if people could 'pin' photos or notes on a virtual cork board like
 * you'd see in an office."* It replaces Company News and becomes Company &
 * Team News.
 *
 * 237.192 (Mike) — the four house cards are now FIXED POSTERS, not draggable
 * pins: the Closing Bell hangs down the left of the board and the Herald's
 * Board down the right, with the Town Crier under the Bell on the left and
 * Celebrations fixed at the top right. The whole middle channel, and
 * everything below the posters, is the team's. Their geometry is therefore a
 * client-side constant (LAYOUT in armory-board.js) and no longer stored —
 * any sys_* doc left over from 237.191 is swept on the next read.
 *
 * Storage — the existing `armory` blob store (strong):
 *
 *   board/<id>            one doc per pin
 *   board-mute/<id>       tombstone: an auto-pin somebody took down, so the
 *                         next sync does not cheerfully put it back
 *   board-archive/<YYYY-MM>  a snapshot of the wall at the end of that month
 *
 * One doc per pin on purpose: two people dragging at the same time never
 * read-modify-write the same blob — the same reason the scores board is one
 * doc per player per month.
 *
 * Photos live in their own store (`armory-board-photos`) as BASE64 TEXT, the
 * way envelope PDFs are stored — never a Buffer. They are served by
 * armory-photo.mjs through a short-lived HMAC-signed URL, because an <img>
 * tag cannot send a bearer token (the broker one-pager learned this with an
 * <a>). The signature covers the id and an expiry, with ESIGN_SEAL_SECRET.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { normalizeEmail } from './auth.mjs';
import { touchPulse } from './armory.mjs';
import { pushUserNotification } from './user-notifications.mjs';

const STORE = 'armory';
const PHOTO_STORE = 'armory-board-photos';

// Two weeks is the default life of a pin (Mike). Anything longer is a
// deliberate choice by whoever pinned it — a birthday card should outlive the
// lunch menu.
export const KEEP_OPTIONS = {
  '1w':      { label: '1 week',   days: 7 },
  '2w':      { label: '2 weeks',  days: 14 },
  '1m':      { label: '1 month',  days: 31 },
  '3m':      { label: '3 months', days: 92 },
  'forever': { label: 'Until I take it down', days: 0 },
};
export const DEFAULT_KEEP = '2w';

// The four house cards. Fixed posters since 237.192 — the ids survive only so
// old docs can be recognised and swept.
export const SYSTEM_IDS = ['sys_bell', 'sys_crier', 'sys_cele', 'sys_herald'];
export function isSystemId(id) { return SYSTEM_IDS.indexOf(String(id || '')) >= 0; }

// note / photo are what people pin; tape and arrow are decoration (Mike: "add
// all of those ideas") — no text, just something to point with or hold a
// corner down.
export const KINDS = ['note', 'photo', 'tape', 'arrow'];
const MAX_ITEMS = 160;                      // a cork board, not a photo library
const MAX_PHOTO_BYTES = 3 * 1024 * 1024;    // ~3MB of base64 after the client downscales
const REACTIONS = ['👍', '🔥', '😂', '🎉', '❤️'];
export const REACTION_SET = REACTIONS;

// The free cork: the middle channel between the two poster columns, and
// everything below them. Auto-pins and anything the client does not place
// itself land here. Mirrors LAYOUT in armory-board.js.
const FREE_X0 = 340, FREE_X1 = 780, FREE_Y0 = 40, FREE_STEP_X = 130, FREE_STEP_Y = 140;
const BELOW_Y = 980;

function _store()  { return getStore({ name: STORE, consistency: 'strong' }); }
function _photos() { return getStore({ name: PHOTO_STORE, consistency: 'strong' }); }

function _str(v, n) { return String(v == null ? '' : v).trim().slice(0, n); }
function _num(v, min, max, dflt) {
  const n = Number(v);
  if (!isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100));
}
export function newItemId() { return 'pin_' + Date.now().toString(36) + '_' + randomBytes(3).toString('hex'); }

function _expiryFor(keep, fromMs) {
  const k = KEEP_OPTIONS[keep] ? keep : DEFAULT_KEEP;
  if (!KEEP_OPTIONS[k].days) return '';                  // forever = no expiry
  return new Date((fromMs || Date.now()) + KEEP_OPTIONS[k].days * 86400000).toISOString();
}

// ── Signed photo URLs ─────────────────────────────────────────────
// <img src> cannot carry an Authorization header, so the photo endpoint is
// public and the URL itself is the credential: unguessable, and dead after
// PHOTO_URL_DAYS. The board re-signs on every read.
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
  const kind = KINDS.indexOf(x.kind) >= 0 ? x.kind : 'note';
  const keep = KEEP_OPTIONS[x.keep] ? x.keep : DEFAULT_KEEP;
  const item = {
    id:        _str(x.id, 60),
    kind,
    text:      _str(x.text, 1200),
    caption:   _str(x.caption, 200),
    color:     _str(x.color, 20) || 'yellow',
    author:    {
      email:  normalizeEmail((x.author && x.author.email) || ''),
      name:   _str((x.author && x.author.name) || '', 120),
      avatar: _str((x.author && x.author.avatar) || '', 40),
    },
    // Board coordinates are in the board's own pixel space (the client scales
    // the surface), so they survive any viewport.
    x:   _num(x.x, -200, 4000, 400),
    y:   _num(x.y, -200, 8000, 60),
    w:   _num(x.w, 40, 900, 240),
    rot: _num(x.rot, -45, 45, 0),
    z:   _num(x.z, 0, 99999, 1),
    keep,
    createdAt: _str(x.createdAt, 40) || new Date().toISOString(),
    updatedAt: _str(x.updatedAt, 40) || new Date().toISOString(),
    expiresAt: _str(x.expiresAt, 40),
    reactions: {},
    photo:     x.photo ? { w: _num(x.photo.w, 1, 8000, 800), h: _num(x.photo.h, 1, 8000, 600), type: _str(x.photo.type, 40) || 'image/jpeg' } : null,
    // 237.192 — pinned by the platform rather than a person (a big closing, a
    // birthday, a new deed). Printed rather than handwritten on the board.
    auto:      x.auto ? { kind: _str(x.auto.kind, 30), icon: _str(x.auto.icon, 8), title: _str(x.auto.title, 160) } : null,
    mentions:  [],
  };
  const ms = Array.isArray(x.mentions) ? x.mentions : [];
  ms.slice(0, 20).forEach((m) => {
    const email = normalizeEmail((m && m.email) || '');
    const name = _str((m && m.name) || '', 120);
    if (email && name) item.mentions.push({ email, name });
  });
  const r = (x.reactions && typeof x.reactions === 'object') ? x.reactions : {};
  REACTIONS.forEach((emo) => {
    const list = Array.isArray(r[emo]) ? r[emo] : [];
    const seen = {};
    const clean = [];
    list.forEach((e) => { const n = normalizeEmail(e); if (n && !seen[n]) { seen[n] = 1; clean.push(n); } });
    if (clean.length) item.reactions[emo] = clean.slice(0, 200);
  });
  return item;
}

export function isExpired(item, now) {
  if (!item || !item.expiresAt) return false;
  return new Date(item.expiresAt).getTime() <= (now || Date.now());
}

async function _listKeys(prefix) {
  const store = _store();
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix, cursor });
    (page && page.blobs || []).forEach((b) => { if (b && b.key) keys.push(b.key); });
    cursor = page && page.cursor;
  } while (cursor);
  return keys;
}

/**
 * Everything currently on the board, oldest first (z decides paint order).
 * Expired pins are dropped from the answer AND deleted on the way past — a
 * lazy purge, so the board needs no cron of its own. Leftover sys_* geometry
 * docs from 237.191 go the same way: the posters are fixed now.
 */
export async function listBoard() {
  const store = _store();
  const keys = await _listKeys('board/');
  const docs = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)));
  const now = Date.now();
  const live = [];
  const dead = [];
  docs.forEach((d) => {
    if (!d || !d.id) return;
    if (isSystemId(d.id) || d.kind === 'system') { dead.push({ id: d.id, retired: true }); return; }
    const item = _clean(d);
    if (isExpired(item, now)) dead.push(item); else live.push(item);
  });
  if (dead.length) {
    // Best effort; a failure here just means another go on the next read. An
    // auto-pin that fell off on its own is NOT tombstoned — only one a person
    // took down (see deleteItem), so the sync may legitimately re-post it.
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

/** A free-ish spot in the middle channel, then below the posters. */
export function placeInFreeZone(existing, w) {
  const taken = (existing || []).filter((i) => i && i.kind);
  let x = FREE_X0, y = FREE_Y0;
  for (let tries = 0; tries < 80; tries++) {
    let clash = false;
    for (let i = 0; i < taken.length; i++) {
      if (Math.abs(taken[i].x - x) < 100 && Math.abs(taken[i].y - y) < 100) { clash = true; break; }
    }
    if (!clash) return { x, y };
    x += FREE_STEP_X;
    if (x > FREE_X1) { x = FREE_X0; y += FREE_STEP_Y; }
    if (y > BELOW_Y) { x = 60; }              // below the posters the whole width is free
    if (y > 2400) break;
  }
  return { x, y };
}

// ── @mentions ─────────────────────────────────────────────────────
/**
 * "@Dan" / "@Dan Austin" against the roster. Deliberately conservative: a
 * first name only matches when exactly one person on the roster answers to
 * it, so a board full of Mikes never pings the wrong one.
 */
export function findMentions(text, roster) {
  const out = [];
  const seen = {};
  const people = (roster || []).filter((p) => p && p.email && p.name);
  const hits = String(text || '').match(/@[A-Za-z][A-Za-z'.-]*(?:\s+[A-Z][A-Za-z'.-]*)?/g) || [];
  hits.forEach((raw) => {
    const q = raw.slice(1).trim().toLowerCase();
    if (!q) return;
    let match = people.filter((p) => p.name.toLowerCase() === q);
    if (!match.length) {
      const first = people.filter((p) => String(p.name).split(/\s+/)[0].toLowerCase() === q.split(/\s+/)[0] && q.indexOf(' ') < 0);
      if (first.length === 1) match = first;
    }
    if (match.length === 1 && !seen[match[0].email]) {
      seen[match[0].email] = 1;
      out.push({ email: normalizeEmail(match[0].email), name: match[0].name });
    }
  });
  return out;
}

async function _notifyMentions(item, fromName) {
  await Promise.all((item.mentions || []).map((m) => {
    if (m.email === item.author.email) return null;    // no pinging yourself
    return pushUserNotification(m.email, {
      kind: 'mention',
      fromName: fromName || item.author.name || 'Someone',
      fromEmail: item.author.email,
      address: 'the cork board',
      snippet: (item.text || item.caption || '').slice(0, 160),
      href: '/armory.html#news',
    }).catch(() => null);
  }));
}

// ── Create / change / remove ──────────────────────────────────────
export async function countItems(items) {
  const list = items || await listBoard();
  return list.length;
}

export async function createItem(user, body, photoBase64, roster) {
  const current = await listBoard();
  if (current.length >= MAX_ITEMS) {
    throw new Error('The board is full (' + MAX_ITEMS + ' pins). Take something down first.');
  }
  const id = newItemId();
  const kind = KINDS.indexOf(body && body.kind) >= 0 ? body.kind : 'note';
  if (kind === 'photo') {
    const b64 = String(photoBase64 || '');
    if (!b64) throw new Error('No photo received');
    if (b64.length > MAX_PHOTO_BYTES) throw new Error('That photo is too large even after resizing — try a smaller one.');
    await _photos().set(id, b64);          // BASE64 TEXT, never a Buffer
  } else if (kind === 'note' && !_str(body && body.text, 1200)) {
    throw new Error('Write something on the note first');
  }
  const spot = (body && body.x != null && body.y != null) ? null : placeInFreeZone(current, body && body.w);
  const item = _clean({
    id,
    kind,
    text:    body && body.text,
    caption: body && body.caption,
    color:   body && body.color,
    author:  { email: user.email, name: (body && body.authorName) || '', avatar: (body && body.avatar) || '' },
    x: spot ? spot.x : body.x, y: spot ? spot.y : body.y,
    w: body && body.w, rot: body && body.rot, z: body && body.z,
    keep: body && body.keep,
    photo: body && body.photo,
    mentions: kind === 'note' ? findMentions(body && body.text, roster) : [],
  });
  item.expiresAt = _expiryFor(item.keep);
  await _put(item);
  if (item.mentions.length) await _notifyMentions(item, item.author.name);
  await touchPulse('board', (item.author.name || 'Someone') + ' pinned something to the cork board');
  return item;
}

/**
 * Geometry only: x / y / w / rot / z. ANYONE on the team may rearrange the
 * board — it is a shared wall in a shared office, and locking pins to their
 * author would make tidying up impossible. Content and lifespan are a
 * different matter (see editItem). The four posters are fixed and are not
 * movable at all.
 */
export async function moveItem(user, body) {
  const id = _str(body && body.id, 60);
  if (!id) throw new Error('id required');
  if (isSystemId(id)) throw new Error('The house posters are fixed to the frame');
  const item = await getItem(id);
  if (!item) throw new Error('That pin is no longer on the board');
  ['x', 'y', 'w', 'rot', 'z'].forEach((k) => { if (body[k] !== undefined && body[k] !== null) item[k] = body[k]; });
  const cleaned = _clean(item);
  cleaned.expiresAt = item.expiresAt;
  cleaned.movedBy = normalizeEmail(user.email);
  return _put(cleaned);
}

/** Text, caption, colour and lifespan — author or admin only. */
export async function editItem(user, body, isAdminUser, roster) {
  const id = _str(body && body.id, 60);
  const item = await getItem(id);
  if (!item) throw new Error('That pin is no longer on the board');
  const me = normalizeEmail(user.email);
  const isAuto = !!item.auto;
  if (!isAuto && item.author.email !== me && !isAdminUser) throw new Error('Only the person who pinned it (or an admin) can change it');
  if (isAuto && !isAdminUser) throw new Error('That card was posted by the Armory — an admin can change how long it stays up');
  if (body.text !== undefined)    item.text = body.text;
  if (body.caption !== undefined) item.caption = body.caption;
  if (body.color !== undefined)   item.color = body.color;
  const before = (item.mentions || []).map((m) => m.email);
  const cleaned = _clean(item);
  if (body.text !== undefined && cleaned.kind === 'note') cleaned.mentions = findMentions(item.text, roster);
  if (body.keep !== undefined && KEEP_OPTIONS[body.keep]) {
    cleaned.keep = body.keep;
    // Measured from NOW, so "keep this up" on a pin about to fall off does the
    // obvious thing.
    cleaned.expiresAt = _expiryFor(body.keep);
  }
  await _put(cleaned);
  const fresh = cleaned.mentions.filter((m) => before.indexOf(m.email) < 0);
  if (fresh.length) await _notifyMentions(Object.assign({}, cleaned, { mentions: fresh }), cleaned.author.name);
  return cleaned;
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

/** Take a pin down — author or admin; an auto-pin is admin-only and stays down. */
export async function deleteItem(user, id, isAdminUser) {
  const item = await getItem(id);
  if (!item) return true;
  const me = normalizeEmail(user.email);
  if (item.auto) {
    if (!isAdminUser) throw new Error('That card was posted by the Armory — an admin can take it down');
    // Remember, or the next sync puts it straight back up.
    await _store().setJSON('board-mute/' + item.id, { id: item.id, at: new Date().toISOString(), by: me });
  } else if (item.author.email !== me && !isAdminUser) {
    throw new Error('Only the person who pinned it (or an admin) can take it down');
  }
  await removeItem(item.id);
  return true;
}

/** The raw base64 for one photo (armory-photo.mjs serves it). */
export async function readPhoto(id) {
  return _photos().get(_str(id, 60), { type: 'text' }).catch(() => null);
}

// ── Auto-pins (237.192, Mike: "add all of those ideas") ───────────
// The board fills itself in a quiet week: a big closing, a birthday or work
// anniversary, a new deed. Ids are deterministic, so a sync is idempotent —
// the same closing never lands twice. They live a week by default.
export const AUTO_CLOSING_MIN = 1000000;   // one-line change if Mike wants it lower
const AUTO_KEEP = '1w';

function _autoCard(id, fields) {
  return _clean(Object.assign({
    id, kind: 'note', color: 'white', keep: AUTO_KEEP,
    author: { email: 'armory@slacapital.com', name: 'The Armory' },
  }, fields));
}

/**
 * Make sure the platform's own cards are on the wall. Takes what the caller
 * already loaded (bells, celebrations, deeds) so this costs one list of
 * tombstones and a write per genuinely new card.
 */
export async function syncAutoPins({ bells, celebrations, deeds, existing }) {
  const have = {};
  (existing || []).forEach((i) => { have[i.id] = 1; });
  const muted = {};
  (await _listKeys('board-mute/')).forEach((k) => { muted[k.replace('board-mute/', '')] = 1; });

  const wanted = [];
  const weekAgo = Date.now() - 7 * 86400000;

  (bells || []).forEach((b) => {
    if (!b || !b.loanId) return;
    if ((Number(b.amount) || 0) < AUTO_CLOSING_MIN) return;
    if (Date.parse(b.closedAt || 0) < weekAgo) return;
    const money = '$' + Math.round(Number(b.amount) / 1000) + 'K';
    wanted.push(_autoCard('auto_close_' + String(b.loanId).replace(/[^\w-]/g, ''), {
      text: (b.address || b.place || 'A loan') + '\n' + (b.loName || '') + (b.processors && b.processors.length ? ' with ' + b.processors.map((p) => p.name).join(', ') : ''),
      auto: { kind: 'closing', icon: '🔔', title: money + ' closed' },
      createdAt: b.closedAt,
      expiresAt: _expiryFor(AUTO_KEEP, Date.parse(b.closedAt || 0) || Date.now()),
      w: 250,
    }));
  });

  const today = (celebrations && celebrations.today) || {};
  const ymd = new Date().toISOString().slice(0, 10);
  (today.birthdays || []).forEach((p) => {
    wanted.push(_autoCard('auto_bday_' + normalizeEmail(p.email || p.name).replace(/[^\w]/g, '') + '_' + ymd.slice(0, 7), {
      text: 'Happy birthday, ' + (p.name || 'friend') + '!',
      auto: { kind: 'birthday', icon: '🎂', title: 'Birthday' }, color: 'pink', w: 230,
    }));
  });
  (today.anniversaries || []).forEach((p) => {
    wanted.push(_autoCard('auto_anniv_' + normalizeEmail(p.email || p.name).replace(/[^\w]/g, '') + '_' + ymd.slice(0, 4), {
      text: (p.name || 'A knight') + ' — ' + (p.years || '') + ' year' + (p.years === 1 ? '' : 's') + ' at SLA Capital today.',
      auto: { kind: 'anniversary', icon: '🏅', title: 'Work anniversary' }, color: 'green', w: 230,
    }));
  });
  (today.company || []).forEach((c) => {
    wanted.push(_autoCard('auto_company_' + String(c.name || '').replace(/[^\w]/g, '') + '_' + ymd.slice(0, 4), {
      text: (c.name || 'Founders Day') + ' — SLA Capital turns ' + (c.years || '') + ' today.',
      auto: { kind: 'company', icon: c.icon || '🏰', title: c.name || 'Founders Day' }, color: 'blue', w: 240, keep: '2w',
    }));
  });

  (deeds || []).forEach((d) => {
    if (!d || !d.email || !d.key) return;
    if (Date.parse(d.at || 0) < weekAgo) return;
    wanted.push(_autoCard('auto_deed_' + normalizeEmail(d.email).replace(/[^\w]/g, '') + '_' + d.key + '_' + d.tier, {
      text: (d.name || 'A knight') + ' earned ' + (d.label || d.key) + (d.rank ? ' ' + d.rank : '') + '.',
      auto: { kind: 'deed', icon: '📜', title: 'New deed' }, color: 'yellow', w: 240,
      createdAt: d.at,
      expiresAt: _expiryFor(AUTO_KEEP, Date.parse(d.at || 0) || Date.now()),
    }));
  });

  const fresh = wanted.filter((c) => !have[c.id] && !muted[c.id]);
  if (!fresh.length) return [];
  const placed = (existing || []).slice();
  for (const card of fresh) {
    const spot = placeInFreeZone(placed, card.w);
    card.x = spot.x; card.y = spot.y;
    card.rot = Math.round((Math.random() * 6 - 3) * 10) / 10;
    card.z = 1;
    placed.push(card);
    await _put(card);
  }
  if (fresh.length) await touchPulse('board', 'The Armory pinned ' + fresh.length + ' card' + (fresh.length === 1 ? '' : 's') + ' to the cork board');
  return fresh;
}

// ── Monthly snapshot ──────────────────────────────────────────────
// Mike: "a board snapshot each month, archived like the Town Crier issues, so
// the wall has a history instead of just falling off." Written lazily on the
// first read of a new month, from whatever is still up.
function _monthKey(d) {
  const dt = d || new Date();
  return dt.getUTCFullYear() + '-' + String(dt.getUTCMonth() + 1).padStart(2, '0');
}
function _prevMonth(key) {
  const y = +key.slice(0, 4), m = +key.slice(5);
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
}

export async function ensureMonthlyArchive(items) {
  const prev = _prevMonth(_monthKey());
  const key = 'board-archive/' + prev;
  const existing = await _store().get(key, { type: 'json' }).catch(() => null);
  if (existing) return null;
  // Only archive pins that were actually up during that month.
  const cutoff = prev + '-32';
  const shot = (items || []).filter((i) => String(i.createdAt || '').slice(0, 7) <= prev && String(i.createdAt || '') <= cutoff);
  if (!shot.length) return null;
  const doc = {
    month: prev,
    at: new Date().toISOString(),
    items: shot.map((i) => ({
      id: i.id, kind: i.kind, text: i.text, caption: i.caption, color: i.color,
      author: i.author, createdAt: i.createdAt, auto: i.auto, reactions: i.reactions,
    })),
  };
  await _store().setJSON(key, doc);
  return doc;
}

export async function listArchiveMonths() {
  const keys = await _listKeys('board-archive/');
  return keys.map((k) => k.replace('board-archive/', '')).sort().reverse();
}

export async function getArchive(month) {
  if (!/^\d{4}-\d{2}$/.test(String(month || ''))) return null;
  const doc = await _store().get('board-archive/' + month, { type: 'json' }).catch(() => null);
  if (!doc) return null;
  // A photo's bytes may be long gone; sign what is still there and let the
  // client fall back to a caption.
  doc.items = (doc.items || []).map((i) => (i.kind === 'photo' ? Object.assign({}, i, { photoUrl: signPhoto(i.id) }) : i));
  return doc;
}

/** What went up in the last N days — the Town Crier's cork-board section. */
export async function boardSince(sinceIso, items) {
  const list = items || await listBoard();
  return list.filter((i) => String(i.createdAt || '') >= String(sinceIso) && !i.auto)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}
