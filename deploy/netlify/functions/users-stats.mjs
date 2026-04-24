/**
 * users-stats.mjs — GET /api/users-stats
 *
 * Admin-only. Returns an array of users, each annotated with:
 *   - clientCount: number of client records owned by this user
 *   - quoteCount:  number of saved quotes owned by this user
 *   - totalLoanAmount: sum of loanAmt from the user's quotes (best-effort)
 *
 * Sources:
 *   - User roster from Netlify Identity admin API (via context.identity)
 *   - Client and quote counts from the Blobs stores (by key prefix)
 *
 * Storage keys use the user's *email* as the prefix (see clients-save /
 * quotes-save). We match to Identity users by normalized email.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  // 1) Fetch user roster from Identity Admin API
  const identity = context && context.clientContext && context.clientContext.identity;
  if (!identity || !identity.url || !identity.token) {
    return json(500, { error: 'Identity context unavailable' });
  }

  let identityUsers = [];
  try {
    let page = 1;
    for (;;) {
      const url = `${identity.url}/admin/users?per_page=50&page=${page}`;
      const resp = await fetch(url, { headers: { Authorization: `Bearer ${identity.token}` } });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => '');
        return json(resp.status, { error: `Identity API ${resp.status}: ${txt.slice(0, 200)}` });
      }
      const data = await resp.json();
      const users = Array.isArray(data.users) ? data.users : [];
      identityUsers.push(...users);
      if (users.length < 50) break;
      page += 1;
      if (page > 20) break;
    }
  } catch (e) {
    console.error('users-stats identity error:', e);
    return json(500, { error: 'Failed to list users' });
  }

  // 2) Walk the clients store and count per-owner-key
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientCounts = {}; // ownerKey -> count
  try {
    const { blobs } = await clientsStore.list();
    for (const { key } of blobs) {
      const idx = key.indexOf('/');
      if (idx < 0) continue;
      const ownerKey = key.slice(0, idx);
      clientCounts[ownerKey] = (clientCounts[ownerKey] || 0) + 1;
    }
  } catch (e) {
    console.warn('users-stats clients list failed:', e);
  }

  // 3) Walk the quotes store, count and sum loan amounts
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  const quoteCounts = {};      // ownerKey -> count
  const quoteLoanSums = {};    // ownerKey -> sum
  try {
    const { blobs } = await quotesStore.list();
    // Need the quote body to sum loan amounts — fetch each one.
    // At the scale of ~6–20 users × ~dozens of quotes each, this is cheap.
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
      } catch (_) { /* ignore individual failures */ }
    }));
  } catch (e) {
    console.warn('users-stats quotes list failed:', e);
  }

  // 4) Join everything. Match on normalized-email → keySafe(email).
  const annotated = identityUsers.map((u) => {
    const ownerKey = keySafe(normalizeEmail(u.email || ''));
    const roles = (u.app_metadata && (Array.isArray(u.app_metadata.roles)
      ? u.app_metadata.roles
      : (u.app_metadata.roles ? [u.app_metadata.roles] : ['user']))) || ['user'];
    return {
      id: u.id,
      email: u.email,
      fullName: (u.user_metadata && u.user_metadata.full_name) || '',
      confirmed_at: u.confirmed_at || null,
      last_sign_in_at: u.last_sign_in_at || null,
      roles,
      clientCount: clientCounts[ownerKey] || 0,
      quoteCount:  quoteCounts[ownerKey] || 0,
      totalLoanAmount: quoteLoanSums[ownerKey] || 0,
    };
  });

  // Sort: super_admin first, then admin, then user; within a role, alpha by email
  const roleOrder = { super_admin: 0, admin: 1, user: 2 };
  annotated.sort((a, b) => {
    const aR = (a.roles[0] || 'user'), bR = (b.roles[0] || 'user');
    const aO = roleOrder[aR] !== undefined ? roleOrder[aR] : 2;
    const bO = roleOrder[bR] !== undefined ? roleOrder[bR] : 2;
    if (aO !== bO) return aO - bO;
    return (a.email || '').localeCompare(b.email || '');
  });

  // 5) Any "orphan" storage prefixes that don't match a current user?
  //    (e.g. clients that were saved under an email for a user who was later
  //    deleted.) Report them so data isn't silently hidden.
  const knownKeys = new Set(annotated.map((u) => keySafe(normalizeEmail(u.email || ''))));
  const orphanKeys = new Set();
  Object.keys(clientCounts).forEach((k) => { if (!knownKeys.has(k)) orphanKeys.add(k); });
  Object.keys(quoteCounts).forEach((k) => { if (!knownKeys.has(k)) orphanKeys.add(k); });
  const orphans = Array.from(orphanKeys).map((k) => ({
    ownerKey: k,
    clientCount: clientCounts[k] || 0,
    quoteCount:  quoteCounts[k]  || 0,
    totalLoanAmount: quoteLoanSums[k] || 0,
  }));

  return json(200, { users: annotated, orphans });
};

// Parse "1,250,000" / "$1250000" / 1250000 → number, or 0 on failure.
function parseMoney(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' && isFinite(v)) return v;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}
