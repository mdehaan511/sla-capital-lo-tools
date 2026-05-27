/**
 * brokers-find.mjs — GET /api/brokers-find?email=X
 *
 * Deploy 236 (Brokers Phase 1). Lookup helper used by:
 *   - Phase 2 sizer autocomplete — "do we already have a broker with
 *     this email?" without paginating the whole list.
 *   - Phase 5 migration — bind legacy inline brokerEmail to a real
 *     broker record.
 *
 * Searches the caller's own broker book (or, with admin override,
 * another LO's). Returns the first email match or null.
 *
 * Response: { broker: <record> | null }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const email = String(url.searchParams.get('email') || '').toLowerCase().trim();
  if (!email) return json(400, { error: 'email required' });

  // Owner — default to caller; admins can pass ?owner= to look up
  // another LO's broker.
  let owner = normalizeEmail(user.email);
  const ownerOverride = url.searchParams.get('owner');
  if (ownerOverride && isAdmin(user)) owner = normalizeEmail(ownerOverride);
  const ownerKey = keySafe(owner);

  const store = getStore({ name: 'brokers', consistency: 'strong' });
  try {
    const { blobs } = await store.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const rec = await store.get(key, { type: 'json' });
      if (rec && (rec.email || '').toLowerCase() === email) {
        return json(200, { broker: rec });
      }
    }
    return json(200, { broker: null });
  } catch (e) {
    console.error('brokers-find error:', e);
    return json(500, { error: 'Failed to search brokers' });
  }
};
