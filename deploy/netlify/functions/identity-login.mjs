/**
 * identity-login.mjs — Identity event handler
 *
 * Netlify automatically invokes this function whenever an Identity user
 * successfully logs in. The request body contains the event type and
 * the full user object — including app_metadata, user_metadata, etc.
 *
 * We use it to mirror user profile data into our `profiles` Blobs store
 * so other functions (users-stats, etc.) can read user info without
 * needing an Identity admin token.
 *
 * Netlify expects a 200 response. Returning anything else blocks the login.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './_shared/auth.mjs';

export default async (req) => {
  let payload = {};
  try { payload = await req.json(); } catch (_) { /* ignore */ }

  const u = payload && payload.user;
  if (u && u.email) {
    try {
      await writeProfile(u);
    } catch (e) {
      // Don't block login on profile write failure — just log
      console.warn('identity-login profile write failed:', e);
    }
  }

  // Always return 200 with valid JSON — Netlify parses this as the
  // authoritative user metadata. Empty object means "no changes".
  return new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};

async function writeProfile(u) {
  const meta = u.user_metadata || {};
  const app  = u.app_metadata  || {};
  const fullName =
    meta.full_name || meta.fullName || meta.name ||
    ((meta.firstName || '') + ' ' + (meta.lastName || '')).trim() || '';
  const roles = Array.isArray(app.roles) ? app.roles
              : (app.roles ? [app.roles] : ['user']);

  const profile = {
    id: u.id,
    email: normalizeEmail(u.email),
    fullName,
    roles,
    confirmed_at: u.confirmed_at || null,
    last_seen_at: new Date().toISOString(),
    created_at: u.created_at || null,
    user_metadata: meta, // keep raw in case we missed a field
  };

  const store = getStore({ name: 'profiles', consistency: 'strong' });
  const key = keySafe(profile.email);
  await store.setJSON(key, profile);
}
