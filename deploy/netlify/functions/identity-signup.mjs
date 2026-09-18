/**
 * identity-signup.mjs — Identity event handler
 * Fires when a user completes signup (after email confirmation if enabled).
 * Mirrors the new user's profile into the `profiles` Blobs store.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './_shared/auth.mjs';
import { mergeIdentityProfile } from './_shared/profile-record.mjs'; // Deploy 237.153

export default async (req) => {
  let payload = {};
  try { payload = await req.json(); } catch (_) {}

  const u = payload && payload.user;
  if (u && u.email) {
    try {
      // Deploy 237.153 — merge, don't overwrite: a profile can already exist
      // before the first signup event (the team calendar seed fills start
      // dates by name), and a blind write threw those away.
      const store = getStore({ name: 'profiles', consistency: 'strong' });
      const key = keySafe(normalizeEmail(u.email));
      let existing = null;
      try { existing = await store.get(key, { type: 'json' }); } catch (_) { /* treat as new */ }
      const profile = mergeIdentityProfile(existing, u, { lastSeen: false });
      if (!profile.confirmed_at) profile.confirmed_at = new Date().toISOString();
      await store.setJSON(key, profile);
    } catch (e) {
      console.warn('identity-signup profile write failed:', e);
    }
  }

  return new Response('{}', {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
