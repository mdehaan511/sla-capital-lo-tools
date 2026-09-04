/**
 * broker-claim.mjs — /api/broker-claim
 *
 * Deploy 236.873. The Preferred Partner login: an invited broker turns
 * their invite link into a real account.
 *
 *   GET  ?t=<token>   → what the signup page needs to render
 *   POST { t, firstName, lastName, company, phone, repId, password }
 *                     → creates the Supabase user, sets the rep, consumes
 *                       the token
 *
 * THIS IS THE ONLY UNAUTHENTICATED ENDPOINT IN THE BROKER PORTAL.
 * Everything else requires a session. So:
 *
 *   - the invite token IS the credential, and it is single-use: claiming
 *     clears it, and a second attempt with the same link fails
 *   - a token that matches nothing gets "this link isn't valid" and
 *     nothing else — never a hint about which emails exist
 *   - the email comes from the PARTNER RECORD, never from the request, so
 *     a token can only ever create the account it was minted for
 *   - rate-limited by IP, because there's no account to limit by yet
 *
 * INVITATION ONLY (Mike). The signup asks who at SLA invited them, and
 * that person becomes their rep — the name on their sizer and the person
 * their submitted deals route to. The picker is names-only (see
 * listRepsPublic); a mid-signup caller never sees the staff roster.
 */
