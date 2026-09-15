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
import { saveEvents, voidScore, isMonthKey } from './_shared/armory.mjs';

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
      const removed = await voidScore(month, email);
      console.log('[armory] score voided', { month, email, by: normalizeEmail(user.email) });
      return json(200, { ok: true, removed });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('armory-admin error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
