/**
 * _shared/loan-review-checklists.mjs — Phase 1 source of truth for which
 * documents need to be reviewed per loan type, and what the human +
 * AI processors should check on each. Encoded from the user-supplied
 * "DSCR - UW Sheet - DSCR Review Template" and "RTL - UW Sheet - RTL
 * Checklist" PDFs.
 *
 * Slug conventions (stable IDs — DO NOT RENAME once a review uses them):
 *   - lowercase, snake_case, no spaces
 *   - section prefix avoided (the `section` field already groups them)
 *
 * `optional: true` means the doc is "(if applicable)" — the processor
 * must explicitly mark it N/A with a reason if it doesn't apply to
 * this loan; otherwise an upload is required.
 *
 * `purchaseOnly: true` means the doc is only required for purchase
 * transactions (vs refi). For Phase 1 the processor decides this; we
 * don't yet infer purpose from the linked loan record.
 *
 * `investor: 'corrfirst'` (etc.) flags docs that only apply to a
 * specific investor. Phase 1 defaults: Diya = DSCR, Colchis = RTL.
 * If the loan ships to a different investor, the processor can
 * override which docs are required from the loan settings.
 */

export const SECTIONS = [
  { key: 'borrower',  label: 'Borrower Documents'  },
  { key: 'guarantor', label: 'Guarantor Documents' },
  { key: 'collateral',label: 'Collateral Documents'},
  { key: 'loan',      label: 'Loan Documents'      },
  { key: 'closing',   label: 'Closing Documents'   },
];

