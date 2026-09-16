/**
 * armory-admin.mjs — POST /api/armory-admin   (admin only)
 *
 * Deploy 237.073 (Mike) — the two things an admin does on armory.html:
 *
 *   { action: 'events-save', events: [...] }   replace the events board
 *   { action: 'score-void', month, email }     wipe a player's score for a
 *                                              month (typo'd cheat, test run)
 *
 * Returns: { ok, events } or { ok, removed }
 */
import { handleOptions, json, requireAuth, isAdmin, readJsonBody, normalizeEmail } from './_shared/auth.mjs';
import { saveEvents, voidScore, isMonthKey, isGameId, questForMonth } from './_shared/armory.mjs';
import { sendTownCrier, latestTownCrier } from './_shared/town-crier.mjs'; // Deploy 237.082
import { computeAchievements } from './_shared/achievements.mjs';        // Deploy 237.085

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    const body = await readJsonBody(req);
    const action = String((body && body.action) || '');

    if (action === 'events-save') {
      const events = await saveEvents(body.events, user.email);
      return json(200, { ok: true, events });
    }
    if (action === 'score-void') {
      const month = String(body.month || '');
      const email = normalizeEmail(body.email);
      if (!isMonthKey(month) || !email) return json(400, { error: 'month (YYYY-MM) and email are required' });
      const game = isGameId(body.game) ? body.game : questForMonth(month).id; // Deploy 237.083 — per game
      const removed = await voidScore(month, email, game);
      console.log('[armory] score voided', { month, email, game, by: normalizeEmail(user.email) });
      return json(200, { ok: true, removed });
    }
    // Deploy 237.082 — Town Crier controls. 'crier-send-test' emails the
    // built issue to the CALLER only (no Slack, no archive) so Mike can see
    // Monday's digest before Monday. 'crier-latest' returns the archived HTML
    // for the "read the latest Town Crier" modal.
    if (action === 'crier-send-test') {
      const r = await sendTownCrier({ onlyTo: normalizeEmail(user.email) });
      return json(200, { ok: !!r.ok, sentTo: r.sentTo, stats: r.stats });
    }
    // Deploy 237.085 — rebuild the Hall of Deeds now (the daily cron does it
    // at 8:10am PT; this is for "I just entered the start dates").
    if (action === 'achievements-recompute') {
      const r = await computeAchievements({ announce: true });
      return json(200, { ok: true, members: r.index.members.length, announced: r.announced });
    }
    if (action === 'crier-latest') {
      const c = await latestTownCrier();
      return json(200, { ok: true, crier: c ? { ymd: c.ymd, subject: c.subject, html: c.html, at: c.at } : null });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('armory-admin error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
