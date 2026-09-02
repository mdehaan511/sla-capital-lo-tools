/**
 * maturity-reminder-preview.mjs — GET /api/maturity-reminder-preview
 *
 * Deploy 236.806 (Mike) — read-only view of exactly who the maturity cron would
 * email on its next run, and the exact copy they'd receive. Sends nothing.
 *
 * This exists because the cron mails BORROWERS. Being able to read the list and
 * the wording before it goes out (and after any change to it) is the difference
 * between a reviewable feature and a surprise in someone's inbox.
 *
 * Query: ?full=1 to include the rendered text body of the first message.
 *        ?days=N to preview a wider window than the cron's 30 days — handy for
 *        "who's coming up next month", without affecting what actually sends.
 */
import {
  handleOptions, json, requireAuth, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { getStore } from '@netlify/blobs';
import { db } from './_shared/supabase-db.mjs';
import {
  findMaturityCandidates, buildMaturityEmail, daysToMaturity, _replyByMs, PAYOFF_INBOX,
} from './maturity-reminder-cron.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('maturity-reminder-preview error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const q = new URL(req.url).searchParams;
  const wantFull = q.get('full') === '1';
  const widen = Math.min(365, Math.max(0, parseInt(q.get('days'), 10) || 0));

  // What the cron would send on its next run, exactly as it computes it.
  const due = await findMaturityCandidates();

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const rows = [];
  for (const c of due.slice(0, 60)) {
    const ownerEmail = String(c.row.owner_email || '').toLowerCase();
    const client = await clientsStore
      .get(keySafe(ownerEmail) + '/' + keySafe(c.row.client_id), { type: 'json' })
      .catch(() => null);
    const loan = client && Array.isArray(client.loans)
      ? client.loans.find((l) => l && l.id === c.row.id) : null;
    // Same resolution order the cron uses, including FCI's copy — otherwise the
    // preview reports "no email, will be skipped" for loans that would actually
    // send. (Deploy 236.808.)
    const borrowerEmail = String(
      (client && client.email) || (loan && loan.borrowerEmail) || (loan && loan.fciBorrowerEmail) || ''
    ).trim().toLowerCase();
    const emailSource = (client && client.email) ? 'client record'
      : ((loan && loan.borrowerEmail) ? 'loan record'
        : ((loan && loan.fciBorrowerEmail) ? 'FCI' : 'none'));
    rows.push({
      loanId: c.row.id,
      address: c.row.address || (loan && loan.address) || '',
      borrower: (client ? ((client.firstName || '') + ' ' + (client.lastName || '')).trim() : '')
        || (loan && loan.fciBorrowerName) || '',
      emailSource,
      to: borrowerEmail || '(no borrower email — will be skipped)',
      cc: PAYOFF_INBOX,
      maturityDate: c.maturity,
      daysLeft: c.daysLeft,
      willSend: !!(borrowerEmail && borrowerEmail.includes('@')),
      owner: ownerEmail,
    });
  }

  // Optional wider look-ahead so staff can see what's coming without waiting.
  let upcoming = [];
  if (widen > 0) {
    const PAGE = 1000;
    for (let offset = 0; ; offset += PAGE) {
      // maturity_date is a promoted COLUMN (see findMaturityCandidates).
      const pg = await db.select('loans', { select: 'id,client_id,owner_email,address,status,maturity_date,extra', limit: PAGE, offset });
      for (const r of (pg || [])) {
        const ex = (r.extra && typeof r.extra === 'object') ? r.extra : {};
        if (String(ex.disposition || '').toLowerCase() === 'paid_off') continue;
        const maturity = r.maturity_date || ex.maturityDate || '';
        const d = daysToMaturity(maturity);
        if (d == null || d <= 0 || d > widen) continue;
        upcoming.push({
          loanId: r.id, address: r.address || '', maturityDate: maturity,
          daysLeft: d, alreadyNotified: !!(ex.maturityNotified || {})[String(maturity)],
        });
      }
      if (!pg || pg.length < PAGE) break;
      if (offset > 100000) break;
    }
    upcoming.sort((a, b) => a.daysLeft - b.daysLeft);
  }

  let sample = null;
  if (wantFull && rows.length) {
    const first = due[0];
    const matMs = Date.parse(String(first.maturity).length === 10 ? first.maturity + 'T00:00:00Z' : first.maturity) ||
      Date.now() + first.daysLeft * 86400000;
    const built = buildMaturityEmail({
      firstName: (rows[0].borrower || '').split(' ')[0],
      address: rows[0].address,
      maturityMs: matMs,
      replyByMs: _replyByMs(Date.now(), matMs),
      daysLeft: first.daysLeft,
    });
    sample = { to: rows[0].to, cc: PAYOFF_INBOX, replyTo: PAYOFF_INBOX, subject: built.subject, text: built.text };
  }

  return json(200, {
    ok: true,
    schedule: '16:20 UTC daily (≈9:20am PT)',
    thresholdDays: 30,
    wouldSendNow: rows.filter((r) => r.willSend).length,
    skippedNoEmail: rows.filter((r) => !r.willSend).length,
    rows,
    ...(widen ? { upcomingWindowDays: widen, upcoming } : {}),
    ...(sample ? { sample } : {}),
  });
}
