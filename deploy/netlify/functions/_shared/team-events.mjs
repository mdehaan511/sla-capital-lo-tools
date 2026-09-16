/**
 * _shared/team-events.mjs — Deploy 237.082 (Mike)
 *
 * Birthdays + work anniversaries for the team. The dates live on the
 * `profiles` blob (keyed keySafe(email)), read BY KEY for the staff roster
 * (never a store walk — see reference_profiles_store_slow):
 *
 *   profile.birthday   'MM-DD'        (the LO enters it — login prompt +
 *                                      Profile page; year optional)
 *   profile.birthYear  'YYYY' | ''    (optional; never shown, never used
 *                                      for age — kept only so a future
 *                                      "big 4-0" style milestone is possible)
 *   profile.startDate  'YYYY-MM-DD'   (admin enters it on Users Admin;
 *                                      Mike gets the real dates from Dan)
 *
 * Everything is Pacific-time day math on 'YYYY-MM-DD' strings so the cron
 * (which runs in UTC) celebrates on the right office day. Feb 29 birthdays
 * are celebrated Feb 28 in non-leap years.
 *
 * Consumers: team-calendar-cron (daily Slack to the leadership channel),
 * town-crier-cron (Monday digest), armory-state (Celebrations card).
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';
import { loadRoleTable } from './team-roster.mjs';
import { classifyAccount } from './team-roster-rules.mjs';

const TZ = 'America/Los_Angeles';
const DAY_MS = 86400000;

// ── Dates ─────────────────────────────────────────────────────────
/** 'YYYY-MM-DD' for a Date in Pacific time. */
export function todayPacific(d) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(d || new Date());
  const get = (t) => parts.find((p) => p.type === t).value;
  return get('year') + '-' + get('month') + '-' + get('day');
}

function _isLeap(y) { return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0; }
function _ymdToMs(ymd) { const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd); return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN; }
function _msToYmd(ms) { return new Date(ms).toISOString().slice(0, 10); }
export function addDays(ymd, n) { return _msToYmd(_ymdToMs(ymd) + n * DAY_MS); }

/** 'YYYY-MM-DD' or '' — accepts ISO, M/D/YYYY, MM/DD/YY. */
export function normalizeDate(s) {
  const v = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(v);
  let y, mo, d;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(v);
    if (!m) return '';
    mo = +m[1]; d = +m[2]; y = +m[3]; if (y < 100) y += y < 50 ? 2000 : 1900;
  }
  if (y < 1900 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
  const out = y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0');
  return isNaN(_ymdToMs(out)) ? '' : out;
}

/**
 * Birthday input → { md: 'MM-DD', year: 'YYYY'|'' }. Accepts 'MM-DD',
 * 'YYYY-MM-DD', 'M/D', 'M/D/YYYY'. Returns { md: '' } when unparseable.
 */
