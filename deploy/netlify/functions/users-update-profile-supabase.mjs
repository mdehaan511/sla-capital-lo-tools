/**
 * users-update-profile-supabase.mjs — POST /api/users-update-profile-supabase
 *
 * Deploy 236.579 — admin edit of a user's DISPLAY profile: full name + phone.
 * Updates the Supabase user's user_metadata via the Auth Admin API AND mirrors
 * to our `profiles` blob (the source of truth for the users directory, admin
 * views, and the Proof-of-Funds letter's LO phone).
 *
 * Body: { userId, fullName?, phone? }  (at least one of fullName / phone)
 *
 * NOTE: email is intentionally NOT editable here. An LO's email is the ownership
 * key — every one of their loans/clients/grants is stored under keySafe(email).
 * Changing it would orphan all of them, so a real email change is a separate,
 * deliberate re-owning migration, not a profile edit.
 *
 * Auth: admin (admin / super_admin).
 * Response 200: { ok, user: { id, email, fullName, phone } }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { supabaseBaseUrl } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const caller = await requireAuth(context, req);
  if (!caller) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(caller)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  const userId = String((body && body.userId) || '').trim();
  if (!userId) return json(400, { error: 'userId required' });

  const hasName  = typeof body.fullName === 'string';
  const hasPhone = typeof body.phone === 'string';
  if (!hasName && !hasPhone) return json(400, { error: 'Provide fullName and/or phone' });
  const fullName = hasName  ? body.fullName.trim().slice(0, 120) : undefined;
  const phone    = hasPhone ? body.phone.trim().slice(0, 40)     : undefined;

  const SUPABASE_URL = supabaseBaseUrl();
  const SVC = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_URL || !SVC) return json(500, { error: 'Supabase env vars not configured' });
  const base = String(SUPABASE_URL).replace(/\/+$/, '');

  try {
    // Look up the target so we preserve the rest of user_metadata + get email.
    const lookupResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC },
    });
    if (!lookupResp.ok) {
      const txt = await lookupResp.text().catch(() => '');
      return json(lookupResp.status, { error: 'Supabase lookup ' + lookupResp.status + ': ' + txt.slice(0, 300) });
    }
    const target = await lookupResp.json();
    const email = normalizeEmail(target && target.email);
    const existingUm = (target && target.user_metadata) || {};

    const mergedUm = Object.assign({}, existingUm);
    if (fullName !== undefined) mergedUm.full_name = fullName;
    if (phone    !== undefined) mergedUm.phone     = phone;

    const putResp = await fetch(base + '/auth/v1/admin/users/' + encodeURIComponent(userId), {
      method: 'PUT',
      headers: { 'apikey': SVC, 'Authorization': 'Bearer ' + SVC, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_metadata: mergedUm }),
    });
    if (!putResp.ok) {
      const txt = await putResp.text().catch(() => '');
      return json(putResp.status, { error: 'Supabase update ' + putResp.status + ': ' + txt.slice(0, 300) });
    }

    // Mirror to the profiles blob (directory / admin / POF read from here).
    if (email) {
      try {
        const store = getStore({ name: 'profiles', consistency: 'strong' });
        const profileKey = keySafe(email);
        let profile = null;
        try { profile = await store.get(profileKey, { type: 'json' }); } catch (_) {}
        if (!profile) {
          profile = { id: userId, email, fullName: '', roles: [], confirmed_at: null, user_metadata: {} };
        }
        if (fullName !== undefined) profile.fullName = fullName;
        if (phone    !== undefined) profile.phone = phone;
        profile.user_metadata = Object.assign({}, profile.user_metadata || {}, mergedUm);
        profile.last_seen_at = new Date().toISOString();
        await store.setJSON(profileKey, profile);
      } catch (e) {
        console.warn('users-update-profile-supabase: profile blob mirror failed (auth updated):', e && e.message);
      }
    }

    return json(200, {
      ok: true,
      user: {
        id: userId,
        email,
        fullName: fullName !== undefined ? fullName : (existingUm.full_name || ''),
        phone:    phone    !== undefined ? phone    : (existingUm.phone || ''),
      },
    });
  } catch (e) {
    console.error('users-update-profile-supabase error:', e);
    return json(500, { error: 'Failed to update profile: ' + ((e && e.message) || 'unknown') });
  }
};
