/**
 * loan-uw-fields.js — Field registry for the Underwriting + Lightning Docs
 * tabs (Deploy 236.489, Phase 1a of the AI Underwriting / Doc-Prep tool).
 *
 * SCOPE: RTL loans only (this sheet is the RTL one). A separate DSCR field
 * set + calcs come later — the tab shell will branch on loan.toolType.
 *
 * This is the SPEC BACKBONE, transcribed from Mike's Google Sheet:
 *   - Lightning Docs = sheet columns F (item) / G (value) / H (source)
 *   - Underwriting   = sheet columns J (item) / K (value) / L (source)
 *
 * LOCKED CALC FORMULAS (Mike, RTL):
 *   monthlyPayment       = Loan × Rate ÷ 12
 *   ltarv                = Loan ÷ ARV
 *   ltc                  = same as the term sheet (Loan ÷ (Purchase + Reno))
 *   ltaiv                = Loan ÷ As-is Value
 *   prepaidInterest      = Loan × Rate ÷ 365 × days, where days = funding
 *                          date → end of that month (365-day basis)
 *   liquidityTotal       = Σ(account balance × its weight) + EMD paid
 *   liquidityRequirement = Cash to Close + 20% × Renovation + 6 months
 *                          interest  (= RTL sizer Cash Reserve, 236.485)
 *   assignmentToPurchase = Assignment Fee ÷ Purchase Price  (RED if > 15%)
 * HUD Balancing + Profit Analysis are OUT (separate manual tabs later).
 *
 * Every field carries a `source` tier that drives HOW it gets populated —
 * this ordering is the accuracy safeguard (most-trustworthy source wins):
 *
 *   'loan'   — deterministic, from OUR system of record (loan/term-sheet).
 *              Never AI-guessed. `loanField` names the mapping (wired in
 *              the auto-fill step). Provenance: "from loan record".
 *   'const'  — a fixed constant (`const` holds the value).
 *   'calc'   — computed by the deterministic engine (Phase 1c). `calc`
 *              names the formula id. Never AI, never hand-typed.
 *   'doc'    — lives in an uploaded document (`docType` = where). Populated
 *              by a human OR (Phase 3) proposed by AI and human-confirmed.
 *              Every AI value stays 'unverified' until a person approves it.
 *   'manual' — free entry, no auto-source.
 *
 * Persistence (Phase 1b): each loan gets loan.uwData / loan.lightningData,
 * a map of { key: { value, source, sourceNote, by, byName, isAI, at } }.
 * Every write appends to loan.uwAudit[] / loan.lightningAudit[] with the
 * full before/after + actor (or AI + note). Nothing is ever silently set.
 *
 * NOTE: `loanField` mappings marked /*?*​/ are best-guess and get verified
 * against the real loan record when auto-fill is wired — do not treat them
 * as final until then.
 */
