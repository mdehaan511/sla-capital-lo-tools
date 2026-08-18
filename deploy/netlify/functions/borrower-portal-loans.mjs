/**
 * borrower-portal-loans.mjs — GET /api/borrower-portal-loans
 *
 * Deploy 236.171 — Access Refactor PR #4. Returns the loans this
 * borrower has been granted access to (from loan_access), joined
 * with a sanitized view of each loan record.
 *
 * Auth: any authenticated user. The result is scoped to grants
 * matching THEIR email — no way for a borrower to list someone
 * else's loans. Admins get their own list too; if an admin needs
 * to inspect a borrower's list on their behalf, they use
 * /api/loan-access-list?email=... which is separately gated.
 *
 * Response: { loans: [{ loanId, address, status, propertyType,
 *                       loanAmt, primaryClientId, ownerKey,
 *                       grantedAt, grantedBy }] }
 *
 * Sanitization strips LO-side context that borrowers shouldn't
 * see: commissions, notes log, processor fields, other guarantors'
 * SSNs, etc. Anything on the loan the borrower doesn't need for
 * "here's your loan" is dropped.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-portal-loans error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const email = normalizeEmail(user.email);
  const grants = await listAccessibleLoans(email);
  if (!grants.length) return json(200, { loans: [] });

  const clientsStore = getStore({ name: 'clients', consistency: 'eventual' });

  const results = await Promise.all(grants.map(async (g) => {
    if (!g.ownerKey || !g.primaryClientId || !g.loanId) return null;
    try {
      const client = await clientsStore.get(g.ownerKey + '/' + keySafe(g.primaryClientId), { type: 'json' });
      if (!client || !Array.isArray(client.loans)) return null;
      const loan = client.loans.find((l) => l && l.id === g.loanId);
      if (!loan) return null;
      // Deploy 236.591 — a granted loan is only VISIBLE when the borrower is
      // actually TIED to it: the primary borrower, or a guarantor client on the
      // loan. "Granted but not tied" = pending onboarding (item 3) — the portal
      // shows a first-login form to collect their info and attach them as a
      // guarantor. This ALSO self-heals item 4: a removed guarantor is no longer
      // tied, so the loan drops out of their list even if a stale grant lingers.
      const tied = await _emailTiedToLoan(email, loan, client, g.ownerKey, clientsStore);
      if (tied) return { kind: 'loan', value: _sanitize(loan, client, g) };
      return { kind: 'pending', value: {
        loanId:          loan.id,
        address:         loan.address || '',
        primaryClient:   (client.firstName || client.lastName)
                           ? ((client.firstName || '') + ' ' + (client.lastName || '')).trim()
                           : (client.email || ''),
        primaryClientId: client.id || g.primaryClientId || '',
        ownerKey:        g.ownerKey || '',
      } };
    } catch (e) {
      console.warn('[borrower-portal-loans] loan fetch failed:', g.loanId, e && e.message);
      return null;
    }
  }));

  const loans = [];
  const pendingOnboarding = [];
  for (const r of results) {
    if (!r) continue;
    if (r.kind === 'loan') loans.push(r.value);
    else if (r.kind === 'pending') pendingOnboarding.push(r.value);
  }
  return json(200, { loans, pendingOnboarding });
}

// Deploy 236.591 — is this email tied to the loan (visible in the portal)?
// True when it's the primary borrower's email, or matches a guarantor on the
// loan. Guarantors are separate `clients` records linked via guarantorClientIds
// (the denormalized loan.guarantors[] can drift, so it's only a fast-path — the
// authoritative check resolves the linked client ids to their emails).
async function _emailTiedToLoan(email, loan, client, ownerKey, clientsStore) {
  if (client && normalizeEmail(client.email || '') === email) return true;
  if (Array.isArray(loan.guarantors)) {
    for (const g of loan.guarantors) {
      if (g && normalizeEmail(g.email || '') === email) return true;
    }
  }
  const ids = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
  for (const gid of ids) {
    if (!gid) continue;
    try {
      const gc = await clientsStore.get(ownerKey + '/' + keySafe(gid), { type: 'json' });
      if (gc && normalizeEmail(gc.email || '') === email) return true;
    } catch (_) { /* missing guarantor client → not a match */ }
  }
  return false;
}

// Deploy 236.550 — borrower-facing stage bucket. Collapses the internal
// processing stage (processingStage, authoritative) — falling back to
// status/baselineStatus — into a small, friendly set borrowers see:
//   In Review → Document Collection → Underwriting → Clear to Close → Closed/Funded
// "Processing" shows as "Document Collection" per Mike; "Approved" = "Clear to
// Close". Internal stage renames never leak to borrowers.
function _borrowerStage(loan) {
  const ps = String(loan.processingStage || '').toLowerCase().trim();
  const st = String(loan.status || '').toLowerCase().trim();
  const bl = String(loan.baselineStatus || '').toLowerCase().replace(/[_\s]+/g, ' ').trim();
  if (ps === 'pp_closed' || st === 'closed' || bl === 'closed' || bl === 'sold' ||
      bl === 'liquidated' || bl === 'servicing' || bl === 'in servicing' || bl === 'paid off') {
    return { key: 'closed', label: 'Closed / Funded' };
  }
  if (ps === 'pp_approved' || st === 'approved' || bl === 'approved') return { key: 'cleartoclose', label: 'Clear to Close' };
  if (ps === 'underwriting' || bl === 'underwriting') return { key: 'underwriting', label: 'Underwriting' };
  if (ps === 'processing' || bl === 'processing') return { key: 'processing', label: 'Document Collection' };
  return { key: 'review', label: 'In Review' };
}

// Strip fields the borrower shouldn't see. Whitelist approach —
// only fields listed here make it into the response.
function _sanitize(loan, client, grant) {
  return {
    borrowerStage:   _borrowerStage(loan),
    loanId:          loan.id,
    slaDisplayId:    loan.slaDisplayId || '',
    address:         loan.address || '',
    propType:        loan.propType || '',
    propTypeLabel:   loan.propTypeLabel || '',
    loanType:        loan.loanType || '',
    loanPurpose:     loan.loanPurpose || '',
    status:          loan.status || 'active',
    loanAmt:         loan.loanAmt || '',
    rate:            loan.rate || '',
    points:          loan.points || '',
    fundingDate:     loan.fundingDate || '',
    propValue:       loan.propValue || loan.appraisedValue || '',
    createdAt:       loan.createdAt || '',
    updatedAt:       loan.updatedAt || '',

    // Borrower's-eye view of who this loan belongs to.
    primaryClient:   client.firstName || client.lastName
                       ? ((client.firstName || '') + ' ' + (client.lastName || '')).trim()
                       : client.email || '',
    primaryClientId: client.id || grant.primaryClientId || '',
    ownerKey:        grant.ownerKey || '',

    // Grant metadata (so borrower can see when they were added
    // and by whom).
    grantedAt:       grant.grantedAt || '',
    role:            grant.role || 'borrower',
  };
}
