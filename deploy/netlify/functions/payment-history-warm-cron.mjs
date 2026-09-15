/**
 * payment-history-warm-cron.mjs — scheduled 10:15 UTC daily.
 *
 * Deploy 237.054 (Mike) — kicks payment-history-warm-background (15-min
 * budget) after the 09:40 FCI and 09:55 Servicing Pros portfolio syncs, so the
 * Closed Loans Servicing tab has every borrower's payment history cached
 * before the day starts. Same HMAC hand-off pattern as mail-sync-cron →
 * mail-suggest-background.
 */
import crypto from 'node:crypto';

export const config = { schedule: '15 10 * * *' };

function jobSignature() {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || '').update('payment-history-warm').digest('hex');
}

export default async () => {
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || '';
  if (!base) return new Response(JSON.stringify({ ok: false, reason: 'no site URL' }), { headers: { 'Content-Type': 'application/json' } });
  try {
    const resp = await fetch(base + '/.netlify/functions/payment-history-warm-background', {
      method: 'POST',
      headers: { 'x-history-job': jobSignature(), 'Content-Type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(8000),
    });
    return new Response(JSON.stringify({ ok: resp.status === 202 || resp.ok, status: resp.status }), { headers: { 'Content-Type': 'application/json' } });
  } catch (e) {
    return new Response(JSON.stringify({ ok: false, error: (e && e.message) || 'trigger failed' }), { headers: { 'Content-Type': 'application/json' } });
  }
};
