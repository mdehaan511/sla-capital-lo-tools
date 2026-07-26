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
  handleOptions, json, requireAuth, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

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

  if (!Object.keys(updates).length) {
    return json(400, { error: 'Nothing to update' });
  }

  // Mirror to profiles store so other pages reflect the change immediately
  try {
    const store = getStore({ name: 'profiles', consistency: 'strong' });
    const email = normalizeEmail(user.email);
    const profileKey = keySafe(email);
    let profile = null;
    try { profile = await store.get(profileKey, { type: 'json' }); } catch (_) {}
    if (!profile) {
      profile = {
        id: user.sub, email, fullName: '', roles: [], confirmed_at: null,
        last_seen_at: new Date().toISOString(), user_metadata: {},
      };
    }
    if (updates.full_name != null) profile.fullName = updates.full_name;
    profile.user_metadata = Object.assign({}, profile.user_metadata || {}, updates);
    profile.last_seen_at = new Date().toISOString();
    await store.setJSON(profileKey, profile);
  } catch (e) {
    console.warn('profile-update mirror failed:', e);
    return json(500, { error: 'Failed to save profile' });
  }

  return json(200, { ok: true, updated: updates });
};
