/**
 * clients-list.js — GET /api/clients
 *
 * Returns all clients owned by the authenticated LO.
 * Admins may pass ?all=1 to get every LO's clients (grouped by owner).
 *
 * Response shapes:
 *   Normal LO: { clients: [...] }
 *   Admin w/ ?all=1: { byOwner: { "alice@x.com": [...], "bob@x.com": [...] } }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
// Deploy 236.169 — Access Refactor PR #1: cross-LO listing is now
// gated by canListAllClients() instead of hand-rolled isAdmin. Same
// behavior for callers; centralizes the decision so PR #2+ can
// evolve the rule without editing every endpoint.
import { canListAllClients } from './_shared/access.mjs';
// Deploy 236.341 (Tier 2 scaling) — materialized index blob so
// cross-owner reads are 1 fetch not N.
import { readIndex, rebuildIndex } from './_shared/clients-index.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const wantAll = url.searchParams.get('all') === '1';
  // Deploy 236.340 — `?summary=1` returns a compact projection of
  // each client + a per-loan mini-record covering only the fields
  // pipeline.html / clients.html / loans.html actually render. Cuts
  // wire size ~90% and JSON parse time by roughly the same on Mike's
  // post-import 2 852-record set. Callers that need the full record
  // (loan-details.js, sizer) leave this off.
  const wantSummary = url.searchParams.get('summary') === '1';
  const store = getStore({ name: 'clients', consistency: 'strong' });

  const project = wantSummary ? projectSummary : sanitize;

  try {
    if (wantAll && canListAllClients(user).ok) {
      // Deploy 236.341 — index fast path for summary reads. Pipeline
      // and dashboards use ?all=1&summary=1 → single blob fetch.
      // Full-record cross-owner reads still walk (rare, admin-only
      // forensics + a few merge helpers).
      if (wantSummary) {
        const { index, exists } = await readIndex();
        if (exists && index && index.byOwner) {
          // Deploy 236.344 — do NOT fire a background rebuild on the
          // stale path. AWS Lambda holds the response until pending
          // promises settle by default; the "fire and forget"
          // rebuildIndex().catch(...) was a ~15s stall on every
          // read. Freshness comes from write-through instrumentation
          // + manual admin rebuild, not background work triggered
          // from reads.
          const nonEmpty = url.searchParams.get('nonEmptyOnly') === '1';
          let byOwner = index.byOwner;
          if (nonEmpty) {
            // Deploy 236.344 — Pipeline / dashboards only render
            // tiles for clients with loans. The 2 852-record CSV
            // import inflated the payload from ~100 KB → 1.1 MB
            // with records that Pipeline can't display anyway.
            // Drop clients whose loans array is empty. Response
            // stays the same shape ({ byOwner: {...} }), just
            // with those clients omitted.
            byOwner = {};
            for (const owner of Object.keys(index.byOwner)) {
              const list = index.byOwner[owner].filter(
                (c) => c && Array.isArray(c.loans) && c.loans.length > 0
              );
              if (list.length) byOwner[owner] = list;
            }
          }
          return json(200, { byOwner, _fromIndex: true });
        }
        // Index missing (or version-drift) → build it in-request.
        // Later reads hit the fast path.
        try {
          const stats = await rebuildIndex();
          const fresh = await readIndex();
          if (fresh && fresh.index && fresh.index.byOwner) {
            const nonEmpty = url.searchParams.get('nonEmptyOnly') === '1';
            let byOwner = fresh.index.byOwner;
            if (nonEmpty) {
              byOwner = {};
              for (const owner of Object.keys(fresh.index.byOwner)) {
                const list = fresh.index.byOwner[owner].filter(
                  (c) => c && Array.isArray(c.loans) && c.loans.length > 0
                );
                if (list.length) byOwner[owner] = list;
              }
            }
            return json(200, { byOwner, _fromIndex: true, _rebuilt: stats });
          }
        } catch (e) {
          console.warn('clients-list inline rebuild failed, falling through to walk:', e && e.message);
        }
        // Fall through to the walk below if the rebuild couldn't
        // write for some reason.
      }
      const { blobs } = await store.list();
      const byOwner = {};
      await Promise.all(blobs.map(async ({ key }) => {
        const idx = key.indexOf('/');
        if (idx < 0) return;
        const owner = key.slice(0, idx);
        const record = await store.get(key, { type: 'json' });
        if (!record) return;
        if (!byOwner[owner]) byOwner[owner] = [];
        byOwner[owner].push(record);
      }));
      // Sort each owner's list by most-recent
      Object.keys(byOwner).forEach((o) => {
        byOwner[o].sort((a, b) =>
          new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
        );
        byOwner[o] = byOwner[o].map(project);
      });
      return json(200, { byOwner });
    }

    const loKey = keySafe(normalizeEmail(user.email));
    const prefix = loKey + '/';
    const { blobs } = await store.list({ prefix });
    const clients = await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' })),
    );
    let filtered = clients.filter(Boolean);
    // Deploy 236.344 — nonEmptyOnly filter on self-scope too.
    const nonEmpty = url.searchParams.get('nonEmptyOnly') === '1';
    if (nonEmpty) {
      filtered = filtered.filter(
        (c) => c && Array.isArray(c.loans) && c.loans.length > 0
      );
    }
    filtered.sort((a, b) =>
      new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0),
    );
    return json(200, { clients: filtered.map(project) });
  } catch (e) {
    console.error('clients-list error:', e);
    return json(500, { error: 'Failed to load clients' });
  }
};

// Strip the encrypted SSN from list responses; expose only a boolean flag.
// Plaintext SSN is fetched via /api/client-ssn-reveal on demand.
function sanitize(client) {
  const out = Object.assign({}, client);
  if (out.ssn_enc) {
    out.hasSSN = true;
    delete out.ssn_enc;
  } else {
    out.hasSSN = false;
  }
  return out;
}

// Deploy 236.340 — compact projection for list views. Includes what
// pipeline tile / clients card / loans row render + everything the
// per-loan lookup needs to route clicks and cross-check status.
// Excludes: notesLog, sizer formData snapshots, envelope metadata,
// borrower_info long-app data, pricing overrides, signed docs, ssn.
// The full record is still available via a follow-up
// /api/clients?all=1 (no summary) or per-loan fetch on demand.
const LOAN_SUMMARY_FIELDS = [
  'id', 'address', 'status', 'processingStage', 'loanAmt', 'loanType',
  'toolType', 'rate', 'points', 'purchasePrice', 'propValue', 'propType',
  'fico', 'prepay', 'dscr', 'brokerId', 'brokerName', 'brokerCompany',
  'brokerEmail', 'brokerPhone', 'brokerFee', '_isBrokerLoan',
  'fromApplication', 'prospectId', 'fundingDate', 'maturityDate',
  'servicerName', 'servicerUrl',
  'slaDisplayId', 'guarantorClientIds',
  'createdAt', 'updatedAt', 'savedAt', '_owner',
];
function projectLoan(l) {
  if (!l || typeof l !== 'object') return l;
  const out = {};
  for (const k of LOAN_SUMMARY_FIELDS) {
    if (k in l) out[k] = l[k];
  }
  // Keep formData._finalRate + propType only — pipeline uses them for
  // the "unpriced auto-create" filter and the propType-discriminated
  // loanLookup.
  if (l.formData && typeof l.formData === 'object') {
    out.formData = {
      _finalRate: l.formData._finalRate,
      propType:   l.formData.propType,
    };
  }
  return out;
}
function projectSummary(client) {
  if (!client || typeof client !== 'object') return client;
  return {
    id:        client.id,
    firstName: client.firstName || '',
    lastName:  client.lastName  || '',
    name:      client.name      || '',
    email:     client.email     || '',
    phone:     client.phone     || '',
    entityName: client.entityName || '',
    companies: Array.isArray(client.companies)
      ? client.companies.map((co) => ({ id: co && co.id, name: co && co.name }))
      : [],
    hasSSN:    !!client.ssn_enc,
    _isBroker: !!client._isBroker,
    _importedAt:    client._importedAt    || undefined,
    _importSource:  client._importSource  || undefined,
    createdAt: client.createdAt,
    updatedAt: client.updatedAt,
    loans: Array.isArray(client.loans) ? client.loans.map(projectLoan) : [],
  };
}
