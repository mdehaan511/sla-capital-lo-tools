/**
 * armory-achievements.mjs — GET /api/armory-achievements
 *
 * Deploy 237.085 (Mike) — the Hall of Deeds: every team member's earned
 * ranks + progress, for the Armory and the Profile page (everyone sees
 * everyone's). Builds the index on the spot the first time (26s timeout in
 * netlify.toml); the daily cron keeps it fresh after that.
 *
 * Returns: { ok, computedAt, deeds: DEEDS, ranks, members: [{ email, name,
 *            earned: { key: { tier, at } }, metrics }], recent: [...] }
 */
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';
import { isTeamMember } from './_shared/armory.mjs';
import { ensureAchievementsIndex, DEEDS, RANKS } from './_shared/achievements.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!(await isTeamMember(user))) return json(403, { error: 'The Armory is for SLA Capital team members.' });
    const idx = await ensureAchievementsIndex();
    return json(200, { ok: true, computedAt: idx.computedAt, deeds: DEEDS, ranks: RANKS, members: idx.members || [], recent: idx.recent || [] });
  } catch (e) {
    console.error('armory-achievements error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
