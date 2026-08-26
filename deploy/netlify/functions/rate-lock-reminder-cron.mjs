/**
 * rate-lock-reminder-cron.mjs — daily rate-lock expiration reminders
 *
 * Deploy 236.763 — DSCR loans carry a 45-day rate lock from the day the
 * loan application is signed (loan.rateLockStart, stamped at signing;
 * legacy loans fall back to borrowerInfoCompletedAt). When the lock has
 * 30 / 15 / 10 / 5 days remaining, BOTH the borrower and the Loan
 * Officer get an email.
 *
 * Idempotency: loan.rateLockNotified = { '30': iso, '15': iso, … } is
 * stamped on the loan after a send. If the cron misses the exact day
 * (e.g. daysLeft is 13 on first sight), it sends ONE catch-up email for
 * the smallest threshold ≥ daysLeft and marks every threshold ≥ daysLeft
 * as covered — never a burst of back-dated emails. The Reset Rate Lock
 * action clears the ledger so a fresh 45-day period re-arms all four.
 *
 * Candidates come from a fast PG page-through (same pattern as
 * processing-alerts); the send + ledger stamp re-reads the CLIENT BLOB
 * (source of truth) and writes through writeClient (strict discipline).
 * Zero-throw; time-budgeted under Netlify's ~30s scheduled-fn kill.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { getOwnerReplyTo, logBorrowerSendFromResponse } from './_shared/email.mjs';

export const config = { schedule: '10 16 * * *' }; // 16:10 UTC ≈ 9:10am PT

const LOCK_DAYS   = 45;
const THRESHOLDS  = [30, 15, 10, 5]; // descending
const TIME_BUDGET_MS = 24_000;
const MAX_LOANS_PER_RUN = 40;
const DEAD_STATUSES = ['closed', 'cancelled', 'denied', 'sold', 'liquidated', 'paid_off'];

export function lockDaysLeft(startIso, now) {
  const t = Date.parse(startIso || '');
  if (!isFinite(t)) return null;
  const expires = t + LOCK_DAYS * 86400000;
  return Math.ceil((expires - (now || Date.now())) / 86400000);
}

function _fmtDate(ms) {
  const d = new Date(ms);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
}

async function _candidatesFromPG() {
  const SELECT = 'id,client_id,owner_email,address,status,processing_stage,tool_type,extra';
  const PAGE = 1000;
  const out = [];
  let offset = 0;
  for (;;) {
    const rows = await db.select('loans', { select: SELECT, limit: PAGE, offset });
    for (const r of (rows || [])) {
      if (String(r.tool_type || '').toLowerCase() !== 'dscr') continue;
      if (DEAD_STATUSES.includes(String(r.status || '').toLowerCase())) continue;
      if (String(r.processing_stage || '') === 'pp_closed') continue;
      const ex = r.extra || {};
      const start = ex.rateLockStart || ex.borrowerInfoCompletedAt || '';
      if (!start) continue;
      const d = lockDaysLeft(start);
      if (d == null || d <= 0 || d > THRESHOLDS[0]) continue;
      // Smallest threshold ≥ daysLeft that hasn't been covered yet.
      const notified = ex.rateLockNotified || {};
      const due = THRESHOLDS.filter((t) => d <= t && !notified[String(t)]);
      if (!due.length) continue;
      out.push({ row: r, daysLeft: d, tier: due[due.length - 1], coverTiers: due });
    }
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break;
  }
  // Most urgent first so a budget cut never starves the closest expirations.
  out.sort((a, b) => a.daysLeft - b.daysLeft);
  return out;
}

async function _sendEmail(apiKey, to, subject, html, text, replyTo) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [to],
      ...(replyTo ? { reply_to: replyTo } : {}),
      subject, html, text,
    }),
  });
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function _emailBodies({ firstName, address, daysLeft, expiresStr, forLO, loLabel }) {
  const who = forLO
    ? 'The rate lock on your loan at ' + (address || '(no address)') + (loLabel ? ' (' + loLabel + ')' : '')
    : 'The rate lock on your loan' + (address ? ' at ' + address : '');
  const subject = 'Rate lock expires in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') +
    (address ? ' — ' + address : '');
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Rate Lock Expiration Notice</h1></div>' +
    '<div style="padding:24px">' +
    '<p style="font-size:14px">' + (firstName ? 'Hi ' + esc(firstName) + ',' : 'Hello,') + '</p>' +
    '<p style="font-size:14px">' + esc(who) + ' expires in <strong>' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + '</strong>, on <strong>' + esc(expiresStr) + '</strong>.</p>' +
    (forLO
      ? '<p style="font-size:14px">If the loan will not close before then, reach out to the borrower and your manager about next steps or a lock reset.</p>'
      : '<p style="font-size:14px">To keep your locked rate, your loan needs to close before that date. Please make sure any outstanding documents are submitted, and reply to this email if you have questions — your loan officer is happy to help.</p>') +
    '</div></div></body></html>';
  const text = (firstName ? 'Hi ' + firstName + ',\n\n' : '') +
    who + ' expires in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ', on ' + expiresStr + '.\n\n' +
    (forLO
      ? 'If the loan will not close before then, reach out to the borrower and your manager about next steps or a lock reset.'
      : 'To keep your locked rate, your loan needs to close before that date. Reply to this email with any questions.') +
    '\n\n— SLA Capital';
  return { subject, html, text };
}

export default async () => {
  const started = Date.now();
  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { console.warn('[rate-lock-cron] no RESEND_API_KEY'); return new Response('{"ok":false}'); }

    const candidates = await _candidatesFromPG();
    scanned = candidates.length;
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

    for (const c of candidates) {
      if (Date.now() - started > TIME_BUDGET_MS || sent >= MAX_LOANS_PER_RUN) break;
      try {
        const ownerEmail = String(c.row.owner_email || '').toLowerCase();
        const ownerKey = keySafe(ownerEmail);
        const client = await clientsStore.get(ownerKey + '/' + keySafe(c.row.client_id), { type: 'json' });
        const loan = client && Array.isArray(client.loans)
          ? client.loans.find((l) => l && l.id === c.row.id) : null;
        if (!loan) { skipped++; continue; }

        // Recompute from the BLOB (source of truth) — PG could be stale.
        const start = loan.rateLockStart || loan.borrowerInfoCompletedAt || '';
        const d = lockDaysLeft(start);
        if (d == null || d <= 0 || d > THRESHOLDS[0]) { skipped++; continue; }
        const notified = loan.rateLockNotified || {};
        const due = THRESHOLDS.filter((t) => d <= t && !notified[String(t)]);
        if (!due.length) { skipped++; continue; }

        const expiresMs = Date.parse(start) + LOCK_DAYS * 86400000;
        const expiresStr = _fmtDate(expiresMs);
        const address = loan.address || '';
        const borrowerEmail = String((client.email || loan.borrowerEmail || '')).trim().toLowerCase();
        const borrowerFirst = client.firstName || '';
        const borrowerLabel = ((client.firstName || '') + ' ' + (client.lastName || '')).trim();

        // Borrower email (bounce-logged so the LO hears about a bad address).
        if (borrowerEmail && borrowerEmail.includes('@')) {
          const b = _emailBodies({ firstName: borrowerFirst, address, daysLeft: d, expiresStr, forLO: false });
          const replyTo = await getOwnerReplyTo(ownerKey).catch(() => null);
          const resp = await _sendEmail(apiKey, borrowerEmail, b.subject, b.html, b.text, replyTo);
          if (resp.ok) {
            try {
              await logBorrowerSendFromResponse(resp, {
                kind: 'rate_lock_reminder', to: borrowerEmail, ownerKey, address, loEmail: ownerEmail,
              });
            } catch (_) {}
          } else {
            console.warn('[rate-lock-cron] borrower send failed', resp.status, address);
          }
        }
        // LO email.
        if (ownerEmail && ownerEmail.includes('@')) {
          const b = _emailBodies({ firstName: '', address, daysLeft: d, expiresStr, forLO: true, loLabel: borrowerLabel });
          const resp = await _sendEmail(apiKey, ownerEmail, b.subject, b.html, b.text, null);
          if (!resp.ok) console.warn('[rate-lock-cron] LO send failed', resp.status, address);
        }

        // Mark every threshold ≥ daysLeft covered (one catch-up email, not a burst).
        loan.rateLockNotified = Object.assign({}, notified);
        const nowIso = new Date().toISOString();
        for (const t of due) loan.rateLockNotified[String(t)] = nowIso;
        loan.updatedAt = nowIso;
        await writeClient(ownerKey, client, { clientsStore });
        sent++;
      } catch (e) {
        failed++;
        console.error('[rate-lock-cron] loan failed:', c.row && c.row.id, e && e.message);
      }
    }
    console.log(`[rate-lock-cron] candidates=${scanned} sent=${sent} skipped=${skipped} failed=${failed}`);
  } catch (e) {
    console.error('[rate-lock-cron] error:', e && e.message);
  }
  return new Response(JSON.stringify({ ok: true, scanned, sent, skipped, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
