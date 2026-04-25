/**
 * users-stats.mjs — GET /api/users-stats
 *
 * Admin-only. Returns a per-user roster annotated with:
 *   - clientCount: number of client records owned by the user
 *   - quoteCount:  number of saved quotes owned by the user
 *   - totalLoanAmount: sum of loanAmt from the user's quotes
 *
 * Sources (no Identity admin API needed):
 *   - User roster: the `profiles` Blobs store, populated by
 *     identity-login / identity-signup event handlers and by
 *     profile-ping (called from the frontend on page load).
 *   - Counts: walk the `clients` and `quotes` Blobs stores by prefix.
 *
 * Users who haven't logged in since profile-tracking was added will
 * appear as "orphan" entries (we know they have data, but no profile).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  // 1) Load all profiles from the `profiles` blobs store
  const profilesStore = getStore({ name: 'profiles', consistency: 'strong' });
  const profiles = [];
  try {
    const { blobs } = await profilesStore.list();
    await Promise.all(blobs.map(async ({ key }) => {
      const p = await profilesStore.get(key, { type: 'json' });
      if (p) profiles.push(p);
    }));
  } catch (e) {
    console.warn('users-stats profiles list failed:', e);
  }

  // 2) Walk clients store for counts per owner-key
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientCounts = {};
  try {
    const { blobs } = await clientsStore.list();
    for (const { key } of blobs) {
      const idx = key.indexOf('/');
      if (idx < 0) continue;
      clientCounts[key.slice(0, idx)] = (clientCounts[key.slice(0, idx)] || 0) + 1;
    }
  } catch (e) {
    console.warn('users-stats clients list failed:', e);
  }

  // 3) Walk quotes store for counts and loan-amount sums
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  const quoteCounts = {};
  const quoteLoanSums = {};
  try {
    const { blobs } = await quotesStore.list();
    await Promise.all(blobs.map(async ({ key }) => {
      const idx = key.indexOf('/');
      if (idx < 0) return;
      const ownerKey = key.slice(0, idx);
      quoteCounts[ownerKey] = (quoteCounts[ownerKey] || 0) + 1;
      try {
        const q = await quotesStore.get(key, { type: 'json' });
        if (q) {
          const n = parseMoney(q.loanAmt);
          if (n > 0) quoteLoanSums[ownerKey] = (quoteLoanSums[ownerKey] || 0) + n;
        }
      } catch (_) { /* skip */ }
    }));
  } catch (e) {
    console.warn('users-stats quotes list failed:', e);
  }

  // 4) Annotate each profile with stats
  const annotated = profiles.map((p) => {
    const ownerKey = keySafe(normalizeEmail(p.email || ''));
    return {
      id: p.id || null,
      email: p.email,
      fullName: p.fullName || '',
      confirmed_at: p.confirmed_at || null,
      last_seen_at: p.last_seen_at || null,
      roles: Array.isArray(p.roles) && p.roles.length ? p.roles : ['user'],
      clientCount: clientCounts[ownerKey] || 0,
      quoteCount:  quoteCounts[ownerKey] || 0,
      totalLoanAmount: quoteLoanSums[ownerKey] || 0,
      userMetadata: p.user_metadata || {},
    };
  });

  // 5) Orphan storage prefixes (users with data but no profile entry)
  const knownKeys = new Set(annotated.map((u) => keySafe(normalizeEmail(u.email))));
  const orphanKeys = new Set();
  Object.keys(clientCounts).forEach((k) => { if (!knownKeys.has(k)) orphanKeys.add(k); });
  Object.keys(quoteCounts).forEach((k) => { if (!knownKeys.has(k)) orphanKeys.add(k); });

  // Promote orphans to entries so admin can still see their activity
  for (const k of orphanKeys) {
    annotated.push({
      id: null,
      email: k.replace(/_/g, '.'), // best-effort — storage key isn't reversible
      fullName: '',
      confirmed_at: null,
      last_seen_at: null,
      roles: ['user'],
      clientCount: clientCounts[k] || 0,
      quoteCount:  quoteCounts[k]  || 0,
      totalLoanAmount: quoteLoanSums[k] || 0,
      userMetadata: {},
      isOrphan: true, // UI hint: this user hasn't logged in since profile tracking started
    });
  }

  // Sort: super_admin first, then admin, then user; alpha by email within
  const roleOrder = { super_admin: 0, admin: 1, user: 2 };
  annotated.sort((a, b) => {
    const aR = (a.roles[0] || 'user'), bR = (b.roles[0] || 'user');
    const aO = roleOrder[aR] !== undefined ? roleOrder[aR] : 2;
    const bO = roleOrder[bR] !== undefined ? roleOrder[bR] : 2;
    if (aO !== bO) return aO - bO;
    return (a.email || '').localeCompare(b.email || '');
  });

  return json(200, {
    users: annotated,
    profileCount: profiles.length,
    note: profiles.length === 0
      ? 'No profiles stored yet. Log in once to populate your profile, then existing users will need to log in too.'
      : undefined,
  });
};

function parseMoney(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' && isFinite(v)) return v;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}
