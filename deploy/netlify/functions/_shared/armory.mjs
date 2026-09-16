/**
 * _shared/armory.mjs — Deploy 237.073 (Mike)
 *
 * THE ARMORY: the team's fun corner. Today that is one mini-game
 * ("Sir Lends-A-Lot's Gallop", sir-lends-a-lot.html — an endless runner)
 * with a MONTHLY high-score contest, plus an admin-editable events board
 * (March Madness, Secret Santa, whatever comes next). armory.html renders
 * the Round Table (this month's leaderboard), the Hall of Champions (past
 * monthly winners) and the events.
 *
 * Storage — one blob store, `armory` (strong):
 *
 *   scores/<YYYY-MM>/<ownerKey>   one doc per PLAYER per MONTH
 *       { email, name, month, best, bestAt, bestCoins, bestDurationMs,
 *         runs, lastRunAt, recentRuns: [{ id, at }], updatedAt }
 *       The month prefix IS the monthly reset: a new month simply starts
 *       an empty prefix, and every past month stays behind as history for
 *       the Hall of Champions. One doc per player means two players never
 *       read-modify-write the same blob.
 *   events                        { items: [...], updatedAt, updatedBy }
 *
 * Anti-cheat, sized for an office contest (not a casino):
 *   - A run starts by asking the server for a SIGNED run token
 *     (HMAC, ESIGN_SEAL_SECRET) that carries the player + issue time.
 *   - On game over the score is submitted WITH that token. The server
 *     measures elapsed time itself (now − issue time) and rejects any
 *     score above MAX_POINTS_PER_SEC × elapsed + SCORE_SLACK. The game's
 *     real theoretical ceiling is ~75 pts/s (see the SCORING comment in
 *     sir-lends-a-lot.html) — keep this constant ABOVE that if the game
 *     is re-tuned, or honest runs will bounce.
 *   - Tokens are single-use (recentRuns on the player doc) and expire.
 *   - Runs longer than MAX_RUN_MS are capped at that elapsed time.
 *   - Admins can VOID a month's score for a player from armory.html.
 *
 * Months are Pacific time (SLA is in Washington) so the contest rolls
 * over at midnight in the office, not at UTC midnight the evening before.
 */
import { createHmac, timingSafeEqual, randomBytes } from 'node:crypto';
import { getStore } from '@netlify/blobs';
import { getRoles, keySafe, normalizeEmail } from './auth.mjs';
import { classifyAccount } from './team-roster-rules.mjs';
import { loadRoleTable } from './team-roster.mjs';

const STORE = 'armory';
const TZ = 'America/Los_Angeles';

export const GAME_ID = 'gallop';

/**
 * Deploy 237.082 (Mike) — quest rotation. One game is THE contest each
 * month, and the set repeats every quarter (month 1 / 2 / 3 of each
 * quarter). Before ROTATION_START only the Gallop exists, so it is the
 * quest every month until then.
 */
// maxPps = the server plausibility cap (points per second of server-measured
// ride time) — keep each ABOVE the game's real ceiling (see the SCORING
// comment at the top of each game page) or honest runs bounce.
export const GAMES = {
  gallop: { id: 'gallop', name: "Sir Lends-A-Lot's Gallop", href: '/sir-lends-a-lot.html', blurb: 'An endless ride past houses, DENIED stamps, tax collectors, bats and one very hungry dragon.', icon: '🏇', maxPps: 100 }, // 237.087: speed now reaches 1000 px/s
  'coin-catch': { id: 'coin-catch', name: 'Coin Catch', href: '/coin-catch.html', blurb: 'Catch the falling gold, dodge the falling DENIED stamps. Two arrows, three lives, no mercy.', icon: '💰', maxPps: 140 },
  'fund-the-house': { id: 'fund-the-house', name: 'Fund the House', href: '/fund-the-house.html', blurb: 'Houses pop up for a heartbeat. Fund them before a competitor does — but never the one with the dragon in the window. Sixty seconds.', icon: '🏠', maxPps: 700 },
};
export function isGameId(id) { return Object.prototype.hasOwnProperty.call(GAMES, String(id || '')); }
export const ROTATION = ['gallop', 'coin-catch', 'fund-the-house'];
export const ROTATION_START = '2026-10';
export function questForMonth(month) {
  if (!isMonthKey(month) || month < ROTATION_START) return GAMES.gallop;
  const m = Number(month.slice(5));
  return GAMES[ROTATION[(m - 1) % 3]];
}
export const MAX_POINTS_PER_SEC = 90;
export const SCORE_SLACK = 300;
export const RUN_TOKEN_TTL_MS = 30 * 60000;
export const MAX_RUN_MS = 20 * 60000;
const RECENT_RUNS_KEEP_MS = RUN_TOKEN_TTL_MS + 60000;
const MAX_EVENTS = 40;

