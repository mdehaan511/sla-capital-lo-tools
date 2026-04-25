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

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  // 1) Fetch user roster from Identity Admin API.
  //
  // Strategy 1 (preferred): use context.clientContext.identity if present —
  //   that's a per-request scoped admin token Netlify provides for free.
  //   In modern .mjs functions, this is often NOT populated.
  //
  // Strategy 2 (fallback): use a Personal Access Token (NETLIFY_AUTH_TOKEN env)
  //   and the site URL (auto-injected as URL env var) to hit the GoTrue
  //   admin endpoint at https://yoursite.netlify.app/.netlify/identity/admin/users
  let identityUrl = '';
  let identityToken = '';
  const cc = context && context.clientContext;
  if (cc && cc.identity && cc.identity.url && cc.identity.token) {
    identityUrl = cc.identity.url;
    identityToken = cc.identity.token;
  } else if (process.env.NETLIFY_AUTH_TOKEN && process.env.URL) {
    // Build from the site URL Netlify auto-sets in functions
    identityUrl = process.env.URL.replace(/\/$/, '') + '/.netlify/identity';
    identityToken = process.env.NETLIFY_AUTH_TOKEN;
  }

  let identityUsers = [];
  if (identityUrl && identityToken) {
    try {
      let page = 1;
      for (;;) {
        const url = `${identityUrl}/admin/users?per_page=50&page=${page}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${identityToken}` } });
        if (!resp.ok) {
          console.warn(`users-stats identity API ${resp.status}`);
          break;
        }
        const data = await resp.json();
        const users = Array.isArray(data.users) ? data.users : [];
        identityUsers.push(...users);
        if (users.length < 50) break;
        page += 1;
        if (page > 20) break;
      }
    } catch (e) {
      console.warn('users-stats identity error:', e);
    }
  } else {
    console.warn('users-stats: no Identity admin token available — set NETLIFY_AUTH_TOKEN env var');
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

    // Name can live in a few places depending on how the user was created:
    //   - user_metadata.full_name   (widget-set display name)
    //   - user_metadata.name        (some flows use this key)
    //   - raw_user_meta_data        (GoTrue internal field on older accounts)
    //   - firstName/lastName pair   (if client code ever set it)
    const meta = u.user_metadata || {};
    const raw  = u.raw_user_meta_data || {};
    let fullName =
      meta.full_name ||
      meta.fullName ||
      meta.name     ||
      raw.full_name ||
      raw.name      ||
      '';
    if (!fullName && (meta.firstName || meta.lastName)) {
      fullName = ((meta.firstName || '') + ' ' + (meta.lastName || '')).trim();
    }

    return {
      id: u.id,
      email: u.email,
      fullName,
      userMetadata: meta, // raw — so admin UI can inspect if name extraction missed something
      confirmed_at: u.confirmed_at || null,
      last_sign_in_at: u.last_sign_in_at || null,
      roles,
      clientCount: clientCounts[ownerKey] || 0,
      quoteCount:  quoteCounts[ownerKey] || 0,
      totalLoanAmount: quoteLoanSums[ownerKey] || 0,
    };
  });

  // 5) Any "orphan" storage prefixes that don't match a current user?
  //    When Identity is unreachable, identityUsers is empty and *all* prefixes
  //    become orphans. Treat them as real rows (with ownerKey as email) so
  //    the admin still sees stats.
  const knownKeys = new Set(annotated.map((u) => keySafe(normalizeEmail(u.email || ''))));
  const orphanKeys = new Set();
  Object.keys(clientCounts).forEach((k) => { if (!knownKeys.has(k)) orphanKeys.add(k); });
  Object.keys(quoteCounts).forEach((k) => { if (!knownKeys.has(k)) orphanKeys.add(k); });

  const identityUnavailable = identityUsers.length === 0;
  const orphans = [];
  for (const k of orphanKeys) {
    const entry = {
      ownerKey: k,
      clientCount: clientCounts[k] || 0,
      quoteCount:  quoteCounts[k]  || 0,
      totalLoanAmount: quoteLoanSums[k] || 0,
    };
    if (identityUnavailable) {
      // Promote to a pseudo-user row so the admin sees their activity
      annotated.push({
        id: null,
        email: k.replace(/_/g, '.') || k, // best-effort pretty email from key
        fullName: '',
        confirmed_at: null,
        last_sign_in_at: null,
        roles: ['user'],
        clientCount: entry.clientCount,
        quoteCount:  entry.quoteCount,
        totalLoanAmount: entry.totalLoanAmount,
      });
    } else {
      orphans.push(entry);
    }
  }

  // Sort: super_admin first, then admin, then user; within a role, alpha by email
  const roleOrder = { super_admin: 0, admin: 1, user: 2 };
  annotated.sort((a, b) => {
    const aR = (a.roles[0] || 'user'), bR = (b.roles[0] || 'user');
    const aO = roleOrder[aR] !== undefined ? roleOrder[aR] : 2;
    const bO = roleOrder[bR] !== undefined ? roleOrder[bR] : 2;
    if (aO !== bO) return aO - bO;
    return (a.email || '').localeCompare(b.email || '');
  });

  return json(200, { users: annotated, orphans, identityUnavailable });
};

// Parse "1,250,000" / "$1250000" / 1250000 → number, or 0 on failure.
function parseMoney(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' && isFinite(v)) return v;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}
