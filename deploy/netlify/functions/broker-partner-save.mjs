/**
 * broker-partner-save.mjs — POST /api/broker-partner-save
 *
 * Deploy 236.859 — Broker Portal, Phase 1. Create, update, approve,
 * suspend, invite or delete a Preferred Partner. ADMIN ONLY.
 *
 * Body:
 *   { email, action?, ...fields }
 *
 *   action 'save'    (default) create or update the fields supplied
 *          'approve' status -> approved, and grant the broker role
 *          'suspend' status -> suspended, and revoke the broker role
 *          'invite'  mint an invite token and return the claim link
 *          'delete'  remove the record entirely (mistakes only), and
 *                    its pricing history with it
 *          'purge-activity'  clear a partner's pricing sessions, keeping
 *                    the record — for clearing test rows off the desk
 *
 * Fields: clientId, ownerKey, company, firstName, lastName, phone, nmls,
 *         programs[], feeCapPoints, notes, status
 *
 * ROLE WRITES GO THROUGH THE TABLE
 * --------------------------------
 * Approving a partner writes role 'broker' to public.sla_user_roles via
 * syncRoleTable — the access-token hook stamps roles onto tokens FROM
 * THAT TABLE and overwrites app_metadata, so a role set anywhere else is
 * a role that silently doesn't exist (Deploy 236.826). Suspending strips
 * it back to []. Either way it takes effect on their NEXT token mint.
 *
 * NOTHING HERE SENDS EMAIL. An invite returns a link for the admin to
 * copy — a half-built portal must not start mailing 117 brokers.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import {
  getPartner, savePartner, mintInvite, deletePartner, ALL_PROGRAMS,
} from './_shared/broker-partners.mjs';
import { purgeActivity } from './_shared/broker-activity.mjs';
// Deploy 236.870 — the saved quote history goes with the record too.
import { purgeQuotes } from './_shared/broker-quotes.mjs';
import { syncRoleTable } from './_shared/sla-roles.mjs';

// Deploy 237.234 -- the invite email. Plain and short: who invited them, what the portal is
// for, the one link. Never throws; the caller reports `emailed: false` and shows the link.
async function sendInviteEmail({ toEmail, inviteUrl, rec, actor }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return { ok: false, error: 'RESEND_API_KEY not set' };
  const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const first = String(rec.firstName || '').trim();
  const subject = 'Your SLA Capital Preferred Partner login';
  const text = (first ? 'Hi ' + first + ',\n\n' : '') +
    'You have been invited to the SLA Capital Preferred Partner portal: see the loans you have with us, ' +
    'the terms being negotiated, and upload documents for your borrowers.\n\n' +
    'Set up your login here (the link is yours alone and works once):\n' + inviteUrl + '\n\n' +
    'Questions? Just reply to this email.\n\nSLA Capital';
  const html = '<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f0ece5;font-family:Arial,Helvetica,sans-serif">' +
    '<div style="max-width:560px;margin:0 auto;padding:32px 24px">' +
      '<div style="background:#fff;border:1px solid #ddd8d0;border-radius:12px;padding:28px">' +
        '<p style="font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:#C8813A;margin:0 0 6px">SLA Capital · Preferred Partners</p>' +
        '<h1 style="font-size:20px;margin:0 0 14px;color:#261a36">Your partner login</h1>' +
        (first ? '<p style="font-size:14px;line-height:1.6;color:#1a1520">Hi ' + escH(first) + ',</p>' : '') +
        '<p style="font-size:14px;line-height:1.6;color:#1a1520">You have been invited to the SLA Capital Preferred Partner portal: see the loans you have with us, the terms being negotiated, and upload documents for your borrowers.</p>' +
        '<p style="margin:22px 0"><a href="' + escH(inviteUrl) + '" style="display:inline-block;background:#261a36;color:#f2ede6;text-decoration:none;font-weight:600;font-size:14px;padding:12px 18px;border-radius:8px">Set up my login</a></p>' +
        '<p style="font-size:12px;line-height:1.6;color:#7a7488">The link is yours alone and works once. If the button does not open, copy this address:<br>' + escH(inviteUrl) + '</p>' +
        '<p style="font-size:12px;color:#7a7488;margin-top:24px">Questions? Just reply to this email.<br>Sir Lends A Lot LLC dba SLA Capital.</p>' +
      '</div></div></body></html>';
  try {
    const resp = await fetch('https://api.resend.com/emails', {
      signal: AbortSignal.timeout(15000),
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'SLA Capital <noreply@leads.slacapital.com>', to: [toEmail], subject, text, html, ...(actor ? { reply_to: actor } : {}) }),
    });
    if (!resp.ok) { const t = await resp.text().catch(() => ''); return { ok: false, error: 'Resend ' + resp.status + ' ' + t.slice(0, 160) }; }
    return { ok: true };
  } catch (e) { return { ok: false, error: (e && e.message) || 'send failed' }; }
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-partner-save error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const email = normalizeEmail(body.email || '');
  if (!email || !email.includes('@')) return json(400, { error: 'A valid email is required' });

  const actor  = normalizeEmail(user.email || '');
  const action = String(body.action || 'save').toLowerCase();

  // ── delete ──────────────────────────────────────────────────────
  if (action === 'delete') {
    // Offboarding is `suspend` — it keeps the history and is one click to
    // undo. Delete is for a record created by mistake, so it also drops
    // the role rather than leaving a login pointing at nothing, and takes
    // the pricing history with it: activity for a partner who no longer
    // exists is noise on the desk that nobody can act on.
    await deletePartner(email);
    await syncRoleTable(email, []);
    const purged = await purgeActivity(email);
    const quotesPurged = await purgeQuotes(email);
    return json(200, { ok: true, deleted: email, activityPurged: purged, quotesPurged });
  }

  // ── purge activity, keeping the partner ─────────────────────────
  // Separate from delete so test rows can be cleared off the desk without
  // touching a real partner record.
  if (action === 'purge-activity') {
    const purged = await purgeActivity(email);
    const quotesPurged = await purgeQuotes(email);
    return json(200, { ok: true, activityPurged: purged, quotesPurged });
  }

  // ── invite ──────────────────────────────────────────────────────
  if (action === 'invite') {
    const existing = await getPartner(email);
    if (!existing) return json(404, { error: 'No partner record for ' + email });
    const rec = await mintInvite(email, actor);
    const origin = (() => {
      try { return new URL(req.url).origin; } catch (_) { return 'https://portal.slacapital.ai'; }
    })();
    const inviteUrl = origin + '/broker-signup.html?t=' + encodeURIComponent(rec.inviteToken);
    // Deploy 237.234 (Mike: "a login that brokers get invited to") -- `send: true` emails
    // the link to the partner, from SLA with the inviting admin as reply-to. Still opt-in
    // per partner: nothing mails anyone unless a person clicked "Email it".
    let emailed = false, emailError = '';
    if (body.send === true) {
      const r = await sendInviteEmail({ toEmail: email, inviteUrl, rec, actor });
      emailed = r.ok; emailError = r.error || '';
    }
    return json(200, { ok: true, partner: rec, inviteUrl, emailed, emailError });
  }

  // ── save / approve / suspend ────────────────────────────────────
  const patch = {};
  for (const f of ['clientId', 'ownerKey', 'company', 'firstName', 'lastName',
                   'phone', 'nmls', 'notes']) {
    if (body[f] !== undefined) patch[f] = String(body[f] || '').trim();
  }
  if (body.ownerKey !== undefined) patch.ownerKey = body.ownerKey ? keySafe(normalizeEmail(body.ownerKey)) : '';

  if (body.programs !== undefined) {
    if (!Array.isArray(body.programs)) return json(400, { error: 'programs must be an array' });
    const bad = body.programs.filter((p) => !ALL_PROGRAMS.includes(p));
    if (bad.length) return json(400, { error: 'Unknown program(s): ' + bad.join(', ') });
    patch.programs = body.programs;
  }

  if (body.feeCapPoints !== undefined) {
    if (body.feeCapPoints === null || body.feeCapPoints === '') {
      patch.feeCapPoints = null;
    } else {
      const n = Number(body.feeCapPoints);
      if (!isFinite(n) || n < 0 || n > 10) {
        return json(400, { error: 'feeCapPoints must be between 0 and 10, or blank for no cap' });
      }
      patch.feeCapPoints = n;
    }
  }

  if (action === 'approve')      patch.status = 'approved';
  else if (action === 'suspend') patch.status = 'suspended';
  else if (body.status !== undefined) patch.status = String(body.status);

  let rec;
  try {
    rec = await savePartner(email, patch, actor);
  } catch (e) {
    return json(400, { error: (e && e.message) || 'Could not save partner' });
  }

  // Role follows status. Errors here are reported, not swallowed: a
  // partner marked approved whose role never landed can sign in and find
  // pricing refused, which reads as a bug rather than a permission.
  let roleSync = null;
  if (patch.status === 'approved') {
    roleSync = await syncRoleTable(email, ['broker']);
  } else if (patch.status === 'suspended') {
    roleSync = await syncRoleTable(email, []);
  }

  return json(200, {
    ok: true,
    partner: rec,
    roleSync,
    // The hook stamps roles at token-mint time, so an approval isn't live
    // in their session until they sign in again. Say so rather than
    // letting an admin wonder.
    roleNote: patch.status
      ? 'Role takes effect on the partner\'s next sign-in.'
      : undefined,
  });
}
