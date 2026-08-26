/**
 * _shared/borrower-fix-email.mjs — Deploy 236.746
 *
 * "Please upload corrected documents" email for flagged doc-review items.
 * A tray is flagged when a processor sets verdict 'issues' (with a
 * flagReason, Deploy 236.746). Used by BOTH:
 *   - borrower-fix-reminder-cron.mjs  — daily sweep, skips closed loans
 *   - borrower-fix-notify.mjs         — processor's on-demand send button
 *
 * Zero-throw contract: returns { ok, sent, reason?, to?, flagged? }.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { findCategory } from './loan-review-checklists.mjs';
import { getOwnerReplyTo, logBorrowerSendFromResponse } from './email.mjs';

const PORTAL_ORIGIN = 'https://portal.slacapital.ai';

// Flagged = processor verdict 'issues' on a non-hidden tray.
export function flaggedDocsOf(review) {
  const docs = (review && review.docs) || {};
  return Object.keys(docs)
    .filter((slug) => docs[slug] && docs[slug].verdict === 'issues' && !docs[slug].hidden)
    .map((slug) => {
      const d = docs[slug];
      const cat = findCategory(slug);
      return {
        slug,
        label: (cat && cat.label) || d.label || slug,
        reason: d.flagReason || d.processorNotes || '',
      };
    });
}

function _loanIsClosed(loan) {
  const st = String((loan && loan.status) || '').toLowerCase();
  if (st === 'closed' || st === 'denied' || st === 'cancelled') return true;
  if (String((loan && loan.processingStage) || '').toLowerCase() === 'pp_closed') return true;
  const bl = String((loan && loan.baselineStatus) || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  return (bl === 'closed' || bl === 'sold' || bl === 'liquidated' || bl === 'servicing' || bl === 'in servicing' || bl === 'paid off');
}

export async function sendFixEmailForReview(review, opts) {
  opts = opts || {};
  try {
    const flagged = flaggedDocsOf(review);
    if (!flagged.length) return { ok: true, sent: false, reason: 'no-flagged-docs' };

    const src = review.source || {};
    if (src.kind !== 'existing' || !src.clientId || !src.loanId || !src.ownerKey) {
      return { ok: true, sent: false, reason: 'no-loan-source' };
    }
    const ownerKey = keySafe(src.ownerKey);

    // Live loan + client — the closed check and borrower email must be current.
    let client = null, loan = null;
    try {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      client = await clientsStore.get(ownerKey + '/' + keySafe(src.clientId), { type: 'json' });
      loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === src.loanId) : null;
    } catch (_) {}
    if (opts.skipIfClosed && loan && _loanIsClosed(loan)) {
      return { ok: true, sent: false, reason: 'loan-closed' };
    }

    const toEmail = String(
      (client && client.email) ||
      (loan && loan.borrowerEmail) ||
      (loan && loan.formData && loan.formData.borrowerEmail) || ''
    ).trim().toLowerCase();
    if (!toEmail || !toEmail.includes('@')) return { ok: true, sent: false, reason: 'no-borrower-email' };

    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) return { ok: false, sent: false, reason: 'no-resend-key' };

    const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const address = review.address || (loan && loan.address) || '';
    const link = PORTAL_ORIGIN + '/borrower-intake.html?loanId=' + encodeURIComponent(src.loanId) +
      '&primaryClientId=' + encodeURIComponent(src.clientId) +
      '&ownerKey=' + encodeURIComponent(src.ownerKey);
    const firstName = (client && client.firstName) || '';

    const rows = flagged.map((f) =>
      '<tr><td style="padding:8px 10px;border-bottom:1px solid #eee7da;font-weight:600">' + esc(f.label) + '</td>' +
      '<td style="padding:8px 10px;border-bottom:1px solid #eee7da;color:#5a5348">' + esc(f.reason || 'Please see your portal for details.') + '</td></tr>'
    ).join('');
    const textList = flagged.map((f) => ' - ' + f.label + (f.reason ? ': ' + f.reason : '')).join('\n');

    const subject = 'Action needed: ' + flagged.length + ' document' + (flagged.length === 1 ? '' : 's') +
      ' need' + (flagged.length === 1 ? 's' : '') + ' a fix' + (address ? ' — ' + address : '');
    const html =
      '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
      '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261a36;padding:24px"><h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Documents Need Your Attention</h1></div>' +
      '<div style="padding:24px">' +
      '<p style="font-size:14px">' + (firstName ? 'Hi ' + esc(firstName) + ',' : 'Hello,') + '</p>' +
      '<p style="font-size:14px">Your loan team flagged ' + (flagged.length === 1 ? 'an issue with one of your documents' : 'issues with ' + flagged.length + ' of your documents') +
      (address ? ' for <strong>' + esc(address) + '</strong>' : '') + '. Please upload a corrected version so we can keep your loan moving.</p>' +
      '<table style="width:100%;border-collapse:collapse;font-size:13px;margin:14px 0">' + rows + '</table>' +
      '<p style="text-align:center;margin:26px 0">' +
        '<a href="' + esc(link) + '" style="background:#C8813A;color:#fff;text-decoration:none;padding:12px 26px;border-radius:8px;font-size:14px;font-weight:600">Upload corrected documents</a>' +
      '</p>' +
      '<p style="font-size:12px;color:#7a7488">Questions? Just reply to this email and your loan officer will help.</p>' +
      '</div></div></body></html>';
    const text = 'Your loan team flagged issues with the following document' + (flagged.length === 1 ? '' : 's') +
      (address ? ' for ' + address : '') + ':\n\n' + textList +
      '\n\nUpload corrected documents here: ' + link +
      '\n\nQuestions? Reply to this email and your loan officer will help.\n\n— SLA Capital';

    const replyTo = await getOwnerReplyTo(ownerKey).catch(() => null);
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'SLA Capital <noreply@leads.slacapital.com>',
        to: [toEmail],
        ...(replyTo ? { reply_to: replyTo } : {}),
        subject, html, text,
      }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.warn('[fix-email] resend failed:', resp.status, body.slice(0, 200));
      return { ok: false, sent: false, reason: 'resend-http-' + resp.status };
    }
    // Bounce tracking (236.684) — log the send so a bounce notifies the LO.
    try {
      await logBorrowerSendFromResponse(resp, {
        kind: 'doc_fix_reminder', to: toEmail, ownerKey,
        address, loEmail: src.ownerKey,
      });
    } catch (_) {}
    return { ok: true, sent: true, to: toEmail, flagged };
  } catch (e) {
    console.error('[fix-email] unexpected error:', e && e.message);
    return { ok: false, sent: false, reason: (e && e.message) || 'unknown' };
  }
}
