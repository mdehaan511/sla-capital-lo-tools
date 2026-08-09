/**
 * borrower-intake-invite.mjs — POST /api/borrower-intake-invite
 *
 * Deploy 236.531 — borrower auth migrated to SUPABASE (was Netlify Identity).
 * From "Start Document Review", the processor invites the borrower to submit
 * documents. We resolve WHO to invite (broker email for broker loans, else the
 * borrower's application email), then:
 *   1. Create a SUPABASE user with role 'borrower' stamped into app_metadata
 *      (the access-token hook leaves sla_roles empty for non-staff, and the
 *      backend's _extractRoles falls back to app_metadata.roles → 'borrower').
 *   2. Grant loan_access (email-keyed, provider-agnostic — authorizes the portal).
 *   3. Email a one-click magic-link sign-in (via Resend, bypassing Supabase's
 *      own mailer / ES256 issue) that lands on /activate.html, which routes
 *      borrowers to their portal. Mirrors users-invite-supabase.mjs.
 * Borrowers can also sign in with Google any time (same Supabase account,
 * matched by email) — no password is ever created.
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
import { supabaseBaseUrl } from './_shared/supabase-db.mjs';

const INVITE_FROM = 'SLA Capital <noreply@leads.slacapital.com>';

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

  // Load loan + client to resolve the invite email + borrower name.
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
  const fullName =
    [client && client.first_name, client && client.last_name].filter(Boolean).join(' ').trim() ||
    [client && client.firstName, client && client.lastName].filter(Boolean).join(' ').trim();

  const SUPABASE_URL = supabaseBaseUrl(); // strips /rest/v1 suffix
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) {
    return json(500, { error: 'Supabase env not configured (need SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY)' });
  }
  const sbBase = String(SUPABASE_URL).replace(/\/+$/, '');
  const sbHeaders = { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC, 'Content-Type': 'application/json' };

  // ── 1. Create the Supabase borrower user (role stamped), or note existing ──
  let created = false, alreadyMember = false;
  try {
    const createResp = await fetch(sbBase + '/auth/v1/admin/users', {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({
        email: inviteEmail,
        email_confirm: true, // no separate confirmation step
        app_metadata: { role: 'borrower', roles: ['borrower'] },
        user_metadata: fullName ? { full_name: fullName } : {},
      }),
    });
    if (createResp.ok) {
      created = true;
    } else {
      const txt = await createResp.text().catch(() => '');
      if (createResp.status === 422 && /already|exists|registered/i.test(txt)) {
        alreadyMember = true; // fine — they'll get a fresh magic link below
      } else {
        console.warn('intake-invite: createUser', createResp.status, txt.slice(0, 200));
      }
    }
  } catch (e) { console.warn('intake-invite: createUser threw:', e && e.message); }

  // ── 2. Grant loan access (idempotent, email-keyed → authorizes the portal) ──
  try {
    await grantLoanAccess({ email: inviteEmail, loanId, primaryClientId, ownerKey, role: 'borrower', grantedBy: selfEmail });
  } catch (e) {
    return json(500, { error: 'Grant write failed: ' + (e.message || 'unknown') });
  }

  // ── 3. Generate a one-click magic-link sign-in. redirect_to lands on
  //        /activate.html (allowlisted; establishes the Supabase session and
  //        routes borrowers to their portal). ──
  const origin = new URL(req.url).origin;
  let actionLink = '';
  try {
    const linkResp = await fetch(sbBase + '/auth/v1/admin/generate_link', {
      method: 'POST',
      headers: sbHeaders,
      body: JSON.stringify({ type: 'magiclink', email: inviteEmail, redirect_to: origin + '/activate.html' }),
    });
    if (linkResp.ok) {
      const d = await linkResp.json().catch(() => ({}));
      actionLink = (d && d.properties && d.properties.action_link) || d.action_link || '';
    } else {
      console.warn('intake-invite: generate_link', linkResp.status);
    }
  } catch (e) { console.warn('intake-invite: generate_link threw:', e && e.message); }

  // ── 4. Branded doc-submission email with the magic-link sign-in ──
  const addr = loan.address || 'your loan';
  const portalLink = origin + '/borrower-portal.html'; // fallback if link gen failed
  let emailed = false;
  try {
    emailed = await sendIntakeEmail(inviteEmail, addr, actionLink || portalLink, ownerKey, !actionLink);
  } catch (e) { console.warn('intake-invite: email send failed:', e && e.message); }

  return json(200, { ok: true, created, alreadyMember, email: inviteEmail, emailed, hasLink: !!actionLink });
}

async function sendIntakeEmail(toEmail, addr, actionLink, ownerKey, isFallback) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  const cta = isFallback ? 'Open my document list' : 'Sign in & submit documents';
  const text = [
    `You've been invited to submit the documents for your loan at ${addr}.`,
    '',
    isFallback
      ? 'Open your document list here (sign in with Google or request a login link):'
      : 'Click the link below to sign in and open your document list — no password needed:',
    actionLink,
    '',
    'You can also sign in any time with Google using this same email address.',
    '',
    'Our system reviews most documents instantly, so you\'ll know right away if something needs fixing — no more back-and-forth.',
    '',
    '— SLA Capital',
  ].join('\n');
  const html = `<!doctype html><html><body style="margin:0;background:#f4f1ea;font-family:Arial,Helvetica,sans-serif;color:#1a1520">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-family:Georgia,serif;font-size:20px;font-weight:600;margin-bottom:14px">SLA Capital</div>
      <p style="font-size:15px;line-height:1.55">You've been invited to submit the documents for your loan at <strong>${escHtml(addr)}</strong>.</p>
      <p style="font-size:14px;line-height:1.55;color:#555">${escHtml(isFallback
        ? 'Open your document list below — sign in with Google or request a login link.'
        : 'Click below to sign in and open your document list. No password needed.')}</p>
      <p style="text-align:center;margin:22px 0">
        <a href="${escHtml(actionLink)}" style="background:#b5712d;color:#fff;text-decoration:none;font-weight:600;font-size:15px;padding:12px 26px;border-radius:10px;display:inline-block">${escHtml(cta)} &rarr;</a>
      </p>
      <p style="font-size:13px;line-height:1.55;color:#7a7488">You can also sign in any time with <strong>Google</strong> using this same email address. Our system reviews most documents instantly, so you'll know right away if something needs fixing — no more back-and-forth.</p>
      <p style="font-size:12px;color:#999;margin-top:24px">If the button doesn't work, paste this link into your browser:<br>${escHtml(actionLink)}</p>
    </div></body></html>`;
  const payload = {
    from: INVITE_FROM,
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
