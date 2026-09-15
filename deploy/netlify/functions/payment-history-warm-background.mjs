/**
 * payment-history-warm-background.mjs — POST /api/payment-history-warm
 *
 * Deploy 237.054 (Mike) — fills the borrower payment-history cache for every
 * serviced loan that carries a servicer loan number, so the Closed Loans
 * Servicing tab opens a row instantly instead of waiting on FCI. Runs as a
 * Netlify BACKGROUND function (15-min budget): triggered daily by
 * payment-history-warm-cron (x-history-job HMAC, right after the FCI and
 * Servicing Pros syncs) or by an admin.
 *
 *   FCI            one getBorrowerPayment per account, 3 at a time
 *   Servicing Pros the payments feed is loaded once and sliced per account
 *
 * Report → store payment_history_cache key 'meta/warm'.
 */
import crypto from 'node:crypto';
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { pgGet } from './_shared/mail-match.mjs';
import { servicerKind, fetchAndCache, spLoadFeeds, cacheStore, readCached, fciLoadBulk } from './_shared/payment-history.mjs';
import { db } from './_shared/supabase-db.mjs';
import { pushUserNotification, listUserNotifications, dismissUserNotifications } from './_shared/user-notifications.mjs';
import { keySafe, normalizeEmail } from './_shared/auth.mjs';
import { runSync as runFciSync } from './fci-portfolio-sync.mjs';

const BUDGET_MS = 13.5 * 60 * 1000;
export function jobSignature() {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || '').update('payment-history-warm').digest('hex');
}
function signed(req) {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const got = Buffer.from(String(req.headers.get('x-history-job') || ''));
  const want = Buffer.from(jobSignature());
  return !!secret && got.length === want.length && crypto.timingSafeEqual(got, want);
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    if (!signed(req)) {
      const user = await requireAuth(context, req);
      if (!user) return json(401, { error: 'Not authenticated' });
      if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    }
    return await warm();
  } catch (e) {
    console.error('payment-history-warm error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function warm() {
  const started = Date.now();
  const report = { startedAt: new Date().toISOString(), status: 'running', loans: 0, fci: 0, sp: 0, skipped: 0, warmed: 0, errors: 0, sample: [] };
  const save = () => cacheStore().setJSON('meta/warm', report).catch(() => {});
  await save();

  // Deploy 237.057 (Mike) — FULL-book FCI refresh first. The 09:40 cron syncs only
  // the accounts FCI's getUpdatedLoanList flags, and a posted payment does NOT
  // flag the loan (6401 S Pine paid 9/2, its next-due stayed 9/1 for two weeks).
  // One getLoanPortfolio call; this background function has the time for it.
  try {
    const r = await runFciSync({ dryRun: false, overwriteManual: false, limit: 500, offset: 0, actor: 'payment-history-warm' });
    report.fciFullSync = { written: r && r.write ? r.write : null, errors: r && r.errors ? r.errors.length : 0 };
  } catch (e) { report.fciFullSync = { error: (e && e.message) || 'failed' }; }
  await save();

  // Every loan with a servicer number that is not paid off (the sync stamps
  // servicerLoanNumber on the record; paid-off loans stop changing).
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await pgGet('loans', 'select=id,client_id,owner_email,address,servicer_name:extra->>servicerName,servicer_no:extra->>servicerLoanNumber,disposition:extra->>disposition,status,fci_status:extra->>fciLoanStatus,payoff_date:extra->>payoffDate,current_balance:extra->>currentBalance,next_due:extra->>nextDueDate,clients!client_id(first_name,last_name,entity_name)' +
      '&extra->>servicerLoanNumber=not.is.null&order=id.asc&limit=1000&offset=' + offset);
    page.forEach((r) => rows.push(r));
    if (page.length < 1000) break;
  }
  const targets = rows.filter((r) => {
    const acct = String(r.servicer_no || '').trim();
    if (!acct) return false;
    const d = String(r.disposition || '').toLowerCase().replace(/[_\s]+/g, ' ');
    if (d === 'paid off' || String(r.status || '').toLowerCase() === 'liquidated') return false;
    if (/PAID ?OFF/i.test(String(r.fci_status || ''))) return false;
    return !!servicerKind(r.servicer_name, acct);
  });
  report.loans = targets.length;

  const fciList = targets.filter((r) => servicerKind(r.servicer_name, r.servicer_no) === 'FCI');
  const spList = targets.filter((r) => servicerKind(r.servicer_name, r.servicer_no) === 'Servicing Pros');
  report.fci = fciList.length; report.sp = spList.length;

  if (spList.length) {
    const feeds = await spLoadFeeds();
    for (const r of spList) {
      try { await fetchAndCache('Servicing Pros', String(r.servicer_no).trim(), feeds); report.warmed++; }
      catch (e) { report.errors++; if (report.sample.length < 10) report.sample.push([r.address, (e && e.message) || 'error']); }
    }
  }
  // Deploy 237.068 — notes / ledger / charges for the whole FCI book in 3 calls, sliced per loan.
  let fciBulk = null;
  if (fciList.length) {
    fciBulk = await fciLoadBulk();
    report.fciBulk = { notes: fciBulk.notes ? fciBulk.notes.size : null, ledger: fciBulk.ledger ? fciBulk.ledger.size : null, charges: fciBulk.charges ? fciBulk.charges.size : null, errors: fciBulk.errors };
    await save();
  }
  let i = 0;
  await Promise.all(new Array(3).fill(0).map(async () => {
    while (i < fciList.length) {
      const r = fciList[i++];
      if (Date.now() - started > BUDGET_MS) { report.skipped++; continue; }
      try { await fetchAndCache('FCI', String(r.servicer_no).trim(), null, fciBulk); report.warmed++; }
      catch (e) { report.errors++; if (report.sample.length < 10) report.sample.push([r.address, (e && e.message) || 'error']); }
    }
  }));

  // ── Deploy 237.056 (Mike) — servicing alerts from the freshly cached history ──
  try { report.alerts = await evaluateAlerts(targets); }
  catch (e) { report.alerts = { error: (e && e.message) || 'alert pass failed' }; }

  report.status = 'done';
  report.finishedAt = new Date().toISOString();
  report.tookSeconds = Math.round((Date.now() - started) / 1000);
  await save();
  return json(200, { ok: true, report });
}

