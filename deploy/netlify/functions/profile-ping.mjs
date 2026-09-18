/**
 * profile-ping.mjs — POST /api/profile-ping
 *
 * Any logged-in user calls this on page load. It writes their *current*
 * profile (from their JWT) to the `profiles` Blobs store. That keeps the
 * profiles store fresh without depending on Netlify's identity-login
 * event firing (which only fires on actual login transitions, not on
 * every page load).
 *
 * Idempotent. Safe to call frequently. Cheap (one blob write).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { mergeIdentityProfile } from './_shared/profile-record.mjs'; // Deploy 237.153

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!user.email) return json(400, { error: 'No email in token' });

  try {
    const store = getStore({ name: 'profiles', consistency: 'strong' });
    const key = keySafe(normalizeEmail(user.email));
    let existing = null;
    try { existing = await store.get(key, { type: 'json' }); } catch (_) {}
    // Deploy 237.153 — one shared merge rule with the identity-login /
    // identity-signup handlers: app-owned fields (birthday, startDate, avatar,
    // phone) survive, and a token with no name or no roles can't blank the
    // stored ones. It also keeps the first created_at, which is the fallback
    // work anniversary (Deploy 237.088, Mike: "when they were added to the app").
    const merged = mergeIdentityProfile(existing, user);
    await store.setJSON(key, merged);
    // Deploy 237.082 — hand back the calendar fields so the client can decide
    // whether to prompt for a birthday (they live on the blob, not the token).
    return json(200, { ok: true, profile: { fullName: merged.fullName || '', birthday: merged.birthday || '', birthYear: merged.birthYear || '', startDate: merged.startDate || '', avatar: merged.avatar || '' } });
  } catch (e) {
    console.error('profile-ping error:', e);
    return json(500, { error: 'Failed to save profile' });
  }
};
