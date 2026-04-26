/**
 * profile-update.mjs — POST /api/profile-update
 *
 * Update the authenticated user's own profile fields (full_name, phone).
 * Writes to Netlify Identity user_metadata via the admin API
 * (NETLIFY_AUTH_TOKEN required), then mirrors to our `profiles` Blobs
 * store so other pages see the new values immediately.
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

  const user = requireAuth(context, req);
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

  // Resolve Identity admin URL + token
  let identityUrl = '';
  let identityToken = '';
  const cc = context && context.clientContext;
  if (cc && cc.identity && cc.identity.url && cc.identity.token) {
    identityUrl = cc.identity.url;
    identityToken = cc.identity.token;
  } else if (process.env.NETLIFY_AUTH_TOKEN && process.env.URL) {
    identityUrl = process.env.URL.replace(/\/$/, '') + '/.netlify/identity';
    identityToken = process.env.NETLIFY_AUTH_TOKEN;
  } else {
    return json(500, { error: 'Identity admin token not configured (set NETLIFY_AUTH_TOKEN env var)' });
  }

  // PUT to Identity admin to merge user_metadata
  try {
    // First fetch current user_metadata so we don't clobber other fields
    const getResp = await fetch(`${identityUrl}/admin/users/${encodeURIComponent(user.sub)}`, {
      headers: { Authorization: `Bearer ${identityToken}` },
    });
    let currentMeta = (user.user_metadata || {});
    if (getResp.ok) {
      const currentUser = await getResp.json();
      if (currentUser && currentUser.user_metadata) currentMeta = currentUser.user_metadata;
    }

    const merged = Object.assign({}, currentMeta, updates);

    const putResp = await fetch(`${identityUrl}/admin/users/${encodeURIComponent(user.sub)}`, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${identityToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_metadata: merged }),
    });

    if (!putResp.ok) {
      const txt = await putResp.text().catch(() => '');
      return json(putResp.status, { error: `Identity API ${putResp.status}: ${txt.slice(0, 200)}` });
    }
  } catch (e) {
    console.error('profile-update identity write failed:', e);
    return json(500, { error: 'Failed to update Identity profile' });
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
    console.warn('profile-update mirror failed (non-fatal):', e);
  }

  return json(200, { ok: true, updated: updates });
};