(function () {

  // ── LIGHTNING DOCS (sheet F/G/H) ─────────────────────────────────
  // Grouped into display sections. `sourceNote` mirrors the sheet's
  // column H so the closer sees where each value is expected to come from.
  var LIGHTNING_DOCS_FIELDS = [
    // — Borrower / Entity —
    { key: 'borrowerName',       label: 'Borrower Name',        section: 'Borrower / Entity', source: 'loan',   loanField: 'entityName',         sourceNote: 'AOO (entity name)' },
    { key: 'aooOrDl',            label: 'AOO or DL',            section: 'Borrower / Entity', source: 'doc',    docType: 'AOO / DL',             sourceNote: '' },
    { key: 'organizationState',  label: 'Organization State',   section: 'Borrower / Entity', source: 'doc',    docType: 'AOO',                  sourceNote: 'AOO' },
    { key: 'borrowerAddress',    label: 'Borrower Address',     section: 'Borrower / Entity', source: 'doc',    docType: 'Application/Baseline', sourceNote: 'Application/Baseline' },
    { key: 'entityManagerTitle', label: 'Entity Manager Title', section: 'Borrower / Entity', source: 'doc',    docType: 'Operating Agreement', sourceNote: 'Operating Agreement' },

    // — Valuation —
    { key: 'arv',                label: 'ARV',                  section: 'Valuation',        source: 'loan',   loanField: 'arv',                sourceNote: '' },
    { key: 'bpoValuation',       label: 'BPO/Valuation',        section: 'Valuation',        source: 'doc',    docType: 'BPO/Valuation',        sourceNote: '' },

    // — Guarantors —
    { key: 'guarantor1Name',     label: 'Guarantor 1 Name',     section: 'Guarantors',       source: 'doc',    docType: 'Application/Baseline', sourceNote: 'Application/Baseline' },
    { key: 'guarantor2Name',     label: 'Guarantor 2 Name',     section: 'Guarantors',       source: 'doc',    docType: 'Application/Baseline', sourceNote: 'Application/Baseline' },
    { key: 'guarantor1Address',  label: 'Guarantor 1 Address',  section: 'Guarantors',       source: 'doc',    docType: 'Application/Baseline', sourceNote: 'Application/Baseline' },
    { key: 'guarantor2Address',  label: 'Guarantor 2 Address',  section: 'Guarantors',       source: 'doc',    docType: 'Application/Baseline', sourceNote: 'Application/Baseline' },

    // — Broker —
    { key: 'brokerName',         label: 'Broker Name',          section: 'Broker',           source: 'loan',   loanField: 'brokerName',         sourceNote: 'Baseline' },
    { key: 'brokerLicense',      label: 'Broker License #',     section: 'Broker',           source: 'doc',    docType: 'Baseline',             sourceNote: 'Baseline' },
    { key: 'brokerAddress',      label: 'Broker Address',       section: 'Broker',           source: 'doc',    docType: 'Baseline',             sourceNote: 'Baseline' },

    // — Property / Title —
    { key: 'subjectPropertyAddress', label: 'Subject Property Address', section: 'Property / Title', source: 'loan', loanField: 'address',      sourceNote: 'Title Commitment' },
    { key: 'parcelNumber',       label: 'Parcel #',             section: 'Property / Title', source: 'doc',    docType: 'Title Commitment',     sourceNote: 'Title Commitment' },
    { key: 'propertyCounty',     label: 'Property County',      section: 'Property / Title', source: 'doc',    docType: 'Title Commitment',     sourceNote: 'Title Commitment' },
    { key: 'titleCompanyName',   label: 'Title Company Name',   section: 'Property / Title', source: 'doc',    docType: 'Title Commitment',     sourceNote: 'Title Commitment' },
    { key: 'titleOfficerName',   label: 'Title Officer Name',   section: 'Property / Title', source: 'doc',    docType: 'Title Commitment',     sourceNote: 'Title Commitment' },
    { key: 'titleOfficerEmail',  label: 'Title Officer Email',  section: 'Property / Title', source: 'doc',    docType: 'Baseline',             sourceNote: 'Baseline' },
    { key: 'titleCommitmentNumber', label: 'Title Commitment Number', section: 'Property / Title', source: 'doc', docType: 'Title Commitment', sourceNote: 'Title Commitment' },
    { key: 'titleCommitmentDate', label: 'Title Commitment Date', section: 'Property / Title', source: 'doc',  docType: 'Title Commitment',     sourceNote: 'Title Commitment' },
    { key: 'exceptionsToDelete', label: 'Exceptions to be Deleted', section: 'Property / Title', source: 'doc', docType: 'Underwriting',        sourceNote: 'Underwriting' },
    { key: 'additionalEndorsements', label: 'Additional Endorsements', section: 'Property / Title', source: 'doc', docType: 'Underwriting',     sourceNote: 'Underwriting' },
    { key: 'earliestSigningDate', label: 'Earliest Signing Date', section: 'Property / Title', source: 'doc',  docType: 'PSA or Assignment',    sourceNote: 'PSA or Assignment' },

    // — Loan Terms (from the term sheet = our loan record) —
    { key: 'slaLoanNumber',      label: 'SLA Loan Number',      section: 'Loan Terms',       source: 'loan',   loanField: 'slaDisplayId',       sourceNote: 'Baseline' },
    { key: 'loanTermMonths',     label: 'Loan Term (Months)',   section: 'Loan Terms',       source: 'const',  const: '12',                     sourceNote: 'Term Sheet' },
    { key: 'loanAmount',         label: 'Loan Amount',          section: 'Loan Terms',       source: 'loan',   loanField: 'loanAmt',            sourceNote: 'Term Sheet' },
    { key: 'interestRate',       label: 'Interest Rate',        section: 'Loan Terms',       source: 'loan',   loanField: 'rate',               sourceNote: 'Term Sheet' },
    { key: 'interestOnlyPeriod', label: 'Interest Only Period', section: 'Loan Terms',       source: 'const',  const: '12',                     sourceNote: 'Term Sheet' },
    { key: 'interestAccrualType', label: 'Interest Accrual Type', section: 'Loan Terms',     source: 'loan',   loanField: 'dutchInterest',      sourceNote: 'Term Sheet' },
    { key: 'constructionHoldback', label: 'Construction Holdback', section: 'Loan Terms',    source: 'loan',   loanField: 'rehabBudget',        sourceNote: 'Term Sheet' },

    // — Fees (all from the term sheet / our fee schedule) —
    { key: 'brokerOriginationFee', label: 'Broker Origination Fee', section: 'Fees',         source: 'calc',   calc: 'brokerOriginationFee',    sourceNote: 'Broker % × loan' },
    { key: 'brokerOtherFees',    label: 'Broker Other Fees',    section: 'Fees',             source: 'manual',                                  sourceNote: 'Term Sheet' },
    { key: 'originationFee',     label: 'Origination Fee',      section: 'Fees',             source: 'calc',   calc: 'originationFee',          sourceNote: 'Loan × points' },
    { key: 'documentPrepFee',    label: 'Document Prep Fee',    section: 'Fees',             source: 'const',  const: '900',                    sourceNote: 'Term Sheet' },
    { key: 'underwritingFee',    label: 'Underwriting Fee',     section: 'Fees',             source: 'const',  const: '600',                    sourceNote: 'Term Sheet' },
    { key: 'processingFee',      label: 'Processing Fee',       section: 'Fees',             source: 'const',  const: '500',                    sourceNote: 'Term Sheet' },
    { key: 'creditBackgroundFee', label: 'Credit & Background Fee', section: 'Fees',         source: 'const',  const: '150',                    sourceNote: 'Term Sheet' },
    { key: 'prepaidInterest',    label: 'Prepaid Interest',     section: 'Fees',             source: 'calc',   calc: 'prepaidInterest',         sourceNote: 'Calculated' },

    // — Constants / Servicing —
    { key: 'loanServicer',       label: 'Loan Servicer',        section: 'Servicing',        source: 'doc',    docType: 'Underwriting',         sourceNote: 'Underwriting' },
    { key: 'fundingSource',      label: 'Funding Source',       section: 'Servicing',        source: 'loan',   loanField: 'fundingSource',      sourceNote: 'Underwriting' },
    { key: 'mortgageeClause',    label: 'Mortgagee Clause',     section: 'Servicing',        source: 'const',  const: 'Sir Lends A Lot, LLC ISAOA/ATIMA', sourceNote: 'Baseline' },
  ];

  // ── UNDERWRITING (sheet J/K/L) ───────────────────────────────────
  // `flag` marks fields the red-flag engine (Phase 1d) evaluates against
  // the Underwriting Guidelines. The rule set is confirmed with Mike
  // before it's implemented — placeholders only for now.
  var UNDERWRITING_FIELDS = [
    // — Deal terms —
    { key: 'asIsPrice',      label: 'As-is Price',    section: 'Deal',   source: 'doc',    docType: 'BPO/Valuation',   sourceNote: 'BPO/Valuation' },
    { key: 'purchasePrice',  label: 'Purchase Price (PSA)', section: 'Deal', source: 'loan', loanField: 'purchasePrice', sourceNote: 'PSA' },
    { key: 'assignmentContractPrice', label: 'Assignment Contract Price', section: 'Deal', source: 'doc', docType: 'Assignment Contract', sourceNote: 'Assignment Contract' },
    { key: 'assignmentFee',  label: 'Assignment Fee (listed)', section: 'Deal', source: 'doc', docType: 'Assignment Contract', sourceNote: 'Assignment Contract' },
    // Effective assignment fee: the listed fee if present & ≤ purchase price,
    // else (Assignment Contract Price − PSA Purchase Price). Drives A/P ratio.
    { key: 'assignmentFeeEffective', label: 'Assignment Fee (used)', section: 'Deal', source: 'calc', calc: 'assignmentFeeEffective', sourceNote: 'listed, or Assign price − PSA price' },
    { key: 'downPayment',    label: 'Down Payment',   section: 'Deal',   source: 'doc',    docType: 'Term Sheet',          sourceNote: 'Term Sheet' },
    { key: 'titleEscrowFees', label: 'Title/Escrow Fees', section: 'Deal', source: 'doc',  docType: 'HUD Statement',   sourceNote: 'HUD Statement' },

    // — Borrower / Credit —
    { key: 'lowCredit',      label: 'Low Credit',     section: 'Borrower', source: 'doc',  docType: 'Credit Report',   sourceNote: 'Credit Report', flag: true },
    { key: 'middleCredit',   label: 'Middle Credit',  section: 'Borrower', source: 'doc',  docType: 'Credit Report',   sourceNote: 'Credit Report', flag: true },
    { key: 'usCitizen',      label: 'US Citizen',     section: 'Borrower', source: 'doc',  docType: 'Loan Application', sourceNote: 'Loan Application' },
    { key: 'maritalStatus',  label: 'Marital Status', section: 'Borrower', source: 'doc',  docType: 'Loan Application', sourceNote: 'Loan Application' },

    // — Ratios (all calculated; red-flagged vs guidelines) —
    { key: 'monthlyPayment', label: 'Monthly Payment', section: 'Ratios', source: 'calc', calc: 'monthlyPayment', sourceNote: 'Calculated' },
    { key: 'ltarv',          label: 'LTARV',          section: 'Ratios', source: 'calc',  calc: 'ltarv',           sourceNote: 'Calculated', flag: true },
    { key: 'ltc',            label: 'LTC',            section: 'Ratios', source: 'calc',  calc: 'ltc',             sourceNote: 'Calculated', flag: true },
    { key: 'ltaiv',          label: 'LTAIV',          section: 'Ratios', source: 'calc',  calc: 'ltaiv',           sourceNote: 'Calculated', flag: true },
    { key: 'assignmentToPurchase', label: 'Assignment to Purchase', section: 'Ratios', source: 'calc', calc: 'assignmentToPurchase', sourceNote: 'RED if > 15%', flag: true },

    // — Liquidity —
    // Each account carries { type, balance, weight }. The type picks the
    // weight from ACCOUNT_WEIGHTS (sheet cols N/O); weight is editable per
    // account to cover the exceptions (100% joint checking, 100% stocks if
    // 63+, HELOC by % business ownership). `accountRow: true` tells the UI
    // to render the type-dropdown + balance + weight triple.
    { key: 'account1', label: 'Account 1', section: 'Liquidity', source: 'doc', accountRow: true, docType: 'Most Recent Account Statement', sourceNote: 'Most Recent Account Statement' },
    { key: 'account2', label: 'Account 2', section: 'Liquidity', source: 'doc', accountRow: true, docType: 'Most Recent Account Statement', sourceNote: 'Most Recent Account Statement' },
    { key: 'account3', label: 'Account 3', section: 'Liquidity', source: 'doc', accountRow: true, docType: 'Most Recent Account Statement', sourceNote: 'Most Recent Account Statement' },
    { key: 'account4', label: 'Account 4', section: 'Liquidity', source: 'doc', accountRow: true, docType: 'Most Recent Account Statement', sourceNote: 'Most Recent Account Statement' },
    { key: 'account5', label: 'Account 5', section: 'Liquidity', source: 'doc', accountRow: true, docType: 'Most Recent Account Statement', sourceNote: 'Most Recent Account Statement' },
    // Earnest Money PAID counts toward liquidity at 100% (Mike). Source is
    // the PSA / Assignment contract, not the title EMD receipt.
    { key: 'emd',            label: 'EMD (earnest money paid)', section: 'Liquidity', source: 'doc', docType: 'PSA / Assignment', sourceNote: 'PSA or Assignment' },
    // Available liquidity = Σ(account balance × its weight) + EMD paid.
    { key: 'liquidityTotal', label: 'Total (weighted liquidity)', section: 'Liquidity', source: 'calc', calc: 'liquidityTotal', sourceNote: 'Σ(account × weight) + EMD' },
    // Requirement (Mike) = Cash to Close + 20% × Renovation + 6 months
    // interest — identical to the RTL sizer's Cash Reserve (Deploy 236.485).
    // RED-flagged when weighted liquidity Total < Requirement.
    { key: 'liquidityRequirement', label: 'Liquidity Requirement', section: 'Liquidity', source: 'calc', calc: 'liquidityRequirement', sourceNote: 'Cash to Close + 20% Reno + 6mo interest', flag: true },
    { key: 'liquidityNotes', label: 'Liquidity Notes', section: 'Liquidity', source: 'manual', sourceNote: '' },

    // NOTE (Mike, RTL sheet): HUD Balancing + Profit Analysis are NOT part
    // of underwriting — they'll be their own manually-entered tabs later,
    // so they're intentionally omitted from this field set.
  ];

  // Account-type → liquidity weight (sheet cols N/O). `weight` is the
  // DEFAULT; each account's weight is editable per deal for the noted
  // exceptions. Order = the account-type dropdown order.
  var ACCOUNT_WEIGHTS = [
    { type: 'Checking/Savings',            weight: 0.70, note: '100% if joint checking' },
    { type: 'Stocks/Mutual Funds',         weight: 0.50, note: '100% if 63 y/o' },
    { type: 'IRA/401k/Retirement Plans',   weight: 0.00, note: '' },
    { type: 'HELOC',                       weight: 0.00, note: '0–100% by % business ownership' },
    { type: 'Business Checking Acct.',     weight: 1.00, note: '100%' },
  ];

  var _API = {
    LIGHTNING_DOCS_FIELDS: LIGHTNING_DOCS_FIELDS,
    UNDERWRITING_FIELDS: UNDERWRITING_FIELDS,
    ACCOUNT_WEIGHTS: ACCOUNT_WEIGHTS,
  };
  if (typeof window !== 'undefined') window.SLA_UW_FIELDS = _API;
  if (typeof module !== 'undefined' && module.exports) module.exports = _API;
})();
