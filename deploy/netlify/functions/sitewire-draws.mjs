/**
 * sitewire-draws.mjs — POST /api/sitewire-draws
 *
 * Deploy 236.704 — live draw data for the Closed Loans → Draws tab.
 *
 * Sitewire (app.sitewire.co) is the draw-management system for RTL
 * construction loans. Their v2 API is org-scoped via three static
 * credential headers created on portal.sitewire.co/lenders/api_keys.
 * Each Sitewire property carries a `loan_number` that Mike keys to our
 * `slaDisplayId` (SLA-YYYYMMDD-NNNN), so the join is deterministic and
 * we persist NOTHING on the loan — no linking step, no write path.
 *
 * Flow per request:
 *   1. Serve from the org-wide blob cache when younger than 10 min
 *      (`refresh: true` bypasses). One Sitewire sweep = list properties
 *      + one budget call per active property, so the cache keeps the
 *      tab paint fast and Sitewire traffic low.
 *   2. Filter the org map down to the loan numbers the caller asked for.
 *      Staff may omit `loanNumbers` to get the whole map; non-staff must
 *      name the loans they're looking at (closed-loans.html always does).
 *
 * Body: { loanNumbers?: [..], refresh?: bool }
 * Response: { ok, fetchedAt, propertyCount, matched, byLoanNumber: {
 *   '<LOAN NUMBER>': { propertyId, address, budget: { budgetedCents,
 *     approvedCents, balanceCents }, draws: [{ id, number, name, status,
 *     historical, requestedCents, approvedCents, updatedAt }] } } }
 *
 * All amounts stay integer cents (Sitewire's unit) — the client divides.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  isAdmin, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

const SW_BASE = 'https://app.sitewire.co/api/v2';
const CACHE_KEY = 'org-draws-v1';
const CACHE_TTL_MS = 10 * 60 * 1000;
const BATCH = 8; // parallel budget fetches — polite but fast

function swHeaders() {
  const t = process.env.SITEWIRE_ACCESS_TOKEN, c = process.env.SITEWIRE_CLIENT, u = process.env.SITEWIRE_UID;
  if (!t || !c || !u) return null;
  return { 'access-token': t, client: c, uid: u, accept: 'application/json' };
}

async function swGet(path, headers) {
  const res = await fetch(SW_BASE + path, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error('Sitewire ' + path + ' -> HTTP ' + res.status + (body ? ' ' + body.slice(0, 200) : ''));
  }
  return res.json();
}

function normLoanNumber(v) { return String(v == null ? '' : v).trim().toUpperCase(); }

// One full Sitewire sweep: properties -> budgets (draws + balance ride
// along on the Budget show, so it's exactly one extra call per property).
async function sweepSitewire(headers) {
  const props = await swGet('/properties', headers);
  const active = (Array.isArray(props) ? props : []).filter(function (p) {
    return p && !p.inactive && p.budget && p.budget.id && normLoanNumber(p.loan_number);
  });
  const byLoanNumber = {};
  for (let i = 0; i < active.length; i += BATCH) {
    const chunk = active.slice(i, i + BATCH);
    const budgets = await Promise.all(chunk.map(function (p) {
      return swGet('/budgets/' + p.budget.id, headers).catch(function (e) {
        // One broken property must not sink the whole sweep — log + skip.
        console.error('[SLA] sitewire-draws: budget ' + p.budget.id + ' failed:', e.message);
        return null;
      });
    }));
    chunk.forEach(function (p, j) {
      const b = budgets[j];
      if (!b) return;
      byLoanNumber[normLoanNumber(p.loan_number)] = {
        propertyId: p.id,
        address: (p.address && (p.address.full_address || p.address.street)) || '',
        budget: {
          budgetedCents: b.total_budgeted_cents || 0,
          approvedCents: b.total_approved_cents || 0,
          balanceCents:  b.balance_cents || 0,
        },
        draws: (Array.isArray(b.draws) ? b.draws : []).map(function (d) {
          return {
            id: d.id, number: d.number, name: d.name || '',
            status: d.status || '', historical: !!d.historical,
            requestedCents: d.total_requested_cents || 0,
            approvedCents:  d.total_approved_cents || 0,
            updatedAt: d.updated_at || '',
          };
        }),
      };
    });
  }
  return { fetchedAt: new Date().toISOString(), propertyCount: active.length, byLoanNumber };
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('sitewire-draws error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const headers = swHeaders();
  if (!headers) return json(503, { error: 'Sitewire credentials not configured (SITEWIRE_ACCESS_TOKEN / SITEWIRE_CLIENT / SITEWIRE_UID)' });

  const body = (await readJsonBody(req)) || {};
  const staff = isAdmin(user) || isProcessor(user);
  let wanted = Array.isArray(body.loanNumbers) ? body.loanNumbers.map(normLoanNumber).filter(Boolean) : null;
  if (!staff && (!wanted || !wanted.length)) {
    return json(400, { error: 'loanNumbers required' });
  }

  const cacheStore = getStore({ name: 'sitewire-cache', consistency: 'strong' });

  // Deploy 236.761 — non-staff scoping. slaDisplayIds are guessable
  // (SLA-YYYYMMDD-NNNN), and naming a number was the only gate: any LO
  // could pull budget/draw/balance data for every loan in the org. Now a
  // non-staff caller only gets numbers that exist on THEIR OWN loans
  // (10-min cached per owner), and the force-refresh sweep is staff-only.
  if (!staff) {
    if (body.refresh) return json(403, { error: 'Refresh is staff-only' });
    const ownerKey = keySafe(normalizeEmail(user.email));
    const ownCacheKey = 'own/' + ownerKey;
    let own = null;
    try {
      const c = await cacheStore.get(ownCacheKey, { type: 'json' });
      if (c && c.fetchedAt && (Date.now() - Date.parse(c.fetchedAt)) < CACHE_TTL_MS) own = c.numbers;
    } catch (_) {}
    if (!own) {
      own = [];
      try {
        const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
        const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
        for (const { key } of blobs) {
          const c = await clientsStore.get(key, { type: 'json' }).catch(() => null);
          const loans = (c && Array.isArray(c.loans)) ? c.loans : [];
          for (const l of loans) {
            const n = l && l.slaDisplayId ? normLoanNumber(l.slaDisplayId) : '';
            if (n) own.push(n);
          }
        }
        try { await cacheStore.setJSON(ownCacheKey, { fetchedAt: new Date().toISOString(), numbers: own }); } catch (_) {}
      } catch (e) {
        console.warn('sitewire-draws: ownership scan failed:', e && e.message);
        return json(500, { error: 'Could not verify loan ownership — try again.' });
      }
    }
    const ownSet = new Set(own);
    wanted = wanted.filter((n) => ownSet.has(n));
    if (!wanted.length) {
      return json(200, { ok: true, fetchedAt: '', propertyCount: 0, matched: 0, byLoanNumber: {} });
    }
  }
  let data = null;
  if (!body.refresh) {
    try {
      const cached = await cacheStore.get(CACHE_KEY, { type: 'json' });
      if (cached && cached.fetchedAt && (Date.now() - Date.parse(cached.fetchedAt)) < CACHE_TTL_MS) data = cached;
    } catch (_) {}
  }
  if (!data) {
    data = await sweepSitewire(headers);
    try { await cacheStore.setJSON(CACHE_KEY, data); } catch (_) {}
  }

  // Staff with no explicit filter get the whole org map; everyone else
  // gets exactly the loan numbers they asked about.
  let out = data.byLoanNumber;
  if (wanted && wanted.length) {
    out = {};
    wanted.forEach(function (n) { if (data.byLoanNumber[n]) out[n] = data.byLoanNumber[n]; });
  }
  return json(200, {
    ok: true,
    fetchedAt: data.fetchedAt,
    propertyCount: data.propertyCount,
    matched: Object.keys(out).length,
    byLoanNumber: out,
  });
}
