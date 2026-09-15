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
import { servicerKind, fetchAndCache, spLoadFeeds, cacheStore } from './_shared/payment-history.mjs';

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

  // Every loan with a servicer number that is not paid off (the sync stamps
  // servicerLoanNumber on the record; paid-off loans stop changing).
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await pgGet('loans', 'select=id,address,servicer_name:extra->>servicerName,servicer_no:extra->>servicerLoanNumber,disposition:extra->>disposition,status' +
      '&extra->>servicerLoanNumber=not.is.null&order=id.asc&limit=1000&offset=' + offset);
    page.forEach((r) => rows.push(r));
    if (page.length < 1000) break;
  }
  const targets = rows.filter((r) => {
    const acct = String(r.servicer_no || '').trim();
    if (!acct) return false;
    const d = String(r.disposition || '').toLowerCase().replace(/[_\s]+/g, ' ');
    if (d === 'paid off' || String(r.status || '').toLowerCase() === 'liquidated') return false;
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
  let i = 0;
  await Promise.all(new Array(3).fill(0).map(async () => {
    while (i < fciList.length) {
      const r = fciList[i++];
      if (Date.now() - started > BUDGET_MS) { report.skipped++; continue; }
      try { await fetchAndCache('FCI', String(r.servicer_no).trim()); report.warmed++; }
      catch (e) { report.errors++; if (report.sample.length < 10) report.sample.push([r.address, (e && e.message) || 'error']); }
    }
  }));

  report.status = 'done';
  report.finishedAt = new Date().toISOString();
  report.tookSeconds = Math.round((Date.now() - started) / 1000);
  await save();
  return json(200, { ok: true, report });
}
