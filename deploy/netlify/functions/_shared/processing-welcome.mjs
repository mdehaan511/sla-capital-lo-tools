/**
 * _shared/processing-welcome.mjs — auto-actions when a loan ENTERS the
 * Processing Pipeline.
 *
 * Deploy 236.803 (Mike): the moment a loan is pushed into processing,
 *   1. the BORROWER is automatically invited to the borrower portal to
 *      upload documents for that loan (Supabase user + loan_access grant
 *      + magic-link email — same machinery as the manual Invite button), and
 *   2. a TASK is created for the loan officer: run credit and submit the
 *      loan to DIYA (DSCR) / the investor (RTL/GUC), due next day.
 *
 * Called from every first-entry path: the long-app signing advance
 * (borrower-info-sync), the manual status advance (loan-advance-status),
 * and a first-time stage set on the Processing board (loan-processing-
 * stage). NOT called by loan-create-manual — hand-entered/migration loans
 * shouldn't blast borrowers with invites.
 *
 * Contract: BEST-EFFORT and IDEMPOTENT. Mutates the loan in place
 * (stamps loan._processingWelcomeAt + a notesLog entry) — the CALLER
 * persists the client afterwards. Never throws; failures are logged and
 * partial results returned. Broker-placeholder deals are skipped (no
 * real borrower email to invite).
 */
import { appendNoteEntry } from './notes-log.mjs';
import { grantLoanAccess } from './loan-access-store.mjs';
import { getOwnerReplyTo } from './email.mjs';
import {
  getSb, ensureBorrowerUser, borrowerMagicLink, sendBorrowerEmail,
  mintDurablePortalLink, linkExpiryCopy,
  writeLoanInvite, readLoanInvites, escHtml,
} from './borrower-invite-core.mjs';
import { getStore } from '@netlify/blobs';

const PORTAL_ORIGIN = 'https://portal.slacapital.ai';

