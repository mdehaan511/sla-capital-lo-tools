/**
 * leaderboard.mjs — GET /api/leaderboard
 *
 * Deploy 236.167 — Loan Officer leaderboard powering the right column
 * of the redesigned home page. Returns one row per LO with:
 *
 *   fullName        Display name (falls back to email)
 *   email           Canonical email
 *   clientCount     # of clients they own
 *   quoteCount      # of saved quotes (any status)
 *   approvedCount   # of loans that reached approved/awaiting_app/closed
 *   pendingVolume   sum of loanAmt for loans currently "In Processing"
 *                   (status = approved or awaiting_app)
 *   closedVolume    sum of finalLoanAmount (or loanAmt) for closed loans
 *
 * Auth: requireAuth. Any signed-in user can see the leaderboard —
 * it's for team gamification, not admin analytics. The deeper admin
 * view (conversion rates, commissions, deleted flags) still lives
 * behind users-stats.mjs which is admin-only.
 *
 * Sort is done client-side; this endpoint returns the raw rows.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

    const user = requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });

    // 1) Profile roster (for display names).
    const profilesStore = getStore({ name: 'profiles', consistency: 'eventual' });
    const profiles = [];
    try {
      const { blobs } = await profilesStore.list();
      await Promise.all(blobs.map(async ({ key }) => {
        const p = await profilesStore.get(key, { type: 'json' });
        if (p && p.email) profiles.push(p);
      }));
    } catch (e) {
      console.warn('leaderboard: profiles list failed:', e && e.message);
    }

    // 2) Clients per owner (prefix walk — key format: <ownerKey>/<clientId>).
    const clientsStore = getStore({ name: 'clients', consistency: 'eventual' });
    const clientCounts = {};
    try {
      const { blobs } = await clientsStore.list();
      for (const { key } of blobs) {
        const idx = key.indexOf('/');
        if (idx < 0) continue;
        const ownerKey = key.slice(0, idx);
        clientCounts[ownerKey] = (clientCounts[ownerKey] || 0) + 1;
      }
    } catch (e) {
      console.warn('leaderboard: clients list failed:', e && e.message);
    }

    // 3) Quotes per owner with per-status rollups. Cumulative counts
    // (approved includes closed, etc.) mirror users-stats so the two
    // views agree.
    const quotesStore = getStore({ name: 'quotes', consistency: 'eventual' });
    const quoteCounts    = {};
    const approvedCounts = {};
    const pendingVolumes = {};
    const closedVolumes  = {};
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
          const amt = _parseMoney(fd.loanAmt || fd.purchasePrice || q.loanAmt);

          const reachedApproved = ['awaiting_app', 'approved', 'closed'].includes(status);
          const isPending       = ['approved', 'awaiting_app'].includes(status); // "In Processing"
          const isClosed        = status === 'closed';

          if (reachedApproved) approvedCounts[ownerKey] = (approvedCounts[ownerKey] || 0) + 1;
          if (isPending && amt > 0) {
            pendingVolumes[ownerKey] = (pendingVolumes[ownerKey] || 0) + amt;
          }
          if (isClosed) {
            const finalAmt = Number(q.finalLoanAmount) || amt;
            if (finalAmt > 0) closedVolumes[ownerKey] = (closedVolumes[ownerKey] || 0) + finalAmt;
          }
        } catch (_) { /* skip */ }
      }));
    } catch (e) {
      console.warn('leaderboard: quotes list failed:', e && e.message);
    }

    // 4) Assemble rows. Deploy 236.168 — filter out LOs with no
    // quoted loans OR who haven't logged in for 3+ weeks per Mike.
    // Orphans (activity but no profile record) get dropped too,
    // since we have no last_seen_at to test them against and they
    // clutter the leaderboard.
    const STALE_MS = 21 * 24 * 60 * 60 * 1000; // 3 weeks
    const nowMs = Date.now();
    const rows = [];
    const seenKeys = new Set();
    let hiddenNoQuotes = 0, hiddenStale = 0;
    profiles.forEach((p) => {
      const email = String(p.email || '').toLowerCase().trim();
      if (!email) return;
      const ownerKey = keySafe(normalizeEmail(email));
      seenKeys.add(ownerKey);
      const quoteCount = quoteCounts[ownerKey] || 0;
      if (quoteCount === 0) { hiddenNoQuotes++; return; }
      const lastSeenAt = p.last_seen_at || p.confirmed_at || '';
      const lastSeenMs = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
      if (!isFinite(lastSeenMs) || (nowMs - lastSeenMs) > STALE_MS) { hiddenStale++; return; }
      rows.push({
        fullName:      (p.fullName || p.full_name || '').trim() || _emailDisplay(email),
        email,
        clientCount:   clientCounts[ownerKey]    || 0,
        quoteCount,
        approvedCount: approvedCounts[ownerKey]  || 0,
        pendingVolume: pendingVolumes[ownerKey]  || 0,
        closedVolume:  closedVolumes[ownerKey]   || 0,
      });
    });
    // Orphans (activity without a profile) are intentionally
    // excluded — no last_seen_at to gate them. Their totals still
    // show up in the admin users-stats view.

    // Default sort: Closed Volume DESC (client can re-sort). Ties
    // break on Pending Volume then alphabetically by name.
    rows.sort((a, b) => {
      if (b.closedVolume  !== a.closedVolume)  return b.closedVolume  - a.closedVolume;
      if (b.pendingVolume !== a.pendingVolume) return b.pendingVolume - a.pendingVolume;
      return String(a.fullName || '').localeCompare(String(b.fullName || ''));
    });

    return json(200, { rows, hiddenNoQuotes, hiddenStale });
  } catch (e) {
    console.error('leaderboard top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function _parseMoney(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number' && isFinite(v)) return v;
  const cleaned = String(v).replace(/[$,\s]/g, '');
  const n = parseFloat(cleaned);
  return isFinite(n) ? n : 0;
}
function _emailDisplay(email) {
  const at = String(email || '').indexOf('@');
  return at > 0 ? email.slice(0, at) : email;
}
