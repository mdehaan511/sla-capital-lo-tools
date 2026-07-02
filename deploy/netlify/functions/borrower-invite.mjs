/**
 * borrower-invite.mjs — POST /api/borrower-invite
 *
 * Deploy 236.170 — Access Refactor PR #3. Invites an email
 * address to the SLA borrower portal for a SPECIFIC loan:
 *
 *   1. Fires a Netlify Identity /invite email (existing user? we
 *      skip this step and go straight to the grant).
 *   2. Sets app_metadata.roles = ['borrower'] on the newly-
 *      created Identity user so their session paints the portal
 *      shell, not the LO tools.
 *   3. Grants loan_access on the specified loanId so canReadLoan
 *      lets the borrower through when they hit LO-shared endpoints
 *      that have been migrated to access.mjs (currently:
 *      borrower-info-status, loan-review-doc-get, etc.).
 *
 * Body: { email, loanId, primaryClientId, owner? }
 * Auth: LO who owns the loan, OR admin.
 *
 * Returns: { ok, invitedUser?: { id, email }, grant, alreadyMember }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canEditLoan } from './_shared/access.mjs';
import { grantLoanAccess } from './_shared/loan-access-store.mjs';

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

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body || !body.email || !body.loanId || !body.primaryClientId) {
    return json(400, { error: 'email, loanId, primaryClientId required' });
  }
  const inviteEmail    = normalizeEmail(body.email);
  const loanId         = String(body.loanId).trim();
  const primaryClientId = String(body.primaryClientId).trim();

  // Resolve owner. Admins can invite on any loan; LOs invite on
  // their own book. Owner override lets an admin do it "on behalf
  // of" the LO.
  const selfEmail = normalizeEmail(user.email);
  const ownerEmail = (body.owner && isAdmin(user)) ? normalizeEmail(body.owner) : selfEmail;
  const ownerKey = keySafe(ownerEmail);

  // Load the target loan and confirm the caller can edit it. Fails
  // closed on any mismatch.
  let loan = null;
  try {
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
    if (client && Array.isArray(client.loans)) {
      loan = client.loans.find((l) => l && l.id === loanId) || null;
    }
    if (!loan) return json(404, { error: 'Loan not found' });
  } catch (e) {
    return json(500, { error: 'Failed to load loan: ' + (e.message || 'unknown') });
  }
  const perm = await canEditLoan(user, loan, { ownerKey });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  // ── Netlify Identity invite ───────────────────────────────
  const identity = context && context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    return json(500, { error: 'Identity context unavailable — cannot invite' });
  }

  let invitedUser = null;
  let alreadyMember = false;
  try {
    const inviteResp = await fetch(`${identity.url}/invite`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${identity.token}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ email: inviteEmail }),
    });

    if (inviteResp.ok) {
      const created = await inviteResp.json().catch(() => ({}));
      invitedUser = { id: created.id, email: created.email };
      // Set the borrower role on the newly-created user. Best-effort;
      // don't fail the whole flow if this PUT fails — the LO can
      // re-run the invite (which will now hit alreadyMember and
      // still grant loan access).
      if (created.id) {
        try {
          await fetch(`${identity.url}/admin/users/${encodeURIComponent(created.id)}`, {
            method: 'PUT',
            headers: {
              'Authorization': `Bearer ${identity.token}`,
              'Content-Type':  'application/json',
            },
            body: JSON.stringify({ app_metadata: { roles: ['borrower'] } }),
          });
        } catch (e) {
          console.warn('borrower-invite: role PUT failed:', e && e.message);
        }
      }
    } else if (inviteResp.status === 422) {
      // Identity returns 422 when the email already has an account
      // — that's fine, we just skip the invite step and go straight
      // to the loan_access grant.
      alreadyMember = true;
    } else {
      const txt = await inviteResp.text().catch(() => '');
      return json(inviteResp.status, {
        error: `Identity API ${inviteResp.status}: ${txt.slice(0, 200)}`,
      });
    }
  } catch (e) {
    return json(500, { error: 'Invite request failed: ' + (e.message || 'unknown') });
  }

  // ── Grant loan access (idempotent) ────────────────────────
  let grant;
  try {
    grant = await grantLoanAccess({
      email:           inviteEmail,
      loanId,
      primaryClientId,
      ownerKey,
      role:            'borrower',
      grantedBy:       selfEmail,
    });
  } catch (e) {
    return json(500, { error: 'Grant write failed: ' + (e.message || 'unknown') });
  }

  return json(200, {
    ok:            true,
    invitedUser,
    alreadyMember,
    grant,
  });
}
