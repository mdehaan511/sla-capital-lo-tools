/**
 * profile-update.mjs — POST /api/profile-update
 *
 * Mirrors the authenticated user's profile fields (fullName, phone) to
 * our `profiles` blob store so admin views see them. The user's actual
 * user_metadata on Netlify Identity is updated client-side directly via
 * netlifyIdentity.currentUser().update({ data: {...} }) — see
 * SLA.Profile.update in sla-api.js. The client write doesn't need an
 * admin token (users can write their own user_metadata via the gotrue
 * API), so this endpoint is the simpler "mirror to blob" half.
 *
 * Pre-Deploy-178: we ALSO called the Identity admin API from here using
 * either context.clientContext.identity.token or NETLIFY_AUTH_TOKEN to
 * write user_metadata server-side. That path was fragile: the
 * clientContext admin token is short-lived and often arrives expired in
 * function invocations (well-documented Netlify issue), and a manually
 * set NETLIFY_AUTH_TOKEN is a PAT (opaque string), not a JWT — the
 * Identity API rejects it with "Invalid token: token contains an
 * invalid number of segments" since a PAT has no dot-separated
 * segments. Both failure modes blocked users (including new signups)
 * from saving their profile. Moving the user_metadata write client-
 * side bypasses both problems entirely.
 *
 * Body: { fullName?, phone? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, keySafe, normalizeEmail, isAdmin,
} from './_shared/auth.mjs';
import { normalizeBirthday, normalizeDate } from './_shared/team-events.mjs'; // Deploy 237.082

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!user.sub) return json(400, { error: 'No user id in token' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });

  const updates = {};
  if (typeof body.fullName === 'string') updates.full_name = body.fullName.trim().slice(0, 120);
  if (typeof body.phone    === 'string') updates.phone     = body.phone.trim().slice(0, 40);

  // Deploy 237.082 (Mike) — team calendar fields, stored on the PROFILE BLOB
  // only (not user_metadata): birthday 'MM-DD' + optional year (the LO enters
  // these), startDate 'YYYY-MM-DD' (admin only — Mike enters the real dates
  // from Dan on Users Admin). '' clears. See _shared/team-events.mjs.
  const calendar = {};
  // Deploy 237.113 — an EMPTY birthday / start date is "no change" (the Profile
  // page's Save can fire before the calendar fields have loaded); clearing takes
  // an explicit clearBirthday / clearStartDate flag.
  if (typeof body.birthday === 'string' && (body.birthday.trim() !== '' || body.clearBirthday === true)) {
    const bd = normalizeBirthday(body.birthday);
    if (body.birthday.trim() && !bd.md) return json(400, { error: 'Birthday should be a month and day, like 3/14' });
    calendar.birthday = bd.md;
    calendar.birthYear = bd.year || (typeof body.birthYear === 'string' && /^\d{4}$/.test(body.birthYear.trim()) ? body.birthYear.trim() : '');
  }
  if (typeof body.startDate === 'string' && (body.startDate.trim() !== '' || body.clearStartDate === true)) {
    if (!isAdmin(user)) return json(403, { error: 'Start dates are set by an admin' });
    const sd = normalizeDate(body.startDate);
    if (body.startDate.trim() && !sd) return json(400, { error: 'Start date should look like 2021-09-15' });
    calendar.startDate = sd;
  }

  // Deploy 237.086 (Mike) — Armory avatar: one of the pixel characters in
  // armory-avatars.js (keys mirrored here so a bad key can never be stored).
  const AVATARS = ['paladin', 'dragon_knight', 'berserker', 'ranger', 'wizard', 'rogue', 'valkyrie', 'bard', 'monk', 'alchemist'];
  if (typeof body.avatar === 'string') {
    const a = body.avatar.trim();
    if (a && AVATARS.indexOf(a) < 0) return json(400, { error: 'Unknown avatar' });
    calendar.avatar = a;
  }

  if (!Object.keys(updates).length && !Object.keys(calendar).length) {
    return json(400, { error: 'Nothing to update' });
  }

  // Deploy 236.578 — optional owner override. The Proof-of-Funds flow saves the
  // assigned LO's phone to THEIR profile; when an admin generates the letter for
  // another LO's loan, they pass owner=<lo email>. Editing anyone else's profile
  // requires admin. Default target is the caller's own profile.
  const selfEmail = normalizeEmail(user.email);
  let targetEmail = selfEmail;
  if (body.owner) {
    const reqOwner = normalizeEmail(body.owner);
    if (reqOwner && reqOwner !== selfEmail) {
      if (!isAdmin(user)) return json(403, { error: "Editing another user's profile requires admin" });
      targetEmail = reqOwner;
    }
  }

  // Mirror to profiles store so other pages reflect the change immediately
  try {
    const store = getStore({ name: 'profiles', consistency: 'strong' });
    const profileKey = keySafe(targetEmail);
    let profile = null;
    try { profile = await store.get(profileKey, { type: 'json' }); } catch (_) {}
    if (!profile) {
      profile = {
        id: (targetEmail === selfEmail ? user.sub : ''), email: targetEmail,
        fullName: '', roles: [], confirmed_at: null,
        last_seen_at: new Date().toISOString(), user_metadata: {},
      };
    }
    if (updates.full_name != null) profile.fullName = updates.full_name;
    // Promote phone to a top-level field too (users-directory + POF read it
    // there first), alongside the user_metadata mirror.
    if (updates.phone != null) profile.phone = updates.phone;
    if (calendar.birthday != null) { profile.birthday = calendar.birthday; profile.birthYear = calendar.birthYear; }
    if (calendar.startDate != null) profile.startDate = calendar.startDate;
    if (calendar.avatar != null) profile.avatar = calendar.avatar;
    profile.user_metadata = Object.assign({}, profile.user_metadata || {}, updates);
    profile.last_seen_at = new Date().toISOString();
    await store.setJSON(profileKey, profile);
  } catch (e) {
    console.warn('profile-update mirror failed:', e);
    return json(500, { error: 'Failed to save profile' });
  }

  return json(200, { ok: true, updated: updates, owner: targetEmail });
};
