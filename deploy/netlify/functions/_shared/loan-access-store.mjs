/**
 * loan-access-store.mjs — Deploy 236.169 (Access Refactor PR #1)
 *
 * Thin wrapper around the `loan_access` Netlify Blob store. This
 * store is the source of truth for RELATIONSHIP-based access —
 * borrowers linked to specific loans, external attorneys viewing
 * one closing, co-signers on a portal, etc.
 *
 * Key format:  <keySafe(email)>
 * Value:
 *   {
 *     email,                    // canonical lowercase
 *     grants: [
 *       {
 *         loanId,
 *         primaryClientId,      // for display / cross-lookup
 *         ownerKey,             // the LO who granted (audit)
 *         role,                 // 'borrower' | future roles
 *         grantedAt,
 *         grantedBy,            // email of who granted
 *         revokedAt,            // ISO string or null
 *         revokedBy,            // email or null
 *       },
 *       ...
 *     ],
 *     createdAt,
 *     updatedAt,
 *   }
 *
 * Keying by email lets a borrower's session ask "what can I see?"
 * in one lookup. Loan-side view ("who has access to this loan?")
 * gets a store walk — fine for admin ops, no hot path.
 *
 * All functions are zero-throw: they log + swallow storage
 * failures. Access checks default to DENY on ambiguity.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';

const STORE_NAME = 'loan_access';

function _store() {
  return getStore({ name: STORE_NAME, consistency: 'strong' });
}

// ── Read paths ───────────────────────────────────────────────

// Fast yes/no for "does this email have a live grant on this
// loan?" Used by access.mjs on every borrower-path check.
// Returns false on any error so a store outage fails CLOSED for
// borrowers (LOs and admins short-circuit before ever hitting
// this — they're unaffected).
export async function hasLoanGrant(email, loanId) {
  if (!email || !loanId) return false;
  try {
    const rec = await _store().get(keySafe(normalizeEmail(email)), { type: 'json' });
    if (!rec || !Array.isArray(rec.grants)) return false;
    return rec.grants.some((g) => g && g.loanId === loanId && !g.revokedAt);
  } catch (e) {
    console.warn('[loan-access] hasLoanGrant read failed:', e && e.message);
    return false;
  }
}

// List every loanId this email is currently granted on. Used by
// the future borrower portal to render "your loans".
export async function listAccessibleLoans(email) {
  if (!email) return [];
  try {
    const rec = await _store().get(keySafe(normalizeEmail(email)), { type: 'json' });
    if (!rec || !Array.isArray(rec.grants)) return [];
    return rec.grants
      .filter((g) => g && !g.revokedAt)
      .map((g) => ({
        loanId:          g.loanId,
        primaryClientId: g.primaryClientId || '',
        ownerKey:        g.ownerKey || '',
        role:            g.role || 'borrower',
        grantedAt:       g.grantedAt || '',
      }));
  } catch (e) {
    console.warn('[loan-access] listAccessibleLoans read failed:', e && e.message);
    return [];
  }
}

// List every live grant on a specific loanId — for the admin/LO
// UI "who has access to this loan?" panel. Walks the store; fine
// for occasional use, don't call in a hot path.
export async function listGrantsForLoan(loanId) {
  if (!loanId) return [];
  try {
    const store = _store();
    const { blobs } = await store.list();
    const out = [];
    for (const { key } of blobs) {
      const rec = await store.get(key, { type: 'json' });
      if (!rec || !Array.isArray(rec.grants)) continue;
      for (const g of rec.grants) {
        if (g && g.loanId === loanId && !g.revokedAt) {
          out.push({
            email:           rec.email,
            role:            g.role || 'borrower',
            grantedAt:       g.grantedAt || '',
            grantedBy:       g.grantedBy || '',
            primaryClientId: g.primaryClientId || '',
          });
        }
      }
    }
    return out;
  } catch (e) {
    console.warn('[loan-access] listGrantsForLoan read failed:', e && e.message);
    return [];
  }
}

// ── Write paths ──────────────────────────────────────────────

// Idempotent grant: if the email already has a live grant on this
// loanId, we no-op (still bump updatedAt so audit sees it). If a
// revoked grant exists, we re-activate it in place rather than
// creating a duplicate.
export async function grantLoanAccess({ email, loanId, primaryClientId, ownerKey, role, grantedBy }) {
  if (!email || !loanId) throw new Error('email + loanId required');
  const store = _store();
  const key   = keySafe(normalizeEmail(email));
  const now   = new Date().toISOString();
  let rec;
  try { rec = await store.get(key, { type: 'json' }); }
  catch (_) { rec = null; }
  if (!rec) {
    rec = { email: normalizeEmail(email), grants: [], createdAt: now, updatedAt: now };
  }
  const existing = rec.grants.find((g) => g && g.loanId === loanId);
  if (existing) {
    existing.revokedAt = null;
    existing.revokedBy = null;
    existing.role = role || existing.role || 'borrower';
    if (primaryClientId) existing.primaryClientId = primaryClientId;
    if (ownerKey)        existing.ownerKey = ownerKey;
    existing.grantedAt  = existing.grantedAt || now;
    existing.grantedBy  = existing.grantedBy || grantedBy || '';
  } else {
    rec.grants.push({
      loanId,
      primaryClientId: primaryClientId || '',
      ownerKey:        ownerKey || '',
      role:            role || 'borrower',
      grantedAt:       now,
      grantedBy:       grantedBy || '',
      revokedAt:       null,
      revokedBy:       null,
    });
  }
  rec.updatedAt = now;
  await store.setJSON(key, rec);
  return rec;
}

// Soft-revoke: sets revokedAt but keeps the record so we retain
// the audit trail. hasLoanGrant filters revoked entries.
export async function revokeLoanAccess({ email, loanId, revokedBy }) {
  if (!email || !loanId) throw new Error('email + loanId required');
  const store = _store();
  const key   = keySafe(normalizeEmail(email));
  const now   = new Date().toISOString();
  let rec;
  try { rec = await store.get(key, { type: 'json' }); }
  catch (_) { rec = null; }
  if (!rec || !Array.isArray(rec.grants)) return null;
  const existing = rec.grants.find((g) => g && g.loanId === loanId);
  if (!existing) return rec;
  existing.revokedAt = now;
  existing.revokedBy = revokedBy || '';
  rec.updatedAt = now;
  await store.setJSON(key, rec);
  return rec;
}
