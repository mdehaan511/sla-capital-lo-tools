/**
 * town-crier-cron.mjs — Monday 15:00 UTC (8am PDT / 7am PST)
 *
 * Deploy 237.082 (Mike) — sends the Town Crier (weekly team digest) to
 * every team member + the Slack 'armory' channel. All the content and the
 * idempotency live in _shared/town-crier.mjs; this is just the alarm clock.
 * Netlify scheduled functions are invoked by Netlify only (no public
 * route) — nothing to authenticate here.
 */
import { sendTownCrier } from './_shared/town-crier.mjs';

export const config = { schedule: '0 15 * * 1' };

export default async () => {
  try {
    const r = await sendTownCrier();
    console.log('[town-crier-cron]', JSON.stringify({ ok: r.ok, skipped: r.skipped || '', sentTo: (r.sentTo || []).length, stats: r.stats || null }));
  } catch (e) {
    console.error('[town-crier-cron] failed:', e && e.message);
  }
  return new Response('ok');
};