// Deploy 236.212 — DSCR checklist rewritten to match Mike's list
// derived from the Diya Underwriting Guidelines (Term - 2026.01.29).
// Slug identifiers preserved for docs that carry over (Operating
// Agreement, Articles, EIN, Bank Stmts, PFS, PSA, etc.) so existing
// reviews continue to render; renamed / new slugs are minted fresh.
// Any prior slug not on this list is removed from the checklist —
// old reviews retain their docs but won't require them going forward.
export const DSCR_DOCS = [
  // ── Borrower ──────────────────────────────────────────────────
  { slug: 'operating_agreement', label: 'Operating Agreement', section: 'borrower',
    conditions: 'Verify LLC name; identify all owners with 20%+ ownership; all signatures + initials present.' },
  { slug: 'articles_of_organization', label: 'Recorded Articles of Organization', section: 'borrower',
    conditions: 'Verify LLC name matches loan application; must be the recorded copy stamped by the Secretary of State.' },
  { slug: 'certificate_of_good_standing', label: 'Certificate of Good Standing', section: 'borrower',
    conditions: 'Within last 90 days; correct LLC listed; state seal; Secretary of State signature.' },
  { slug: 'entity_background_check', label: 'Entity Background Check', section: 'borrower',
    conditions: 'No bankruptcies, liens, or judgements within 90 days of close date.' },
  { slug: 'ofac_entity', label: 'OFAC Check (Entity)', section: 'borrower',
    conditions: 'Entity name on OFAC report matches Articles of Organization exactly.' },
  { slug: 'ein_letter', label: 'EIN Letter (Entity & Guarantors)', section: 'borrower',
    conditions: 'SS-4 form or filed tax return showing the entity\'s EIN.' },
  { slug: 'foreign_entity_registration', label: 'Registration as a Foreign Entity', section: 'borrower',
    conditions: 'Required when the borrowing LLC is formed in a different state than the subject property.', optional: true },
  { slug: 'track_record_reo', label: 'Real Estate Schedule & Track Record', section: 'borrower',
    conditions: 'Confirm all cells filled with reasonable info; addresses, values, mortgages, cash flow.' },
  { slug: 'bank_stmt_current', label: 'This Month\'s Bank Statements', section: 'borrower',
    conditions: 'Liquidity requirements met? Borrower\'s ownership of accounts verified?' },
  { slug: 'bank_stmt_previous', label: 'Last Month\'s Bank Statements', section: 'borrower',
    conditions: 'Liquidity requirements met? Borrower\'s ownership of accounts verified?' },
  { slug: 'voided_check_ach', label: 'Voided Check', section: 'borrower',
    conditions: 'Scan of a voided check for the account the loan payments will come from. Account holder should match borrower or a third-party payee form is required.' },

  // ── Guarantor ─────────────────────────────────────────────────
  // Deploy 236.708 — PFS is an OPTIONAL guarantor document (per Mike).
  { slug: 'pfs', label: 'Personal Financial Statement (PFS)', section: 'guarantor',
    conditions: 'Signed by all guarantors. Assets, liabilities, income, contingent liabilities.', optional: true },
  { slug: 'guarantor_id', label: 'ID for each Guarantor', section: 'guarantor',
    conditions: 'Driver\'s License or Passport for each guarantor; matches name on application; not expired.' },
  // Deploy 236.670 — added per Mike.
  { slug: 'proof_of_citizenship', label: 'Proof of Citizenship', section: 'guarantor',
    conditions: 'Citizenship / permanent-residency evidence for each guarantor (passport, birth certificate, naturalization certificate, or green card). Name matches the application.', optional: true },
  { slug: 'credit_authorization', label: 'Credit Authorization', section: 'guarantor',
    conditions: 'Signed by all guarantors.' },
  { slug: 'credit_report', label: 'Credit Report', section: 'guarantor',
    conditions: 'Middle score above 690? Any lates or past-due accounts? Report is < 90 days old?' },
  { slug: 'guarantor_background_check', label: 'Guarantor Background Check', section: 'guarantor',
    conditions: 'No bankruptcies, liens, or judgements; criminal report < 90 days old.' },
  { slug: 'ofac_personal', label: 'OFAC Check (Personal)', section: 'guarantor',
    conditions: 'Personal name of all guarantors must match exactly.' },

  // ── Collateral ────────────────────────────────────────────────
  { slug: 'psa', label: 'Purchase Agreement', section: 'collateral',
    conditions: 'Borrower listed as buyer; all parties signed; price matches application.', purchaseOnly: true },
  { slug: 'cost_basis', label: 'Cost Basis', section: 'collateral',
    conditions: 'Documentation of borrower\'s total invested basis (purchase price + rehab + closing costs).', optional: true },
  { slug: 'lease_agreements', label: 'Lease Agreements', section: 'collateral',
    conditions: 'Signed by landlord and tenant; term length; non-corporate tenant; rent verifies to the underwriting.' },
  // Deploy 236.670 — added per Mike (DSCR docs from the S7 Holdings package).
  { slug: 'proof_of_security_deposit', label: 'Proof of Security Deposit', section: 'collateral',
    conditions: 'Evidence the tenant security deposit(s) are held (bank record, ledger, or receipt). Amount is consistent with the lease(s).', optional: true },
  { slug: 'insurance_invoice', label: 'Insurance Invoice', section: 'collateral',
    conditions: 'Invoice for the property insurance premium. Annual premium, policy number, carrier, and named insured (borrower / LLC) shown; premium reasonable for the coverage.', optional: true },
  { slug: 'property_mgmt_summary', label: 'Property Management Summary', section: 'collateral',
    conditions: 'Summary of PM company\'s scope; fees; contact info.', optional: true },
  { slug: 'property_mgmt_agreement', label: 'Property Management Agreement', section: 'collateral',
    conditions: 'PMA signed; covers the subject property.', optional: true },
  { slug: 'property_mgmt_questionnaire', label: 'Property Management Questionnaire', section: 'collateral',
    conditions: 'PMQ completed in full.', optional: true },
  { slug: 'mortgage_statements_payoffs', label: 'Mortgage Statements / Payoffs', section: 'collateral',
    conditions: 'Existing mortgage information verified; unpaid balances confirmed; payoff figures current for refi.', optional: true },
  { slug: 'vom', label: 'VOM (Verification of Mortgage)', section: 'collateral',
    conditions: 'Existing mortgage information verified.', optional: true },
  { slug: 'property_insurance_binder', label: 'Property Insurance — Binder', section: 'collateral',
    conditions: 'Provided if the Dec Page is not yet available. Mortgagee clause; loan number; borrower name; coverage >= loan value; $1M liability.', optional: true },
  { slug: 'evidence_of_insurance', label: 'Property Insurance — Dec Page', section: 'collateral',
    conditions: 'Mortgagee clause; loan number; borrower/LLC name; coverage >= loan value; $1M liability; effective dates through closing.' },
  { slug: 'flood_insurance_policy', label: 'Flood Insurance Policy', section: 'collateral',
    conditions: 'Required if property is in a FEMA flood zone. Mortgagee clause; coverage meets guidelines.', optional: true },
  { slug: 'proof_of_insurance_pif', label: 'Proof of Property Insurance Paid-Through Date', section: 'collateral',
    conditions: 'Receipt or endorsement showing policy paid through closing.' },
  { slug: 'property_profile', label: 'Property Profile', section: 'collateral',
    conditions: 'Ownership history, parcel details, tax history, comparable properties.' },
  { slug: 'appraisal', label: 'Appraisal', section: 'collateral',
    conditions: 'Value >= loan amount; does NOT say "subject to"; appraiser certified; comps recent + within 1 mile.' },
  { slug: 'appraisal_receipt', label: 'Appraisal Receipt', section: 'collateral',
    conditions: 'Paid-in-full receipt for the appraisal.' },
  { slug: 'air', label: 'AIR (Appraisal Independence Report)', section: 'collateral',
    conditions: 'Appraisal Independence Report signed.' },
  { slug: 'cda_report', label: 'CDA Report', section: 'collateral',
    conditions: 'Value >= Appraised value.' },
  { slug: 'property_condition_assessment', label: 'Property Condition Assessment (PCA)', section: 'collateral',
    conditions: 'PCA report on subject property; deferred maintenance itemized; capital reserves recommended.', optional: true },
  { slug: 'flood_certificate', label: 'Flood Certificates', section: 'collateral',
    conditions: 'Life-of-loan flood cert; zone determination.' },
  { slug: 'condo_documents', label: 'Condo Documents', section: 'collateral',
    conditions: 'HOA docs, master insurance, budget, reserve study — for condo units only.', optional: true },
  { slug: 'environmental_survey', label: 'Environmental Survey (5+ MF)', section: 'collateral',
    conditions: 'Required for 5+ unit multifamily properties. Phase I ESA or transaction screen.', optional: true },

  // ── Loan ──────────────────────────────────────────────────────
  { slug: 'letter_of_intent', label: 'Letter of Intent', section: 'loan',
    conditions: 'LOI signed and dated; terms consistent with final loan.' },
  { slug: 'revised_loan_terms', label: 'New / Revised Loan Terms', section: 'loan',
    conditions: 'Reflects any changes since the original LOI; both parties agreed.', optional: true },
  { slug: 'loan_application', label: 'Loan Application / Credit Authorization', section: 'loan',
    conditions: 'All information filled out and accurate; signatures present; credit auth signed by every guarantor.' },
  { slug: 'term_sheet', label: 'Term Sheet', section: 'loan',
    conditions: 'Ensure it is the most up-to-date terms.' },
  { slug: 'outstanding_conditions', label: 'Outstanding Conditions & Documents', section: 'loan',
    conditions: 'Log of any remaining conditions that need resolution before funding.', optional: true },
  { slug: 'exception_request', label: 'Exception Request Form (TPO / Borrower)', section: 'loan',
    conditions: 'Signed exception form when a guideline exception is being requested.', optional: true },

  // ── Closing ───────────────────────────────────────────────────
  { slug: 'title_escrow_contact', label: 'Title / Escrow Contact Information', section: 'closing',
    conditions: 'Title company name; address; primary contact name; phone; email.' },
  { slug: 'title_commitment', label: 'Title Commitment / Preliminary Title Report', section: 'closing',
    conditions: 'Mortgagee Clause; loan number; borrower name; property address(es); 125% of loan value; date; exceptions reviewed.' },
  { slug: 'cpl', label: 'Title — Closing Protection Letter (CPL)', section: 'closing',
    conditions: 'Mortgagee Clause; loan number; property address; date.' },
  { slug: 'title_eo_insurance', label: 'Title — E&O Insurance', section: 'closing',
    conditions: 'Title company name; $1 million in protection; policy dates current.' },
  { slug: 'wire_instructions', label: 'Settlement Agent Wire Instructions', section: 'closing',
    conditions: 'Wire instructions for the title company. Verified via callback to a known number.' },
  { slug: 'prelim_settlement', label: 'Escrow — Estimated Closing Statement', section: 'closing',
    conditions: 'Loan amount correct; fees correct; prepaid interest; property address; borrower named.' },
  { slug: 'final_hud', label: 'Final HUD / Settlement Statement', section: 'closing',
    conditions: 'Final signed settlement statement (HUD / Closing Disclosure) collected AFTER closing. Loan amount, fees, prepaid interest, payoffs, and net wire all reconcile to the approved terms.' },
  { slug: 'tax_certificate', label: 'Tax Certificates', section: 'closing',
    conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed.' },
  // Deploy 236.670 — added per Mike (payoff of the existing lien on a refi).
  { slug: 'payoff_demand', label: 'Payoff Demand', section: 'closing',
    conditions: 'Payoff statement from the existing lender (refinance). Payoff amount, per-diem interest, and good-through date are current; lender + loan match the subject property.', optional: true },
  { slug: 'borrower_closing_funds_receipt', label: 'Borrower Closing Funds Receipt', section: 'closing',
    conditions: 'Requested day of closing.', purchaseOnly: true },
  { slug: 'emd_receipt', label: 'EMD Receipt', section: 'closing',
    conditions: 'Receipt showing borrower provided EMD to the title company.', purchaseOnly: true },
  { slug: 'invoice', label: 'Invoice', section: 'closing',
    conditions: 'Third-party fees invoiced (appraisal, PCA, environmental, etc.).', optional: true },
];

// Deploy 236.681 — RTL rubrics rewritten to the Colchis RTL Underwriting
// Guidelines (Mike, 2026-08-24). Each `conditions` string is the exact set of
// checkable thresholds the doc-review AI verifies for that document. The full
// guidelines PDF is also attached as the `colchis` investor reference so the AI
// has the complete ruleset + tier structure + geographic exclusions as context.
// HARD STOP = an item the guidelines allow no exception on at any tier.
export const RTL_DOCS = [
  // ── Borrower ──────────────────────────────────────────────────
  { slug: 'articles_of_organization', label: 'Articles of Organization', section: 'borrower',
    conditions: 'Government-filed certificate (state file number/stamp visible; NOT a screenshot, template, or unfiled draft). Entity name matches the loan application (ignore punctuation). Entity type is LLC, LP, LLP, C-Corp, or S-Corp — NOT an irrevocable trust, religious entity, tenant-in-common, non-profit, land trust, IRA-owned/managed entity, or an entity with more than 4 members/managers. U.S.-domiciled. If formed in a different state than the property, a Certificate of Foreign Qualification is required.' },
  { slug: 'entity_background_check', label: 'Entity Background Check', section: 'borrower',
    conditions: 'Report within 60 days of origination (and still within 60 days at the note date). Entity status Active (no expired registration, lapsed reports, termination, or recent agent change). Zero judgments, liens, bankruptcies, foreclosures, or NODs — or disclosed and resolved before closing; UCC filings zero or tied to a disclosed obligation. Formation state, date, and filing number reconcile to the Articles. Related parties (seller, assignor, contractor, title/closing agent, insurance agent, valuation provider, referring broker/LO) screened.' },
  { slug: 'bank_stmt_current', label: 'Current-Month Bank Statements', section: 'borrower',
    conditions: 'Two most recent statements, latest dated no more than 45 days before the note date; ALL pages present (no summary statement). Shows bank name, account number, account-holder name, and full transaction history. Available liquidity must cover down payment + 20% of the total rehab budget + 6 months of interest (PITIA). Asset weighting: checking/savings/money-market/CD/trust 100%; publicly traded stocks/bonds 70% of net; retirement 50% of vested (100% if the guarantor is 63+); business funds = the guarantor\'s ownership %. Joint accounts with a non-borrower holder count 50%; crypto, sweat equity, and unsecured credit lines are excluded. Account owner is the guarantor or the borrowing entity.' },
  { slug: 'bank_stmt_previous', label: 'Previous-Month Bank Statements', section: 'borrower',
    conditions: 'Second of the two most recent statements. All pages present (no summary). Bank name, account number, account holder, and full transaction history shown; account owned by the guarantor/entity. Balances support the liquidity requirement (down payment + 20% of rehab + 6 months interest) under the same asset weighting as the current-month statement.' },
  { slug: 'certificate_of_good_standing', label: 'Certificate of Good Standing', section: 'borrower',
    conditions: 'State-issued certificate (seal, signature, or filing number visible; NOT a screenshot). Entity name matches the Articles and the loan application. States the entity is active / in good standing (NOT delinquent, suspended, or administratively dissolved). Dated within 90 days of the note date. (Entity formed <60 days ago with no COGS available: active status confirmed directly with the Secretary of State and documented.)' },
  { slug: 'ein_or_w9', label: 'EIN Letter or W9', section: 'borrower',
    conditions: 'EIN letter is an IRS CP 575 or 147C showing an entity name matching the Articles and a readable EIN. If no EIN letter is available, a completed and signed W-9 instead (entity name, EIN, and a tax classification matching the entity type). An individual/single-member borrower with no EIN uses a W-9 with SSN.' },
  { slug: 'ofac_entity', label: 'OFAC Check (Entity)', section: 'borrower',
    conditions: 'OFAC run on the entity\'s legal name plus any DBA; name matches the loan application and the Articles exactly. No matches — or all matches conclusively ruled out via secondary identifiers (address, EIN, state of formation). Re-run if more than 30 days pass before closing. Any match that cannot be ruled out is escalated (Tier 3).' },
  { slug: 'operating_agreement', label: 'Operating Agreement', section: 'borrower',
    conditions: 'Entity name matches the loan application and Articles; filing state matches the Articles/COGS; no termination/expiration date. Every owner of 25%+ is named and is a natural person (chase any entity/trust owner down the chain to a natural person). The guarantors\' combined ownership interest is at least 51%. Management structure (member- vs manager-managed) is identified and the signer has authority to bind the entity. All owners signed with printed names beneath each signature; all referenced attachments/addenda are present and all pages complete.' },
  { slug: 'track_record', label: 'Track Record', section: 'borrower',
    conditions: 'Track Record / SREO covering the last 36 months, with each claimed project supported by a settlement statement/HUD-1 (or third-party property report) showing BOTH an acquisition and a disposition or refinance. Residential investment property only (SFR, multi-family, condo, PUD — NOT a primary/second home or vacant land). Counts combine all guarantors in the borrowing entity; partially documented projects do not count.' },
  { slug: 'voided_check', label: 'Voided Check', section: 'borrower',
    conditions: 'For the account payments will be drafted from. The borrower\'s and/or the borrowing entity\'s name is printed on the check; account number and routing number are clearly visible. A bank letter on letterhead showing account name, account number, and routing number is an acceptable substitute.' },
  { slug: 'borrower_loe', label: 'Borrower Letter of Explanation', section: 'borrower',
    conditions: 'As required — explains a specific flagged item (e.g. a non-arm\'s-length transaction or a background/credit finding). Dated and signed by the borrower; addresses the specific issue.', optional: true },

  // ── Guarantor ─────────────────────────────────────────────────
  { slug: 'guarantor_background_check', label: 'Guarantor Background Check', section: 'guarantor',
    conditions: 'Report within 60 days of origination (and still within 60 days at the note date); run on the full legal name from the government ID plus date of birth. SSN matches the application and credit report; residence identified (no PO Box). Zero judgments, liens, bankruptcies, foreclosures, or NODs — or disclosed and resolved. Driving offenses are noted; any other offense escalates. HARD STOP (no exception, any age): a financial-crime conviction (fraud, embezzlement, money laundering) or a violent-crime conviction.' },
  { slug: 'credit_authorization', label: 'Credit Authorization', section: 'guarantor',
    conditions: 'Signed and dated by every guarantor.' },
  { slug: 'credit_report', label: 'Credit Report', section: 'guarantor',
    conditions: 'Tri-merge report dated within 90 days of the note date. The file-representative score — the LOWEST of the per-guarantor middle scores across all guarantors and any 25%+ owner — is at least 680. Every late payment in the last 36 months and every derogatory item in the last 24 months has a Letter of Explanation. HARD STOP (4-year lookback, no exception): no foreclosure, short sale, deed-in-lieu, bankruptcy, lis pendens, or judgment. HARD STOP: no felony conviction of any age. SSN verified (credit-report notation, Social Security card, or SSA-89).' },
  { slug: 'guarantor_id', label: 'Guarantor ID (Driver’s License or Passport)', section: 'guarantor',
    conditions: 'Unexpired government-issued photo ID. Name matches the loan application, credit report, and entity documents; date of birth matches the application. A non-citizen provides a green card (both sides) or a visa plus passport. Any name discrepancy (nickname, maiden name) is resolved and documented.' },
  { slug: 'ofac_personal', label: 'OFAC Check (Personal)', section: 'guarantor',
    conditions: 'OFAC run on the full legal name including middle name; matches the government ID exactly. No matches — or partial matches conclusively ruled out via secondary identifiers (DOB, address, SSN fragment). Re-run if more than 30 days pass before closing. Any partial match that cannot be ruled out is escalated (Tier 3).' },
  { slug: 'guarantor_loe', label: 'Guarantor Letter of Explanation', section: 'guarantor',
    conditions: 'As required — explains a specific credit/background item. Dated and signed by the guarantor; addresses the specific issue.', optional: true },
  // Deploy 236.708 — PFS added to RTL/GUC as an OPTIONAL guarantor document (per Mike).
  { slug: 'pfs', label: 'Personal Financial Statement (PFS)', section: 'guarantor',
    conditions: 'Signed and dated by each guarantor. Lists assets, liabilities, income, and contingent liabilities; net worth and liquidity reconcile to the bank statements and the loan file.', optional: true },

  // ── Collateral ────────────────────────────────────────────────
  { slug: 'assignment_agreement', label: 'Assignment Agreement', section: 'collateral',
    conditions: 'Assignor matches the seller on the Purchase Agreement; assignee is the borrower. Price including the assignment fee matches the term sheet. Closing date on or after the date requested on the application. Signed by both the assignor and the borrower. Assignment fee is at most 15% of the Purchase Agreement price AND at most $75,000; total seller concessions are at most 5% of the gross purchase price. A fee above either cap requires a restructure (Tier 3).', optional: true },
  { slug: 'bpo_valuation', label: 'BPO / Valuation', section: 'collateral',
    conditions: 'A BPO / hybrid appraisal / AVM-with-interior-photos is acceptable ONLY for Light Rehab under $500,000 (Heavy Rehab, or Light Rehab of $500,000+, requires a full appraisal). Dated within 60 days of the note date. Comparables: at least 2 within 1 mile, or at least 3 in the same zip code, all sold within the last 12 months. Concluded value is at least the loan amount.' },
  { slug: 'evidence_of_insurance', label: 'Evidence of Insurance', section: 'collateral',
    conditions: 'A dec page, binder, or ACORD 27/28 EOI/COI — NOT a quote. Builder\'s Risk / Course-of-Construction (or equivalent) for any property with a rehab budget (a Dwelling Policy DP/DP-3 only for a no-renovation SFR/2–4). Coverage equals the loan amount or 100% of replacement cost, whichever is less, on a Replacement-Cost (RCV) basis — not ACV. Liability at least $1,000,000 ($500,000 acceptable only if documented as the insurer\'s maximum). Every deductible (incl. wind/hail/named-storm) is at most 5% of the loan amount or $5,000, whichever is less. Named insured matches the Articles entity exactly; mortgagee clause and loan number correct; property address matches the title commitment (all units if multi-unit); coverage effective on or before closing; a purchase policy runs at least 12 months. Vacancy is addressed in writing (vacant-property/Builder\'s Risk form or a written vacancy permit/endorsement).' },
  { slug: 'flood_certificate', label: 'Flood Certificate & Insurance', section: 'collateral',
    conditions: 'A flood certificate is pulled for the subject property; address matches exactly; flood zone stated. If the property is in Zone A or V, flood insurance is required: coverage is the lesser of 100% replacement cost, $250,000, or the unpaid principal balance; deductible at most $10,000; mortgagee clause and loan number correct; effective on or before closing; proof of payment on file.', optional: true },
  { slug: 'proof_of_insurance_pif', label: 'Proof of Insurance Paid in Full (PIF)', section: 'collateral',
    conditions: 'An actual receipt or invoice (NOT a screenshot) showing the borrower/entity name; the policy number matches the Evidence of Insurance; property address matches the subject; effective on or before closing; shows $0 owed or states paid in full. Confirmed within 3 days before closing — or the premium is collected on the settlement statement with coverage already bound.' },
  { slug: 'psa', label: 'Purchase and Sale Agreement (PSA)', section: 'collateral',
    conditions: 'Buyer is the borrowing entity (not an individual, unless the loan is not entity-vested); seller matches the currently vested owner on the title commitment; purchase price matches the term sheet (plus the assignment fee if an assignment contract is used). All addenda/amendments included; all contract dates valid (not expired without extension); all parties signed. A price mismatch means the loan is rebuilt — never proceed on a mismatch. Back-to-back/double-close spreads are treated as a wholesale fee (15% / $75,000 caps); a non-arm\'s-length transaction requires a borrower Letter of Explanation.', purchaseOnly: true },
  { slug: 'sow', label: 'Statement of Work (SOW)', section: 'collateral',
    conditions: 'A line-item budget (no lump sums) with a material/work description per line; the total equals the rehab amount on the term sheet. Contingency is at most 10% of the budget. A feasibility study is required if the total budget is $150,000 or more. The ARV is at least 115% of total project cost (the lesser of as-is value or purchase price, plus the rehab budget). Ineligible costs are stripped out (financing/closing costs, inspections, insurance, taxes, staging, late/extension fees, interest carry). Cash-in-hand to the borrower at settlement is at most 35% of the rehab budget.' },
  // Deploy 236.670 — added to RTL per Mike (Appraisal + Insurance Invoice).
  { slug: 'appraisal', label: 'Appraisal', section: 'collateral',
    conditions: 'A full appraisal dated within 90 days of the note date (required for Heavy Rehab, or Light Rehab of $500,000+). Does NOT read "subject to" an unresolved condition. Comparables: at least 2 within 1 mile, or at least 3 in the same zip, sold within the last 12 months (a renovation loan needs at least 3 As-Is and 3 ARV comps). Value at least the loan amount; if the property was listed in the last 12 months use the lower of list price or value; a loan over $2,000,000 needs a second appraisal (use the lesser). Property is an eligible type — SFR, 2–4 unit, PUD, or condo — at least 700 sq ft (single) or 500 sq ft per unit; NOT a mobile/manufactured home, co-op, working farm, B&B, timeshare, condemned, care/assisted-living facility, log/dome/geothermal home, agricultural/industrial-zoned, without legal access, historically designated, environmentally hazardous, or owner/family-occupied. NOT in a geographic hard-stop — Illinois (statewide), Orange County NY, Lakewood NJ, Monsey NY, or Newark NJ. Rural test: the valuation is not designated rural AND the RUCA code is 2 or less.', optional: true },
  { slug: 'insurance_invoice', label: 'Insurance Invoice', section: 'collateral',
    conditions: 'Invoice for the property insurance premium. Annual premium, policy number, carrier, and named insured (borrower / entity) shown; the premium is reasonable for the coverage and matches the bound policy.', optional: true },
  // Deploy 236.708 — Lease Agreements added to RTL/GUC (per Mike). Optional here
  // because RTL/construction deals are often vacant (flip/bridge/ground-up);
  // required only where a property is tenant-occupied. On a portfolio loan the
  // Collateral section is split per property (loan-reviews-save), so this is
  // asked per property automatically.
  { slug: 'lease_agreements', label: 'Lease Agreements', section: 'collateral',
    conditions: 'For any tenant-occupied property: current lease(s) signed by landlord and tenant; term length stated; non-corporate arm\'s-length tenant; stated rent reconciles to the underwriting / rent schedule. Vacant properties: mark N/A.', optional: true },
  // Deploy 236.681 — condo-specific docs (per the RTL guidelines C.7/C.8); optional (condos only).
  { slug: 'condo_hoa_docs', label: 'Condo HOA Documents', section: 'collateral',
    conditions: 'For a condo: estoppel/resale certificate, condo project questionnaire, current HOA budget, and CC&Rs. HOA dues are current (no past-due balance that could become a lien); no pending/approved special assessment (or it is factored into the borrower\'s reserves); no active Right of First Refusal; no rental restriction that would block non-owner-occupied investment use; transfer/resale fees identified. Questionnaire red flags (pending litigation, underfunded reserves, high renter-occupancy) reviewed.', optional: true },
  { slug: 'condo_insurance', label: 'Condo Insurance (Master + HO-6)', section: 'collateral',
    conditions: 'For a condo: an active master/HOA policy covering 100% of building replacement cost. If the master is not "all-in", an HO-6 policy covers at least 20% of the appraised value or purchase price (whichever is lower) and includes loss-assessment coverage. Combined master + HO-6 meets the loan amount or 100% replacement cost (whichever is less). A unit under renovation carries a course-of-construction endorsement. Mortgagee clause and loan number correct on any policy naming SLA.', optional: true },

  // ── Loan ──────────────────────────────────────────────────────
  { slug: 'loan_application', label: 'Loan Application', section: 'loan',
    conditions: 'Complete (no missing fields or cut-offs) and signed by every guarantor. Loan amount, rehab budget, and ARV match the term sheet. The transaction is a Purchase or Refinance Fix & Flip; loan amount is between $125,000 and $3,500,000; term is 6–24 months; citizenship confirmed. Aggregate SLA exposure (incl. affiliated/cross-guaranteed entities) is at most $10,000,000 UPB or 4 active transactions. No payment on an existing SLA loan is past its grace period. Any "Yes" declaration answer other than citizenship is escalated. A loan over $3,500,000 or over the exposure cap is Tier 3.' },
  { slug: 'term_sheet', label: 'Term Sheet', section: 'loan',
    conditions: 'Loan amount, rehab amount, fees, and borrower name all match the loan application; term is 6–24 months; no escrow account is reflected (SLA does not escrow).' },

  // ── Closing ───────────────────────────────────────────────────
  { slug: 'borrower_closing_funds_receipt', label: 'Borrower Closing Funds Receipt', section: 'closing',
    conditions: 'Requested the day of closing. Shows the borrower funded the required cash-to-close to the title company.', purchaseOnly: true },
  { slug: 'cpl', label: 'Closing Protection Letter (CPL)', section: 'closing',
    conditions: 'Mortgagee clause matches the funding-source template exactly; loan number, borrower/entity, property address, and commitment number match the title commitment. CPL dated on or before the origination date and no more than 60 days before the note date. (New York uses an Agent Authorization Letter instead of a CPL.)' },
  { slug: 'emd_receipt', label: 'EMD Receipt', section: 'closing',
    conditions: 'Shows the title company received the earnest-money deposit from the borrower; amount matches the Purchase Agreement or assignment contract (an email confirmation from the title company is an acceptable substitute).', purchaseOnly: true },
  { slug: 'prelim_settlement', label: 'Pre-Lim Settlement Statement', section: 'closing',
    conditions: 'Loan amount, fees, prepaid interest, property address, and borrower are correct and reconcile to the approved term sheet.' },
  { slug: 'final_hud', label: 'Final HUD / Settlement Statement', section: 'closing',
    conditions: 'Final signed settlement statement (HUD / Closing Disclosure) collected AFTER closing. Loan amount, fees, prepaid interest, payoffs, and net wire all reconcile to the approved terms.' },
  { slug: 'tax_certificate', label: 'Tax Certificate', section: 'closing',
    conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed; real-estate taxes are current.' },
  // Deploy 236.670 — added to RTL per Mike (payoff of the existing lien on a refi).
  { slug: 'payoff_demand', label: 'Payoff Demand', section: 'closing',
    conditions: 'Payoff statement from the existing lender (refinance). Payoff amount, per-diem interest, and good-through date are current; lender + loan match the subject property.', optional: true },
  { slug: 'title_commitment', label: 'Title Commitment', section: 'closing',
    conditions: 'Mortgagee clause matches the funding-source template; borrower name(s) match the Articles (or the ID if individual); property address complete (all units if multi-unit); dated within 60 days of closing. Lender\'s coverage is 125% of the loan amount (100% minimum); owner\'s coverage equals the purchase price; Fee Simple; chain of title at least 24 months with the current vested owner matching the Purchase Agreement seller; real-estate taxes current. NO subordinate/junior liens (SLA allows no subordinate financing). HARD STOP (no exception): any lis pendens must be fully removed, and an oil/gas lease granting surface rights makes the property ineligible. Required endorsements present (ALTA 9/100, 8.1, and 4/5 as applicable); survey/affidavit on file; HOA dues current; solar/HERO liens subordinated or paid off.' },
  { slug: 'title_eo_insurance', label: 'Title E&O Insurance', section: 'closing',
    conditions: 'Insured name matches the title company; coverage at least $1,000,000 per occurrence; policy effective through the note date.' },
  { slug: 'wire_instructions', label: 'Wire Instructions', section: 'closing',
    conditions: 'Wire instructions for the title company; verified against the CPL / title commitment.' },
];

// Deploy 236.702 — GUC (Ground-Up Construction) document set. Construction runs
// off the same Colchis borrower/guarantor/collateral/closing checklist as RTL,
// PLUS these construction-specific collateral items (per Mike): architectural
// plans, building permits, a feasibility study, and a General Contractor review.
export const GUC_CONSTRUCTION_DOCS = [
  { slug: 'architectural_plans', label: 'Architectural Plans', section: 'collateral',
    conditions: 'Complete architectural/engineering plan set for the proposed build. Plans match the subject property address and the project scope on the construction budget (unit count, square footage, number of stories). Signed/sealed by a licensed architect or engineer where the jurisdiction requires it; latest revision on file. Square footage and unit count reconcile to the as-completed appraisal (ARV) and the loan application.' },
  { slug: 'building_permits', label: 'Building Permits', section: 'collateral',
    conditions: 'Building/construction permits issued for the subject property — or a documented permit-ready / plan-check status with a clear path to issuance before the first draw. Permit address matches the subject; permitted scope matches the plans and the construction budget. Any required demolition, grading, or utility permits are identified, and impact/tap fees are accounted for in the budget.' },
  { slug: 'feasibility_study', label: 'Feasibility Study', section: 'collateral',
    conditions: 'Third-party feasibility / plan-and-cost review for the ground-up construction (required when the construction budget is $150,000 or more). Confirms the line-item budget, timeline, and draw schedule are reasonable for the scope and market and flags cost overruns or scope gaps. As-completed value (ARV) is at least 115% of total project cost (land value or purchase price + construction budget).' },
  { slug: 'gc_review', label: 'General Contractor Review', section: 'collateral',
    conditions: 'General Contractor package: a signed construction contract with a line-item budget and draw schedule; the GC\'s license (active and in-scope for the jurisdiction); general-liability and workers\'-comp insurance; and references / a track record of comparable completed builds. The GC is an arm\'s-length third party — or a borrower-affiliated GC is disclosed and reviewed. W-9 on file; OFAC/background screen on the GC entity and its principal.' },
];
export const GUC_DOCS = [...RTL_DOCS, ...GUC_CONSTRUCTION_DOCS];

export function getChecklist(loanType) {
  const t = String(loanType || '').toLowerCase();
  if (t === 'dscr') return DSCR_DOCS;
  if (t === 'rtl')  return RTL_DOCS;
  if (t === 'guc')  return GUC_DOCS;
  return [];
}

export function getDefaultInvestor(loanType) {
  const t = String(loanType || '').toLowerCase();
  if (t === 'dscr') return 'diya';
  if (t === 'rtl')  return 'colchis';
  if (t === 'guc')  return 'colchis';
  return '';
}

// Deploy 236.678 — resolve a STANDARD category definition by slug across ALL
// loan types (union of DSCR + RTL). Used by the doc-move endpoint so a processor
// can file a mis-bucketed doc into any standard category (with its real rubric)
// even when that category isn't part of the loan's own checklist — e.g. moving a
// lease agreement into "Lease Agreements" on an RTL loan. DSCR wins on slug
// collisions (its rubric text is the fuller of the two).
export function findCategory(slug) {
  const s = String(slug || '');
  if (!s) return null;
  return DSCR_DOCS.find((d) => d.slug === s)
    || RTL_DOCS.find((d) => d.slug === s)
    || GUC_CONSTRUCTION_DOCS.find((d) => d.slug === s)
    || null;
}
