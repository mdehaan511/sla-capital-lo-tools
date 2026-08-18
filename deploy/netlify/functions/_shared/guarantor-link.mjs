/**
 * guarantor-link.mjs — shared "attach a guarantor to a loan" core.
 *
 * Deploy 236.591 — used by the borrower-portal invite / onboarding flows to tie
 * a portal-invited person to a loan as a Guarantor. A guarantor is a real
 * `clients` record linked via `loan.guarantorClientIds[]` (+ `guarantorOwnership`).
 * This helper dedupes the guarantor by email under the loan's owner, creates the
 * client if new, wires it onto the loan, and persists the guarantor client via
 * the PG-first `writeClient` (strict write discipline).
 *
 * Deliberately LIGHTER than loan-add-guarantor.mjs: no vesting-entity mapping, no
 * sub-form token, no LO notesLog — those are LO-initiated extras that don't apply
 * to a borrower self-onboarding or a portal invite. loan-add-guarantor.mjs keeps
 * its full behavior and is intentionally NOT routed through here.
 *
 * The caller loads the PRIMARY client, finds the loan object on it, and passes
 * both in. This helper mutates `loan.guarantorClientIds`/`guarantorOwnership` on
 * that object and writes the GUARANTOR client; the caller writes the PRIMARY
 * afterward (so it can add its own audit first).
 *
 * Returns { guarantor, matchedExistingClient, alreadyLinked }.
 */
import { writeClient } from './client-write.mjs';
import { findClientByEmail } from './client-lookup.mjs';

export async function linkGuarantorToLoan(opts) {
  opts = opts || {};
  const { ownerKey, primaryClientId, loanId, primary, loan, clientsStore } = opts;
  const g = opts.guarantor || {};
  const viaKey = opts.createdVia || '_createdViaPortalInvite';

  const email     = String(g.email     || '').toLowerCase().trim();
  const firstName = String(g.firstName || '').trim();
  const lastName  = String(g.lastName  || '').trim();
  const phone     = String(g.phone     || '').trim();
  if (!email) throw new Error('guarantor email required');
  if (!ownerKey || !primaryClientId || !loanId || !primary || !loan) {
    throw new Error('ownerKey, primaryClientId, loanId, primary, loan required');
  }

  const now = new Date().toISOString();
  const backref = { primaryClientId, loanId };

  // ── Dedupe by email under this owner (one indexed PG lookup). ──
  let matchedExistingClient = false;
  let guarantor = null;
  const emailHit = await findClientByEmail(ownerKey, email, clientsStore);
  if (emailHit) { guarantor = emailHit.client; matchedExistingClient = true; }

  if (guarantor) {
    // Fill blanks only — never overwrite what the existing client carries.
    if (!guarantor.firstName && firstName) guarantor.firstName = firstName;
    if (!guarantor.lastName  && lastName)  guarantor.lastName  = lastName;
    if (!guarantor.phone     && phone)     guarantor.phone     = phone;
    guarantor._guarantorOnLoans = Array.isArray(guarantor._guarantorOnLoans) ? guarantor._guarantorOnLoans : [];
    const linked = guarantor._guarantorOnLoans.some((b) =>
      b && b.primaryClientId === primaryClientId && b.loanId === loanId);
    if (!linked) guarantor._guarantorOnLoans.push(backref);
  } else {
    guarantor = {
      id:         'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      firstName,
      lastName,
      email,
      phone,
      entityName: '',
      createdAt:  now,
      updatedAt:  now,
      loans:      [],
      companies:  [],
      _guarantorOnLoans: [backref],
    };
    guarantor[viaKey] = true;
  }
  guarantor.updatedAt = now;

  // ── Wire into the loan (mutates the caller's loan object). ──
  loan.guarantorClientIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
  const alreadyLinked = loan.guarantorClientIds.indexOf(guarantor.id) >= 0;
  if (!alreadyLinked) loan.guarantorClientIds.push(guarantor.id);
  const pct = parseFloat(g.ownershipPct);
  if (isFinite(pct)) {
    loan.guarantorOwnership = Object.assign({}, loan.guarantorOwnership || {});
    loan.guarantorOwnership[guarantor.id] = pct;
  }
  loan.updatedAt = now;

  // ── Persist the guarantor client (PG-first). Caller writes primary. ──
  await writeClient(ownerKey, guarantor, { clientsStore });

  return { guarantor, matchedExistingClient, alreadyLinked };
}
