/**
 * maturity-reminder-cron.mjs — one-month-to-maturity notice to the borrower.
 *
 * Deploy 236.806 (Mike) — when a serviced loan is a month from maturing, email
 * the borrower, CC payoffs@slacapital.com, and ask them to say by the 15th
 * whether they need an extension so the loan doesn't default at maturity. The
 * borrower answers by hitting Reply All, which reaches both us and their own
 * record of it.
 *
 * ── Why the 15th works out ───────────────────────────────────────────
 * Checked against the live FCI book: ALL 41 performing loans mature on the 1st
 * of a month. Firing at 30 days out therefore lands the email on the 1st or 2nd
 * of the prior month, which puts "the 15th" about two weeks later and about two
 * weeks before maturity — real time to paper an extension.
 *
 * That regularity is a property of today's book, not a guarantee, so
 * _replyByMs() falls back to (maturity − 14 days) whenever the 15th of the send
 * month is already past or lands on/after maturity. The email always prints the
 * actual date rather than the words "the 15th", so an odd maturity date can
 * never produce a deadline the borrower has to guess at.
 *
 * ── Sending discipline ───────────────────────────────────────────────
 * Idempotent via loan.maturityNotified = { '30': iso } — one notice per loan per
 * maturity date. If the maturity date MOVES (an extension is granted), the
 * ledger is keyed by the date it was sent for, so a new date re-arms the notice.
 * Zero-throw, time-budgeted under Netlify's scheduled-function kill, and
 * candidates come from a PG page-through with the send re-reading the client
 * blob (source of truth) — same shape as rate-lock-reminder-cron.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { logBorrowerSendFromResponse } from './_shared/email.mjs';

export const config = { schedule: '20 16 * * *' }; // 16:20 UTC ≈ 9:20am PT

export const PAYOFF_INBOX = 'payoffs@slacapital.com';
// Deploy 236.808 — fire in a BAND, not just "≤ 30". The first preview turned up
// three loans maturing the very next day; a letter headed "you have about one
// month" that also asks for an answer "by the 15th" is nonsense at one day out,
// and the reply-by date would already be in the past. Anything inside 21 days is
// a payoff conversation, not this one.
//
// The band is 11 days wide rather than a single day so a missed or failed run
// doesn't silently skip a loan — and the email states the ACTUAL day count, so
// a catch-up send at 22 days still reads correctly.
const THRESHOLD_DAYS = 31;
const MIN_DAYS = 21;
const TIME_BUDGET_MS = 24_000;
const MAX_LOANS_PER_RUN = 40;
// A loan in one of these states isn't heading to maturity any more.
const DEAD_DISPOSITIONS = ['paid_off', 'liquidated'];
const DEAD_STATUSES = ['cancelled', 'denied'];

function _parseDate(v) {
  const s = String(v == null ? '' : v).trim();
  if (!s || /^n\/?a$/i.test(s)) return NaN;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]);
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return Date.UTC(+m[3], +m[1] - 1, +m[2]);
  return NaN;
}

function _fmt(ms) {
  const d = new Date(ms);
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
  return MONTHS[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear();
}

export function daysToMaturity(maturity, now) {
  const t = _parseDate(maturity);
  if (!isFinite(t)) return null;
  // Compare date-to-date in UTC so a run at 9am PT doesn't read as a day early.
  const n = now || Date.now();
  const today = Date.UTC(new Date(n).getUTCFullYear(), new Date(n).getUTCMonth(), new Date(n).getUTCDate());
  return Math.round((t - today) / 86400000);
}

/** The date we ask them to respond by. See the header for why this is the 15th. */
export function _replyByMs(sendMs, maturityMs) {
  const d = new Date(sendMs);
  const fifteenth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15);
  if (fifteenth > sendMs && fifteenth < maturityMs) return fifteenth;
  // Odd maturity date — give them two weeks before it, but never a past date.
  return Math.max(sendMs + 86400000, maturityMs - 14 * 86400000);
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildMaturityEmail({ firstName, address, maturityMs, replyByMs, daysLeft }) {
  const matStr = _fmt(maturityMs);
  const byStr = _fmt(replyByMs);
  const subject = 'Your loan matures ' + matStr + (address ? ' — ' + address : '') + ' (action needed)';

  // Deploy 236.808 — state the real number of days. The band is 21–31, so a
  // catch-up send should say "in 23 days", not claim "about one month".
  const when = (daysLeft >= 28 && daysLeft <= 31)
    ? 'about one month from today'
    : 'in ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's');
  const p1 = 'Your loan' + (address ? ' secured by ' + address : '') +
    ' reaches its maturity date on ' + matStr + ' — ' + when + '.';
  const p2 = 'Please let us know by ' + byStr + ' whether you will need an extension. ' +
    'If the loan is not paid off or extended by its maturity date, it will go into default.';
  const p3 = 'Just hit Reply All on this email and tell us either that you plan to pay the loan off ' +
    'by maturity, or that you would like to request an extension. Reply All keeps our payoff team ' +
    'on the thread so we can get started right away.';

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif;color:#1a1520">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Maturity Notice</h1></div>' +
    '<div style="padding:24px">' +
    '<p style="font-size:14px">' + (firstName ? 'Hi ' + esc(firstName) + ',' : 'Hello,') + '</p>' +
    '<p style="font-size:14px;line-height:1.55">' + esc(p1) + '</p>' +
    '<div style="margin:18px 0;padding:14px 16px;background:#faf6ee;border-left:3px solid #C8813A">' +
      '<p style="font-size:14px;line-height:1.55;margin:0"><strong>Respond by ' + esc(byStr) + '.</strong> ' +
      esc('Let us know whether you will need an extension. If the loan is not paid off or extended by ' + matStr + ', it will go into default.') + '</p>' +
    '</div>' +
    '<p style="font-size:14px;line-height:1.55">' + esc(p3) + '</p>' +
    '<table style="width:100%;border-collapse:collapse;font-size:13px;margin-top:20px;border-top:1px solid #ddd8d0">' +
      (address ? '<tr><td style="padding:8px 0;color:#7a7488;width:150px">Property</td><td style="padding:8px 0">' + esc(address) + '</td></tr>' : '') +
      '<tr><td style="padding:8px 0;color:#7a7488">Maturity Date</td><td style="padding:8px 0"><strong>' + esc(matStr) + '</strong></td></tr>' +
      '<tr><td style="padding:8px 0;color:#7a7488">Respond By</td><td style="padding:8px 0"><strong>' + esc(byStr) + '</strong></td></tr>' +
    '</table>' +
    '<p style="font-size:12px;color:#7a7488;margin-top:22px">Questions? Reply All and our team will help.</p>' +
    '</div></div></body></html>';

  const text = (firstName ? 'Hi ' + firstName + ',\n\n' : 'Hello,\n\n') +
    p1 + '\n\n' + p2 + '\n\n' + p3 + '\n\n' +
    (address ? 'Property:      ' + address + '\n' : '') +
    'Maturity Date: ' + matStr + '\n' +
    'Respond By:    ' + byStr + '\n\n— SLA Capital';

  return { subject, html, text, matStr, byStr, daysLeft };
}

