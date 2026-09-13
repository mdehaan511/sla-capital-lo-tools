/**
 * mail-sync-cron.mjs — Deploy 236.995 (Mike, mail room)
 *
 * Every 15 minutes: pull new Stable mail into the Unsorted queue, refresh
 * pieces whose scan/forward/shred/deposit is still processing, and compute
 * loan + category suggestions. Same code path as POST /api/mail-sync.
 * Skips quietly until STABLE_API_KEY is set.
 */
import { runSync } from './mail-sync.mjs';
import { stableConfigured } from './_shared/stable-api.mjs';

export const config = { schedule: '*/15 * * * *' };

export default async () => {
  if (!stableConfigured()) {
    return new Response(JSON.stringify({ ok: true, skipped: 'STABLE_API_KEY not set' }), { status: 200 });
  }
  try {
    const r = await runSync({ dryRun: false, budgetMs: 22000, actor: 'auto:mail-sync-cron' });
    if (r.errors && r.errors.length) console.warn('[mail-sync-cron] errors:', JSON.stringify(r.errors.slice(0, 5)));
    return new Response(JSON.stringify(Object.assign({ ok: true }, r)), { status: 200 });
  } catch (e) {
    console.error('[mail-sync-cron] failed:', e && e.message);
    return new Response(JSON.stringify({ ok: false, error: (e && e.message) || 'failed' }), { status: 500 });
  }
};
