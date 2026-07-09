/**
 * access.mjs — Deploy 236.169 (Access Refactor PR #1)
 *
 * Single decision point for "can this user do X to this resource?"
 * Every backend endpoint SHOULD consult this module rather than
 * hand-rolling role checks. As new roles land (borrower, viewer,
 * external-attorney, ...) the changes fit in ONE file instead of
 * being scattered across ~60 endpoints.
 *
 * Design notes:
 *   - Return shape is { ok: true } OR { ok: false, reason, status }.
 *     `reason` is a short debug string; `status` is what the caller
 *     returns to the client (401 / 403 / 404).
 *   - LO and admin fast paths short-circuit before hitting any blob
 *     store — the store lookup is only for RELATIONSHIP-based
 *     access (borrowers linked to specific loans via loan_access).
 *   - This module is ADDITIVE. Existing isAdmin / isProcessor /
 *     isSuperAdmin helpers in auth.mjs stay untouched; access.mjs
 *     uses them internally. Old endpoints keep working; new ones
 *     opt in. Migration is per-endpoint.
 */
import {
  isAdmin, isSuperAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './auth.mjs';
import { hasLoanGrant } from './loan-access-store.mjs';

// ── Role resolution ──────────────────────────────────────────
// A single normalized role tag per user, in descending privilege
// order. Callers rarely need this — the capability helpers below
// are the primary surface — but it's here for logging / audit and
// for the rare check that needs a raw role label (e.g. UI shell
// selection).
export function roleOf(user) {
  if (!user) return null;
  if (isSuperAdmin(user)) return 'super_admin';
  if (isAdmin(user))      return 'admin';
  if (isProcessor(user))  return 'processor';
  // Deploy 236.169 — borrower + viewer roles are recognized in the
  // roles metadata but not yet issued to any real user. Wire the
  // resolver so PR #2+ can lean on it without touching this file.
  const raw = _rawRoles(user);
  if (raw.indexOf('borrower') >= 0) return 'borrower';
  if (raw.indexOf('viewer')   >= 0) return 'viewer';
  return 'loan_officer'; // current default
}

// ── Client-level capabilities ────────────────────────────────
// A "client" is the SLA-side borrower record (people/entity) —
// distinct from the future "borrower" role which is an Identity
// account belonging to an actual person.

export function canListAllClients(user) {
  if (!user) return _deny(401, 'not authenticated');
  if (isAdmin(user)) return _allow();
  // Deploy 236.266 — processors are staff who work across every LO's
  // loans (Processing Pipeline, Tasks, etc.). Grant them the same
  // cross-LO read scope as admins on list endpoints. Admin-only pages
  // (Dashboard, Users admin, Submissions, admin settings) are gated
  // separately.
  if (isProcessor(user)) return _allow();
  return _deny(403, 'admin or processor required for cross-LO listing');
}

// Deploy 236.266 — cross-owner MUTATION gate. Processors need to add
// notes / advance status / upload docs on any LO's loan as part of
// their processing workflow. Same set as canListAllClients today
// (admin OR processor); separate helper so future policy changes can
// diverge read from write.
export function canOverrideOwner(user) {
  if (!user) return _deny(401, 'not authenticated');
  if (isAdmin(user)) return _allow();
  if (isProcessor(user)) return _allow();
  return _deny(403, 'owner override requires admin or processor');
}

export function canReadClient(user, client) {
  if (!user) return _deny(401, 'not authenticated');
  if (!client) return _deny(404, 'client not found');
  if (isAdmin(user)) return _allow();
  const ownerKey = _ownerKeyOfClient(client);
  const selfKey  = keySafe(normalizeEmail(user.email));
  if (ownerKey && ownerKey === selfKey) return _allow();
  // Borrower access to a client is derived from access to any of
  // that client's loans. Since PR #1 doesn't ship borrowers, this
  // path is dead code today — enable in PR #3.
  return _deny(403, 'not owner');
}

// ── Loan-level capabilities ──────────────────────────────────

export async function canReadLoan(user, loan, opts) {
  if (!user) return _deny(401, 'not authenticated');
  if (!loan)  return _deny(404, 'loan not found');
  if (isAdmin(user)) return _allow();

  const ownerKey = (opts && opts.ownerKey) || _ownerKeyOfLoan(loan, opts);
  const selfKey  = keySafe(normalizeEmail(user.email));
  if (ownerKey && ownerKey === selfKey) return _allow();

  // Borrower path — check the loan_access store for a live grant.
  // Cheap when the store is empty (returns false immediately);
  // becomes meaningful once borrowers are on-board.
  const loanId = loan.id || (opts && opts.loanId);
  if (loanId) {
    const linked = await hasLoanGrant(normalizeEmail(user.email), loanId);
    if (linked) return _allow();
  }
  return _deny(403, 'not owner and no loan_access grant');
}

export async function canEditLoan(user, loan, opts) {
  // Borrowers CANNOT edit — mutation gate is stricter than read.
  // Everything else mirrors canReadLoan.
  if (!user) return _deny(401, 'not authenticated');
  if (!loan)  return _deny(404, 'loan not found');
  if (isAdmin(user)) return _allow();
  const ownerKey = (opts && opts.ownerKey) || _ownerKeyOfLoan(loan, opts);
  const selfKey  = keySafe(normalizeEmail(user.email));
  if (ownerKey && ownerKey === selfKey) return _allow();
  return _deny(403, 'not owner');
}

// ── Doc-review capabilities ──────────────────────────────────
// Processors + admins can review docs on any loan. Borrowers get
// a VIEW-only path via canReadReviewDoc (below) — never a review
// verdict.

export function canReviewDocs(user, loan) {
  if (!user) return _deny(401, 'not authenticated');
  if (isProcessor(user)) return _allow(); // admins implicitly count
  return _deny(403, 'processor or admin required');
}

export async function canReadReviewDoc(user, review, docId, opts) {
  if (!user) return _deny(401, 'not authenticated');
  if (isProcessor(user)) return _allow(); // full read for staff
  // Borrower path — must be linked to the loan the review belongs
  // to. Enable once borrowers exist.
  const loanId = (review && review.source && review.source.loanId) || (opts && opts.loanId);
  if (loanId) {
    const linked = await hasLoanGrant(normalizeEmail(user.email), loanId);
    if (linked) return _allow();
  }
  return _deny(403, 'not authorized for this review');
}

// ── Private helpers ──────────────────────────────────────────

function _allow() { return { ok: true }; }
function _deny(status, reason) { return { ok: false, status, reason }; }

function _rawRoles(user) {
  if (!user) return [];
  const meta = user.app_metadata || {};
  let roles = Array.isArray(meta.roles) ? meta.roles
            : typeof meta.roles === 'string' ? [meta.roles]
            : [];
  if (!roles.length && user.user_metadata && user.user_metadata.roles) {
    roles = Array.isArray(user.user_metadata.roles) ? user.user_metadata.roles : [user.user_metadata.roles];
  }
  return roles;
}

// The client record's ownerKey lives on the storage key (before
// the '/'), not on the record itself. Callers pass it via opts or
// we fall back to inferring from createdBy on the record.
function _ownerKeyOfClient(client) {
  if (!client) return null;
  if (client.ownerKey) return client.ownerKey;
  if (client.createdBy) return keySafe(normalizeEmail(client.createdBy));
  return null;
}
function _ownerKeyOfLoan(loan, opts) {
  if (loan && loan.ownerKey) return loan.ownerKey;
  if (opts && opts.ownerKey) return opts.ownerKey;
  // Loans are nested inside clients; when the caller has the
  // client record available they pass ownerKey directly. When
  // they don't, this returns null and we fall through to the
  // borrower path — that's intentional (fail-closed for LOs but
  // let borrower grants still resolve).
  return null;
}