/**
 * Loans a month out from maturity that haven't been told yet.
 * Exported so the preview endpoint shows exactly what the cron would send.
 */
export async function findMaturityCandidates(now) {
  // maturity_date is a PROMOTED COLUMN, not an `extra` key — LOAN_PROMOTED_KEYS
  // in pg-projections.mjs strips it out of the JSONB. Reading extra.maturityDate
  // silently matched nothing (the first cut of this cron found 0 candidates
  // while FCI showed loans 31 days out). `disposition` is NOT promoted, so that
  // one really does live in extra. Check pg-projections before assuming either.
  const SELECT = 'id,client_id,owner_email,address,status,maturity_date,extra';
  const PAGE = 1000;
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const rows = await db.select('loans', { select: SELECT, limit: PAGE, offset });
    for (const r of (rows || [])) {
      if (DEAD_STATUSES.includes(String(r.status || '').toLowerCase())) continue;
      const ex = (r.extra && typeof r.extra === 'object') ? r.extra : {};
      if (DEAD_DISPOSITIONS.includes(String(ex.disposition || '').toLowerCase())) continue;
      const maturity = r.maturity_date || ex.maturityDate || '';
      const d = daysToMaturity(maturity, now);
      if (d == null || d < MIN_DAYS || d > THRESHOLD_DAYS) continue;
      // Ledger is keyed by the maturity date this notice is FOR, so granting an
      // extension (which moves the date) re-arms the notice for the new one.
      const notified = ex.maturityNotified || {};
      if (notified[String(maturity)]) continue;
      out.push({ row: r, daysLeft: d, maturity });
    }
    if (!rows || rows.length < PAGE) break;
    if (offset > 100000) break;
  }
  out.sort((a, b) => a.daysLeft - b.daysLeft);
  return out;
}

