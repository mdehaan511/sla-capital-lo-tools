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
import { mergeIdentityProfile } from './_shared/profile-record.mjs'; // Deploy 237.153

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
  // Deploy 237.153 (Chance: "Camelot asks me for my birthday every time I log
  // in"). This used to build a fresh object and setJSON it, which wiped every
  // app-owned field on the record — birthday, birthYear, startDate, avatar,
  // phone — on EVERY login. Read first, merge through the one shared rule.
  const store = getStore({ name: 'profiles', consistency: 'strong' });
  const key = keySafe(normalizeEmail(u.email));
  let existing = null;
  try { existing = await store.get(key, { type: 'json' }); } catch (_) { /* treat as new */ }
  await store.setJSON(key, mergeIdentityProfile(existing, u));
}
