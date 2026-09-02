/**
 * borrower-invite.mjs — POST /api/borrower-invite
 *
 * Per-loan "invite a borrower to the portal" — the Send Invite button in
 * Loan Details → Borrower Access. Grants loan_access on ONE loanId and sends
 * the borrower a sign-in.
 *
 * Deploy 236.170 — original (Netlify Identity) implementation.
 * Deploy 236.589 — MIGRATED off Netlify Identity onto Supabase, so borrowers
 *   invited here land in the SAME auth backbone the portal now uses (Google +
 *   magic link). The old path created a Netlify Identity user and relied on
 *   Netlify's invite email — but borrower-portal.html dropped the Netlify
 *   Identity widget in Deploy 236.542, so anyone invited through here got an
 *   account they literally could NOT sign in with. Now mirrors
 *   borrower-portal-invite.mjs / borrower-intake-invite.mjs via the shared
 *   _shared/borrower-invite-core.mjs: create/find the Supabase borrower user
 *   (roles:['borrower'] — the custom_access_token_hook falls back to
 *   app_metadata.roles so the token carries ['borrower'] and LO-vs-borrower
 *   detection stays correct), grant loan_access, email a magic-link sign-in via
 *   Resend, and record the per-loan invite audit so the Loan Details status
 *   line updates. This was the last Netlify-Identity residue in the borrower
 *   invite flow.
 *
 * Body: { email, loanId, primaryClientId, owner? }
 * Auth: LO who owns the loan, OR admin.
 *
 * Returns: { ok, email, emailed, alreadyMember, grant, sentAt }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canEditLoan, isLoanInProcessing } from './_shared/access.mjs';
import { grantLoanAccess } from './_shared/loan-access-store.mjs';
import { linkGuarantorToLoan } from './_shared/guarantor-link.mjs';
import { findClientByEmail } from './_shared/client-lookup.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { getOwnerReplyTo } from './_shared/email.mjs';
import {
  getSb, ensureBorrowerUser, borrowerMagicLink, sendBorrowerEmail, writeLoanInvite, escHtml,
  mintDurablePortalLink, linkExpiryCopy,
} from './_shared/borrower-invite-core.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-invite error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.email || !body.loanId || !body.primaryClientId) {
    return json(400, { error: 'email, loanId, primaryClientId required' });
  }
  const inviteEmail     = normalizeEmail(body.email);
  const loanId          = String(body.loanId).trim();
  const primaryClientId = String(body.primaryClientId).trim();
  if (inviteEmail.indexOf('@') < 0) return json(400, { error: 'Valid email required' });

  // Resolve owner. Admins can invite on any loan; LOs invite on their own
  // book. Owner override lets an admin do it "on behalf of" the LO.
  const selfEmail = normalizeEmail(user.email);
  const ownerEmail = (body.owner && isAdmin(user)) ? normalizeEmail(body.owner) : selfEmail;
  const ownerKey = keySafe(ownerEmail);

  // Load the target loan + its client and confirm the caller can edit the
  // loan. Fails closed on any mismatch.
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client = null, loan = null;
  try {
    client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
    if (client && Array.isArray(client.loans)) {
      loan = client.loans.find((l) => l && l.id === loanId) || null;
    }
    if (!loan) return json(404, { error: 'Loan not found' });
  } catch (e) {
    return json(500, { error: 'Failed to load loan: ' + (e.message || 'unknown') });
  }
  const perm = await canEditLoan(user, loan, { ownerKey });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  // Deploy 236.590 — no borrower invites before the loan is In Processing.
  // Before that there is no rate sheet / signed application to review the
  // borrower's uploaded documents against, so an invite would let docs show
  // "looks good" with no point of truth. Enforced server-side so the frontend
  // grey-out can't be bypassed.
  if (!isLoanInProcessing(loan)) {
    return json(409, { error: 'Loan must be In Processing before inviting a borrower.' });
  }

  // ── Resolve the invited person relative to the loan (Deploy 236.591) ──
  //  - the primary borrower's own email → portal access only (they ARE the
  //    borrower on this loan; no guarantor needed).
  //  - an existing OTHER client → auto-attach as a Guarantor now, with their
  //    name + phone from their client profile. The Supabase account name comes
  //    from THEM (fixes the 236.589 bug where fullName was the primary's).
  //  - a brand-new email → grant access only; they become a guarantor via the
  //    first-login onboarding form (borrower-guarantor-onboard) — see item 3b.
  const primaryEmail = normalizeEmail(client.email || '');
  const isPrimaryBorrower = !!primaryEmail && primaryEmail === inviteEmail;
  let guarantorClient = null;
  let inviteRole = 'borrower';
  if (!isPrimaryBorrower) {
    inviteRole = 'guarantor';
    try {
      const emailHit = await findClientByEmail(ownerKey, inviteEmail, clientsStore);
      if (emailHit && emailHit.client && emailHit.client.id !== primaryClientId) {
        const res = await linkGuarantorToLoan({
          ownerKey, primaryClientId, loanId, primary: client, loan, clientsStore,
          createdVia: '_createdViaBorrowerInvite',
          guarantor: {
            email:     inviteEmail,
            firstName: emailHit.client.firstName || '',
            lastName:  emailHit.client.lastName  || '',
            phone:     emailHit.client.phone     || '',
          },
        });
        guarantorClient = res.guarantor;
        // linkGuarantorToLoan mutated loan.guarantorClientIds on `client`;
        // persist the primary so the link sticks (PG-first).
        client.updatedAt = new Date().toISOString();
        await writeClient(ownerKey, client, { clientsStore });
      }
    } catch (e) {
      console.warn('borrower-invite: guarantor auto-link failed (non-fatal):', e && e.message);
    }
  }

  // Account + email name: the guarantor's own name when we linked one, else the
  // primary borrower's (it's their loan).
  const fullName = guarantorClient
    ? [guarantorClient.firstName, guarantorClient.lastName].filter(Boolean).join(' ').trim()
    : ([client.first_name, client.last_name].filter(Boolean).join(' ').trim() ||
       [client.firstName, client.lastName].filter(Boolean).join(' ').trim());

  // ── Supabase borrower user (role stamped) ─────────────────
  const sb = getSb();
  if (!sb) return json(500, { error: 'Supabase env not configured' });
  const { userId, alreadyMember } = await ensureBorrowerUser(sb, inviteEmail, fullName);

  // ── Grant loan access (idempotent) ────────────────────────
  let grant;
  try {
    grant = await grantLoanAccess({
      email:           inviteEmail,
      loanId,
      primaryClientId,
      ownerKey,
      role:            inviteRole,
      grantedBy:       selfEmail,
    });
  } catch (e) {
    return json(500, { error: 'Grant write failed: ' + (e.message || 'unknown') });
  }

  // ── Per-loan invite audit + magic-link sign-in email ──────
  const sentAt = new Date().toISOString();
  try { await writeLoanInvite(loanId, 'borrower', { email: inviteEmail, userId, sentAt, sentBy: selfEmail }); } catch (_) {}

  const origin = new URL(req.url).origin;
  // Deploy 236.818 — email a durable 72h link (redeemed via /api/borrower-link,
  // which mints a fresh Supabase magic link at click time). Raw magic link only
  // as fallback when the signing secret isn't configured.
  const durable = mintDurablePortalLink(inviteEmail, origin);
  const actionLink = durable ? durable.url : await borrowerMagicLink(sb, inviteEmail, origin);
  let replyTo = '';
  try { replyTo = await getOwnerReplyTo(ownerKey); } catch (_) {}
  const mail = _inviteEmail(fullName, actionLink || (origin + '/borrower-portal.html'), !actionLink, linkExpiryCopy(durable));
  let emailed = false;
  try { emailed = await sendBorrowerEmail(inviteEmail, mail.subject, mail.text, mail.html, replyTo, { kind: 'portal_invite', ownerKey }); }
  catch (e) { console.warn('borrower-invite: email send failed:', e && e.message); }

  return json(200, {
    ok: true, email: inviteEmail, emailed, alreadyMember, grant, sentAt,
    role: inviteRole,
    guarantorLinked: !!guarantorClient,
    guarantorClientId: guarantorClient ? guarantorClient.id : null,
  });
}

// Branded borrower-portal invite email (magic-link sign-in, no password).
// Mirrors borrower-portal-invite.mjs's copy so both invite paths read the same.
function _inviteEmail(name, actionLink, isFallback, expiry) {
  expiry = expiry || { text: '', html: '' };
  const hi = name ? ('Hi ' + name + ',') : 'Hi there,';
  const text = [
    hi, '',
    'You\'ve been invited to your SLA Capital borrower portal, where you can view your loan and upload requested documents.', '',
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
      <p style="font-size:15px;line-height:1.55">You've been invited to your <strong>SLA Capital borrower portal</strong>, where you can view your loan and upload requested documents.</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(actionLink)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">Sign in to my portal &rarr;</a>
      </p>
      ${expiry.html}
      <p style="font-size:13px;line-height:1.55;color:#7a7488">You can also sign in any time with <strong>Google</strong> using this same email address.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this into your browser:<br>${escHtml(actionLink)}</p>
    </div></body></html>`;
  return { subject: 'Your SLA Capital borrower portal', text, html };
}