export async function runProcessingWelcome({ ownerKey, ownerEmail, client, loan, origin, actorEmail }) {
  const out = { invited: false, taskCreated: false, skipped: '' };
  try {
    if (!client || !loan) { out.skipped = 'missing client/loan'; return out; }
    if (loan._processingWelcomeAt) { out.skipped = 'already ran'; return out; }
    // Working stages only — a legacy loan whose FIRST stage is pp_closed is
    // being archived, not worked.
    if (String(loan.processingStage || '') === 'pp_closed') { out.skipped = 'entered as closed'; return out; }

    const notesBits = [];

    // ── 1. Borrower portal invite (this loan) ──
    const isBroker = !!(loan._isBrokerLoan || client._isBrokerPlaceholder);
    const email = String(client.email || '').toLowerCase().trim();
    if (!isBroker && email && email.indexOf('@') >= 0) {
      try {
        const sb = getSb();
        if (sb) {
          // Skip the email if this loan already carries a borrower invite
          // (e.g. the LO invited manually before the advance) — but still
          // make sure the access grant exists.
          let already = null;
          try { already = await readLoanInvites(loan.id); } catch (_) {}
          const fullName = [client.firstName, client.lastName].filter(Boolean).join(' ').trim();
          const { userId } = await ensureBorrowerUser(sb, email, fullName);
          await grantLoanAccess({
            email, loanId: loan.id, primaryClientId: client.id, ownerKey,
            role: 'borrower', grantedBy: actorEmail || 'system@slacapital.com',
          });
          if (!(already && already.borrower && already.borrower.sentAt)) {
            const sentAt = new Date().toISOString();
            try { await writeLoanInvite(loan.id, 'borrower', { email, userId, sentAt, sentBy: actorEmail || 'system@slacapital.com' }); } catch (_) {}
            // Deploy 236.818 — durable 72h link; raw magic link only as fallback.
            const durable = mintDurablePortalLink(email, origin || PORTAL_ORIGIN);
            const actionLink = durable ? durable.url : await borrowerMagicLink(sb, email, origin || PORTAL_ORIGIN);
            let replyTo = '';
            try { replyTo = await getOwnerReplyTo(ownerKey); } catch (_) {}
            const mail = _docsEmail(fullName, loan.address || '', actionLink || ((origin || PORTAL_ORIGIN) + '/borrower-portal.html'), !actionLink, linkExpiryCopy(durable));
            await sendBorrowerEmail(email, mail.subject, mail.text, mail.html, replyTo, { kind: 'processing_portal_invite', ownerKey });
            out.invited = true;
            notesBits.push('borrower invited to the portal to upload documents (' + email + ')');
          } else {
            out.invited = true;
            notesBits.push('borrower portal access confirmed (already invited earlier)');
          }
        } else {
          out.skipped += 'supabase not configured; ';
        }
      } catch (e) {
        console.warn('processing-welcome: invite failed (non-fatal):', e && e.message);
      }
    } else if (isBroker) {
      notesBits.push('broker deal — borrower portal invite skipped');
    } else {
      notesBits.push('no borrower email on file — portal invite skipped');
    }

    // ── 2. LO task: run credit + submit ──
    try {
      const tool = String(loan.toolType || '').toLowerCase();
      const dest = tool === 'dscr' ? 'DIYA' : 'the investor';
      const now = new Date();
      const due = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
      const ymd = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0') + '-' + String(due.getDate()).padStart(2, '0');
      const lo = String(ownerEmail || ownerKey || '').toLowerCase();
      const task = {
        id:              't_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        clientId:        client.id, loanId: loan.id, ownerKey,
        title:           'Run credit + submit loan to ' + dest,
        dueDate:         ymd,
        assignedTo:      lo,
        assignedToName:  '',
        description:     'Auto-created when the loan entered the Processing Pipeline. Pull the credit report (Contacts tab → Verifications) and submit the loan to ' + dest + '.',
        completed:       false,
        completedAt:     '', completedBy: '', completedByName: '',
        createdAt:       new Date().toISOString(),
        createdBy:       'system@slacapital.com',
        createdByName:   'SLA Platform (auto-task)',
        updatedAt:       new Date().toISOString(),
        updatedBy:       actorEmail || 'system@slacapital.com',
        autoFromStage:   'processing_entry',
      };
      const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });
      await tasksStore.setJSON(ownerKey + '/' + task.id.replace(/[^a-zA-Z0-9_-]/g, '_'), task);
      out.taskCreated = true;
      notesBits.push('LO task created: ' + task.title);
    } catch (e) {
      console.warn('processing-welcome: task creation failed (non-fatal):', e && e.message);
    }

    loan._processingWelcomeAt = new Date().toISOString();
    if (notesBits.length) {
      appendNoteEntry(loan, {
        kind:        'system',
        text:        'Entered Processing Pipeline — ' + notesBits.join('; ') + '.',
        author:      'SLA Platform',
        authorEmail: 'system@slacapital.com',
        meta:        { via: 'processing_welcome', invited: out.invited, taskCreated: out.taskCreated },
      });
    }
  } catch (e) {
    console.warn('processing-welcome failed (non-fatal):', e && e.message);
  }
  return out;
}

function _docsEmail(name, address, actionLink, isFallback, expiry) {
  expiry = expiry || { text: '', html: '' };
  const hi = name ? ('Hi ' + name + ',') : 'Hi there,';
  const forLoan = address ? (' for your loan at ' + address) : ' for your loan';
  const text = [
    hi, '',
    'Your loan is now in processing! Please sign in to your SLA Capital borrower portal to upload the documents we need' + forLoan + '.', '',
    isFallback
      ? 'Open your portal here (sign in with Google or request a login link):'
      : 'Click the link below to sign in — no password needed:',
    actionLink, '',
  ].concat(expiry.text ? [expiry.text, ''] : []).concat([
    'You can also sign in any time with Google using this same email address.', '',
    '— SLA Capital',
  ]).join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">${escHtml(hi)}</p>
      <p style="font-size:15px;line-height:1.55">Your loan is now <strong>in processing</strong>! Please sign in to your <strong>SLA Capital borrower portal</strong> to upload the documents we need${escHtml(forLoan)}.</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(actionLink)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">Upload my documents &rarr;</a>
      </p>
      ${expiry.html}
      <p style="font-size:13px;line-height:1.55;color:#7a7488">You can also sign in any time with <strong>Google</strong> using this same email address.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this into your browser:<br>${escHtml(actionLink)}</p>
    </div></body></html>`;
  return { subject: 'Your loan is in processing — upload your documents', text, html };
}
