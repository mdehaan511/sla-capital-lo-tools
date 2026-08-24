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
  // Deploy 236.681 — RTL guideline-driven Underwriting-tab auto-grab. These
  // populate the new RTL UW fields (loan-uw-fields.js) as unverified proposals
  // for the underwriter to confirm. (Harmless on DSCR reviews — no matching DSCR
  // registry field, so the proposal simply isn't rendered.)
  appraisal: [
    { dataset: 'uw', key: 'asIsPrice',    label: 'The AS-IS / current market value the appraisal concludes (number only)' },
    { dataset: 'uw', key: 'propertyType', label: 'The property type as stated: "SFR" (single family), "2-4 Unit", "PUD", or "Condo" — or the exact type if none of these' },
    { dataset: 'uw', key: 'propertySqFt', label: 'The gross living area / square footage of the subject property (number only)' },
    { dataset: 'uw', key: 'rucaRural',    label: 'Does the appraisal designate the property as Rural? Answer exactly "Yes" or "No" (append the RUCA code if the report states one)' },
  ],
  sow: [
    { dataset: 'uw', key: 'rehabBudget',         label: 'The TOTAL renovation / rehab budget on this Statement of Work (number only)' },
    { dataset: 'uw', key: 'rehabContingencyPct', label: 'The contingency shown as a percent of the budget (number only, e.g. 10), or null if none is stated' },
  ],
  evidence_of_insurance: [
    { dataset: 'uw', key: 'insuranceLiability',  label: 'The general/personal liability coverage limit on the policy (number only)' },
    { dataset: 'uw', key: 'insuranceDeductible', label: 'The policy deductible as a number; if it is a percentage, return the percent value (number only)' },
  ],
  flood_certificate: [
    { dataset: 'uw', key: 'floodZone', label: 'The FEMA flood zone stated for the property (e.g. X, A, AE, V), or null if not stated' },
  ],
  final_hud: [
    { dataset: 'uw', key: 'titleEscrowFees', label: 'The total title + escrow / settlement fees charged to the borrower (number only)' },
    { dataset: 'uw', key: 'downPayment',     label: "The borrower's down payment / cash brought to close (number only)" },
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
