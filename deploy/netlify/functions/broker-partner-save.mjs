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
 *          'delete'  remove the record entirely (mistakes only)
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
import { syncRoleTable } from './_shared/sla-roles.mjs';

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
    // the role rather than leaving a login pointing at nothing.
    await deletePartner(email);
    await syncRoleTable(email, []);
    return json(200, { ok: true, deleted: email });
  }

  // ── invite ──────────────────────────────────────────────────────
  if (action === 'invite') {
    const existing = await getPartner(email);
    if (!existing) return json(404, { error: 'No partner record for ' + email });
    const rec = await mintInvite(email, actor);
    const origin = (() => {
      try { return new URL(req.url).origin; } catch (_) { return 'https://portal.slacapital.ai'; }
    })();
    return json(200, {
      ok: true,
      partner: rec,
      inviteUrl: origin + '/broker-signup.html?t=' + encodeURIComponent(rec.inviteToken),
      emailed: false,
    });
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
