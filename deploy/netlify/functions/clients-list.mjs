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
    const filtered = clients.filter(Boolean);
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
