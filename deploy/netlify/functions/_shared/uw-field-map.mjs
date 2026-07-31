/**
 * _shared/uw-field-map.mjs — Deploy 236.500 (AI auto-grab, Phase 3).
 *
 * Maps a Document-Review checklist SLUG → the Underwriting / Lightning Docs
 * fields the AI should extract from that document type, and writes them onto
 * the loan as UNVERIFIED proposals (verified:false) for a human to confirm.
 *
 * The doc→field pairing mirrors the sheet's "Location" column (encoded in
 * loan-uw-fields.js). Only fields that genuinely live IN a document are here;
 * loan-record / constant / calculated fields are never AI-touched.
 *
 * `dataset` = 'uw' | 'lightning'; `key` matches loan-uw-fields.js; `label` is
 * the extraction instruction handed to Claude (be explicit — accuracy).
 *
 * ACCURACY GUARDRAIL: only fields whose registry source is 'doc' (or 'manual')
 * may appear here. Never AI-overlay a 'loan'/'const'/'calc' field — those are
 * authoritative or computed, are NOT editable inline, and feed the pricing
 * calcs. e.g. `purchasePrice` and `arv` are source:'loan' (the LO-entered,
 * pricing-basis values) — the AI-read PSA price / BPO ARV are cross-checks a
 * human eyeballs, NOT values that should silently replace the loan record.
 */
export const SLUG_FIELD_MAP = {
  articles_of_organization: [
    { dataset: 'lightning', key: 'organizationState', label: 'The state where the LLC was formed / organized' },
  ],
  operating_agreement: [
    { dataset: 'lightning', key: 'entityManagerTitle', label: "The managing person's exact TITLE (e.g. Manager, Managing Member, Member)" },
  ],
  title_commitment: [
    { dataset: 'lightning', key: 'parcelNumber',          label: 'The parcel number / APN of the subject property' },
    { dataset: 'lightning', key: 'propertyCounty',        label: 'The county the subject property is in' },
    { dataset: 'lightning', key: 'titleCompanyName',      label: 'The title company / underwriter name' },
    { dataset: 'lightning', key: 'titleOfficerName',      label: 'The title officer / escrow officer name' },
    { dataset: 'lightning', key: 'titleCommitmentNumber', label: 'The title commitment / order / file number' },
    { dataset: 'lightning', key: 'titleCommitmentDate',   label: 'The commitment effective date, as YYYY-MM-DD' },
  ],
  psa: [
    // NOTE: purchasePrice is source:'loan' (pricing basis) — intentionally NOT
    // AI-written. The PSA price is a human cross-check against the loan record.
    { dataset: 'lightning', key: 'earliestSigningDate', label: 'The earliest signature / execution date on the agreement, as YYYY-MM-DD' },
  ],
  assignment_agreement: [
    { dataset: 'uw',        key: 'assignmentContractPrice', label: 'The purchase price stated on THIS assignment contract (number only)' },
    { dataset: 'uw',        key: 'assignmentFee',           label: 'The assignment fee EXPLICITLY stated on the contract (number), or null if none is stated' },
    { dataset: 'lightning', key: 'earliestSigningDate',     label: 'The earliest signature date on the assignment, as YYYY-MM-DD' },
  ],
  credit_report: [
    { dataset: 'uw', key: 'lowCredit',    label: 'The LOWEST of the three bureau credit scores for the primary guarantor (number)' },
    { dataset: 'uw', key: 'middleCredit', label: 'The MIDDLE of the three bureau credit scores for the primary guarantor (number)' },
  ],
  bpo_valuation: [
    // NOTE: arv is source:'loan' (pricing basis) — intentionally NOT AI-written.
    // The BPO ARV is a human cross-check against the loan record's ARV.
    { dataset: 'uw',        key: 'asIsPrice',    label: 'The AS-IS value / current value (number only)' },
    { dataset: 'lightning', key: 'bpoValuation', label: 'The BPO / valuation figure this report concludes (number only)' },
  ],
  loan_application: [
    { dataset: 'uw',        key: 'usCitizen',        label: 'Is the borrower/guarantor a U.S. citizen? Answer exactly "Yes" or "No"' },
    { dataset: 'uw',        key: 'maritalStatus',    label: 'The borrower/guarantor marital status (Single / Married / Divorced / Widowed)' },
    { dataset: 'lightning', key: 'borrowerAddress',  label: 'The borrower / entity mailing address' },
    { dataset: 'lightning', key: 'guarantor1Name',   label: 'Guarantor 1 full legal name' },
    { dataset: 'lightning', key: 'guarantor2Name',   label: 'Guarantor 2 full legal name, or null if only one guarantor' },
    { dataset: 'lightning', key: 'guarantor1Address',label: 'Guarantor 1 home address' },
    { dataset: 'lightning', key: 'guarantor2Address',label: 'Guarantor 2 home address, or null if only one guarantor' },
  ],
  emd_receipt: [
    { dataset: 'uw', key: 'emd', label: 'The earnest money deposit (EMD) amount that was PAID (number only)' },
  ],
};

// Keys that are source:'loan'/'const'/'calc' in loan-uw-fields.js — pricing
// basis or computed. The AI must NEVER write these (they're not editable
// inline and feed the LTC/LTARV/liquidity calcs). Belt-and-suspenders choke
// point so a future SLUG_FIELD_MAP edit can't silently reintroduce an overlay.
const NEVER_AI_WRITE = {
  purchasePrice: 1, arv: 1, loanAmt: 1, interestRate: 1, asIsValue: 1,
  assignmentFeeEffective: 1, monthlyPayment: 1, ltarv: 1, ltc: 1, ltaiv: 1,
  assignmentToPurchase: 1, prepaidInterest: 1, liquidityTotal: 1,
  liquidityRequirement: 1,
};

// Return the extraction spec for a given checklist slug (or null). Any
// protected (non-editable) key is stripped defensively.
export function fieldsForSlug(slug) {
  const spec = SLUG_FIELD_MAP[String(slug || '')];
  if (!spec) return null;
  const safe = spec.filter(function (f) { return !NEVER_AI_WRITE[f.key]; });
  return safe.length ? safe : null;
}
