/**
 * search.mjs — GET /api/search?q=...
 *
 * Searches the authenticated user's prospects, quotes, and clients for
 * matches in name, email, address. Admins searching with ?all=1 search
 * across every LO's data.
 *
 * Returns up to 8 results per category, ranked by recency within match.
 *
 * Response shape:
 *   {
 *     prospects: [{id, ownerKey, name, address, email, date, link}],
 *     quotes:    [{id, ownerKey, name, address, status, link, toolType}],
 *     clients:   [{id, ownerKey, name, email, link}]
 *   }
 *
 * Each `link` is a relative URL to the page where the user can see/work
 * on the result.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.170

const PER_CATEGORY = 8;

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const q = (url.searchParams.get('q') || '').trim().toLowerCase();
  const wantAll = url.searchParams.get('all') === '1' && canListAllClients(user).ok;

  if (q.length < 2) {
    return json(200, { prospects: [], quotes: [], clients: [], q });
  }

  const ownerKey = keySafe(normalizeEmail(user.email));
  const myEmail = (user.email || '').toLowerCase();

  // Build the set of prefixes to scan based on scope
  // For non-admins: only their own prefix (and legacy slugs for backwards compat)
  // For admins with all=1: every prefix
  const prospectsStore = getStore({ name: 'prospects', consistency: 'strong' });
  const quotesStore    = getStore({ name: 'quotes',    consistency: 'strong' });
  const clientsStore   = getStore({ name: 'clients',   consistency: 'strong' });

  // Build LO-email map for cross-owner prospect routing (admin scope)
  // and to know which LO a prospect belongs to so the link can target right
  let allOwnerKeys = null;
  if (wantAll) {
    allOwnerKeys = new Set();
    try {
      const { blobs } = await prospectsStore.list();
      for (const { key } of blobs) {
        const idx = key.indexOf('/');
        if (idx > 0) allOwnerKeys.add(key.slice(0, idx));
      }
      for (const { key } of (await quotesStore.list()).blobs) {
        const idx = key.indexOf('/');
        if (idx > 0) allOwnerKeys.add(key.slice(0, idx));
      }
    } catch (_) { /* fall through with empty set */ }
  }

  function matches(text) {
    if (!text) return false;
    return String(text).toLowerCase().includes(q);
  }

  // ── Search prospects ──
  const prospects = [];
  try {
    const prefixes = wantAll
      ? Array.from(allOwnerKeys || [])
      : await collectMyPrefixes(prospectsStore, user);
    for (const prefix of prefixes) {
      const { blobs } = await prospectsStore.list({ prefix: prefix + '/' });
      for (const { key } of blobs) {
        const p = await prospectsStore.get(key, { type: 'json' });
        if (!p) continue;
        const name = ((p.firstName || '') + ' ' + (p.lastName || '')).trim();
        if (matches(name) || matches(p.email) || matches(p.propAddress)) {
          prospects.push({
            id: p.id,
            ownerKey: prefix,
            name: name || p.email || 'Borrower',
            email: p.email || '',
            address: p.propAddress || '',
            date: p.submittedAt || '',
            link: 'pipeline.html', // single page; the prospect lives in the New Application column
          });
        }
        if (prospects.length >= PER_CATEGORY * 2) break;
      }
      if (prospects.length >= PER_CATEGORY * 2) break;
    }
  } catch (e) { console.warn('search prospects failed:', e); }

  // ── Search quotes ──
  const quotes = [];
  try {
    const prefixes = wantAll ? Array.from(allOwnerKeys || []) : [ownerKey];
    for (const prefix of prefixes) {
      const { blobs } = await quotesStore.list({ prefix: prefix + '/' });
      for (const { key } of blobs) {
        const qr = await quotesStore.get(key, { type: 'json' });
        if (!qr) continue;
        const fd = qr.formData || {};
        const name = qr.borrower || fd.borrower || '';
        if (matches(name) || matches(qr.address) || matches(fd.address)) {
          quotes.push({
            id: qr.id,
            ownerKey: prefix,
            name: name || qr.address || 'Quote',
            address: qr.address || fd.address || '',
            status: qr.status || 'active',
            toolType: qr.toolType || 'dscr',
            date: qr.updatedAt || qr.savedAt || '',
            link: linkForQuote(qr),
          });
        }
        if (quotes.length >= PER_CATEGORY * 2) break;
      }
      if (quotes.length >= PER_CATEGORY * 2) break;
    }
  } catch (e) { console.warn('search quotes failed:', e); }

  // ── Search clients ──
  const clients = [];
  try {
    const prefixes = wantAll ? Array.from(allOwnerKeys || []) : [ownerKey];
    for (const prefix of prefixes) {
      const { blobs } = await clientsStore.list({ prefix: prefix + '/' });
      for (const { key } of blobs) {
        const c = await clientsStore.get(key, { type: 'json' });
        if (!c) continue;
        const name = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
        const addrMatch = (c.loans || []).some((l) => matches(l.address));
        if (matches(name) || matches(c.email) || addrMatch) {
          clients.push({
            id: c.id,
            ownerKey: prefix,
            name: name || c.email || 'Client',
            email: c.email || '',
            loanCount: (c.loans || []).length,
            link: 'client-details.html?clientId=' + encodeURIComponent(c.id) +
                  (prefix !== ownerKey ? '&owner=' + encodeURIComponent(prefix) : ''),
          });
        }
        if (clients.length >= PER_CATEGORY * 2) break;
      }
      if (clients.length >= PER_CATEGORY * 2) break;
    }
  } catch (e) { console.warn('search clients failed:', e); }

  // Sort each category by date desc, trim to PER_CATEGORY
  function byDate(a, b) { return new Date(b.date || 0) - new Date(a.date || 0); }
  prospects.sort(byDate);
  quotes.sort(byDate);
  clients.sort(function(a, b){ return (a.name || '').localeCompare(b.name || ''); });

  return json(200, {
    q,
    prospects: prospects.slice(0, PER_CATEGORY),
    quotes:    quotes.slice(0, PER_CATEGORY),
    clients:   clients.slice(0, PER_CATEGORY),
  });
};

// Determine the right page to deep-link to based on the quote's status.
function linkForQuote(qr) {
  const status = qr.status || 'active';
  if (status === 'on_hold' || status === 'denied') return 'decisions.html';
  if (status === 'closed') return 'closed.html';
  // active / submitted / approved → pipeline (the cards are on the right column)
  return 'pipeline.html';
}

// Collect the prefixes a non-admin user owns. The user's email is the
// canonical prefix; legacy slug prefixes (full_name, email-localpart) are
// also returned for backwards compat with prospects-list.
async function collectMyPrefixes(prospectsStore, user) {
  const out = new Set();
  out.add(keySafe(normalizeEmail(user.email)));
  if (user.email) out.add(keySafe(user.email.split('@')[0].toLowerCase()));
  const fullName = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || '';
  if (fullName) out.add(keySafe(String(fullName).toLowerCase()));
  return Array.from(out);
}
