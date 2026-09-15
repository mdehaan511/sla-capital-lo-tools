/**
 * armory-score-submit.mjs — POST /api/armory-score-submit
 *
 * Deploy 237.073 (Mike) — game over → the score comes here with the run
 * token from armory-run-start. The server checks the token signature,
 * expiry and single-use, measures the ride's elapsed time itself, and
 * rejects anything that scores faster than the game can possibly pay out
 * (_shared/armory.mjs). Accepted runs update the player's month doc.
 *
 * Body:    { token, score, coins, distance, durationMs }
 * Returns: { ok, accepted, reason, best, isNewBest, rank, top, month }
 *   rank / top reflect THIS month's board after the write, so the game can
 *   say "you're #3 at the Round Table" without a second call.
 */
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail } from './_shared/auth.mjs';
import { isTeamMember, verifyRunToken, recordRun, listMonth, listAllMonths, legendsFrom, monthKey, questForMonth, GAMES, RUN_TOKEN_TTL_MS } from './_shared/armory.mjs';
import { postSlack } from './_shared/slack.mjs'; // Deploy 237.082

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!(await isTeamMember(user))) return json(403, { error: 'The Armory is for SLA Capital team members.' });
    const body = await readJsonBody(req);

    const payload = verifyRunToken(body && body.token);
    if (!payload) return json(400, { error: 'Invalid run token' });
    if (payload.e !== normalizeEmail(user.email)) return json(403, { error: 'Run token belongs to another knight' });
    if (Date.now() - Number(payload.t) > RUN_TOKEN_TTL_MS) return json(400, { error: 'Run token expired — start a new ride' });

    // Deploy 237.083 — the game rides on the token; a token for a game that is
    // no longer this month's quest (month rolled over mid-session) is practice.
    const month = monthKey(new Date());
    const game = payload.g;
    const quest = questForMonth(month);
    if (game !== quest.id) return json(200, { ok: true, accepted: false, practice: true, reason: 'Practice run — ' + quest.name + ' is this month\'s quest.', game, month });

    const result = await recordRun(user, {
      runId: payload.id, issuedAt: payload.t, game,
      score: body.score, coins: body.coins, distance: body.distance, durationMs: body.durationMs,
    });
    const board = await listMonth(month, game);
    const email = normalizeEmail(user.email);
    const rankIdx = board.findIndex((r) => r.email === email);
    // Deploy 237.077 — did this ride enter the permanent all-time top 3 (per game)?
    // Only worth the extra prefix read when the run set a new personal best.
    let legendRank = null;
    if (result.accepted && result.isNewBest) {
      const legends = legendsFrom(await listAllMonths(game), 3);
      const li = legends.findIndex((r) => r.email === email && r.month === month && r.best === result.best);
      if (li >= 0) legendRank = li + 1;
      // Deploy 237.082 — a new Legend seat is a milestone: tell leadership.
      if (legendRank) {
        const who = legends[li].name || email;
        await postSlack({ text: '⚜ *Legend of the Realm!* ' + who + ' just took the #' + legendRank + ' all-time seat in ' + GAMES[game].name + ' with *' + String(result.best).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '* 🏆\n<https://portal.slacapital.ai/armory.html|The Armory>' }, { channel: 'leadership' });
      }
    }
    return json(200, {
      ok: true, accepted: result.accepted, reason: result.reason || '', best: result.best, isNewBest: result.isNewBest,
      rank: rankIdx >= 0 ? rankIdx + 1 : null, players: board.length, legendRank, game,
      top: board[0] ? { name: board[0].name, best: board[0].best, email: board[0].email } : null, month,
    });
  } catch (e) {
    console.error('armory-score-submit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
