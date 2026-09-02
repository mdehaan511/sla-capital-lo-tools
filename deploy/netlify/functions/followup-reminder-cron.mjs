/**
 * followup-reminder-cron.mjs — daily closing-anniversary follow-up digest
 *
 * Deploy 236.823 — LOs follow up with borrowers 7 / 30 / 90 / 120 / 240 / 365
 * days after a loan closes (Mike). Each morning this cron finds every closed
 * loan whose anniversary has come due, groups them per Loan Officer, and sends
 * ONE digest email per LO ("You have 3 borrower follow-ups due"). No email on
 * empty days.
 *
 * Rules:
 *   - Due window: from the anniversary day through 14 days after it. Anything
 *     older is auto-skipped (so the Baseline-migrated book doesn't greet LOs
 *     with hundreds of ancient "overdue" 7-day calls). The Follow-ups tab on
 *     Closed Loans uses the same window.
 *   - Idempotent: loan.anniversaryNotified = { d30: iso, … } is stamped after
 *     a send — each milestone emails exactly once. Completions live separately
 *     on loan.anniversaryFollowUps (via /api/loan-followup-done).
 *   - Liquidated loans are excluded (no "how's everything" call after a
 *     foreclosure).
 *
 * Candidates from a fast PG page-through; the stamp re-reads the client BLOB
 * and writes through writeClient (strict discipline). Zero-throw; budgeted
 * under Netlify's ~30s scheduled-fn kill.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { writeClient } from './_shared/client-write.mjs';

export const config = { schedule: '20 16 * * *' }; // 16:20 UTC ≈ 9:20am PT

export const MILESTONE_DAYS = [7, 30, 90, 120, 240, 365];
export const GRACE_DAYS = 14;
const TIME_BUDGET_MS = 24_000;
const PORTAL = 'https://portal.slacapital.ai';

const DAY_MS = 86400000;

function _closeMs(fundingDate) {
  const s = String(fundingDate || '').trim();
  if (!s) return null;
  // Date-only strings parse as UTC midnight; anchor at noon UTC so day math
  // is stable across timezones.
  const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T12:00:00Z' : s);
  return isFinite(t) ? t : null;
}

// A loan counts as closed for follow-ups — mirrors closed-loans.html's
// isClosedLoan(), from PG columns + extra.
function _isClosedRow(r, ex) {
  const dsp = String(ex.disposition || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (['sold', 'servicing', 'pending sale', 'paid off', 'post close'].includes(dsp)) return true;
  const st = String(r.status || '').toLowerCase().trim();
  if (st === 'closed' || st === 'sold' || st === 'liquidated') return true;
  if (String(r.processing_stage || '').toLowerCase().trim() === 'pp_closed') return true;
  const bl = String(ex.baselineStatus || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return ['sold', 'in servicing', 'servicing', 'liquidated', 'paid off', 'closed'].includes(bl);
}

function _isLiquidated(r, ex) {
  const st = String(r.status || '').toLowerCase().trim();
  const bl = String(ex.baselineStatus || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return st === 'liquidated' || bl === 'liquidated';
}

// Milestones due for a loan right now (within the grace window, not done,
// not yet notified). Exported so the logic has one home for tests.
export function dueMilestones({ fundingDate, followUps, notified, now }) {
  const close = _closeMs(fundingDate);
  if (close == null) return [];
  const t = now || Date.now();
  const out = [];
  for (const n of MILESTONE_DAYS) {
    const key = 'd' + n;
    if (followUps && followUps[key]) continue;
    if (notified && notified[key]) continue;
    const dueMs = close + n * DAY_MS;
    if (t >= dueMs && t <= dueMs + GRACE_DAYS * DAY_MS) out.push({ key, days: n, dueMs });
  }
  return out;
}

async function _candidatesFromPG() {
  const SELECT = 'id,client_id,owner_email,address,status,processing_stage,funding_date,extra';
  const PAGE = 1000;
  const out = [];
  let offset = 0;
  for (;;) {
    const rows = await db.select('loans', { select: SELECT, limit: PAGE, offset });
    for (const r of (rows || [])) {
      const ex = r.extra || {};
      if (!_isClosedRow(r, ex)) continue;
      if (_isLiquidated(r, ex)) continue;
      const fundingDate = r.funding_date || ex.fundingDate || '';
      const due = dueMilestones({
        fundingDate,
        followUps: ex.anniversaryFollowUps,
        notified: ex.anniversaryNotified,
      });
      if (!due.length) continue;
      out.push({ row: r, due, fundingDate });
    }
    if (!rows || rows.length < PAGE) break;
    offset += PAGE;
    if (offset > 100000) break;
  }
  return out;
}

const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
function _fmtDate(ms) {
  const d = new Date(ms);
  return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '/' + d.getUTCFullYear();
}

function _digestBodies(items) {
  const n = items.reduce((acc, it) => acc + it.due.length, 0);
  const subject = 'Borrower follow-up' + (n === 1 ? '' : 's') + ' due — ' + n + ' closing anniversar' + (n === 1 ? 'y' : 'ies');
  const rowsHtml = items.map((it) => it.due.map((d) => {
    const overdueDays = Math.floor((Date.now() - d.dueMs) / DAY_MS);
    const when = overdueDays <= 0 ? 'due today' : overdueDays + ' day' + (overdueDays === 1 ? '' : 's') + ' overdue';
    return '<tr>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee"><strong>' + d.days + '-day</strong><br><span style="color:' + (overdueDays > 0 ? '#b91c1c' : '#1e7d3c') + ';font-size:12px">' + esc(when) + '</span></td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee">' + esc(it.borrower || '(unknown)') + '<br><span style="color:#777;font-size:12px">' + esc(it.address || '') + '</span></td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee;font-size:12px;color:#555">closed ' + esc(it.closedStr) + '</td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee"><a href="' + esc(it.link) + '" style="color:#b5712d;font-weight:600;text-decoration:none">Open loan &rarr;</a></td>' +
    '</tr>';
  }).join('')).join('');
  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:680px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Borrower Follow-ups</h1></div>' +
    '<div style="padding:24px">' +
    '<p style="font-size:14px">These closed loans hit a follow-up anniversary — a quick check-in call keeps the relationship warm:</p>' +
    '<table style="border-collapse:collapse;width:100%;font-family:Arial,sans-serif;font-size:13px">' + rowsHtml + '</table>' +
    '<p style="font-size:13px;margin-top:18px"><a href="' + PORTAL + '/closed-loans.html" style="color:#b5712d;font-weight:600">Open the Follow-ups tab &rarr;</a> to see the full queue and mark these done.</p>' +
    '</div></div></body></html>';
  const text = 'Borrower follow-ups due:\n\n' + items.map((it) => it.due.map((d) =>
    '- ' + d.days + '-day: ' + (it.borrower || '(unknown)') + ' — ' + (it.address || '') + ' (closed ' + it.closedStr + ')\n  ' + it.link
  ).join('\n')).join('\n') + '\n\nOpen the Follow-ups tab on Closed Loans to mark these done: ' + PORTAL + '/closed-loans.html\n\n— SLA Capital';
  return { subject, html, text };
}

export default async () => {
  const started = Date.now();
  let candidates = 0, losEmailed = 0, itemsSent = 0, failed = 0;
  try {
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) { console.warn('[followup-cron] no RESEND_API_KEY'); return new Response('{"ok":false}'); }

    const cands = await _candidatesFromPG();
    candidates = cands.length;
    if (!candidates) { console.log('[followup-cron] nothing due'); return new Response('{"ok":true,"due":0}'); }

    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

    // Group by LO, resolving each candidate against the client BLOB (source
    // of truth — PG could be stale on followUps/notified).
    const byOwner = {}; // ownerEmail -> [{ clientKey, client, loan, due, borrower, address, closedStr, link }]
    for (const c of cands) {
      if (Date.now() - started > TIME_BUDGET_MS) break;
      try {
        const ownerEmail = String(c.row.owner_email || '').toLowerCase();
        if (!ownerEmail.includes('@')) continue;
        const ownerKey = keySafe(ownerEmail);
        const clientKey = ownerKey + '/' + keySafe(c.row.client_id);
        const client = await clientsStore.get(clientKey, { type: 'json' });
        const loan = client && Array.isArray(client.loans)
          ? client.loans.find((l) => l && l.id === c.row.id) : null;
        if (!loan) continue;
        const due = dueMilestones({
          fundingDate: loan.fundingDate || c.fundingDate,
          followUps: loan.anniversaryFollowUps,
          notified: loan.anniversaryNotified,
        });
        if (!due.length) continue;
        const closeMs = _closeMs(loan.fundingDate || c.fundingDate);
        (byOwner[ownerEmail] = byOwner[ownerEmail] || []).push({
          ownerKey, clientKey, client, loan, due,
          borrower: ((client.firstName || '') + ' ' + (client.lastName || '')).trim() || client.email || '',
          address: loan.address || '',
          closedStr: closeMs ? _fmtDate(closeMs) : '',
          link: PORTAL + '/loan-details/' + encodeURIComponent(loan.id) + '?owner=' + encodeURIComponent(ownerEmail),
        });
      } catch (e) {
        failed++;
        console.error('[followup-cron] candidate failed:', c.row && c.row.id, e && e.message);
      }
    }

    for (const ownerEmail of Object.keys(byOwner)) {
      if (Date.now() - started > TIME_BUDGET_MS + 4000) break;
      const items = byOwner[ownerEmail];
      try {
        const b = _digestBodies(items);
        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'SLA Capital <noreply@leads.slacapital.com>',
            to: [ownerEmail], subject: b.subject, html: b.html, text: b.text,
          }),
        });
        if (!resp.ok) { console.warn('[followup-cron] send failed', resp.status, ownerEmail); failed++; continue; }
        losEmailed++;
        // Stamp the notified ledger — one client write per client even when
        // several of its loans/milestones were in the digest.
        const nowIso = new Date().toISOString();
        const byClient = {};
        for (const it of items) (byClient[it.clientKey] = byClient[it.clientKey] || []).push(it);
        for (const ck of Object.keys(byClient)) {
          const group = byClient[ck];
          const client = group[0].client;
          for (const it of group) {
            it.loan.anniversaryNotified = Object.assign({}, it.loan.anniversaryNotified || {});
            for (const d of it.due) { it.loan.anniversaryNotified[d.key] = nowIso; itemsSent++; }
            it.loan.updatedAt = nowIso;
          }
          await writeClient(group[0].ownerKey, client, { clientsStore });
        }
      } catch (e) {
        failed++;
        console.error('[followup-cron] LO digest failed:', ownerEmail, e && e.message);
      }
    }
    console.log(`[followup-cron] candidates=${candidates} losEmailed=${losEmailed} items=${itemsSent} failed=${failed}`);
  } catch (e) {
    console.error('[followup-cron] error:', e && e.message);
  }
  return new Response(JSON.stringify({ ok: true, candidates, losEmailed, itemsSent, failed }), {
    headers: { 'Content-Type': 'application/json' },
  });
};
