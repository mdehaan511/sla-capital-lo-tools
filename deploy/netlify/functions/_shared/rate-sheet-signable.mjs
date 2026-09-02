/**
 * rate-sheet-signable.mjs — Deploy 236.846 (Mike)
 *
 * Server-side twin of the `SLARateSheet` block at the bottom of
 * deploy/sla-api.js. There is no bundler in this project, so the browser
 * copy and this one are deliberate duplicates: CHANGE THEM TOGETHER.
 *
 * The question both answer: can this loan's rate sheet be sent for
 * SIGNATURE, or is it only a preliminary pricing document?
 *
 * The rule is PARTY-based, not slot-based. A rate sheet is signable when the
 * loan carries at least one real person we could put on the signature line —
 * first name, last name, a usable email — and that person is not the broker.
 * Candidate parties are the primary client (the UI labels them "Guarantor 1
 * (Primary)") plus every linked guarantor.
 *
 * Why the broker check: on broker deals LOs have been filling the primary
 * client record with the BROKER's contact info (see the Deploy 236.327 note
 * in loan-details.js, where the Borrower LLC box showed the broker "Nexa
 * Lending" instead of the vesting entity). The rate sheet then went out for
 * signature to the broker rather than to the party obligated on the loan.
 */

function s(v) { return String(v == null ? '' : v).trim(); }
function low(v) { return s(v).toLowerCase(); }
function nameKey(v) { return low(v).replace(/[.,]/g, '').replace(/\s+/g, ' '); }

/**
 * A "real" email — good enough to put a signing invitation behind.
 * Rejects the `no-email-<loanid>@unspecified.sla` stub that the link-only
 * send path writes onto envelopes; an envelope carrying that placeholder is
 * not evidence of a contactable signer.
 */
export function realEmail(v) {
  const e = low(v);
  if (!e || e.includes('@unspecified.sla')) return false;
  if (/^(no-?reply|donotreply)@/.test(e)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);
}

export function fullName(p) {
  if (!p) return '';
  const n = `${s(p.firstName)} ${s(p.lastName)}`.trim();
  return n || s(p.name);
}

/**
 * Broker identity on the loan. brokerEmail / brokerName live at the top level
 * on LO-entered loans and under formData on the ones that arrived through the
 * public application, so both are checked.
 */
export function brokerOf(loan) {
  const l = loan || {};
  const fd = l.formData || {};
  const email = low(l.brokerEmail || fd.brokerEmail || '');
  const names = [];
  for (const n of [l.brokerName, fd.brokerName, l.brokerCompany, fd.brokerCompany]) {
    const v = nameKey(n);
    if (v && !names.includes(v)) names.push(v);
  }
  return { email, names, present: !!(email || names.length) };
}

export function isBroker(party, broker) {
  if (!broker || !broker.present || !party) return false;
  if (broker.email && low(party.email) === broker.email) return true;
  const n = nameKey(fullName(party));
  return !!n && broker.names.includes(n);
}

/** Why one party can't be the signer. '' means they can. */
export function partyProblem(party, broker) {
  if (!party) return 'missing';
  if (!s(party.firstName) || !s(party.lastName)) return 'name';
  if (!realEmail(party.email)) return 'email';
  if (isBroker(party, broker)) return 'broker';
  return '';
}

const REASONS = {
  missing: 'This loan has no borrower or guarantor on file.',
  name:    'The borrower/guarantor on this loan is missing a first or last name.',
  email:   'The borrower/guarantor on this loan has no email address.',
  broker:  'The only contact on this loan is the broker. A rate sheet has to be signed by the borrower or a guarantor, not by the broker.',
};
// Ranked worst -> closest to passing, so the message names the thing the LO
// most needs to fix rather than whichever party happened to be checked first.
const RANK = ['missing', 'broker', 'email', 'name'];

/**
 * @param {object} client      the loan's primary client record (Guarantor 1)
 * @param {object} loan        the loan record
 * @param {Array}  guarantors  OPTIONAL resolved guarantor client records.
 *   Callers that can resolve loan.guarantorClientIds should pass them; the
 *   fallback is the denormalized loan.guarantors[] array, which can lag a
 *   manual "+ Add Guarantor".
 * @returns {{ok:boolean, reason:string, signer:object|null, broker:object, parties:Array}}
 */
export function rateSheetSignable(client, loan, guarantors) {
  const l = loan || {};
  const broker = brokerOf(l);
  const parties = [];
  if (client) parties.push(client);
  const extra = (guarantors && guarantors.length)
    ? guarantors
    : (Array.isArray(l.guarantors) ? l.guarantors : []);
  for (const g of extra) if (g) parties.push(g);

  if (!parties.length) {
    return { ok: false, reason: REASONS.missing, signer: null, broker, parties: [] };
  }

  let worst = null;
  for (const p of parties) {
    const why = partyProblem(p, broker);
    if (!why) return { ok: true, reason: '', signer: p, broker, parties };
    if (worst === null || RANK.indexOf(why) < RANK.indexOf(worst)) worst = why;
  }
  return { ok: false, reason: REASONS[worst] || REASONS.missing, signer: null, broker, parties };
}

/**
 * Resolve a loan's guarantor client records out of the same client blob the
 * caller already loaded, falling back to a supplied lookup for guarantors that
 * live under a different primary client. Callers that only have the one client
 * record can pass it alone — guarantors linked to OTHER client records simply
 * fall through to loan.guarantors[].
 */
export function guarantorsFromClient(loan, client) {
  const ids = Array.isArray(loan?.guarantorClientIds) ? loan.guarantorClientIds : [];
  if (!ids.length) return [];
  const out = [];
  // The denormalized array is the only thing a single-client read can offer.
  const flat = Array.isArray(loan.guarantors) ? loan.guarantors : [];
  for (const id of ids) {
    const hit = flat.find((g) => g && (g.id === id || g.clientId === id));
    if (hit) out.push(hit);
    else if (client && client.id === id) out.push(client);
  }
  return out;
}

export const PRELIM_TITLE = 'PRELIMINARY - NOT FOR SIGNATURE';
