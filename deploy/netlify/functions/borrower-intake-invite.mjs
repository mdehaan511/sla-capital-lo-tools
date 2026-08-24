/**
 * borrower-intake-invite.mjs — /api/borrower-intake-invite
 *
 * Deploy 236.533 — loan-level borrower portal invite (Supabase). The processor
 * chooses WHO to send to (borrower or broker), and the loan keeps an audit
 * record so the UI can show recipient + date sent + last sign-in.
 *
 *   POST { loanId, primaryClientId, recipient?: 'borrower'|'broker',
 *          owner?, emailOverride? }
 *        → create/find the Supabase borrower user (role 'borrower'), grant
 *          loan_access, email a one-click magic-link sign-in, record the invite.
 *   GET  ?loanId=&owner=  → { borrower?: {email,sentAt,sentBy,lastSignInAt},
 *                             broker?: {...} }  (invite status for the loan)
 * Auth: any staff (owning LO, processor, or admin). POST is owner-scoped —
 *   a plain LO can only invite on loans in their own book.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

// Deploy 236.534 — any staff member (not a borrower-only account) may invite.
// POST is naturally owner-scoped: non-admin/processor callers resolve the loan
// under their OWN owner key, so they can only invite on loans in their book.
function _isStaff(user) {
  const am = (user && user.app_metadata) || {};
  const roles = Array.isArray(am.roles) ? am.roles : (am.role ? [am.role] : []);
  return !(roles.length > 0 && roles.every((r) => String(r).toLowerCase() === 'borrower'));
}
import { grantLoanAccess } from './_shared/loan-access-store.mjs';
import { isLoanInProcessing } from './_shared/access.mjs';
import { getOwnerReplyTo } from './_shared/email.mjs';
import {
  getSb, ensureBorrowerUser, borrowerMagicLink, lastSignInByUserId,
  sendBorrowerEmail, readLoanInvites, writeLoanInvite, escHtml,
} from './_shared/borrower-invite-core.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-intake-invite error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!_isStaff(user)) return json(403, { error: 'Staff only' });

  const sb = getSb();
  if (!sb) return json(500, { error: 'Supabase env not configured (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });

  // ── GET → invite status for a loan ──
  if (req.method === 'GET') {
    const loanId = new URL(req.url).searchParams.get('loanId') || '';
    if (!loanId) return json(400, { error: 'loanId required' });
    const rec = await readLoanInvites(loanId);
    const out = {};
    for (const who of ['borrower', 'broker']) {
      const e = rec && rec[who];
      if (e && e.email) {
        out[who] = {
          email: e.email, sentAt: e.sentAt || '', sentBy: e.sentBy || '',
          lastSignInAt: await lastSignInByUserId(sb, e.userId || ''),
        };
      }
    }
    return json(200, out);
  }

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (!body || !body.loanId || !body.primaryClientId) {
    return json(400, { error: 'loanId, primaryClientId required' });
  }
  const loanId = String(body.loanId).trim();
  const primaryClientId = String(body.primaryClientId).trim();
  const recipient = body.recipient === 'broker' ? 'broker' : 'borrower';
  const selfEmail = normalizeEmail(user.email);
  // Owner override (act on another LO's loan) is allowed for admins + processors;
  // a plain LO always resolves to their own book.
  const ownerEmail = (body.owner && (isAdmin(user) || isProcessor(user))) ? normalizeEmail(body.owner) : selfEmail;
  const ownerKey = keySafe(ownerEmail);

  // Load loan + client to resolve the recipient email + name.
  let loan = null, client = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
    loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) || null : null;
  } catch (e) {
    return json(500, { error: 'Failed to load loan: ' + (e.message || 'unknown') });
  }
  if (!loan) return json(404, { error: 'Loan not found' });

  // Deploy 236.590 — borrower invites require the loan to be In Processing
  // (no rate sheet / signed application to review uploads against before that).
  // Broker invites are exempt.
  if (recipient === 'borrower' && !isLoanInProcessing(loan)) {
    return json(409, { error: 'Loan must be In Processing before inviting the borrower.' });
  }

  const brokerEmail = loan.brokerEmail || (loan.formData && loan.formData.brokerEmail) || '';
  const appEmail = (client && client.email) || '';
  const chosen = recipient === 'broker' ? (brokerEmail || appEmail) : appEmail;
  const inviteEmail = normalizeEmail(String(body.emailOverride || chosen || '').trim());
  if (!inviteEmail || inviteEmail.indexOf('@') < 0) {
    return json(400, { error: 'No ' + recipient + ' email on file. Add one or pass emailOverride.' });
  }
  const fullName = recipient === 'broker'
    ? String(loan.brokerName || (loan.formData && loan.formData.brokerName) || '').trim()
    : ([client && client.first_name, client && client.last_name].filter(Boolean).join(' ').trim() ||
       [client && client.firstName, client && client.lastName].filter(Boolean).join(' ').trim());

  // 1. Supabase borrower user (role stamped).
  const { userId } = await ensureBorrowerUser(sb, inviteEmail, fullName);

  // 2. Grant loan access (idempotent, email-keyed).
  try {
    await grantLoanAccess({ email: inviteEmail, loanId, primaryClientId, ownerKey, role: 'borrower', grantedBy: selfEmail });
  } catch (e) {
    return json(500, { error: 'Grant write failed: ' + (e.message || 'unknown') });
  }

  // 3. Magic-link sign-in + branded email.
  const origin = new URL(req.url).origin;
  const actionLink = await borrowerMagicLink(sb, inviteEmail, origin);
  const addr = loan.address || 'your loan';
  let replyTo = '';
  try { replyTo = await getOwnerReplyTo(ownerKey); } catch (_) {}
  const mail = _intakeEmail(addr, actionLink || (origin + '/borrower-portal.html'), !actionLink);
  let emailed = false;
  try { emailed = await sendBorrowerEmail(inviteEmail, mail.subject, mail.text, mail.html, replyTo, { kind: 'portal_invite', ownerKey }); }
  catch (e) { console.warn('intake-invite: email send failed:', e && e.message); }

  // 4. Record the invite for the loan (audit + status display).
  const sentAt = new Date().toISOString();
  try { await writeLoanInvite(loanId, recipient, { email: inviteEmail, userId, sentAt, sentBy: selfEmail }); }
  catch (e) { console.warn('intake-invite: record write failed:', e && e.message); }

  return json(200, { ok: true, recipient, email: inviteEmail, emailed, sentAt });
}

function _intakeEmail(addr, actionLink, isFallback) {
  const cta = isFallback ? 'Open my document list' : 'Sign in & submit documents';
  const text = [
    `You've been invited to submit the documents for the loan at ${addr}.`, '',
    isFallback
      ? 'Open your document list here (sign in with Google or request a login link):'
      : 'Click the link below to sign in and open your document list — no password needed:',
    actionLink, '',
    'You can also sign in any time with Google using this same email address.', '',
    'Our system reviews most documents instantly, so you\'ll know right away if something needs fixing.', '',
    '— SLA Capital',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">You've been invited to submit the documents for the loan at <strong>${escHtml(addr)}</strong>.</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(actionLink)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">${escHtml(cta)} &rarr;</a>
      </p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">You can also sign in any time with <strong>Google</strong> using this same email address. Our system reviews most documents instantly, so you'll know right away if something needs fixing.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this into your browser:<br>${escHtml(actionLink)}</p>
    </div></body></html>`;
  return { subject: `Submit your documents — ${addr}`, text, html };
}
