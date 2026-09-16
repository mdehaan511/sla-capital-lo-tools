/**
 * _shared/achievements.mjs — Deploy 237.085 (Mike)
 *
 * DEEDS: tiered achievements for every team member, visible to everyone on
 * the Armory ("Hall of Deeds") and on the Profile page. Almost every deed
 * has ranks (I, II, III …) that get progressively harder — Mike: "Hat Trick
 * is 3 closings in ONE DAY, one month is easy", "$100M lifetime", "5 loans
 * with the same borrower", "loans in X states", "Big Game Hunter 1 / 5 / 10".
 *
 * Data:
 *   production  — every CLOSED loan in Postgres (same closed test as the
 *                 follow-up cron: status/stage/disposition/baselineStatus),
 *                 grouped by owner_email
 *   games       — the armory score docs (champions per quest month, Legend
 *                 seats, total runs)
 *   tenure      — profile.startDate (team-events)
 *
 * Storage (armory store):
 *   achievements/<keySafe(email)>  { email, name, metrics, earned: { key:
 *                                    { tier, at, backfill } }, computedAt }
 *   achievements-index             { computedAt, members: [...], recent: [...] }
 *
 * computeAchievements() rewrites everything, diffs against the prior docs,
 * announces NEW ranks (Slack 'armory' + pulse) unless the member had no
 * prior doc (first run = backfill, silent). Daily cron + admin recompute +
 * lazy compute when the index is missing.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';
import { db } from './supabase-db.mjs';
import { postSlack } from './slack.mjs';
import { loadTeamProfiles, todayPacific } from './team-events.mjs';
import { listAllScores, legendsFrom, questForMonth, monthKey, touchPulse, GAMES } from './armory.mjs';
import { programLabel } from './closing-bell.mjs';

const PORTAL = 'https://portal.slacapital.ai';
const DAY_MS = 86400000;

// ── Definitions ───────────────────────────────────────────────────
// tiers = thresholds for Rank I, II, III… ; metric = key into member metrics.
export const DEEDS = [
  { key: 'first_blood', name: 'First Blood', icon: '🩸', cat: 'Production', metric: 'closed', tiers: [1], unit: 'closed loan', desc: 'Your first funded loan.' },
  { key: 'banners', name: 'Banners', icon: '🚩', cat: 'Production', metric: 'closed', tiers: [10, 25, 50, 100, 250], unit: 'closed loans', desc: 'Loans closed, lifetime.' },
  { key: 'treasury', name: 'The Treasury', icon: '💰', cat: 'Production', metric: 'volume', tiers: [1e6, 10e6, 25e6, 50e6, 100e6], unit: 'funded', money: true, desc: 'Lifetime funded volume.' },
  { key: 'hat_trick', name: 'Hat Trick', icon: '🎩', cat: 'Production', metric: 'maxDay', tiers: [3, 4, 5], unit: 'closings in one day', desc: 'Closings on a single day.' },
  { key: 'frenzy', name: 'Closing Frenzy', icon: '🔥', cat: 'Production', metric: 'maxMonth', tiers: [10, 15, 20, 25], unit: 'closings in one month', desc: 'Closings in a single month.' },
  { key: 'big_game', name: 'Big Game Hunter', icon: '🐘', cat: 'Production', metric: 'bigGame', tiers: [1, 5, 10, 25], unit: 'closings over $1M', desc: 'Single closings of $1,000,000 or more.' },
  { key: 'quiver', name: 'Full Quiver', icon: '🏹', cat: 'Production', metric: 'programs', tiers: [2, 3, 4, 5], unit: 'loan programs', desc: 'Distinct programs closed (DSCR, Fix & Flip, Ground-Up, Multifamily, Bridge, Transactional).' },
  { key: 'repeat', name: 'Repeat Customer', icon: '🤝', cat: 'Production', metric: 'repeatMax', tiers: [2, 3, 5, 10], unit: 'loans with one borrower', desc: 'Most closed loans with the same borrower.' },
  { key: 'cartographer', name: 'Cartographer', icon: '🗺️', cat: 'Production', metric: 'states', tiers: [2, 5, 10, 20], unit: 'states', desc: 'Distinct states with a closed loan.' },
  { key: 'speed', name: 'Speed Demon', icon: '⚡', cat: 'Production', metric: 'speedy', tiers: [1, 5, 10, 25], unit: 'closings in ≤ 14 days', desc: 'Submitted to closed in 14 days or less.' },
  { key: 'round_table', name: 'Knight of the Round Table', icon: '👑', cat: 'Armory', metric: 'champion', tiers: [1, 3, 5, 10], unit: 'monthly wins', desc: 'Months won at the Round Table.' },
  { key: 'legend', name: 'Legend of the Realm', icon: '⚜️', cat: 'Armory', metric: 'legend', tiers: [1, 2, 3], unit: 'seats held', desc: 'All-time top-3 seats held right now, across the quests.' },
  { key: 'triple_crown', name: 'Triple Crown', icon: '🏆', cat: 'Armory', metric: 'gamesWon', tiers: [3], unit: 'different quests won', desc: 'Won a month in all three quests.' },
  { key: 'iron_rider', name: 'Iron Rider', icon: '🐎', cat: 'Armory', metric: 'runs', tiers: [50, 250, 1000], unit: 'runs', desc: 'Total quest runs, all games.' },
  { key: 'loyal', name: 'Loyal Knight', icon: '🛡️', cat: 'Team', metric: 'years', tiers: [1, 3, 5, 10], unit: 'years with SLA', desc: 'Years of service (from your start date).' },
];
export const RANKS = ['I', 'II', 'III', 'IV', 'V'];

export function tierFor(def, value) {
  let t = 0;
  for (let i = 0; i < def.tiers.length; i++) if (Number(value) >= def.tiers[i]) t = i + 1;
  return t;
}

// ── Production metrics from Postgres ──────────────────────────────
function _isClosedRow(r, ex) {
  const dsp = String(ex.disposition || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (['sold', 'servicing', 'pending sale', 'paid off', 'post close'].includes(dsp)) return true;
  const st = String(r.status || '').toLowerCase().trim();
  if (st === 'closed' || st === 'sold' || st === 'liquidated') return true;
  if (String(r.processing_stage || '').toLowerCase().trim() === 'pp_closed') return true;
  const bl = String(ex.baselineStatus || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return ['sold', 'in servicing', 'servicing', 'liquidated', 'paid off', 'closed'].includes(bl);
}
function _stateOf(address) {
  const m = /,\s*([A-Z]{2})(?:\s+\d{5})?\s*$/.exec(String(address || '').trim());
  return m ? m[1] : '';
}
function _ymd(s) {
  const v = String(s || '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(v);
  if (m) return m[1];
  const t = Date.parse(v);
  return isFinite(t) ? new Date(t).toISOString().slice(0, 10) : '';
}

async function _closedLoansByOwner() {
  const SELECT = 'id,client_id,owner_email,address,status,processing_stage,tool_type,loan_type,loan_amt,funding_date,extra';
  const PAGE = 1000;
  const byOwner = {};
  let offset = 0;
  for (;;) {
    const rows = await db.select('loans', { select: SELECT, limit: PAGE, offset });
    for (const r of (rows || [])) {
      const ex = r.extra || {};
      if (!_isClosedRow(r, ex)) continue;
      const owner = normalizeEmail(r.owner_email);
      if (!owner || owner.indexOf('@') < 0) continue;
      const amount = Number(ex.finalLoanAmount || r.loan_amt) || 0;
      const funded = _ymd(r.funding_date || ex.fundingDate || '');
      const submitted = _ymd(ex.submittedAt || ex.submitDate || '');
      (byOwner[owner] = byOwner[owner] || []).push({
        id: r.id, clientId: r.client_id || '', amount, funded, submitted,
        program: programLabel({ toolType: r.tool_type, loanType: r.loan_type, mfProgram: ex.mfProgram }),
        state: _stateOf(r.address),
      });
    }
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break;
  }
  return byOwner;
}

function _productionMetrics(loans) {
  const m = { closed: 0, volume: 0, bigGame: 0, maxDay: 0, maxMonth: 0, programs: 0, repeatMax: 0, states: 0, speedy: 0 };
  if (!loans || !loans.length) return m;
  const byDay = {}, byMonth = {}, byClient = {}, progs = new Set(), states = new Set();
  loans.forEach((l) => {
    m.closed++; m.volume += l.amount;
    if (l.amount >= 1e6) m.bigGame++;
    if (l.funded) { byDay[l.funded] = (byDay[l.funded] || 0) + 1; const mo = l.funded.slice(0, 7); byMonth[mo] = (byMonth[mo] || 0) + 1; }
    if (l.clientId) byClient[l.clientId] = (byClient[l.clientId] || 0) + 1;
    if (l.program) progs.add(l.program);
    if (l.state) states.add(l.state);
    if (l.funded && l.submitted) {
      const d = (Date.parse(l.funded) - Date.parse(l.submitted)) / DAY_MS;
      if (d >= 0 && d <= 14) m.speedy++;
    }
  });
  m.maxDay = Math.max(0, ...Object.values(byDay));
  m.maxMonth = Math.max(0, ...Object.values(byMonth));
  m.repeatMax = Math.max(0, ...Object.values(byClient));
  m.programs = progs.size; m.states = states.size;
  return m;
}

// ── Game metrics ──────────────────────────────────────────────────
function _gameMetrics(allScores, email) {
  const m = { champion: 0, legend: 0, gamesWon: 0, runs: 0 };
  const thisMonth = monthKey(new Date());
  const won = new Set();
  Object.keys(allScores).forEach((g) => {
    Object.keys(allScores[g]).forEach((mo) => {
      const rows = allScores[g][mo];
      rows.forEach((r) => { if (r.email === email) m.runs += Number(r.runs) || 0; });
      if (mo === thisMonth || questForMonth(mo).id !== g) return;   // only closed quest months count as wins
      if (rows[0] && rows[0].email === email) { m.champion++; won.add(g); }
    });
    legendsFrom(allScores[g] || {}, 3).forEach((r) => { if (r.email === email) m.legend++; });
  });
  m.gamesWon = won.size;
  return m;
}

function _years(startDate) {
  const sd = String(startDate || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sd)) return 0;
  const today = todayPacific();
  let y = +today.slice(0, 4) - +sd.slice(0, 4);
  if (today.slice(5) < sd.slice(5)) y--;
  return Math.max(0, y);
}

// ── Compute ───────────────────────────────────────────────────────
function _store() { return getStore({ name: 'armory', consistency: 'strong' }); }

export function fmtValue(def, v) {
  if (def.money) return '$' + Math.round(Number(v) || 0).toLocaleString('en-US');
  return String(Math.floor(Number(v) || 0));
}

export async function computeAchievements(opts) {
  const o = opts || {};
  const store = _store();
  const [profiles, byOwner, allScores] = await Promise.all([loadTeamProfiles(), _closedLoansByOwner(), listAllScores()]);
  const now = new Date().toISOString();
  const members = [];
  const announcements = [];
  for (const p of profiles) {
    const metrics = Object.assign({}, _productionMetrics(byOwner[p.email]), _gameMetrics(allScores, p.email), { years: _years(p.startDate) });
    const key = 'achievements/' + keySafe(p.email);
    const prior = await store.get(key, { type: 'json' }).catch(() => null);
    const priorEarned = (prior && prior.earned) || {};
    const earned = {};
    DEEDS.forEach((def) => {
      const tier = tierFor(def, metrics[def.metric]);
      if (!tier) return;
      const was = priorEarned[def.key];
      if (was && was.tier >= tier) { earned[def.key] = Object.assign({}, was, { tier: was.tier }); return; }
      const entry = { tier, at: now, backfill: !prior, value: metrics[def.metric] };
      earned[def.key] = entry;
      if (prior) announcements.push({ email: p.email, name: p.name, key: def.key, name_: def.name, icon: def.icon, tier, value: metrics[def.metric], at: now });
    });
    const doc = { email: p.email, name: p.name, metrics, earned, computedAt: now };
    await store.setJSON(key, doc);
    members.push({ email: p.email, name: p.name, earned, metrics });
  }
  // Recent: newest 40 earned entries across everyone (backfills excluded).
  const recent = [];
  members.forEach((mb) => Object.keys(mb.earned).forEach((k) => { const e = mb.earned[k]; if (!e.backfill) recent.push({ email: mb.email, name: mb.name, key: k, tier: e.tier, at: e.at }); }));
  recent.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const index = { computedAt: now, members, recent: recent.slice(0, 40) };
  await store.setJSON('achievements-index', index);

  if (announcements.length && o.announce !== false) {
    const lines = announcements.slice(0, 12).map((a) => a.icon + ' *' + a.name + '* — ' + a.name_ + ' Rank ' + RANKS[a.tier - 1] + (a.value != null ? ' (' + fmtValue(DEEDS.find((d) => d.key === a.key), a.value) + ')' : ''));
    await postSlack({ text: '📜 *New deeds in the Hall of Deeds*\n' + lines.join('\n') + (announcements.length > 12 ? '\n…and ' + (announcements.length - 12) + ' more' : '') + '\n<' + PORTAL + '/armory.html|The Armory>' }, { channel: 'armory' });
    await touchPulse('deed', announcements[0].name + ' earned ' + announcements[0].name_ + ' Rank ' + RANKS[announcements[0].tier - 1]);
  }
  console.log('[achievements] computed', { members: members.length, announced: announcements.length });
  return { index, announced: announcements.length };
}

export async function getAchievementsIndex() {
  return _store().get('achievements-index', { type: 'json' }).catch(() => null);
}

/** Index, computing it on the spot if it has never been built (or is > 30h old). */
export async function ensureAchievementsIndex() {
  const idx = await getAchievementsIndex();
  if (idx && Date.now() - Date.parse(idx.computedAt || 0) < 30 * 3600000) return idx;
  const r = await computeAchievements({ announce: !!idx });
  return r.index;
}
