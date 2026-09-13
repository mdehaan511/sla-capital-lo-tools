/**
 * stable-webhook-background.mjs — POST /api/stable-webhook
 *
 * Deploy 236.995 (Mike, mail room). Stable delivers webhooks through Svix.
 * Any verified event simply triggers a sync — the payload is never trusted as
 * data (the sync re-reads Stable's API), so a webhook just makes new mail show
 * up in minutes instead of waiting for the 15-minute cron.
 *
 * Verification: Svix scheme — HMAC-SHA256 over "<svix-id>.<svix-timestamp>.<body>"
 * keyed with the endpoint secret (STABLE_WEBHOOK_SECRET, "whsec_…" from Stable's
 * dashboard → Settings → Webhooks), timestamp within 5 minutes. Without the
 * secret configured every request is ignored.
 *
 * Background function (-background suffix): Netlify answers 202 immediately,
 * which is what Svix wants, and the sync gets the long time budget.
 */
import crypto from 'node:crypto';
import { runSync } from './mail-sync.mjs';
import { stableConfigured } from './_shared/stable-api.mjs';

function verify(secret, id, ts, body, sigHeader) {
  if (!id || !ts || !sigHeader) return false;
  const age = Math.abs(Date.now() / 1000 - Number(ts));
  if (!isFinite(age) || age > 300) return false;
  const key = Buffer.from(secret.indexOf('whsec_') === 0 ? secret.slice(6) : secret, 'base64');
  const expected = crypto.createHmac('sha256', key).update(id + '.' + ts + '.' + body).digest('base64');
  const exp = Buffer.from(expected);
  return String(sigHeader).split(' ').some((part) => {
    const v = part.split(',')[1];
    if (!v) return false;
    const got = Buffer.from(v);
    return got.length === exp.length && crypto.timingSafeEqual(got, exp);
  });
}

export default async (req) => {
  const secret = process.env.STABLE_WEBHOOK_SECRET || '';
  const body = await req.text();
  if (!secret || !stableConfigured()) {
    console.warn('[stable-webhook] STABLE_WEBHOOK_SECRET / STABLE_API_KEY not set — ignoring');
    return new Response('', { status: 202 });
  }
  const ok = verify(secret, req.headers.get('svix-id'), req.headers.get('svix-timestamp'), body, req.headers.get('svix-signature'));
  if (!ok) {
    console.warn('[stable-webhook] signature verification failed — ignoring');
    return new Response('', { status: 202 });
  }
  try {
    const r = await runSync({ dryRun: false, budgetMs: 240000, maxPages: 4, actor: 'auto:stable-webhook' });
    console.log('[stable-webhook] sync:', JSON.stringify({ created: r.created, updated: r.updated, suggested: r.suggested, errors: (r.errors || []).length }));
  } catch (e) {
    console.error('[stable-webhook] sync failed:', e && e.message);
  }
  return new Response('', { status: 202 });
};
