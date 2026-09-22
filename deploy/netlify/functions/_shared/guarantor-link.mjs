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
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { writeClient } from './client-write.mjs';
import { findClientByEmail } from './client-lookup.mjs';

/**
 * Deploy 237.238 (Mike: "hopefully we can finally be done with these broker/borrower mix ups")
 *
 * A loan carries its guarantors in TWO places: `guarantorClientIds[]` (the linked client
 * records the Contacts tab renders) and the flat `guarantors[]` (name/email/clientId, the
 * shape loan-broker-borrower-capture and loan-add-guarantor keep). The broker-loan advance
 * gate on Loan Details, the rate-sheet signer gate and the sizer PDFs read the FLAT array.
 * This helper linked the client but never filled the flat array, so a broker's application
 * named its borrower, the Contacts tab showed them, and the LO still got the "Borrower Info
 * Required" modal on advance. Every link now mirrors into the flat array, and
 * syncFlatGuarantors() backfills loans linked before this deploy on their way into
 * processing.
 */
export function pushFlatGuarantor(loan, client, ownershipPct) {
  if (!loan || !client || !client.id) return false;
  loan.guarantors = Array.isArray(loan.guarantors) ? loan.guarantors : [];
  const email = String(client.email || '').toLowerCase().trim();
  const dupe = loan.guarantors.some((x) => x && (
    (x.clientId && x.clientId === client.id) ||
    (email && x.email && String(x.email).toLowerCase() === email)
  ));
  if (dupe) return false;
  const pct = ownershipPct == null ? NaN : parseFloat(ownershipPct);
  loan.guarantors.push({
    firstName: String(client.firstName || '').trim(),
    lastName:  String(client.lastName  || '').trim(),
    email,
    phone:     String(client.phone || '').trim(),
    clientId:  client.id,
    ownership: isFinite(pct) ? String(pct) : '',
  });
  return true;
}

/** True when the flat array names at least one real person. */
export function hasRealGuarantor(loan) {
  const gs = Array.isArray(loan && loan.guarantors) ? loan.guarantors : [];
  return gs.some((g) => g && (g.firstName || g.lastName || g.email));
}

/**
 * Mirror every linked guarantor client missing from the flat array. Reads only the
 * clients it needs (one blob get per missing id). Returns how many were added. Never
 * throws on a bad read; a client that cannot be read is skipped.
 */
export async function syncFlatGuarantors(ownerKey, loan, clientsStore) {
  if (!ownerKey || !loan) return 0;
  const ids = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds.filter(Boolean) : [];
  if (!ids.length) return 0;
  const store = clientsStore || getStore({ name: 'clients', consistency: 'strong' });
  loan.guarantors = Array.isArray(loan.guarantors) ? loan.guarantors : [];
  let added = 0;
  for (const id of ids) {
    if (loan.guarantors.some((x) => x && x.clientId === id)) continue;
    const c = await store.get(ownerKey + '/' + keySafe(id), { type: 'json' }).catch(() => null);
    if (!c || !c.id) continue;
    const pct = loan.guarantorOwnership && typeof loan.guarantorOwnership === 'object' ? loan.guarantorOwnership[id] : undefined;
    if (pushFlatGuarantor(loan, c, pct)) added++;
  }
  return added;
}

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
  // Deploy 237.238 -- the flat guarantors[] must agree with guarantorClientIds (see above).
  pushFlatGuarantor(loan, guarantor, isFinite(pct) ? pct : undefined);
  loan.updatedAt = now;

  // ── Persist the guarantor client (PG-first). Caller writes primary. ──
  await writeClient(ownerKey, guarantor, { clientsStore });

  return { guarantor, matchedExistingClient, alreadyLinked };
}