function _store() { return getStore({ name: STORE, consistency: 'strong' }); }

// ── Calendar ──────────────────────────────────────────────────────
/** 'YYYY-MM' for a Date in Pacific time. */
export function monthKey(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit' })
    .formatToParts(d || new Date());
  const y = parts.find((p) => p.type === 'year').value;
  const m = parts.find((p) => p.type === 'month').value;
  return y + '-' + m;
}

export function isMonthKey(s) { return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(s || '')); }

/** 'September 2026' */
export function monthLabel(key) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(key || ''));
  if (!m) return String(key || '');
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return names[Number(m[2]) - 1] + ' ' + m[1];
}

/** Whole days (Pacific) left in the current month, counting today. */
export function daysLeftInMonth(d) {
  const now = d || new Date();
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now);
  const y = Number(parts.find((p) => p.type === 'year').value);
  const m = Number(parts.find((p) => p.type === 'month').value);
  const day = Number(parts.find((p) => p.type === 'day').value);
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return daysInMonth - day + 1;
}

// ── Who may play ──────────────────────────────────────────────────
/**
 * Team members only: the same classifier Users Admin uses (staff role from
 * the role table or the token, or an @slacapital.com address). Borrowers
 * and brokers are signed-in users too, so an auth check alone is not enough.
 */
export async function isTeamMember(user) {
  if (!user || !user.email) return false;
  const email = normalizeEmail(user.email);
  let tableRoles = [];
  try { tableRoles = (await loadRoleTable()).get(email) || []; } catch (_) { tableRoles = []; }
  return classifyAccount({ email, appRoles: getRoles(user), tableRoles }) === 'staff';
}

export function displayNameFor(user) {
  const meta = (user && user.user_metadata) || {};
  const n = String(meta.full_name || meta.fullName || meta.name || '').trim();
  if (n) return n;
  const local = String((user && user.email) || '').split('@')[0];
  return local ? local.charAt(0).toUpperCase() + local.slice(1) : 'Unknown Knight';
}

// ── Signed run tokens ─────────────────────────────────────────────
function _secret() {
  const s = process.env.ESIGN_SEAL_SECRET || '';
  if (!s) throw new Error('ESIGN_SEAL_SECRET not configured');
  return s;
}
function _b64u(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function _unb64u(s) { return Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }
function _sig(payloadB64) { return _b64u(createHmac('sha256', _secret()).update(payloadB64).digest()); }

export function issueRunToken(email, game) {
  const payload = { id: 'run_' + Date.now() + '_' + randomBytes(4).toString('hex'), e: normalizeEmail(email), t: Date.now(), g: isGameId(game) ? game : GAME_ID };
  const p = _b64u(JSON.stringify(payload));
  return { token: p + '.' + _sig(p), runId: payload.id, issuedAt: payload.t, expiresAt: payload.t + RUN_TOKEN_TTL_MS };
}

/** Returns the payload, or null when the signature / shape is wrong. Expiry is the caller's call. */
export function verifyRunToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 2) return null;
  let expected;
  try { expected = Buffer.from(_sig(parts[0])); } catch (_) { return null; }
  const given = Buffer.from(parts[1]);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(_unb64u(parts[0]).toString('utf8'));
    if (!payload || !payload.id || !payload.e || !payload.t || !isGameId(payload.g)) return null;
    return payload;
  } catch (_) { return null; }
}

// ── Scores ────────────────────────────────────────────────────────
// Deploy 237.083 — per-game keys. The Gallop keeps its original
// scores/<month>/<owner> keys (its docs predate the rotation and carry no
// game field); every other game lives at scores/<game>/<month>/<owner>.
function _scoreKey(month, email, game) {
  const g = isGameId(game) ? game : GAME_ID;
  return 'scores/' + (g === GAME_ID ? '' : g + '/') + month + '/' + keySafe(normalizeEmail(email));
}

