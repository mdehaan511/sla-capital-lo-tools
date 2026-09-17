/**
 * financial-audit-alerts.mjs — Deploy 237.135 (Mike)
 *
 * "Send an alert to Mike and Dan if [the KAF assignment wire] isn't verified
 * within 24 hours of the closing occurring."
 *
 * Hourly. For every SLA -> KAF loan on the Financial Audit ledger whose closing
 * was more than 24 hours ago (closedAt, else 5pm Pacific on the closing date)
 * and whose assignment wire is still unverified: one email + one bell
 * notification to each recipient, once per loan (state.alerts). Loans that
 * closed before the ledger's start date never alert.
 *
 * Netlify invokes scheduled functions with a POST carrying next_run (no JWT).
 */
import { handleOptions, json, readJsonBody } from './_shared/auth.mjs';
import { pgGet } from './_shared/mail-match.mjs';
import { pushUserNotification } from './_shared/user-notifications.mjs';
import { buildLedger, readState, mutateState, loadLedgerLoans, loadDrawCache } from './_shared/financial-audit.mjs';

export const config = { schedule: '20 * * * *' };

const RECIPIENTS = (process.env.FIN_AUDIT_ALERT_TO || 'mike@slacapital.com,dan@slacapital.com')
  .split(',').map((s) => s.trim()).filter(Boolean);
const PAGE = 'https://portal.slacapital.ai/financial-audit.html';

export default async (req) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const body = req.method === 'POST' ? await readJsonBody(req).catch(() => null) : null;
    if (!(body && body.next_run)) return json(403, { error: 'Scheduled only' });

    const [state, loans, draws] = await Promise.all([readState(), loadLedgerLoans(pgGet), loadDrawCache()]);
    const { rows } = buildLedger(loans, draws.byLoanNumber, state);
    const due = rows.filter((r) => r.kind === 'assign' && r.late24h && !state.alerts[r.key] &&
      r.date >= (state.settings.trackFrom || ''));
    if (!due.length) return json(200, { ok: true, alerted: 0 });

    let sent = 0;
    for (const r of due) {
      const title = 'KAF assignment wire not verified: ' + (r.address || r.slaId || r.loanId);
      const text = '$' + Math.round(r.amount).toLocaleString('en-US') + ' from King Arthur Fund 1 to Sir Lends A Lot — closed ' +
        r.date + ', still not verified against the bank statement 24 hours later.';
      for (const email of RECIPIENTS) {
        try {
          await pushUserNotification(email, { kind: 'servicing', alertType: 'fin_audit_assign', alertKey: r.key,
            loanId: r.loanId, clientId: r.clientId, owner: r.owner, address: r.address, title, text, href: '/financial-audit.html' });
        } catch (e) { console.warn('[financial-audit-alerts] bell failed', email, e && e.message); }
      }
      if (await sendEmail(title, text)) sent++;
    }
    await mutateState((s) => { const at = new Date().toISOString(); due.forEach((r) => { s.alerts[r.key] = at; }); });
    console.log('[financial-audit-alerts] alerted', due.length, 'loan(s); emails ok', sent);
    return json(200, { ok: true, alerted: due.length });
  } catch (e) {
    console.error('financial-audit-alerts error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function sendEmail(subject, text) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !RECIPIENTS.length) return false;
  const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = '<!DOCTYPE html><html><body><div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
    '<div style="background:#261A36;padding:22px"><h1 style="color:#C8813A;margin:0;font-size:18px">' + escH(subject) + '</h1></div>' +
    '<div style="padding:22px;color:#1A1520"><p style="font-size:15px;line-height:1.6">' + escH(text) + '</p>' +
    '<p><a href="' + PAGE + '" style="display:inline-block;background:#C8813A;color:#fff;text-decoration:none;font-weight:700;padding:10px 18px;border-radius:6px">Open Financial Audit</a></p>' +
    '</div></div></body></html>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'SLA Capital <noreply@leads.slacapital.com>', to: RECIPIENTS, subject, text: text + '\n\n' + PAGE, html }),
    });
    if (!resp.ok) { console.warn('[financial-audit-alerts] Resend', resp.status, (await resp.text().catch(() => '')).slice(0, 200)); return false; }
    return true;
  } catch (e) { console.warn('[financial-audit-alerts] email threw:', e && e.message); return false; }
}