async function _send(apiKey, { to, subject, html, text }) {
  return fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [to],
      // CC (not BCC) on purpose — the borrower must SEE payoffs@ on the thread
      // for "Reply All" to be a real instruction.
      cc: [PAYOFF_INBOX],
      reply_to: [PAYOFF_INBOX],
      subject, html, text,
    }),
  });
}

export default async () => {
  const started = Date.now();
  let scanned = 0, sent = 0, skipped = 0, failed = 0;
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      console.warn('[maturity-cron] no RESEND_API_KEY');
      return new Response(JSON.stringify({ ok: false, reason: 'no RESEND_API_KEY' }), { headers: { 'Content-Type': 'application/json' } });
    }

    const candidates = await findMaturityCandidates();
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

        // Re-check against the BLOB — PG can lag a payoff or an extension.
        const maturity = loan.maturityDate || '';
        const d = daysToMaturity(maturity);
        if (d == null || d < MIN_DAYS || d > THRESHOLD_DAYS) { skipped++; continue; }
        if (DEAD_DISPOSITIONS.includes(String(loan.disposition || '').toLowerCase())) { skipped++; continue; }
        const ledger = loan.maturityNotified || {};
        if (ledger[String(maturity)]) { skipped++; continue; }

        // Deploy 236.808 — fall back to FCI's copy of the borrower contact.
        // The Baseline-imported closed loans (most of the serviced book) carry
        // a client record with no name, no email and no company at all, so on
        // our data alone this notice had nobody to write to. fciBorrowerEmail is
        // stamped by fci-portfolio-sync; FCI has one for all 41 performing loans.
        const borrowerEmail = String(
          client.email || loan.borrowerEmail || loan.fciBorrowerEmail || ''
        ).trim().toLowerCase();
        if (!borrowerEmail || !borrowerEmail.includes('@')) { skipped++; continue; }
        // Only greet by first name when it's a person's name we actually hold.
        // FCI's name is often an entity ("Ohana Home Pros LLC") — "Hi Ohana," is
        // worse than no greeting, so an entity falls through to "Hello,".
        const greetName = client.firstName || '';

        const maturityMs = _parseDate(maturity);
        const body = buildMaturityEmail({
          firstName: greetName,
          address: loan.address || '',
          maturityMs,
          replyByMs: _replyByMs(Date.now(), maturityMs),
          daysLeft: d,
        });

        const resp = await _send(apiKey, { to: borrowerEmail, subject: body.subject, html: body.html, text: body.text });
        if (!resp.ok) {
          failed++;
          console.warn('[maturity-cron] send failed', resp.status, loan.address);
          continue;   // no ledger stamp — retry tomorrow
        }
        try {
          await logBorrowerSendFromResponse(resp, {
            kind: 'maturity_reminder', to: borrowerEmail, ownerKey,
            address: loan.address || '', loEmail: ownerEmail,
          });
        } catch (_) {}

        loan.maturityNotified = Object.assign({}, ledger, { [String(maturity)]: new Date().toISOString() });
        loan.updatedAt = new Date().toISOString();
        await writeClient(ownerKey, client, { clientsStore });
        sent++;
      } catch (e) {
        failed++;
        console.error('[maturity-cron] loan failed:', c.row && c.row.id, e && e.message);
      }
    }
    console.log(`[maturity-cron] scanned=${scanned} sent=${sent} skipped=${skipped} failed=${failed}`);
  } catch (e) {
    console.error('[maturity-cron] error:', e && e.message);
  }
  return new Response(JSON.stringify({ ok: true, scanned, sent, skipped, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
