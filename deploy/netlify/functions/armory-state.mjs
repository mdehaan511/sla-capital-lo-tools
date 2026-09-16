/**
 * armory-state.mjs — GET /api/armory-state
 *
 * Deploy 237.073 (Mike) — everything armory.html and the game need in one
 * call: this month's Round Table (leaderboard), the caller's own row, the
 * Hall of Champions (past monthly winners + all-time top runs), and the
 * events board. Team members only (see _shared/armory.mjs).
 *
 * Returns: { ok, month, monthLabel, daysLeft, board, me, champions,
 *            allTime, events, isAdmin, gameId }
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { normalizeEmail } from './_shared/auth.mjs';
import { isTeamMember, monthKey, monthLabel, daysLeftInMonth, listAllScores, getEvents, legendsFrom, questForMonth, GAMES, ROTATION, ROTATION_START } from './_shared/armory.mjs';
import { listBells } from './_shared/closing-bell.mjs';                                   // Deploy 237.082
import { loadTeamProfiles, celebrationsOn, upcomingCelebrations, todayPacific } from './_shared/team-events.mjs';
import { latestTownCrier } from './_shared/town-crier.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!(await isTeamMember(user))) return json(403, { error: 'The Armory is for SLA Capital team members.' });

    const now = new Date();
    const month = monthKey(now);
    // Deploy 237.082 — Closing Bell, celebrations, quest rotation and the
    // latest Town Crier ride along in the same call.
    const [allScores, events, bells, profiles, crier] = await Promise.all([
      listAllScores(), getEvents(), listBells(12).catch(() => []), loadTeamProfiles().catch(() => []), latestTownCrier().catch(() => null),
    ]);
    // Deploy 237.083 — the Round Table / champions / legends are PER GAME; the
    // page shows the month's quest. byMonth = the quest's months.
    const questNow = questForMonth(month);
    const byMonth = allScores[questNow.id] || {};
    const ymd = todayPacific(now);
    const celebrations = { today: celebrationsOn(profiles, ymd), upcoming: upcomingCelebrations(profiles, ymd, 30).filter((c) => c.daysAway > 0) };
    const quest = questForMonth(month);
    const nextMonth = (() => { const y = +month.slice(0, 4), m = +month.slice(5); return (m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0')); })();
    const rotation = { start: ROTATION_START, order: ROTATION.map((id) => GAMES[id]), next: questForMonth(nextMonth), nextMonthLabel: monthLabel(nextMonth) };
    const me0 = normalizeEmail(user.email);
    const myProfile = profiles.find((p) => p.email === me0) || null;
    const board = byMonth[month] || [];
    const email = normalizeEmail(user.email);
    const meIdx = board.findIndex((r) => r.email === email);
    const me = meIdx >= 0 ? Object.assign({ rank: meIdx + 1 }, board[meIdx]) : null;

    // Past months, newest first: the #1 row of each closed month, in whatever
    // game was THAT month's quest (Deploy 237.083).
    const pastMonths = {};
    Object.keys(allScores).forEach((g) => Object.keys(allScores[g]).forEach((m) => { if (m !== month && questForMonth(m).id === g) pastMonths[m] = allScores[g][m]; }));
    const champions = Object.keys(pastMonths).sort().reverse()
      .map((m) => Object.assign({ monthLabel: monthLabel(m), players: pastMonths[m].length, gameName: questForMonth(m).name, gameIcon: questForMonth(m).icon }, pastMonths[m][0]));
    // Best run per player across every month, top 10.
    const bestByPlayer = {};
    Object.keys(byMonth).forEach((m) => byMonth[m].forEach((r) => {
      if (!bestByPlayer[r.email] || r.best > bestByPlayer[r.email].best) bestByPlayer[r.email] = r;
    }));
    const allTime = Object.keys(bestByPlayer).map((k) => bestByPlayer[k]).sort((a, b) => b.best - a.best).slice(0, 10);

    // Deploy 237.077 — the three best scores ever, permanent (the monthly
    // board resets; this never does).
    const legends = legendsFrom(byMonth, 3);
    const legendsByGame = {};
    Object.keys(GAMES).forEach((g) => { legendsByGame[g] = legendsFrom(allScores[g] || {}, 3); });

    return json(200, {
      ok: true, gameId: questNow.id, month, monthLabel: monthLabel(month), daysLeft: daysLeftInMonth(now),
      board, me, champions, allTime, legends, legendsByGame, events, isAdmin: isAdmin(user),
      quest, rotation, bells, celebrations,
      crier: crier ? { ymd: crier.ymd, subject: crier.subject, at: crier.at } : null,
      myCalendar: myProfile ? { birthday: myProfile.birthday, startDate: myProfile.startDate, avatar: myProfile.avatar || '' } : null,
      // Deploy 237.086 — chosen avatars, email → key (Round Table, podium, Legends, Hall of Deeds).
      avatars: profiles.reduce((m, p) => { if (p.avatar) m[p.email] = p.avatar; return m; }, {}),
      // Deploy 237.097 — the whole roster, so the Round Table can list everyone
      // (including knights who have not ridden this month).
      roster: profiles.map((p) => ({ email: p.email, name: p.name, avatar: p.avatar || '' })),
    });
  } catch (e) {
    console.error('armory-state error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
