/**
 * achievements-cron.mjs — daily 15:10 UTC (after the team-calendar cron)
 *
 * Deploy 237.085 (Mike) — recomputes every team member's deeds from closed
 * loans + the Armory score docs, announces new ranks to the 'armory' Slack
 * channel and lights the Armory pulse. See _shared/achievements.mjs.
 */
import { computeAchievements } from './_shared/achievements.mjs';

export const config = { schedule: '10 15 * * *' };

export default async () => {
  try {
    const r = await computeAchievements({ announce: true });
    console.log('[achievements-cron]', JSON.stringify({ members: r.index.members.length, announced: r.announced }));
  } catch (e) {
    console.error('[achievements-cron] failed:', e && e.message);
  }
  return new Response('ok');
};