import { handleOptions, json, readJsonBody, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { checkRateLimit } from './_shared/rate-limit.mjs';
import {
  findByInviteToken, consumeInvite, savePartner, getPartner,
} from './_shared/broker-partners.mjs';
import { listRepsPublic, repEmailFromId, getRep, repId } from './_shared/sla-rep.mjs';
import { getSb } from './_shared/borrower-invite-core.mjs';
import { syncRoleTable } from './_shared/sla-roles.mjs';

// Short enough to be typed once, long enough not to be guessed. Supabase
// enforces its own minimum too; this is the message the broker actually reads.
const MIN_PASSWORD = 10;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-claim error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function invalidLink() {
  return json(404, {
    error: 'This invitation link isn\'t valid any more. It may have already been used — try signing in, or ask your SLA contact for a new one.',
    code: 'invite_invalid',
  });
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  // No account to key on yet, so IP it is. Generous — a broker filling in
  // a form retries — but enough to stop a token-guessing sweep.
  const rl = await checkRateLimit(req, context, { bucket: 'broker-claim', max: 30, windowSec: 900 });
  if (!rl.allowed) {
    return json(429, { error: 'Too many attempts. Please wait a few minutes and try again.' });
  }

  // ── GET: what the signup page renders ───────────────────────────
  if (req.method === 'GET') {
    let t = '';
    try { t = new URL(req.url).searchParams.get('t') || ''; } catch (_) {}
    const partner = await findByInviteToken(t);
    if (!partner) return invalidLink();
    if (partner.status === 'suspended') {
      return json(403, { error: 'This partner account is not active. Please contact your SLA representative.' });
    }
    // If an admin already set the rep, show it and let them confirm rather
    // than asking a question we know the answer to.
    const rep = partner.ownerKey ? await getRep(partner.ownerKey) : null;
    return json(200, {
      ok: true,
      email:     partner.email,
      firstName: partner.firstName || '',
      lastName:  partner.lastName || '',
      company:   partner.company || '',
      phone:     partner.phone || '',
      knownRep:  rep && rep.name ? { id: repId(rep.email), name: rep.name } : null,
      reps:      await listRepsPublic(),
      minPassword: MIN_PASSWORD,
    });
  }

  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  // ── POST: create the account ────────────────────────────────────
  const body = (await readJsonBody(req)) || {};
  const partner = await findByInviteToken(body.t);
  if (!partner) return invalidLink();
  if (partner.status === 'suspended') {
    return json(403, { error: 'This partner account is not active. Please contact your SLA representative.' });
  }

  // The email is the RECORD's, never the request's. A token can only ever
  // create the account it was minted for.
  const email = normalizeEmail(partner.email);

  const firstName = String(body.firstName || '').trim();
  const lastName  = String(body.lastName  || '').trim();
  const company   = String(body.company   || '').trim();
  const phone     = String(body.phone     || '').trim();
  const password  = String(body.password  || '');

  if (!firstName || !lastName) return json(400, { error: 'Please enter your first and last name.' });
  if (!company)               return json(400, { error: 'Please enter your company name.' });
  if (password.length < MIN_PASSWORD) {
    return json(400, { error: 'Please choose a password of at least ' + MIN_PASSWORD + ' characters.' });
  }

  // Who invited them. Required — this is an invitation-only program, and
  // the answer decides who works their deals.
  let repEmail = partner.ownerKey ? normalizeEmail(partner.ownerKey) : '';
  if (body.repId) {
    const resolved = await repEmailFromId(String(body.repId));
    if (!resolved) return json(400, { error: 'Please choose who at SLA invited you.' });
    repEmail = resolved;
  }
  if (!repEmail) return json(400, { error: 'Please choose who at SLA invited you.' });

  const sb = getSb();
  if (!sb) {
    console.error('broker-claim: Supabase service credentials are not configured');
    return json(500, { error: 'Sign-up is temporarily unavailable. Please contact your SLA representative.' });
  }

  // Create the auth user with the password they chose. Deliberately NOT
  // ensureBorrowerUser (that stamps a BORROWER role); the roles
  // TABLE below is what the token hook actually reads.
  const fullName = (firstName + ' ' + lastName).trim();
  let userId = '';
  let created = false;
  try {
    const r = await fetch(sb.base + '/auth/v1/admin/users', {
      method: 'POST',
      headers: sb.headers,
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        app_metadata: { role: 'broker', roles: ['broker'] },
        user_metadata: { full_name: fullName, company },
      }),
    });
    if (r.ok) {
      created = true;
      const d = await r.json().catch(() => ({}));
      userId = (d && d.id) || '';
    } else {
      const txt = await r.text().catch(() => '');
      if (r.status === 422 && /already|exists|registered/i.test(txt)) {
        // They already have a login — most likely they were a borrower or
        // reused an address. Don't reset anyone's password from an invite
        // link; send them to sign in instead.
        return json(409, {
          code: 'already_registered',
          error: 'There is already an account for this email. Please sign in with it — if you\'ve forgotten the password, use "Forgot password" on the sign-in page.',
        });
      }
      console.error('broker-claim createUser', r.status, txt.slice(0, 200));
      return json(500, { error: 'Could not create your account. Please contact your SLA representative.' });
    }
  } catch (e) {
    console.error('broker-claim createUser threw:', e && e.message);
    return json(500, { error: 'Could not create your account. Please contact your SLA representative.' });
  }

  // Roles come from the table, not app_metadata (the access-token hook
  // overwrites the claim from public.sla_user_roles — Deploy 236.826).
  const roleSync = await syncRoleTable(email, ['broker']);
  if (!roleSync.ok) {
    console.error('broker-claim: role table sync failed for ' + email + ':', roleSync.reason);
  }

  // Record what they told us, and who owns the relationship.
  await savePartner(email, {
    firstName, lastName, company, phone,
    ownerKey: keySafe(repEmail),
  }, email);
  await consumeInvite(email);

  const rep = await getRep(repEmail);
  const fresh = await getPartner(email);

  return json(200, {
    ok: true,
    created,
    userId: userId ? true : false,
    email,
    status: fresh ? fresh.status : partner.status,
    rep: rep ? { name: rep.name, email: rep.email } : null,
    // An approved partner can price immediately; a pending one has an
    // account but still waits on approval. Say which, plainly.
    canPriceNow: (fresh ? fresh.status : partner.status) === 'approved',
  });
}
