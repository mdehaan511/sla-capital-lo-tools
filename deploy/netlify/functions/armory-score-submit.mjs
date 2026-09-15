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
import { isTeamMember, verifyRunToken, recordRun, listMonth, listAllMonths, legendsFrom, monthKey, RUN_TOKEN_TTL_MS } from './_shared/armory.mjs';

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

    const result = await recordRun(user, {
      runId: payload.id, issuedAt: payload.t,
      score: body.score, coins: body.coins, distance: body.distance, durationMs: body.durationMs,
    });
    const month = monthKey(new Date());
    const board = await listMonth(month);
    const email = normalizeEmail(user.email);
    const rankIdx = board.findIndex((r) => r.email === email);
    // Deploy 237.063 — did this ride enter the permanent all-time top 3?
    // Only worth the extra prefix read when the run set a new personal best.
    let legendRank = null;
    if (result.accepted && result.isNewBest) {
      const legends = legendsFrom(await listAllMonths(), 3);
      const li = legends.findIndex((r) => r.email === email && r.month === month && r.best === result.best);
      if (li >= 0) legendRank = li + 1;
    }
    return json(200, {
      ok: true, accepted: result.accepted, reason: result.reason || '', best: result.best, isNewBest: result.isNewBest,
      rank: rankIdx >= 0 ? rankIdx + 1 : null, players: board.length, legendRank,
      top: board[0] ? { name: board[0].name, best: board[0].best, email: board[0].email } : null, month,
    });
  } catch (e) {
    console.error('armory-score-submit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
