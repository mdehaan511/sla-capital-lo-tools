/**
 * _shared/esign-people.mjs — Deploy 237.167 (Mike)
 *
 * "Once completed they should be able to be linked to the profiles of people
 * (borrowers, brokers, investors) and be able to be seen in their profiles as
 * documents."
 *
 * The loan half of that already shipped in 237.028 (esign-doc-assign files the executed
 * PDF into the loan's Doc Review tray, which IS the Loan Details Documents tab). The
 * PEOPLE half did not exist at all — this is it.
 *
 * ── Two ways a document belongs to a person, on purpose ──
 *
 *   DERIVED — they signed it. Every signer already carries a name, an email and a kind
 *     ('borrower' | 'broker' | 'user' | 'other'), so "which documents are this person's?"
 *     is answerable from what the document already knows. Nothing to maintain, nothing to
 *     drift, and it is right the moment a document completes. This is the common case and
 *     it needs no clicks.
 *
 *   EXPLICIT — `doc.people[]`, for the documents a signer list cannot describe: a trade
 *     assignment that matters to an investor who never signed it, a payoff a broker needs
 *     on file. Added by hand, removable, and recorded with who linked it and when.
 *
 * A derived link is never written down, so correcting a signer's email fixes the profile
 * it shows on — there is no stale copy to chase.
 *
 * ── Who can see it ──
 * The e-sign index is org-wide, but a client record is owner-scoped, so "every doc whose
 * signer email matches" would leak one LO's document onto another LO's copy of the same
 * borrower. visibleTo() is the gate: staff (admin / processor) see everything, everyone
 * else sees documents they own or that are filed to a loan they own.
 */
import { normalizeEmail } from './auth.mjs';

/** Loose name key so case, punctuation and double spaces don't split one person in two. */
export function nameKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Every email a person record answers to, normalized and de-duped. */
export function emailsOf(person) {
  const p = person || {};
  const out = [];
  const push = (v) => {
    const e = normalizeEmail(v || '');
    if (e && e.includes('@') && out.indexOf(e) < 0) out.push(e);
  };
  // Clients and brokers (brokers ARE clients with _isBroker — see brokers.html, which
  // opens them in client-details.html).
  push(p.email); push(p.contactEmail); push(p.brokerEmail); push(p.secondaryEmail);
  // Investors keep their contact on pocEmail (investors-save.mjs).
  push(p.pocEmail);
  (Array.isArray(p.emails) ? p.emails : []).forEach(push);
  // A client's other guarantors sign under their own addresses.
  (Array.isArray(p.guarantors) ? p.guarantors : []).forEach((g) => push(g && g.email));
  return out;
}

/** The explicit-link shape. Returns null when the caller sent something unusable. */
export function normalizePersonRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const kind = ['client', 'broker', 'investor'].indexOf(String(raw.kind || '')) >= 0 ? String(raw.kind) : '';
  const id = String(raw.id || '').slice(0, 80).trim();
  if (!kind || !id) return null;
  return {
    kind, id,
    name: String(raw.name || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    email: normalizeEmail(raw.email || ''),
    // clients/brokers are owner-scoped; investors are org-wide and carry ''.
    ownerKey: String(raw.ownerKey || raw.owner || '').slice(0, 120),
  };
}

/**
 * Does this document belong to this person, and why?
 * @returns { linked, via: 'signed'|'linked'|'', signer, at } — `via` is what the profile
 *          shows, so a processor can tell "they signed this" from "someone filed it here".
 */
export function docBelongsTo(doc, person, kind) {
  const d = doc || {};
  const mails = emailsOf(person);
  // 1. EXPLICIT wins, because a human said so.
  const pid = String((person && person.id) || '');
  const explicit = (Array.isArray(d.people) ? d.people : []).find((p) =>
    p && String(p.id) === pid && (!kind || p.kind === kind));
  if (explicit) return { linked: true, via: 'linked', signer: null, at: explicit.at || d.completedAt || '' };
  // 2. DERIVED: they signed it. Email is the identity — names repeat, addresses don't.
  const signer = (Array.isArray(d.signers) ? d.signers : []).find((s) =>
    s && s.email && mails.indexOf(normalizeEmail(s.email)) >= 0);
  if (signer) return { linked: true, via: 'signed', signer, at: signer.signedAt || d.completedAt || '' };
  // 3. A person with no email on file is NOT matched by name. Two brothers in the same
  //    book would swap documents, and a signature page under the wrong name is the one
  //    outcome worth refusing outright (the 237.133 lesson).
  return { linked: false, via: '', signer: null, at: '' };
}

/**
 * Can this viewer see this document at all?
 * @param doc     an esign summary (projectDoc shape) or the full record
 * @param viewer  { email, staff } — staff = admin or processor
 * @param ownLoanIds  Set/array of loan ids the viewer owns (optional; '' skips the check)
 */
export function visibleTo(doc, viewer) {
  const v = viewer || {};
  if (v.staff) return true;
  const me = normalizeEmail(v.email || '');
  if (!me) return false;
  const d = doc || {};
  if (normalizeEmail(d.ownerEmail || '') === me) return true;
  // Filed to, or started from, a loan this person owns.
  const a = d.assignment || {};
  const l = d.loan || {};
  if (normalizeEmail(a.ownerKey || '') === me) return true;
  if (normalizeEmail(l.ownerKey || '') === me) return true;
  return false;
}

/** One row for a profile's Documents list. */
export function profileRow(doc, rel) {
  const d = doc || {};
  const signers = (Array.isArray(d.signers) ? d.signers : []);
  return {
    id: d.id,
    title: d.title || d.filename || 'Document',
    completedAt: d.completedAt || '',
    ownerEmail: d.ownerEmail || '',
    ownerName: d.ownerName || '',
    via: (rel && rel.via) || '',
    signedAt: (rel && rel.signer && rel.signer.signedAt) || '',
    signerName: (rel && rel.signer && (rel.signer.name || rel.signer.email)) || '',
    signers: signers.map((s) => ({ name: s.name || s.email || '', email: s.email || '', signedAt: s.signedAt || null })),
    // Where it was filed, so the profile can link straight through to the loan.
    loan: (d.assignment && d.assignment.loanId)
      ? { loanId: d.assignment.loanId, clientId: d.assignment.clientId, ownerKey: d.assignment.ownerKey,
          address: d.assignment.address || '', slaNumber: d.assignment.slaNumber || '',
          slugLabel: d.assignment.slugLabel || '' }
      : ((d.loan && d.loan.loanId)
          ? { loanId: d.loan.loanId, clientId: d.loan.clientId, ownerKey: d.loan.ownerKey,
              address: d.loan.address || '', slaNumber: '', slugLabel: '' }
          : null),
  };
}

/**
 * Every completed document that belongs to this person, newest first.
 * @param summaries  esignIndex list (projectDoc shape)
 */
export function docsForPerson(summaries, person, kind, viewer) {
  const out = [];
  for (const d of (Array.isArray(summaries) ? summaries : [])) {
    if (!d || d.status !== 'completed') continue;      // only EXECUTED documents
    if (!visibleTo(d, viewer)) continue;
    const rel = docBelongsTo(d, person, kind);
    if (!rel.linked) continue;
    out.push(profileRow(d, rel));
  }
  out.sort((a, b) => String(b.completedAt || '').localeCompare(String(a.completedAt || '')));
  return out;
}
