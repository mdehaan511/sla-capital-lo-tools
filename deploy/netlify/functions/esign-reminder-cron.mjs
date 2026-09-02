/**
 * esign-reminder-cron.mjs — scheduled daily at 15:00 UTC (~8am PT)
 *
 * Deploy 236.848 (Mike) — daily signature reminders for Loan Extension
 * Agreements: any invited signer who hasn't signed yet gets the invitation
 * re-sent (same link, "Reminder —" subject) once every ~24 hours until they
 * sign or their token expires (30 days).
 *
 * Scoped to envelopeKind 'loan_extension' for now — widening it to term
 * sheets / loan apps is just loosening the kind filter below, but that
 * changes borrower-facing behavior for every LO, so it stays opt-in.
 *
 * Scan cost control: envelope ids embed their creation time
 * (env_<ms>_<rand>), so we prune the key listing to envelopes younger than
 * the token TTL without reading every envelope ever created.
 *
 * Sequential envelopes need no special handling: a not-yet-invited signer
 * has invitedAt = null and is skipped until envelope-sign invites them.
 */
import { getStore } from '@netlify/blobs';
import { sendInvitationEmail } from './envelopes-send.mjs';

export const config = { schedule: '0 15 * * *' };

const PENDING = new Set(['sent', 'partial_send_failure', 'partially_signed']);
const MAX_AGE_DAYS = 35;  // token TTL is 30 days — older envelopes can't be signed
// Daily cron + "every 24 hours" intent: a strict >=24h gap would skip anyone
// invited less than a full day before the run and stretch their cadence to
// 48h, so anything close to a day counts.
const MIN_GAP_MS = 20 * 3600 * 1000;

export default async () => {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('esign-reminder-cron: RESEND_API_KEY not set — skipping');
    return new Response(JSON.stringify({ ok: false, error: 'no api key' }));
  }
  const store = getStore({ name: 'envelopes', consistency: 'strong' });
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
  const now = Date.now();

  const { blobs } = await store.list();
  let scanned = 0;
  let reminded = 0;
  for (const b of blobs || []) {
    const m = /\/env_(\d{13})_/.exec(b.key || '');
    if (!m || now - parseInt(m[1], 10) > MAX_AGE_DAYS * 86400000) continue;

    let env;
    try { env = await store.get(b.key, { type: 'json' }); } catch (_) { continue; }
    if (!env || env.envelopeKind !== 'loan_extension' || !PENDING.has(env.status)) continue;
    scanned++;

    let touched = false;
    for (const s of env.signers || []) {
      if (!s || (s.audit && s.audit.signedAt) || !s.token || !s.invitedAt) continue;
      if (s.tokenExpiresAt && new Date(s.tokenExpiresAt).getTime() < now) continue;
      const lastTouch = new Date(s.lastReminderAt || s.invitedAt).getTime();
      if (!(now - lastTouch >= MIN_GAP_MS)) continue;

      const link = base + '/term-sheet-sign.html?t=' + encodeURIComponent(s.token);
      let ok = false;
      try {
        ok = await sendInvitationEmail({
          apiKey, signer: s, envelope: env, link,
          loName: env.requesterEmail || env.ownerEmail || 'SLA Capital',
          propertyAddress: env.propertyAddress || '',
          ownerKey: env.ownerKey,
          reminder: true,
        });
      } catch (e) {
        console.warn('esign-reminder-cron: reminder to', s.email, 'failed:', e && e.message);
      }
      if (ok) {
        s.lastReminderAt = new Date(now).toISOString();
        s.remindCount = (s.remindCount || 0) + 1;
        if (!Array.isArray(env.history)) env.history = [];
        env.history.push({
          ts: s.lastReminderAt, status: env.status,
          note: 'Daily reminder #' + s.remindCount + ' sent to ' + s.email + '.',
        });
        touched = true;
        reminded++;
      }
    }
    if (touched) {
      try { await store.setJSON(b.key, env); }
      catch (e) { console.warn('esign-reminder-cron: envelope save failed for', b.key, ':', e && e.message); }
    }
  }
  console.log('esign-reminder-cron: ' + scanned + ' pending extension envelope(s), ' + reminded + ' reminder(s) sent.');
  return new Response(JSON.stringify({ ok: true, scanned, reminded }));
};
