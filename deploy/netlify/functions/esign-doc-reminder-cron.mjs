/**
 * esign-doc-reminder-cron.mjs — scheduled daily at 15:30 UTC (~8:30am PT)
 *
 * Deploy 237.023 (Mike): nudges E-Sign signers who have not signed yet. Same
 * cadence rules as the loan-extension reminder cron (esign-reminder-cron):
 * one reminder per signer per ~day, only while their link is live, capped so
 * nobody gets nagged forever. Sequential documents only remind the signers
 * whose turn it is (they're the only ones holding a token).
 *
 * Reads the E-Sign list index (cheap) to find 'sent' documents, then the full
 * record for each so tokens + reminder stamps are authoritative.
 */
import {
  listSummaries, readDoc, writeDoc, pendingSigners, sendInviteEmail, signUrl, pushHistory, baseUrl,
} from './_shared/esign-docs.mjs';

export const config = { schedule: '30 15 * * *' };

const MIN_GAP_MS = 20 * 3600 * 1000;   // "daily" without skipping anyone invited <24h before the run
const MAX_REMINDERS = 5;               // then the LO takes over (Resend on the status page)

export default async () => {
  if (!process.env.RESEND_API_KEY) {
    console.warn('esign-doc-reminder-cron: RESEND_API_KEY not set — skipping');
    return new Response(JSON.stringify({ ok: false, error: 'no api key' }));
  }
  const base = baseUrl();
  const now = Date.now();
  const byOwner = await listSummaries();
  let scanned = 0, reminded = 0, failed = 0;
  for (const ownerKey of Object.keys(byOwner)) {
    for (const sum of byOwner[ownerKey] || []) {
      if (!sum || sum.status !== 'sent') continue;
      const doc = await readDoc(ownerKey, sum.id);
      if (!doc || doc.status !== 'sent') continue;
      scanned++;
      let touched = false;
      for (const s of pendingSigners(doc)) {
        if (!s.token || !s.invitedAt || s.signedAt) continue;
        if (s.tokenExpiresAt && new Date(s.tokenExpiresAt).getTime() < now) continue;
        if ((s.remindCount || 0) >= MAX_REMINDERS) continue;
        const lastTouch = new Date(s.lastReminderAt || s.invitedAt).getTime();
        if (!(now - lastTouch >= MIN_GAP_MS)) continue;
        try {
          await sendInviteEmail({ doc, signer: s, link: signUrl(base, s.token), reminder: true });
          s.lastReminderAt = new Date().toISOString();
          s.remindCount = (s.remindCount || 0) + 1;
          pushHistory(doc, 'reminded', 'Reminder ' + s.remindCount + ' emailed to ' + (s.name || s.email), 'cron');
          reminded++; touched = true;
        } catch (e) {
          failed++;
          console.warn('esign-doc-reminder-cron: reminder failed for', s.email, e && e.message);
        }
      }
      if (touched) {
        try { await writeDoc(doc); } catch (e) { console.warn('esign-doc-reminder-cron: write failed for', doc.id, e && e.message); }
      }
    }
  }
  console.log('esign-doc-reminder-cron:', JSON.stringify({ scanned, reminded, failed }));
  return new Response(JSON.stringify({ ok: true, scanned, reminded, failed }));
};
