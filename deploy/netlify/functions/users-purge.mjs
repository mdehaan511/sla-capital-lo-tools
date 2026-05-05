/**
 * users-purge.mjs — POST /api/users-purge
 *
 * Super-admin only. Removes a user's PROFILE BLOB from the `profiles` store
 * so they stop appearing in the user roster (used by the LO filter dropdown,
 * pipeline LO labels, profile activity table, etc.).
 *
 * IMPORTANT: This does NOT delete the actual Netlify Identity account.
 * Identity is managed by Netlify; the account must be deleted in the
 * Netlify dashboard separately. This endpoint only cleans up our own
 * derived profile metadata.
 *
 * Body: { email, force?: boolean }
 *   - email: the email of the user whose profile should be purged
 *   - force: if false (default), the endpoint refuses to purge a profile
 *     that still has owned data (clients, quotes, prospects, etc).
 *     The user should run users-reassign FIRST to move the data, then
 *     purge with force not needed. If force=true, profile is removed
 *     regardless — useful when an email is a typo and never had real data.
 *
 * Returns:
 *   200 { ok: true, profilePurged: true, dataCounts: {...} }
 *   400 if the user still owns data and force is false
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isSuperAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

const DATA_STORES = ['clients', 'quotes', 'prospects', 'reminders', 'borrower_info'];

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const user = requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

    const body = await readJsonBody(req);
    if (!body || !body.email) return json(400, { error: 'email required' });

    const targetEmail = normalizeEmail(body.email);
    const force = !!body.force;

    // Don't let an admin accidentally purge themselves
    if (targetEmail === normalizeEmail(user.email)) {
      return json(400, { error: 'Cannot purge your own profile' });
    }

    const targetKey = keySafe(targetEmail);

    // Count owned data so we can refuse-or-warn
    const dataCounts = {};
    let totalOwned = 0;
    for (const storeName of DATA_STORES) {
      try {
        const store = getStore({ name: storeName, consistency: 'strong' });
        const { blobs } = await store.list({ prefix: `${targetKey}/` });
        dataCounts[storeName] = blobs.length;
        totalOwned += blobs.length;
      } catch (e) {
        dataCounts[storeName] = -1; // sentinel for "list failed"
        console.warn(`users-purge: list ${storeName} failed:`, e && e.message);
      }
    }

    if (totalOwned > 0 && !force) {
      return json(400, {
        error: 'User still owns data. Reassign first or set force:true.',
        dataCounts,
        totalOwned,
      });
    }

    // Delete the profile blob
    let profilePurged = false;
    try {
      const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
      // delete() doesn't throw if the key doesn't exist — but we want to
      // surface "no such profile" so the caller knows nothing happened.
      const existing = await profilesStore.get(targetKey, { type: 'json' });
      if (existing) {
        await profilesStore.delete(targetKey);
        profilePurged = true;
      }
    } catch (e) {
      console.error('users-purge profile delete failed:', e);
      return json(500, { error: 'Failed to delete profile blob: ' + (e.message || 'unknown') });
    }

    return json(200, {
      ok: true,
      email: targetEmail,
      profilePurged,
      dataCounts,
      totalOwned,
      note: profilePurged
        ? 'Profile blob removed. The Netlify Identity account (if any) must still be deleted in the Netlify dashboard.'
        : 'No profile blob existed for this email — nothing to remove.',
    });
  } catch (e) {
    console.error('users-purge error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};