export function normalizeBirthday(s) {
  const v = String(s || '').trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return _bd(+m[2], +m[3], m[1]);
  m = /^(\d{1,2})-(\d{1,2})$/.exec(v);
  if (m) return _bd(+m[1], +m[2], '');
  m = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/.exec(v);
  if (m) { let y = m[3] ? +m[3] : 0; if (y && y < 100) y += y < 50 ? 2000 : 1900; return _bd(+m[1], +m[2], y ? String(y) : ''); }
  return { md: '', year: '' };
}
function _bd(mo, d, year) {
  const dim = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (mo < 1 || mo > 12 || d < 1 || d > dim[mo - 1]) return { md: '', year: '' };
  const y = String(year || '');
  if (y && (+y < 1900 || +y > 2100)) return { md: '', year: '' };
  return { md: String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0'), year: y };
}

/** 'MM-DD' → 'March 4' */
export function prettyMd(md) {
  const m = /^(\d{2})-(\d{2})$/.exec(String(md || ''));
  if (!m) return '';
  const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return names[+m[1] - 1] + ' ' + (+m[2]);
}
/** 'YYYY-MM-DD' → 'Mon 3/4' style short label. */
export function prettyYmd(ymd) {
  const ms = _ymdToMs(ymd); if (isNaN(ms)) return String(ymd || '');
  const d = new Date(ms);
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return days[d.getUTCDay()] + ' ' + (d.getUTCMonth() + 1) + '/' + d.getUTCDate();
}

// ── Roster ────────────────────────────────────────────────────────
/**
 * Staff roster with celebration fields. Role table → staff emails →
 * profiles read by key. [{ email, name, birthday, birthYear, startDate, roles }]
 */
export async function loadTeamProfiles() {
  const table = await loadRoleTable();
  const emails = [];
  table.forEach((roles, email) => {
    if (classifyAccount({ email, tableRoles: roles, appRoles: [] }) === 'staff') emails.push(email);
  });
  const store = getStore({ name: 'profiles', consistency: 'eventual' });
  const out = await Promise.all(emails.map(async (email) => {
    const p = await store.get(keySafe(normalizeEmail(email)), { type: 'json' }).catch(() => null) || {};
    const um = p.user_metadata || {};
    return {
      email,
      name: String(p.fullName || um.full_name || um.name || '').trim() || email.split('@')[0],
      birthday: String(p.birthday || ''),
      birthYear: String(p.birthYear || ''),
      startDate: String(p.startDate || ''),
      avatar: String(p.avatar || ''),                         // Deploy 237.086 — chosen pixel character
      roles: table.get(email) || [],
    };
  }));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Map email → { birthday, birthYear, startDate } read by key (Users Admin roster). */
export async function profileCalendarFor(emails) {
  const out = new Map();
  const list = Array.from(new Set((emails || []).map(normalizeEmail).filter(Boolean)));
  if (!list.length) return out;
  const store = getStore({ name: 'profiles', consistency: 'eventual' });
  await Promise.all(list.map((e) =>
    store.get(keySafe(e), { type: 'json' })
      .then((p) => { if (p) out.set(e, { birthday: String(p.birthday || ''), birthYear: String(p.birthYear || ''), startDate: String(p.startDate || '') }); })
      .catch(() => {})));
  return out;
}

// ── Celebrations ──────────────────────────────────────────────────
function _mdMatches(md, ymd) {
  const y = +ymd.slice(0, 4);
  const today = ymd.slice(5);
  if (md === today) return true;
  return md === '02-29' && today === '02-28' && !_isLeap(y);
}

/** { birthdays: [{email,name}], anniversaries: [{email,name,years,startDate}] } for one Pacific day. */
export function celebrationsOn(profiles, ymd) {
  const birthdays = [], anniversaries = [];
  (profiles || []).forEach((p) => {
    if (p.birthday && _mdMatches(p.birthday, ymd)) birthdays.push({ email: p.email, name: p.name });
    if (p.startDate && _mdMatches(p.startDate.slice(5), ymd)) {
      const years = +ymd.slice(0, 4) - +p.startDate.slice(0, 4);
      if (years >= 1) anniversaries.push({ email: p.email, name: p.name, years, startDate: p.startDate });
    }
  });
  return { birthdays, anniversaries };
}

/**
 * Everything in [fromYmd, fromYmd + days): [{ type, date, daysAway, email,
 * name, years }] soonest first. type = 'birthday' | 'anniversary'.
 */
export function upcomingCelebrations(profiles, fromYmd, days) {
  const out = [];
  for (let i = 0; i < (days || 14); i++) {
    const ymd = addDays(fromYmd, i);
    const c = celebrationsOn(profiles, ymd);
    c.birthdays.forEach((b) => out.push({ type: 'birthday', date: ymd, daysAway: i, email: b.email, name: b.name }));
    c.anniversaries.forEach((a) => out.push({ type: 'anniversary', date: ymd, daysAway: i, email: a.email, name: a.name, years: a.years }));
  }
  return out;
}

export function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