function _publicRow(doc) {
  return {
    email: doc.email, name: doc.name || '', best: Number(doc.best) || 0, bestAt: doc.bestAt || '',
    bestCoins: Number(doc.bestCoins) || 0, bestDurationMs: Number(doc.bestDurationMs) || 0,
    runs: Number(doc.runs) || 0, lastRunAt: doc.lastRunAt || '', month: doc.month || '',
    game: isGameId(doc.game) ? doc.game : GAME_ID,
  };
}

async function _readPrefix(prefix) {
  const store = _store();
  const keys = [];
  let cursor;
  do {
    const page = await store.list({ prefix, cursor });
    (page && page.blobs || []).forEach((b) => { if (b && b.key) keys.push(b.key); });
    cursor = page && page.cursor;
  } while (cursor);
  const docs = await Promise.all(keys.map((k) => store.get(k, { type: 'json' }).catch(() => null)));
  return docs.filter((d) => d && d.email);
}

const _byBest = (a, b) => b.best - a.best || String(a.bestAt).localeCompare(String(b.bestAt));

/** One game's board for a month, best-first. */
export async function listMonth(month, game) {
  const g = isGameId(game) ? game : GAME_ID;
  const docs = await _readPrefix('scores/' + (g === GAME_ID ? '' : g + '/') + month + '/');
  return docs.map(_publicRow).filter((r) => r.best > 0 && r.game === g).sort(_byBest);
}

/**
 * Every score doc, grouped { game: { month: [rows best-first] } }. One prefix
 * read for everything (tens of docs per month per game).
 */
export async function listAllScores() {
  const docs = await _readPrefix('scores/');
  const out = {};
  docs.forEach((d) => {
    const row = _publicRow(d);
    if (!(row.best > 0)) return;
    const m = row.month || (String(d.month || '')) || '';
    if (!m) return;
    const g = out[row.game] = out[row.game] || {};
    (g[m] = g[m] || []).push(row);
  });
  Object.keys(out).forEach((g) => Object.keys(out[g]).forEach((m) => out[g][m].sort(_byBest)));
  return out;
}

/** Every month for ONE game, { month: [rows best-first] }. Default: the Gallop. */
export async function listAllMonths(game) {
  const all = await listAllScores();
  return all[isGameId(game) ? game : GAME_ID] || {};
}

/**
 * Deploy 237.077 (Mike) — Legends of the Realm: the top N scores EVER,
 * across every month. Never reset. A player can hold more than one seat
 * (their best from different months) — it is literally the top scores.
 * Rows carry monthLabel so the page can say when the ride happened.
 */
export function legendsFrom(byMonth, n) {
  const rows = [];
  Object.keys(byMonth || {}).forEach((m) => (byMonth[m] || []).forEach((r) => {
    rows.push(Object.assign({ monthLabel: monthLabel(r.month || m) }, r, { month: r.month || m }));
  }));
  return rows.sort((a, b) => b.best - a.best || String(a.bestAt).localeCompare(String(b.bestAt))).slice(0, n || 3);
}

/**
 * Record a finished run. `run` = { runId, issuedAt, score, coins, distance,
 * durationMs }. Returns { accepted, reason?, best, isNewBest, row }.
 */