// ── Deploy 237.056 — NSF + >5-days-late alerts (in-app bell + email) ─────────
// From the cached payment history: paid-to = latest due date with a good
// payment; next due = +1 month; days late = today − next due. An NSF row
// (paymentType "NSF") within the last 14 days alerts once per row; a payment
// more than 5 days late alerts once per due date. Recipients: super admins,
// admins and processors (sla_user_roles) plus the loan's LO.
const GRACE_DAYS = 5;
const isGood = (p) => !!(p && p.dateReceived && !/nsf|revers|return|reject/i.test(String(p.type || '')) && (p.amount == null || Number(p.amount) > 0));
const addMonths = (y, n) => { const m = String(y || '').match(/^(\d{4})-(\d{2})-(\d{2})/); if (!m) return ''; return new Date(Date.UTC(+m[1], +m[2] - 1 + n, +m[3])).toISOString().slice(0, 10); };
const daysBetween = (a, b) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 86400000);
// Deploy 237.058 (Mike) — an NSF is only OPEN until a good payment for that due date
// (or a later one) is received after it. Cured NSFs must not alert.
const isOpenNsf = (nsf, rows) => !rows.some((p) => isGood(p) && String(p.dateReceived) > String(nsf.dateReceived) && String(p.dateDue || '') >= String(nsf.dateDue || ''));
// Deploy 237.066 (Mike) — a good payment that was later returned NSF (same due date, or the
// same amount within a day) never counted: paid-to must skip it, so the loan
// reads LATE for that due date, not "Current · NSF".
const isReversed = (p, rows) => rows.some((n) => /nsf|revers|return|reject/i.test(String(n.type || '')) && n.dateReceived && String(n.dateReceived) >= String(p.dateReceived) &&
  ((n.dateDue && p.dateDue && String(n.dateDue) === String(p.dateDue)) || (n.amount != null && p.amount != null && Math.abs(Math.abs(Number(n.amount)) - Number(p.amount)) < 0.01)));
