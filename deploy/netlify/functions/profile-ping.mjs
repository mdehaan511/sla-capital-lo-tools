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

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!user.email) return json(400, { error: 'No email in token' });

  const meta = user.user_metadata || {};
  const app  = user.app_metadata  || {};
  const fullName =
    meta.full_name || meta.fullName || meta.name ||
    ((meta.firstName || '') + ' ' + (meta.lastName || '')).trim() || '';
  const roles = Array.isArray(app.roles) ? app.roles
              : (app.roles ? [app.roles] : ['user']);

  const profile = {
    id: user.sub || null,
    email: normalizeEmail(user.email),
    fullName,
    roles,
    confirmed_at: user.confirmed_at || null,
    last_seen_at: new Date().toISOString(),
    user_metadata: meta,
  };

  try {
    const store = getStore({ name: 'profiles', consistency: 'strong' });
    // Merge with whatever's already there so we don't lose created_at, etc.
    let existing = null;
    try { existing = await store.get(keySafe(profile.email), { type: 'json' }); } catch (_) {}
    const merged = Object.assign({}, existing || {}, profile);
    if (existing && existing.created_at) merged.created_at = existing.created_at;
    // Deploy 237.088 — first sign-in stamps created_at; with no admin-entered
    // start date that day IS the work anniversary (Mike: "when they were added
    // to the SLA app"). Existing members without it get today on their next ping.
    if (!merged.created_at) merged.created_at = new Date().toISOString();
    await store.setJSON(keySafe(profile.email), merged);
    // Deploy 237.082 — hand back the calendar fields so the client can decide
    // whether to prompt for a birthday (they live on the blob, not the token).
    return json(200, { ok: true, profile: { fullName: merged.fullName || '', birthday: merged.birthday || '', birthYear: merged.birthYear || '', startDate: merged.startDate || '', avatar: merged.avatar || '' } });
  } catch (e) {
    console.error('profile-ping error:', e);
    return json(500, { error: 'Failed to save profile' });
  }
};
