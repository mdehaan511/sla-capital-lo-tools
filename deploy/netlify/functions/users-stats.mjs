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

  // 1b) Deploy 236.23 — fetch live Netlify Identity user emails so we
  // can flag profiles whose Identity record has been deleted. Profiles
  // for deleted users still carry historical stats, but the UI hides
  // them from active LO dropdowns and groups them under a collapsible
  // "Deleted Users" section in User Activity.
  const liveIdentityEmails = new Set();
  let identityFetchOk = false;
  try {
    const identity = context && context.clientContext && context.clientContext.identity;
    if (identity && identity.url && identity.token) {
      let page = 1;
      for (;;) {
        const url = `${identity.url}/admin/users?per_page=50&page=${page}`;
        const resp = await fetch(url, { headers: { Authorization: `Bearer ${identity.token}` } });
        if (!resp.ok) break;
        const data = await resp.json();
        const users = Array.isArray(data.users) ? data.users : [];
        users.forEach((u) => { if (u.email) liveIdentityEmails.add(String(u.email).toLowerCase().trim()); });
        if (users.length < 50) break;
        page += 1;
        if (page > 20) break; // safety cap (1000 users)
      }
      identityFetchOk = true;
    }
  } catch (e) {
    console.warn('users-stats identity fetch failed (deleted-user flag unavailable):', e);
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

  // 2b) Walk prospects store for counts (used for conversion rates)
  const prospectsStore = getStore({ name: 'prospects', consistency: 'strong' });
  const prospectCounts = {};
  try {
    const { blobs } = await prospectsStore.list();
    for (const { key } of blobs) {
      const idx = key.indexOf('/');
      if (idx < 0) continue;
      prospectCounts[key.slice(0, idx)] = (prospectCounts[key.slice(0, idx)] || 0) + 1;
    }
  } catch (e) {
    console.warn('users-stats prospects list failed:', e);
  }

  // 3) Walk quotes store for counts, loan-amount sums, and per-status rollups.
  //
  // IMPORTANT for conversion rates: counts are CUMULATIVE — a closed loan
  // counts toward submittedCount, approvedCount, AND closedCount because it
  // passed through every stage. A loan currently in "approved" counts toward
  // both submittedCount and approvedCount.
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  const quoteCounts        = {};
  const quoteLoanSums      = {};
  const submittedCounts    = {};
  const approvedCounts     = {};
  const closedCounts       = {};
  const closedVolumes      = {};
  const totalCommissions   = {};
  // For avg loan size on closed loans, we need both sum and count (already have both)
  try {
    const { blobs } = await quotesStore.list();
    await Promise.all(blobs.map(async ({ key }) => {
      const idx = key.indexOf('/');
      if (idx < 0) return;
      const ownerKey = key.slice(0, idx);
      quoteCounts[ownerKey] = (quoteCounts[ownerKey] || 0) + 1;
      try {
        const q = await quotesStore.get(key, { type: 'json' });
        if (!q) return;
        const status = q.status || 'active';
        const fd = q.formData || {};
        const amt = parseMoney(fd.loanAmt || fd.purchasePrice || q.loanAmt);
        if (amt > 0) quoteLoanSums[ownerKey] = (quoteLoanSums[ownerKey] || 0) + amt;

        // Cumulative stage counts. The pipeline goes:
        //   active → submitted → approved → closed
        //                     ↘ on_hold
        //                     ↘ denied
        // A closed loan was once approved, was once submitted, was once active.
        // An on_hold or denied loan was once submitted (admin reviewed it).
        const reachedSubmitted = ['submitted','awaiting_app','approved','closed','on_hold','denied'].includes(status);
        const reachedApproved  = ['awaiting_app','approved','closed'].includes(status);
        const reachedClosed    = status === 'closed';

        if (reachedSubmitted) submittedCounts[ownerKey] = (submittedCounts[ownerKey] || 0) + 1;
        if (reachedApproved)  approvedCounts[ownerKey]  = (approvedCounts[ownerKey]  || 0) + 1;
        if (reachedClosed) {
          closedCounts[ownerKey] = (closedCounts[ownerKey] || 0) + 1;
          const finalAmt = Number(q.finalLoanAmount) || amt;
          if (finalAmt > 0) closedVolumes[ownerKey] = (closedVolumes[ownerKey] || 0) + finalAmt;
          const commission = Number(q.commissionAmount) || 0;
          if (commission > 0) totalCommissions[ownerKey] = (totalCommissions[ownerKey] || 0) + commission;
        }
      } catch (_) { /* skip */ }
    }));
  } catch (e) {
    console.warn('users-stats quotes list failed:', e);
  }

  // Helpers
  function rate(num, den) {
    if (!den || den === 0) return null; // null means "no data" rather than 0%
    return Math.round((num / den) * 100);
  }
  function avg(sum, count) {
    if (!count || count === 0) return 0;
    return Math.round(sum / count);
  }

  // 4) Annotate each profile with stats
  const annotated = profiles.map((p) => {
    const ownerKey = keySafe(normalizeEmail(p.email || ''));
    const prospectCount  = prospectCounts[ownerKey]  || 0;
    const quoteCount     = quoteCounts[ownerKey]     || 0;
    const submittedCount = submittedCounts[ownerKey] || 0;
    const approvedCount  = approvedCounts[ownerKey]  || 0;
    const closedCount    = closedCounts[ownerKey]    || 0;
    const closedVolume   = closedVolumes[ownerKey]   || 0;
    // Deploy 236.23 — `deleted` is true when the profile's email is NOT
    // in the live Netlify Identity user set. Only meaningful when the
    // identity fetch succeeded; if it didn't, default to false so the
    // UI doesn't accidentally hide everyone.
    const normEmail = String(p.email || '').toLowerCase().trim();
    const deleted = identityFetchOk && normEmail && !liveIdentityEmails.has(normEmail);
    return {
      id: p.id || null,
      email: p.email,
      deleted,
      fullName: p.fullName || '',
      confirmed_at: p.confirmed_at || null,
      last_seen_at: p.last_seen_at || null,
      roles: Array.isArray(p.roles) && p.roles.length ? p.roles : ['user'],
      clientCount:    clientCounts[ownerKey] || 0,
      prospectCount,
      quoteCount,
      submittedCount,
      approvedCount,
      closedCount,
      totalLoanAmount: quoteLoanSums[ownerKey] || 0,
      closedVolume,
      totalCommission: totalCommissions[ownerKey] || 0,
      // Conversion rates (percent integers, or null if denominator is 0)
      conversion: {
        prospectToQuoted:    rate(quoteCount,     prospectCount + quoteCount), // prospect either becomes a quote or stays a prospect
        quotedToSubmitted:   rate(submittedCount, quoteCount),
        submittedToApproved: rate(approvedCount,  submittedCount),
        approvedToClosed:    rate(closedCount,    approvedCount),
        // Overall funnel: prospect → closed
        prospectToClosed:    rate(closedCount,    prospectCount + quoteCount),
      },
      // Average loan size of closed loans
      avgClosedLoanSize: avg(closedVolume, closedCount),
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
    const prospectCount  = prospectCounts[k]  || 0;
    const quoteCount     = quoteCounts[k]     || 0;
    const submittedCount = submittedCounts[k] || 0;
    const approvedCount  = approvedCounts[k]  || 0;
    const closedCount    = closedCounts[k]    || 0;
    const closedVolume   = closedVolumes[k]   || 0;
    // Deploy 236.23 — an orphan ALWAYS counts as deleted from an
    // Identity standpoint (we have data but no profile and no Identity
    // record). Even if the identity fetch failed we treat orphans as
    // deleted; their absence from Identity is a stronger signal than a
    // network blip on the listing.
    annotated.push({
      id: null,
      email: k.replace(/_/g, '.'),
      deleted: true,
      fullName: '',
      confirmed_at: null,
      last_seen_at: null,
      roles: ['user'],
      clientCount: clientCounts[k] || 0,
      prospectCount,
      quoteCount,
      submittedCount,
      approvedCount,
      closedCount,
      totalLoanAmount: quoteLoanSums[k] || 0,
      closedVolume,
      totalCommission: totalCommissions[k] || 0,
      conversion: {
        prospectToQuoted:    rate(quoteCount,     prospectCount + quoteCount),
        quotedToSubmitted:   rate(submittedCount, quoteCount),
        submittedToApproved: rate(approvedCount,  submittedCount),
        approvedToClosed:    rate(closedCount,    approvedCount),
        prospectToClosed:    rate(closedCount,    prospectCount + quoteCount),
      },
      avgClosedLoanSize: avg(closedVolume, closedCount),
      userMetadata: {},
      isOrphan: true,
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
    // Deploy 236.23 — when identityFetchOk is false the `deleted` flag
    // on profiles falls back to false (only orphans get flagged). The
    // UI can show a warning if needed.
    identityFetchOk,
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