const isEffective = (p, rows) => isGood(p) && !isReversed(p, rows);

async function evaluateAlerts(targets) {
  const out = { checked: 0, late: 0, nsf: 0, notified: 0, emailed: 0, skippedAlreadySent: 0, errors: [] };
  const store = cacheStore();
  const state = (await store.get('meta/alerts-state', { type: 'json' }).catch(() => null)) || { late: {}, nsf: {} };
  state.late = state.late || {}; state.nsf = state.nsf || {};
  const today = new Date().toISOString().slice(0, 10);

  const roleRows = await db.select('sla_user_roles', { select: 'email,roles' }).catch(() => []);
  const staff = new Set((roleRows || []).filter((r) => Array.isArray(r.roles) && r.roles.some((x) => ['super_admin', 'admin', 'processor'].indexOf(x) >= 0)).map((r) => normalizeEmail(r.email)));

  const alerts = []; // { kind, loan, title, text, key }
  const openKeys = new Set();   // Deploy 237.058 — every alert that is still live today
  for (const r of targets) {
    const kind = servicerKind(r.servicer_name, r.servicer_no);
    const hit = await readCached(kind, String(r.servicer_no).trim());
    if (!hit || !Array.isArray(hit.rows)) continue;
    out.checked++;
    let paidTo = '';
    hit.rows.forEach((p) => { if (isEffective(p, hit.rows) && String(p.dateDue || '') > paidTo) paidTo = String(p.dateDue || ''); });
    // No good payment on record at the servicer → fall back to the synced next
    // due date (fresh daily now that the full-book refresh runs first).
    const nextDue = paidTo ? addMonths(paidTo, 1) : String(r.next_due || '').slice(0, 10);
    const c = r.clients || {};
    const borrower = ((c.first_name || '') + ' ' + (c.last_name || '')).trim() || c.entity_name || '';
    const label = (r.address || r.id) + (borrower ? ' — ' + borrower : '');
    if (nextDue) {
      const dl = daysBetween(nextDue, today);
      if (dl > GRACE_DAYS) {
        out.late++;
        const key = r.id + '|' + nextDue;
        openKeys.add(key);
        if (state.late[key]) out.skippedAlreadySent++;
        else alerts.push({ kind: 'late', loan: r, key, stateMap: state.late,
          title: dl + ' days late: ' + label,
          text: 'The ' + nextDue + ' payment has not been received (' + dl + ' days past due). Servicer ' + kind + ' #' + r.servicer_no + '.' });
      }
    }
    hit.rows.forEach((p) => {
      if (!/nsf/i.test(String(p.type || '')) || !p.dateReceived) return;
      if (daysBetween(p.dateReceived, today) > 30) return;
      if (!isOpenNsf(p, hit.rows)) return;                       // Deploy 237.058 — cured (an open NSF also makes the loan LATE above)
      const key = r.id + '|nsf|' + (p.reference || p.dateReceived);
      openKeys.add(key);
      if (state.nsf[key]) { out.skippedAlreadySent++; return; }
      out.nsf++;
      alerts.push({ kind: 'nsf', loan: r, key, stateMap: state.nsf,
        title: 'NSF payment: ' + label,
        text: 'A payment of $' + Math.abs(Number(p.amount) || 0).toLocaleString('en-US') + ' due ' + (p.dateDue || '—') + ' was returned NSF on ' + p.dateReceived + '. Servicer ' + kind + ' #' + r.servicer_no + '.' });
    });
  }
  // Deploy 237.058 — clear resolved alerts out of every recipient's bell: any servicing
  // item whose key is no longer open (cured NSF, payment made). The first run
  // after this deploy also purges the NSF items sent before the cured-check
  // existed (they carry no key).
  const everyone = new Set(Array.from(staff).concat(targets.map((r) => normalizeEmail(r.owner_email || '')).filter(Boolean)));
  out.cleared = 0;
  for (const email of everyone) {
    try {
      const items = await listUserNotifications(email);
      const stale = items.filter((it) => it && it.kind === 'servicing' && (!it.alertKey || !openKeys.has(it.alertKey))).map((it) => it.id);
      if (stale.length) { await dismissUserNotifications(email, stale, false); out.cleared += stale.length; }
    } catch (e) { out.errors.push('clear ' + email + ': ' + ((e && e.message) || 'error')); }
  }
  Object.keys(state.nsf).forEach((k) => { if (!openKeys.has(k)) delete state.nsf[k]; });
  Object.keys(state.late).forEach((k) => { if (!openKeys.has(k)) delete state.late[k]; });
  if (!alerts.length) { await store.setJSON('meta/alerts-state', state).catch(() => {}); return out; }

  for (const a of alerts) {
    const owner = normalizeEmail(a.loan.owner_email || '');
    const to = Array.from(new Set(Array.from(staff).concat(owner ? [owner] : [])));
    const href = '/loan-details/' + encodeURIComponent(a.loan.id) + (owner ? '?owner=' + encodeURIComponent(owner) : '') + '#servicing';
    for (const email of to) {
      try {
        await pushUserNotification(email, { kind: 'servicing', alertType: a.kind, alertKey: a.key, loanId: a.loan.id, clientId: a.loan.client_id, owner, address: a.loan.address || '', title: a.title, text: a.text, href });
        out.notified++;
      } catch (e) { out.errors.push('bell ' + email + ': ' + ((e && e.message) || 'error')); }
    }
    a.stateMap[a.key] = new Date().toISOString();
  }
  await store.setJSON('meta/alerts-state', state).catch(() => {});

  // One email per recipient listing every new alert.
  const byEmail = new Map();
  alerts.forEach((a) => {
    const owner = normalizeEmail(a.loan.owner_email || '');
    Array.from(new Set(Array.from(staff).concat(owner ? [owner] : []))).forEach((e) => { (byEmail.get(e) || byEmail.set(e, []).get(e)).push(a); });
  });
  const apiKey = process.env.RESEND_API_KEY;
  const base = process.env.URL || 'https://portal.slacapital.ai';
  if (apiKey) {
    for (const [email, list] of byEmail) {
      const rows = list.map((a) => '<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><strong>' + (a.kind === 'nsf' ? 'NSF' : 'Late') + '</strong></td><td style="padding:6px 10px;border-bottom:1px solid #eee"><a href="' + base + '/loan-details/' + encodeURIComponent(a.loan.id) + (a.loan.owner_email ? '?owner=' + encodeURIComponent(normalizeEmail(a.loan.owner_email)) : '') + '">' + String(a.loan.address || a.loan.id).replace(/</g, '&lt;') + '</a><br><span style="color:#666;font-size:12px">' + a.text.replace(/</g, '&lt;') + '</span></td></tr>').join('');
      const html = '<div style="font-family:system-ui,sans-serif;font-size:14px;color:#1a1520"><p>' + list.length + ' servicing alert' + (list.length === 1 ? '' : 's') + ' from last night\'s payment-history check:</p><table style="border-collapse:collapse">' + rows + '</table><p style="color:#666;font-size:12px">Payment status and history are on <a href="' + base + '/closed-loans.html">Closed Loans → Servicing</a>.</p></div>';
      try {
        const resp = await fetch('https://api.resend.com/emails', {
          signal: AbortSignal.timeout(15000), method: 'POST',
          headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json', 'Idempotency-Key': ('svc-alert/' + email + '/' + today).slice(0, 250) },
          body: JSON.stringify({ from: 'SLA Capital <noreply@leads.slacapital.com>', to: [email], subject: 'Servicing alert' + (list.length === 1 ? '' : 's') + ': ' + list.map((a) => (a.kind === 'nsf' ? 'NSF' : 'late') + ' — ' + String(a.loan.address || '').split(',')[0]).slice(0, 3).join('; ') + (list.length > 3 ? ' +' + (list.length - 3) + ' more' : ''), html }),
        });
        if (resp.ok) out.emailed++; else out.errors.push('email ' + email + ': HTTP ' + resp.status);
      } catch (e) { out.errors.push('email ' + email + ': ' + ((e && e.message) || 'error')); }
    }
  } else out.errors.push('RESEND_API_KEY not set — no alert emails');
  return out;
}
