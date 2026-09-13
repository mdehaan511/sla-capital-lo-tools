/**
 * mail-sync-cron.mjs — Deploy 236.995 (Mike, mail room)
 *
 * Every 15 minutes: pull new Stable mail into the Unsorted queue and refresh
 * pieces whose scan/forward/shred/deposit is still processing. Same code path
 * as POST /api/mail-sync. Skips quietly until STABLE_API_KEY is set.
 *
 * Deploy 236.998 — suggestions no longer run inside this 30s scheduled
 * function (an AI call started late could get it killed). When pieces are
 * waiting for a suggestion, the cron fires mail-suggest-background, which has
 * a 15-minute budget; the request is signed with an HMAC of a server-only
 * secret that mail-suggest-background checks.
 */
import crypto from 'node:crypto';
import { runSync } from './mail-sync.mjs';
import { stableConfigured } from './_shared/stable-api.mjs';

export const config = { schedule: '*/15 * * * *' };

function mailJobSignature() {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || '').update('mail-suggest-background').digest('hex');
}

export default async () => {
  if (!stableConfigured()) {
    return new Response(JSON.stringify({ ok: true, skipped: 'STABLE_API_KEY not set' }), { status: 200 });
  }
  try {
    const r = await runSync({ dryRun: false, budgetMs: 20000, suggest: false, actor: 'auto:mail-sync-cron' });
    if (r.errors && r.errors.length) console.warn('[mail-sync-cron] errors:', JSON.stringify(r.errors.slice(0, 5)));
    if (r.suggestionsQueued > 0 && process.env.SUPABASE_SERVICE_ROLE_KEY) {
      const base = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
      try {
        const resp = await fetch(base + '/.netlify/functions/mail-suggest-background', {
          method: 'POST',
          headers: { 'x-mail-job': mailJobSignature() },
          signal: AbortSignal.timeout(5000),
        });
        r.suggestJob = resp.status;
      } catch (e) {
        r.suggestJob = 'trigger failed: ' + ((e && e.message) || '');
      }
    }
    return new Response(JSON.stringify(Object.assign({ ok: true }, r)), { status: 200 });
  } catch (e) {
    console.error('[mail-sync-cron] failed:', e && e.message);
    return new Response(JSON.stringify({ ok: false, error: (e && e.message) || 'failed' }), { status: 500 });
  }
};
