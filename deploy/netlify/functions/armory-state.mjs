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
import { isTeamMember, monthKey, monthLabel, daysLeftInMonth, listAllMonths, getEvents, GAME_ID } from './_shared/armory.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!(await isTeamMember(user))) return json(403, { error: 'The Armory is for SLA Capital team members.' });

    const now = new Date();
    const month = monthKey(now);
    const [byMonth, events] = await Promise.all([listAllMonths(), getEvents()]);
    const board = byMonth[month] || [];
    const email = normalizeEmail(user.email);
    const meIdx = board.findIndex((r) => r.email === email);
    const me = meIdx >= 0 ? Object.assign({ rank: meIdx + 1 }, board[meIdx]) : null;

    // Past months, newest first: the #1 row of each closed month.
    const champions = Object.keys(byMonth).filter((m) => m !== month).sort().reverse()
      .map((m) => Object.assign({ monthLabel: monthLabel(m), players: byMonth[m].length }, byMonth[m][0]));
    // Best run per player across every month, top 10.
    const bestByPlayer = {};
    Object.keys(byMonth).forEach((m) => byMonth[m].forEach((r) => {
      if (!bestByPlayer[r.email] || r.best > bestByPlayer[r.email].best) bestByPlayer[r.email] = r;
    }));
    const allTime = Object.keys(bestByPlayer).map((k) => bestByPlayer[k]).sort((a, b) => b.best - a.best).slice(0, 10);

    return json(200, {
      ok: true, gameId: GAME_ID, month, monthLabel: monthLabel(month), daysLeft: daysLeftInMonth(now),
      board, me, champions, allTime, events, isAdmin: isAdmin(user),
    });
  } catch (e) {
    console.error('armory-state error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
