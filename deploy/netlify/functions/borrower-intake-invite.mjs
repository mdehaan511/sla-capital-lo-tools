/**
 * borrower-intake-invite.mjs — POST /api/borrower-intake-invite
 *
 * Deploy 236.520 — from "Start Document Review", the processor invites the
 * borrower to submit documents. Resolves WHO to invite (broker email for broker
 * loans, else the borrower's application email), (1) creates their portal login
 * via a Netlify Identity invite + tags role 'borrower', (2) grants loan_access,
 * and (3) sends a branded doc-submission email with the intake link.
 *
 * Body: { loanId, primaryClientId, owner?, emailOverride? }
 * Auth: processor/admin (canReviewDocs).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canReviewDocs } from './_shared/access.mjs';
import { grantLoanAccess } from './_shared/loan-access-store.mjs';
import { getOwnerReplyTo } from './_shared/email.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-intake-invite error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const gate = canReviewDocs(user);
  if (!gate.ok) return json(gate.status || 403, { error: gate.reason || 'Processor only' });

  const body = await readJsonBody(req);
  if (!body || !body.loanId || !body.primaryClientId) {
    return json(400, { error: 'loanId, primaryClientId required' });
  }
  const loanId = String(body.loanId).trim();
  const primaryClientId = String(body.primaryClientId).trim();
  const selfEmail = normalizeEmail(user.email);
  const ownerEmail = (body.owner && isAdmin(user)) ? normalizeEmail(body.owner) : selfEmail;
  const ownerKey = keySafe(ownerEmail);

  // Load loan + client to resolve the invite email.
  let loan = null, client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
    loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) || null : null;
  } catch (e) {
    return json(500, { error: 'Failed to load loan: ' + (e.message || 'unknown') });
  }
  if (!loan) return json(404, { error: 'Loan not found' });

  // Resolve the invite email: explicit override wins, else broker email for a
  // broker loan, else the borrower's application email.
  const isBroker = !!(loan._isBrokerLoan || (loan.formData && loan.formData._isBrokerLoan));
  const brokerEmail = loan.brokerEmail || (loan.formData && loan.formData.brokerEmail) || '';
  const appEmail = (client && client.email) || '';
  const inviteEmail = normalizeEmail(
    String(body.emailOverride || (isBroker ? brokerEmail : appEmail) || appEmail || '').trim()
  );
  if (!inviteEmail || inviteEmail.indexOf('@') < 0) {
    return json(400, { error: 'No ' + (isBroker ? 'broker' : 'borrower') + ' email on file. Add one or pass emailOverride.' });
  }

  // ── 1. Netlify Identity invite (account creation) + borrower role ──
  const identity = context && context.clientContext && context.clientContext.identity;
  let invited = false, alreadyMember = false;
  if (identity && identity.url && identity.token) {
    try {
      const r = await fetch(`${identity.url}/invite`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail }),
      });
      if (r.ok) {
        invited = true;
        const created = await r.json().catch(() => ({}));
        if (created && created.id) {
          try {
            await fetch(`${identity.url}/admin/users/${encodeURIComponent(created.id)}`, {
              method: 'PUT',
              headers: { 'Authorization': `Bearer ${identity.token}`, 'Content-Type': 'application/json' },
              body: JSON.stringify({ app_metadata: { roles: ['borrower'] } }),
            });
          } catch (e) { console.warn('intake-invite: role PUT failed:', e && e.message); }
        }
      } else if (r.status === 422) {
        alreadyMember = true; // already has an account — fine
      } else {
        console.warn('intake-invite: identity invite', r.status);
      }
    } catch (e) { console.warn('intake-invite: identity invite threw:', e && e.message); }
  }

  // ── 2. Grant loan access (idempotent) ──
  try {
    await grantLoanAccess({ email: inviteEmail, loanId, primaryClientId, ownerKey, role: 'borrower', grantedBy: selfEmail });
  } catch (e) {
    return json(500, { error: 'Grant write failed: ' + (e.message || 'unknown') });
  }

  // ── 3. Branded doc-submission email with the intake link ──
  const base = process.env.URL || 'https://slaloantools.netlify.app';
  const link = `${base}/borrower-intake.html?loanId=${encodeURIComponent(loanId)}` +
    `&clientId=${encodeURIComponent(primaryClientId)}&owner=${encodeURIComponent(ownerKey)}`;
  const addr = loan.address || 'your loan';
  let emailed = false;
  try {
    emailed = await sendIntakeEmail(inviteEmail, addr, link, ownerKey, alreadyMember);
  } catch (e) { console.warn('intake-invite: email send failed:', e && e.message); }

  return json(200, { ok: true, invited, alreadyMember, email: inviteEmail, emailed, link });
}

async function sendIntakeEmail(toEmail, addr, link, ownerKey, alreadyMember) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const firstStep = alreadyMember
    ? 'Sign in to your SLA Capital portal, then open your document list:'
    : 'First, check your inbox for a separate email to create your password. Then open your document list:';
  const text = [
    `You've been invited to submit the documents for your loan at ${addr}.`,
    '',
    firstStep,
    link,
    '',
    'Our system reviews most documents instantly, so you\'ll know right away if something needs fixing — no more back-and-forth.',
    '',
    '— SLA Capital',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">You've been invited to submit the documents for your loan at <strong>${escHtml(addr)}</strong>.</p>
      <p style="font-size:14px;line-height:1.55;color:#555">${escHtml(firstStep)}</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(link)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">Submit My Documents &rarr;</a>
      </p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">Our system reviews most documents instantly, so you'll know right away if something needs fixing — no more back-and-forth.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this link into your browser:<br>${escHtml(link)}</p>
    </div></body></html>`;
  const payload = {
    from: 'SLA Capital <noreply@leads.slacapital.com>',
    to: [toEmail],
    subject: `Submit your documents — ${addr}`,
    text, html,
  };
  try {
    const reply = await getOwnerReplyTo(ownerKey);
    if (reply) payload.reply_to = reply;
  } catch (_) {}
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return r.ok;
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
