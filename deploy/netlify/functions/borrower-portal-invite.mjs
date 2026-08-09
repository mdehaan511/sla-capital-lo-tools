/**
 * borrower-portal-invite.mjs — POST /api/borrower-portal-invite
 *
 * Deploy 236.533 — client-level "Invite to Borrower Portal" (from Client
 * Details). Gives a client's borrower portal access to ALL of their loans and
 * sends one magic-link sign-in. Records a per-loan invite so each loan's
 * status line reflects it too.
 *
 * Body: { clientId, owner? }
 * Auth: the client's owner (LO) or an admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { grantLoanAccess } from './_shared/loan-access-store.mjs';
import { getOwnerReplyTo } from './_shared/email.mjs';
import {
  getSb, ensureBorrowerUser, borrowerMagicLink, sendBorrowerEmail, writeLoanInvite, escHtml,
} from './_shared/borrower-invite-core.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-portal-invite error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });
  const clientId = String(body.clientId).trim();
  const selfEmail = normalizeEmail(user.email);
  const ownerEmail = body.owner ? normalizeEmail(body.owner) : selfEmail;
  const ownerKey = keySafe(ownerEmail);

  // Only the client's owner (or an admin) may invite.
  if (ownerEmail !== selfEmail && !isAdmin(user)) {
    return json(403, { error: 'Only the client\'s loan officer or an admin can invite.' });
  }

  let client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to load client: ' + (e.message || 'unknown') });
  }
  if (!client) return json(404, { error: 'Client not found' });

  const inviteEmail = normalizeEmail(String(body.emailOverride || client.email || '').trim());
  if (!inviteEmail || inviteEmail.indexOf('@') < 0) {
    return json(400, { error: 'This client has no email on file. Add one first.' });
  }
  const fullName = [client.first_name, client.last_name].filter(Boolean).join(' ').trim() ||
                   [client.firstName, client.lastName].filter(Boolean).join(' ').trim();

  const sb = getSb();
  if (!sb) return json(500, { error: 'Supabase env not configured' });

  // 1. Supabase borrower user.
  const { userId } = await ensureBorrowerUser(sb, inviteEmail, fullName);

  // 2. Grant access to every loan on the client + record a per-loan invite.
  const loans = Array.isArray(client.loans) ? client.loans.filter((l) => l && l.id) : [];
  const sentAt = new Date().toISOString();
  let granted = 0;
  for (const l of loans) {
    try {
      await grantLoanAccess({ email: inviteEmail, loanId: l.id, primaryClientId: clientId, ownerKey, role: 'borrower', grantedBy: selfEmail });
      granted += 1;
      try { await writeLoanInvite(l.id, 'borrower', { email: inviteEmail, userId, sentAt, sentBy: selfEmail }); } catch (_) {}
    } catch (e) { console.warn('portal-invite: grant failed for', l.id, e && e.message); }
  }

  // 3. Magic-link sign-in + branded email.
  const origin = new URL(req.url).origin;
  const actionLink = await borrowerMagicLink(sb, inviteEmail, origin);
  let replyTo = '';
  try { replyTo = await getOwnerReplyTo(ownerKey); } catch (_) {}
  const mail = _portalEmail(fullName, actionLink || (origin + '/borrower-portal.html'), !actionLink);
  let emailed = false;
  try { emailed = await sendBorrowerEmail(inviteEmail, mail.subject, mail.text, mail.html, replyTo); }
  catch (e) { console.warn('portal-invite: email send failed:', e && e.message); }

  return json(200, { ok: true, email: inviteEmail, emailed, sentAt, loanCount: granted });
}

function _portalEmail(name, actionLink, isFallback) {
  const hi = name ? ('Hi ' + name + ',') : 'Hi there,';
  const text = [
    hi, '',
    'You\'ve been invited to your SLA Capital borrower portal, where you can view your loans and upload requested documents.', '',
    isFallback
      ? 'Open your portal here (sign in with Google or request a login link):'
      : 'Click the link below to sign in — no password needed:',
    actionLink, '',
    'You can also sign in any time with Google using this same email address.', '',
    '— SLA Capital',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">${escHtml(hi)}</p>
      <p style="font-size:15px;line-height:1.55">You've been invited to your <strong>SLA Capital borrower portal</strong>, where you can view your loans and upload requested documents.</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(actionLink)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">Sign in to my portal &rarr;</a>
      </p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">You can also sign in any time with <strong>Google</strong> using this same email address.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this into your browser:<br>${escHtml(actionLink)}</p>
    </div></body></html>`;
  return { subject: 'Your SLA Capital borrower portal', text, html };
}
