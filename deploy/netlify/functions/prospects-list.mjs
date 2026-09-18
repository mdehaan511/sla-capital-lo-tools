/**
 * prospects-list.mjs — GET /api/prospects
 *
 * Returns prospects belonging to the authenticated LO.
 *
 * New shape: prospects are stored under keySafe(loEmail)/{prospectId}.
 * Older entries may still be under a slug; we read both prefixes for the
 * current LO so nothing's dropped during the transition.
 *
 * Admins may pass ?all=1 to see every prospect grouped by ownerKey.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.266
import { prospectsIndex } from './_shared/prospects-index.mjs'; // Deploy 236.343
import { quotesIndex }    from './_shared/quotes-index.mjs';    // Deploy 236.343

function ownerKeyForUser(user) {
  if (!user) return '';
  return keySafe(normalizeEmail(user.email));
}

function legacySlugForUser(user) {
  if (!user) return '';
  const meta = user.user_metadata || {};
  if (meta.slug) return keySafe(String(meta.slug).toLowerCase());
  if (user.email) return keySafe(user.email.split('@')[0].toLowerCase());
  return '';
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  const store = getStore({ name: 'prospects', consistency: 'strong' });

  try {
    if (wantAll && canListAllClients(user).ok) {
      // Deploy 236.343 — index fast path: pull prospects + quotes
      // from their materialized indexes so we skip the ~2x N-walks
      // this endpoint used to do (once for prospects, once for
      // quotes to dedupe already-worked addresses).
      let byOwner = null;
      try {
        const pIdx = await prospectsIndex.readIndex();
        if (pIdx.exists && pIdx.index && pIdx.index.byOwner) {
          // Deploy 236.344 — no bg rebuild on stale (Lambda holds).
          byOwner = JSON.parse(JSON.stringify(pIdx.index.byOwner)); // clone for mutation
        } else {
          const stats = await prospectsIndex.rebuildIndex();
          const fresh = await prospectsIndex.readIndex();
          if (fresh && fresh.index && fresh.index.byOwner) {
            byOwner = JSON.parse(JSON.stringify(fresh.index.byOwner));
          }
        }
      } catch (e) {
        console.warn('prospects-list: index read failed, falling to walk:', e && e.message);
      }
      if (byOwner) {
        // Dedupe against worked addresses via the quotes index.
        try {
          const qIdx = await quotesIndex.readIndex();
          const qOwners = (qIdx && qIdx.index && qIdx.index.byOwner) || {};
          // Deploy 237.162 — keep the newest quote TIME per address, not just the
          // address (see the LO path below for why).
          const workedByOwner = {};
          for (const o of Object.keys(qOwners)) {
            const at = {};
            for (const q of qOwners[o]) {
              if (!q || !q.address) continue;
              const a = normAddr(q.address);
              const t = Date.parse(q.updatedAt || q.savedAt || q.createdAt || 0) || 0;
              if (!(a in at) || t > at[a]) at[a] = t;
            }
            if (Object.keys(at).length) workedByOwner[o] = at;
          }
          for (const owner of Object.keys(byOwner)) {
            const worked = workedByOwner[owner];
            if (!worked) continue;
            byOwner[owner] = byOwner[owner].filter((p) => !_alreadyWorked(p, worked));
            if (!byOwner[owner].length) delete byOwner[owner];
          }
        } catch (e) {
          console.warn('prospects-list: quote-index dedupe failed:', e && e.message);
        }
        Object.keys(byOwner).forEach((s) => {
          byOwner[s].sort((a, b) => new Date(b.submittedAt || b.savedAt || b.updatedAt || 0) - new Date(a.submittedAt || a.savedAt || a.updatedAt || 0));
        });
        return json(200, { bySlug: byOwner, _fromIndex: true });
      }
      // ── Legacy walk fallback (index unavailable) ──
      const { blobs } = await store.list();
      byOwner = {};
      await Promise.all(blobs.map(async ({ key }) => {
        const idx = key.indexOf('/');
        if (idx < 0) return;
        const owner = key.slice(0, idx);
        const record = await store.get(key, { type: 'json' });
        if (!record) return;
        if (!byOwner[owner]) byOwner[owner] = [];
        byOwner[owner].push(record);
      }));
      Object.keys(byOwner).forEach((s) => {
        byOwner[s].sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
      });
      return json(200, { bySlug: byOwner });
    }

    // Primary: prospects keyed by the LO's own email.
    // Backwards-compat: also pull from any old slug-based prefixes the
    // user previously used (full_name, email-localpart) so historical
    // submissions still appear in the list.
    const ownerKey = ownerKeyForUser(user); // keySafe(user.email)
    const slugCandidates = new Set([ownerKey]);
    if (user.email) slugCandidates.add(keySafe(user.email.split('@')[0].toLowerCase()));
    const fullName = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || '';
    if (fullName) slugCandidates.add(keySafe(String(fullName).toLowerCase()));

    const collected = {};
    async function pull(prefix) {
      if (!prefix) return;
      const { blobs } = await store.list({ prefix: prefix + '/' });
      await Promise.all(blobs.map(async ({ key }) => {
        const p = await store.get(key, { type: 'json' });
        if (p && p.id) collected[p.id] = p;
      }));
    }
    for (const s of slugCandidates) await pull(s);

    let prospects = Object.values(collected);

    // Hide prospects that have already been worked. Definition of "worked":
    // there's a saved quote with the same address (case-insensitive,
    // whitespace-collapsed) under this LO's quotes prefix.
    try {
      const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
      const { blobs: qBlobs } = await quotesStore.list({ prefix: ownerKey + '/' });
      const workedAt = {};
      await Promise.all(qBlobs.map(async ({ key }) => {
        const q = await quotesStore.get(key, { type: 'json' });
        if (!q || !q.address) return;
        const a = normAddr(q.address);
        const t = Date.parse(q.updatedAt || q.savedAt || q.createdAt || 0) || 0;
        if (!(a in workedAt) || t > workedAt[a]) workedAt[a] = t;
      }));
      // Deploy 237.162 (Marianne) — this used to drop ANY prospect whose address
      // matched a quote, so a brand-new application for a property the LO had
      // already quoted vanished from their own New Application column while it
      // stayed visible to admins (who dedupe from the quotes INDEX, which lags).
      // "Chance sees my portfolio app on his end" was exactly this. Hide a lead
      // only when the work happened AFTER it came in; a newer application is new
      // business and has to be worked.
      prospects = prospects.filter((p) => !_alreadyWorked(p, workedAt));
    } catch (e) {
      console.warn('prospects-list quote dedupe failed:', e);
    }

    prospects.sort((a, b) => new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0));
    return json(200, { prospects, slug: ownerKey });
  } catch (e) {
    console.error('prospects-list error:', e);
    return json(500, { error: 'Failed to load prospects' });
  }
};

// Deploy 237.162 — a prospect counts as "already worked" only when a quote at
// the same address is at least as new as the application itself. Without a
// usable timestamp on either side we keep the old behaviour (hide it), so an
// undated legacy record doesn't suddenly resurface.
function _alreadyWorked(prospect, workedAt) {
  const t = workedAt[normAddr((prospect && prospect.propAddress) || '')];
  if (t === undefined) return false;
  const sub = Date.parse((prospect && (prospect.submittedAt || prospect.savedAt || prospect.updatedAt)) || 0) || 0;
  if (!sub || !t) return true;
  return t >= sub;
}

// Deploy 236.799 (Mike) — this feeds the worked-address dedup that decides
// whether a prospect is dropped from the admin all-LOs response because a quote
// already exists at that address. It used to lowercase + collapse whitespace
// only, so it matched nothing that wasn't already byte-identical: apply.html
// stores the Google Places form ("857 6th Ave, Coraopolis, PA 15108, USA"),
// the sizer stores its own ("857 6th Ave, Coraopolis, PA, 15108"), and the same
// deal came back as both a New Application and a Quoted card.
//
// Mirrors _normAddrMod + _dedupAddrKey in pipeline.html (the board runs the
// same dedup client-side) — keep the two in sync. Drop a trailing ", USA",
// turn , . # into spaces, fold street-suffix synonyms. City/state/zip stay in
// the key on purpose so same-named streets in different cities don't merge.
const SUFFIX_MAP = {
  street: 'st', 'st.': 'st',
  avenue: 'ave', 'ave.': 'ave', av: 'ave',
  road: 'rd', 'rd.': 'rd',
  drive: 'dr', 'dr.': 'dr',
  boulevard: 'blvd', 'blvd.': 'blvd',
  lane: 'ln', 'ln.': 'ln',
  court: 'ct', 'ct.': 'ct',
  circle: 'cir', 'cir.': 'cir',
  place: 'pl', 'pl.': 'pl',
  terrace: 'ter', 'ter.': 'ter',
  parkway: 'pkwy', 'pkwy.': 'pkwy',
  highway: 'hwy', 'hwy.': 'hwy',
  square: 'sq', 'sq.': 'sq',
  trail: 'trl', 'trl.': 'trl',
};
function normAddr(s) {
  const v = String(s || '')
    .toLowerCase()
    .replace(/,?\s*usa\s*$/i, '')
    .replace(/[,.#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return v.split(' ').map((t) => SUFFIX_MAP[t] || t).join(' ');
}