export async function recordRun(user, run) {
  const email = normalizeEmail(user.email);
  const now = Date.now();
  const month = monthKey(new Date(now));
  const game = isGameId(run.game) ? run.game : GAME_ID;
  const store = _store();
  const key = _scoreKey(month, email, game);
  const doc = (await store.get(key, { type: 'json' }).catch(() => null)) || {
    email, name: displayNameFor(user), month, game, best: 0, bestAt: '', bestCoins: 0, bestDurationMs: 0, runs: 0, lastRunAt: '', recentRuns: [],
  };
  doc.game = game;
  const recent = (Array.isArray(doc.recentRuns) ? doc.recentRuns : []).filter((r) => r && r.id && now - Number(r.at || 0) < RECENT_RUNS_KEEP_MS);
  if (recent.some((r) => r.id === run.runId)) {
    return { accepted: false, reason: 'That run was already scored.', best: Number(doc.best) || 0, isNewBest: false, row: _publicRow(doc) };
  }
  const elapsedMs = Math.min(Math.max(0, now - Number(run.issuedAt || 0)), MAX_RUN_MS);
  const cap = Math.floor((GAMES[game].maxPps || MAX_POINTS_PER_SEC) * (elapsedMs / 1000) + SCORE_SLACK);
  const score = Math.max(0, Math.floor(Number(run.score) || 0));
  recent.push({ id: run.runId, at: now });
  doc.recentRuns = recent;
  doc.runs = (Number(doc.runs) || 0) + 1;
  doc.lastRunAt = new Date(now).toISOString();
  doc.name = displayNameFor(user) || doc.name;
  doc.updatedAt = doc.lastRunAt;
  let accepted = true; let reason = ''; let isNewBest = false;
  if (score > cap) {
    accepted = false;
    reason = 'Score is higher than a ' + Math.round(elapsedMs / 1000) + 's ride could earn — not counted.';
    console.warn('[armory] implausible score', { email, game, score, cap, elapsedMs });
  } else if (score > (Number(doc.best) || 0)) {
    isNewBest = true;
    doc.best = score;
    doc.bestAt = doc.lastRunAt;
    doc.bestCoins = Math.max(0, Math.floor(Number(run.coins) || 0));
    doc.bestDurationMs = Math.max(0, Math.floor(Number(run.durationMs) || 0));
  }
  await store.setJSON(key, doc);
  return { accepted, reason, best: Number(doc.best) || 0, isNewBest, row: _publicRow(doc) };
}

/** Admin: wipe one player's score for a month (the doc goes away; the next run starts them fresh). */
export async function voidScore(month, email, game) {
  const store = _store();
  const key = _scoreKey(month, email, game);
  const doc = await store.get(key, { type: 'json' }).catch(() => null);
  if (!doc) return false;
  await store.delete(key);
  return true;
}

// ── Pulse (Deploy 237.085) ────────────────────────────────────────
// One tiny doc that says "something new happened in the Armory" — the nav
// link blinks until the user visits armory.html (sla-nav.js compares
// pulse.at to localStorage). Touched by: Closing Bell, events save, Town
// Crier send, a Legend seat, the monthly champion, new deeds.
export async function touchPulse(kind, text) {
  try {
    await _store().setJSON('pulse', { at: new Date().toISOString(), kind: String(kind || ''), text: String(text || '').slice(0, 160) });
  } catch (e) { console.warn('[armory] touchPulse failed:', e && e.message); }
}
export async function getPulse() {
  return _store().get('pulse', { type: 'json' }).catch(() => null);
}

// ── Events board ──────────────────────────────────────────────────
function _cleanEvent(e) {
  const x = e || {};
  const str = (v, n) => String(v == null ? '' : v).trim().slice(0, n);
  const date = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || '')) ? String(v) : '');
  const link = str(x.link, 500);
  return {
    id: str(x.id, 40) || ('ev_' + Date.now() + '_' + randomBytes(3).toString('hex')),
    emoji: str(x.emoji, 8),
    title: str(x.title, 120),
    body: str(x.body, 2000),
    startsAt: date(x.startsAt),
    endsAt: date(x.endsAt),
    link: /^https?:\/\//i.test(link) || /^\//.test(link) ? link : '',
    linkLabel: str(x.linkLabel, 60),
    pinned: !!x.pinned,
    createdAt: str(x.createdAt, 40) || new Date().toISOString(),
    createdBy: str(x.createdBy, 200),
  };
}

export async function getEvents() {
  const doc = await _store().get('events', { type: 'json' }).catch(() => null);
  return (doc && Array.isArray(doc.items) ? doc.items : []).map(_cleanEvent).filter((e) => e.title);
}

export async function saveEvents(items, byEmail) {
  const cleaned = (Array.isArray(items) ? items : []).map(_cleanEvent).filter((e) => e.title).slice(0, MAX_EVENTS);
  await _store().setJSON('events', { items: cleaned, updatedAt: new Date().toISOString(), updatedBy: normalizeEmail(byEmail) });
  await touchPulse('event', 'The Herald posted to the board');
  return cleaned;
}
