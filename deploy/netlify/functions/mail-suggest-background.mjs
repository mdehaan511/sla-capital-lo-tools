/**
 * mail-suggest-background.mjs — Deploy 236.998 (Mike, mail room)
 *
 * Drains the Mail Room's suggestion queue (pieces waiting for an AI loan +
 * category suggestion) with a background function's 15-minute budget.
 * Fired by mail-sync-cron when the queue is non-empty; a busy mail day now
 * clears in one run instead of one piece per 15-minute cron tick.
 *
 * Not user-facing and takes no input: the request must carry the
 * x-mail-job signature (HMAC of a server-only secret), and the work is
 * idempotent + locked (meta/lock-suggest), so a stray or repeated call can't
 * double-spend AI calls.
 */
import crypto from 'node:crypto';
import { runSuggestionsLocked } from './mail-sync.mjs';

function expectedSignature() {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || '').update('mail-suggest-background').digest('hex');
}

export default async (req) => {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const got = Buffer.from(String(req.headers.get('x-mail-job') || ''));
  const want = Buffer.from(expectedSignature());
  if (!secret || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    console.warn('[mail-suggest-background] missing/invalid job signature — ignoring');
    return new Response('', { status: 202 });
  }
  try {
    const r = await runSuggestionsLocked({ budgetMs: 13 * 60 * 1000, actor: 'auto:mail-suggest-background' });
    console.log('[mail-suggest-background]', JSON.stringify({
      suggested: r.suggested, remaining: r.remaining, skipped: r.skipped || '', errors: (r.errors || []).length,
    }));
  } catch (e) {
    console.error('[mail-suggest-background] failed:', e && e.message);
  }
  return new Response('', { status: 202 });
};
