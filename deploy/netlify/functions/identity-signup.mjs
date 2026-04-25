/**
 * identity-signup.mjs — Identity event handler
 * Fires when a user completes signup (after email confirmation if enabled).
 * Mirrors the new user's profile into the `profiles` Blobs store.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './_shared/auth.mjs';

export default async (req) => {
  let payload = {};
  try { payload = await req.json(); } catch (_) {}

  const u = payload && payload.user;
  if (u && u.email) {
    try {
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
        confirmed_at: u.confirmed_at || new Date().toISOString(),
        created_at: u.created_at || new Date().toISOString(),
        last_seen_at: null,
        user_metadata: meta,
      };

      const store = getStore({ name: 'profiles', consistency: 'strong' });
      await store.setJSON(keySafe(profile.email), profile);
    } catch (e) {
      console.warn('identity-signup profile write failed:', e);
    }
  }

  return new Response('OK', { status: 200 });
};
