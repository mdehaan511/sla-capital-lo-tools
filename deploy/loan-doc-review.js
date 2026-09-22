/**
 * loan-doc-review.js — Deploy 236.121
 *
 * Self-contained Loan Doc Review module. Ported from the now-deleted
 * standalone loan-review-detail.html so the same review experience —
 * pending docs checklist, source-data snapshot panel, per-tray
 * upload + AI verdict + processor approve/override + N/A/finalize —
 * lives inline in the Documents tab on loan-details.html.
 *
 * Usage from the host page:
 *   <script src="loan-doc-review.js"></script>
 *   SLA.DocReview.mount(rootEl, {
 *     reviewId,
 *     user,             // Netlify Identity user object
 *     onDeleted: fn,    // called after delete/finalize so the host
 *                       // can return to its "Start Review" state
 *   });
 *
 * Notes:
 *  - All styles are scoped via `.dr-root ` prefix and injected once
 *    on first mount so re-mounts don't duplicate the stylesheet.
 *  - Modals + toast are injected on document.body with `dr-` IDs
 *    to avoid colliding with host-page modals.
 *  - Inline onclick handlers in the rendered HTML reference globals
 *    prefixed `dr_*` (set on window) — same prefix avoids host-page
 *    collisions like switchTab / saveNotes.
 */
(function(global) {
  'use strict';

  // ── Doc checklists (mirrors _shared/loan-review-checklists.mjs) ───
  // Deploy 237.136 (Mike: "make the 2 top documents the Loan Application and Term
  // Sheet in their own section") -- a render-time section; the checklist still
  // files both slugs under 'loan' server-side (_secOf overrides for display).
  // Deploy 237.150 -- the value is also the order INSIDE that section, so the
  // application leads and the term sheet follows it whatever order the trays were
  // created in.
  var APP_SLUGS = { loan_application: 1, term_sheet: 2 };
  // Deploy 237.150 (Dan) -- 'Loan Documents' is retired: once the application and
  // term sheet moved to the top the only thing left in it was the commitment letter,
  // so everything filed under 'loan' now renders with them. And the per-section
  // "Other Documents" blocks became ONE 'other' section at the bottom. Keep this in
  // step with SECTIONS in _shared/loan-review-checklists.mjs.
  var SECTIONS = [
    { key: 'application', label: 'Application & Terms' },
    { key: 'borrower',  label: 'Borrower Documents'  },
    { key: 'guarantor', label: 'Guarantor Documents' },
    { key: 'collateral',label: 'Collateral Documents'},
    { key: 'closing',   label: 'Closing Documents'   },
    // Deploy 237.228 (Dan) -- everything that only exists after the loan funds.
    { key: 'post_close',label: 'Post Close'          },
    { key: 'other',     label: 'Other Documents'     },
  ];
  var DOC_META = {
    // Deploy 237.074 (Mike) -- the Articles are the SOURCE of the LLC name; the item to find is the LLC name, not the guarantor.
    articles_of_organization: { label: 'Articles of Organization', section: 'borrower', conditions: 'Recorded copy stamped by the Secretary of State. Identify the LLC name exactly as filed (not the organizer / member / guarantor name). This name is the entity name of record every other entity document is compared against.' },
    entity_background_check:  { label: 'Entity Background Check',  section: 'borrower', conditions: 'No bankruptcies, liens, or judgements within 90 days of close date.' },
    // Deploy 237.074 (Mike) -- holder may be the entity or ANY guarantor, 100% owned; full statements only.
    bank_stmt_current:        { label: 'Current-Month Bank Statements', section: 'borrower', conditions: 'Full bank-generated statement or Account Transaction History (not a screenshot or photo). Account holder is the borrowing entity or any guarantor. Account is 100% owned by those parties (no non-guarantor person or other entity on the account). Liquidity requirement met.' },
    bank_stmt_previous:       { label: 'Previous-Month Bank Statements', section: 'borrower', conditions: 'Full bank-generated statement or Account Transaction History (not a screenshot or photo). Account holder is the borrowing entity or any guarantor. Account is 100% owned by those parties (no non-guarantor person or other entity on the account). Liquidity requirement met.' },
    certificate_of_good_standing: { label: 'Certificate of Good Standing', section: 'borrower', conditions: 'Dated within the last 90 days. LLC name matches the recorded Articles. State seal. Secretary of State signature.' },
    ein_or_w9:                { label: 'EIN Letter or W9', section: 'borrower', conditions: 'Entity name matches the recorded Articles. Readable EIN. Note the date of the letter. If no EIN letter, a signed W-9 instead.' },
    ofac_entity:              { label: 'OFAC Check (Entity)', section: 'borrower', conditions: 'Entity name searched on the OFAC report matches the recorded Articles exactly.' },
    operating_agreement:      { label: 'Operating Agreement', section: 'borrower', conditions: 'LLC name matches the recorded Articles. Identify all owners with 20%+ ownership. All signatures + initials present.' },
    track_record_reo:         { label: 'Track Record / REO Schedule', section: 'borrower', conditions: 'Max of 6 properties needed. Confirm all cells are filled in with reasonable info.' },
    voided_check_ach:         { label: 'Voided Check / ACH Letter', section: 'borrower', conditions: 'Account that borrower wants to make monthly payments from.' },
    track_record:             { label: 'Track Record', section: 'borrower', conditions: 'Max of 8 properties needed for top pricing. Confirm all cells filled in with reasonable info.' },
    voided_check:             { label: 'Voided Check', section: 'borrower', conditions: 'Account borrower wants payment from. If different than borrower name get 3rd-party payee form.' },
    borrower_loe:             { label: 'Borrower Letter of Explanation', section: 'borrower', conditions: 'As required.', optional: true },

    // Deploy 237.075 (Mike) -- one per guarantor; names must match the ID incl. middle name.
    guarantor_background_check:{ label: 'Guarantor Background Check', section: 'guarantor', conditions: 'One per guarantor. Run on the full legal name per the ID plus DOB. No bankruptcies, liens, or judgements. Criminal report < 90 days old.' },
    credit_authorization:     { label: 'Credit Authorization', section: 'guarantor', conditions: 'Signed and dated by the guarantor this tray belongs to. Deploy 237.152 (Mike): each guarantor signs their OWN authorization — a signature from one guarantor does not cover another, so a form naming a different person is the wrong document for this tray. The signed loan application carries one "Authorization to Conduct Prequal Credit & Background Checks" page per signer; that page for THIS guarantor is what belongs here.' },
    credit_report:            { label: 'Credit Report', section: 'guarantor', conditions: 'One per guarantor. Name is the full legal name per the ID. Middle score above 690? Any lates or past-due accounts? Report is < 90 days old?' },
    guarantor_id:             { label: 'Guarantor ID (Driver’s License or Passport)', section: 'guarantor', conditions: 'Unexpired government photo ID for EACH guarantor. Full legal name incl. middle name as printed. Every other document must match it (no nicknames). Birth date matches the application.' },
    ofac_personal:            { label: 'OFAC Check (Personal)', section: 'guarantor', conditions: 'One per guarantor. Name searched is the full legal name per the ID incl. middle name. No unresolved matches.' },
    pfs:                      { label: 'Personal Financial Statement (PFS)', section: 'guarantor', conditions: 'Signed by borrower.' },
    voh_corrfirst:            { label: 'Verification of Housing Cost (CorrFirst Only)', section: 'guarantor', conditions: 'Copy of primary home’s mortgage or lease agreement along with proof of payment.', optional: true },
    guarantor_loe:            { label: 'Guarantor Letter of Explanation', section: 'guarantor', conditions: 'As required.', optional: true },

    assignment_agreement:     { label: 'Assignment Agreement', section: 'collateral', conditions: 'Buyer matches borrower; seller matches the PSA; all parties signed.', optional: true },
    appraisal:                { label: 'Appraisal', section: 'collateral', conditions: 'Value >= loan amount; does NOT say "subject to".' },
    appraisal_receipt:        { label: 'Appraisal Receipt', section: 'collateral', conditions: 'Paid-in-full receipt for the appraisal.' },
    air:                      { label: 'AIR (Appraisal Independence Report)', section: 'collateral', conditions: 'Appraisal Independence Report signed.' },
    cda_report:               { label: 'CDA Report', section: 'collateral', conditions: 'Value >= Appraised value.' },
    evidence_of_insurance:    { label: 'Evidence of Insurance', section: 'collateral', conditions: 'Mortgagee clause reads the expected lender (ISAOA/ATIMA). Named insured is the borrowing entity or a guarantor. Coverage at least the loan value. $1M liability. Policy number noted.' },
    flood_certificate:        { label: 'Flood Certificate & Insurance', section: 'collateral', conditions: 'If property is in a flood zone, request flood insurance EOI.', optional: true },
    proof_of_insurance_pif:   { label: 'Proof of Insurance Paid in Full (PIF)', section: 'collateral', conditions: 'Receipt or invoice showing $0 owed (paid in full). Property address matches the subject. Policy number matches the EOI. Coverage is not verified here.' },
    lease_agreements:         { label: 'Lease Agreements', section: 'collateral', conditions: '12 months in length? Non-corporate tenant? Signed by landlord and tenant?' },
    property_mgmt_agreement:  { label: 'Property Management Agreement', section: 'collateral', conditions: 'PMA signed; covers the subject property.' },
    property_mgmt_questionnaire: { label: 'Property Management Questionnaire', section: 'collateral', conditions: 'PMQ completed in full.' },
    // Deploy 236.670 — new categories per Mike (DSCR + RTL).
    proof_of_security_deposit: { label: 'Proof of Security Deposit', section: 'collateral', conditions: 'Evidence the tenant security deposit(s) are held; amount consistent with the lease(s).', optional: true },
    insurance_invoice:        { label: 'Insurance Invoice', section: 'collateral', conditions: 'Invoice for the property insurance premium. Annual premium, policy number, carrier, and named insured shown.', optional: true },
    proof_of_citizenship:     { label: 'Proof of Citizenship', section: 'guarantor', conditions: 'Citizenship / permanent-residency evidence for each guarantor (passport, birth certificate, naturalization, or green card); name matches the application.', optional: true },
    payoff_demand:            { label: 'Payoff Demand', section: 'closing', conditions: 'Payoff statement from the existing lender (refi). Payoff amount, per-diem, and good-through date current.', optional: true },
    // Deploy 236.681 — condo-specific docs (RTL guidelines C.7/C.8).
    condo_hoa_docs:           { label: 'Condo HOA Documents', section: 'collateral', conditions: 'Estoppel/resale cert, condo questionnaire, HOA budget, CC&Rs. Dues current; no pending special assessment or Right of First Refusal; no rental restriction blocking investment use.', optional: true },
    condo_insurance:          { label: 'Condo Insurance (Master + HO-6)', section: 'collateral', conditions: 'Master policy covers 100% of building replacement cost; if not "all-in", HO-6 covers ≥20% of value + loss assessment. Combined coverage meets loan or 100% RC. Mortgagee clause + loan # correct.', optional: true },
    psa:                      { label: 'Purchase and Sale Agreement (PSA)', section: 'collateral', conditions: 'Borrower listed as buyer; all parties signed; price matches application.' },
    sow:                      { label: 'Statement of Work (SOW)', section: 'collateral', conditions: 'Budget = Requested rehab $$.' },
    vom:                      { label: 'VOM (Verification of Mortgage)', section: 'collateral', conditions: 'Existing mortgage information verified.', optional: true },
    bpo_valuation:            { label: 'BPO / Valuation', section: 'collateral', conditions: 'As-is value is not below the purchase price or the loan amount. ARV supports the loan amount within the LTARV cap. Comps recent and nearby.' },

    loan_application:         { label: 'Loan Application', section: 'loan', conditions: 'Verify all information filled out and is accurate; signatures present.' },
    term_sheet:               { label: 'Term Sheet', section: 'loan', conditions: 'Ensure it is the most up-to-date terms.' },

    borrower_closing_funds_receipt: { label: 'Borrower Closing Funds Receipt', section: 'closing', conditions: 'Requested day of closing.' },
    cpl:                      { label: 'Closing Protection Letter (CPL)', section: 'closing', conditions: 'Mortgagee Clause; loan number; property address; date.' },
    emd_receipt:              { label: 'EMD Receipt', section: 'closing', conditions: 'Receipt showing borrower provided EMD to the title company.' },
    prelim_settlement:        { label: 'Pre-Lim Settlement Statement', section: 'closing', conditions: 'Loan amount correct; fees correct; prepaid interest; property address; borrower.' },
    // Deploy 237.228 (Dan) -- the final HUD is collected after closing, so it moved
    // to Post Close with the executed documents.
    final_hud:                { label: 'Final HUD / Settlement Statement', section: 'post_close', conditions: 'Final signed settlement statement (HUD / Closing Disclosure) collected AFTER closing. Loan amount, fees, prepaid interest, payoffs, and net wire all reconcile to the approved terms.' },
    tax_certificate:          { label: 'Tax Certificate', section: 'closing', conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed.' },
    title_commitment:         { label: 'Title Commitment', section: 'closing', conditions: 'Mortgagee Clause; loan number; borrower name; property address(es); 125% of loan value; date.' },
    title_eo_insurance:       { label: 'Title E&O Insurance', section: 'closing', conditions: 'Title company name; $1 million in protection; policy dates current.' },
    wire_instructions:        { label: 'Wire Instructions', section: 'closing', conditions: 'Wire instructions for the title company.' },
    draw_wire_form:        { label: 'Construction Draw Wire Information', section: 'closing', conditions: '', noReview: true }, // Deploy 236.945
    commitment_letter:     { label: 'Loan Commitment Letter', section: 'loan', conditions: '', noReview: true },             // Deploy 236.945
    original_doc_tracking: { label: 'Original Doc Tracking', section: 'closing', conditions: '', noReview: true },
    // ── Post Close (Deploy 237.228, Dan) ──
    // Record-keeping vault; never AI-reviewed (noReview). These were filed under
    // Closing since 236.752 / 236.838; they only exist after the loan funds, so
    // they now have their own section under Closing.
    executed_closing_documents: { label: 'Executed Closing Documents', section: 'post_close', conditions: '', noReview: true },
    executed_ach_form:     { label: 'Executed ACH Form',     section: 'post_close', conditions: '', noReview: true },
    executed_deed:         { label: 'Executed Deed',         section: 'post_close', conditions: '', noReview: true },
    closing_w9:            { label: 'Closing W9',            section: 'post_close', conditions: '', noReview: true },
    // Deploy 237.228 (Dan) -- two new post-close trays. Both are storage-only:
    // they arrive from the title company / county after funding and are filed,
    // not underwritten.
    recorded_security_instrument: { label: 'Recorded Deed of Trust / Mortgage', section: 'post_close', conditions: '', noReview: true },
    final_title_policy:    { label: 'Final Title Policy',    section: 'post_close', conditions: '', noReview: true },
  };
  // Deploy 237.228 (Dan: "Remove the document tray for insurance invoice") -- off
  // the checklist (see RETIRED_DOCS in _shared/loan-review-checklists.mjs), so no
  // new review gets one. A review that already has the tray keeps it ONLY while
  // something is filed in it; an empty one stops rendering. Its DOC_META entry
  // stays above so a legacy tray keeps its name and its section.
  var RETIRED_SLUGS = { insurance_invoice: 1 };
  // Deploy 237.228 (Dan) -- the order trays render in INSIDE their section.
  // render() lists trays with Object.keys(_review.docs), which is the order the
  // review created them in and is frozen for every review that already exists, so
  // reordering the checklist arrays alone would only have moved the trays on new
  // reviews. Mirrors TRAY_ORDER in _shared/loan-review-checklists.mjs --
  // scripts/doc-tray-order-test.mjs fails if the two drift apart.
  var TRAY_ORDER = [
    // Borrower
    'articles_of_organization', 'certificate_of_good_standing', 'ein_or_w9', 'ein_letter',
    'ofac_entity', 'operating_agreement', 'bank_stmt_current', 'bank_stmt_previous',
    'voided_check', 'voided_check_ach', 'track_record', 'track_record_reo',
    'entity_background_check', 'borrower_loe', 'foreign_entity_registration',
    // Guarantor
    'guarantor_id', 'credit_authorization', 'credit_report', 'guarantor_background_check',
    'ofac_personal', 'pfs', 'guarantor_loe', 'proof_of_citizenship', 'voh_corrfirst',
    // Collateral
    'bpo_valuation', 'appraisal', 'psa', 'assignment_agreement', 'evidence_of_insurance',
    'proof_of_insurance_pif', 'flood_certificate', 'sow', 'cost_basis', 'lease_agreements',
    'proof_of_security_deposit', 'property_mgmt_summary', 'property_mgmt_agreement',
    'property_mgmt_questionnaire', 'mortgage_statements_payoffs', 'vom',
    'property_insurance_binder', 'flood_insurance_policy', 'property_profile',
    'appraisal_receipt', 'air', 'cda_report', 'property_condition_assessment',
    'condo_documents', 'condo_hoa_docs', 'condo_insurance', 'environmental_survey',
    'insurance_invoice',
    'architectural_plans', 'building_permits', 'feasibility_study', 'gc_review',
    // Application & Terms (APP_SLUGS pins the application and term sheet above these)
    'letter_of_intent', 'revised_loan_terms', 'loan_application', 'term_sheet',
    'outstanding_conditions', 'exception_request', 'commitment_letter',
    // Closing
    'title_eo_insurance', 'emd_receipt', 'cpl', 'tax_certificate', 'title_commitment',
    'wire_instructions', 'prelim_settlement', 'borrower_closing_funds_receipt',
    'title_escrow_contact', 'payoff_demand', 'invoice', 'draw_wire_form',
    'original_doc_tracking',
    // Post Close
    'executed_closing_documents', 'executed_ach_form', 'executed_deed', 'closing_w9',
    'final_hud', 'recorded_security_instrument', 'final_title_policy',
  ];
  var TRAY_RANK = (function() {
    var m = {};
    for (var i = 0; i < TRAY_ORDER.length; i++) m[TRAY_ORDER[i]] = i + 1;
    return m;
  })();
  // A tray's place in its section. Application & Terms keeps its own rule (the
  // loan application and term sheet lead it, 237.150). A tray nobody listed --
  // a custom category, an unknown base slug -- sorts after every listed one and
  // keeps the order the review created it in.
  function _trayRank(slug) {
    var base = String(slug || '').replace(/__[pg]\d+$/, '');
    if (APP_SLUGS[base]) return APP_SLUGS[base];
    return 1000 + (TRAY_RANK[base] || 900);
  }
  function _byTrayOrder(a, b) { return _trayRank(a) - _trayRank(b); }

  var PROP_TYPE_LABELS = {
    sfr: 'Single Family (1 Unit)', '2-4': '2–4 Unit', condo: 'Condo',
    nw_condo: 'Non-Warrantable Condo', multi: 'Multifamily', portfolio: 'Portfolio',
  };
  var LOAN_PURPOSE_LABELS = {
    purchase: 'Purchase', refi_rt: 'Rate/Term Refi', refi_co: 'Cash-Out Refi',
    refinance: 'Refinance', refi: 'Refinance', cashout: 'Cash-Out Refi',
  };
  var RENTAL_TYPE_LABELS = { ltr: 'Long-Term Rental', str: 'Short-Term / Airbnb', mtr: 'Mid-Term Rental' };

  // ── Module state ──────────────────────────────────────────────────
  var _root = null;
  var _opts = null;
  var _user = null;
  var _review = null;
  var _liveLoan = null; // Deploy 237.078 -- the CURRENT loan record from Loan Details (opts.loan / window._loan)
  var _autoSynced = {}; // Deploy 237.078 -- reviewId|fingerprint -> true once the auto truth-refresh fired
  var _activeTab = 'processor'; // Deploy 237.136
  var _activeCollateralProperty = 0; // Deploy 236.690 — portfolio collateral tab
  var _activeGuarantor = 0;          // Deploy 237.106 — per-guarantor tab (Guarantor section)
  var _expanded = {};
  var _aiDetailsOpen = {}; // Deploy 237.070 -- AI block "Details" open per doc (slug|docId)
  var _aiOpenTray = {};    // Deploy 237.221 -- trays whose AI review was opened from the chip
  var _pendingOverride = null;
  var _pendingNa = null;
  var _docSearch = '';
  var _sourceOpen = false;
  var _uploadingSlug = null;
  var _uploadQueue = [];      // Deploy 237.105 -- picks made while an upload is running (one at a time)
  var _uploadStatusMsg = ''; // Deploy 236.839 — live in-tray upload status line
  var _stylesInjected = false;
  // Deploy 236.161 — per-section "Show N hidden" toggle state.
  var _showHidden = {};
  var _pendingHide = null;   // Deploy 237.071 -- slug awaiting a hide reason
  // Deploy 236.162 — pending Add-Document section key + label for
  // the modal. Captured when the LO opens the modal so confirm
  // can route the new tray into the right section.
  var _pendingAddDoc = null;
  // Deploy 236.163 — pending Replace-or-Add upload context. Stashes
  // the slug + File + live-docs list so dr_confirmReplaceOrAdd can
  // re-fire doUpload with the user's choice.
  var _pendingUpload = null;
  var _modalsInjected = false;

  // ── Utils ────────────────────────────────────────────────────────
  function escHtml(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function escAttr(s) { return escHtml(s).replace(/"/g,'&quot;'); }
  // Deploy 237.139 (Mike) — escAttr is NOT enough for a value that lands inside a
  // single-quoted argument of an inline handler: the HTML parser decodes entities
  // BEFORE the JS is compiled, so an apostrophe (or &#39;) closes the string early
  // and the whole handler dies with "SyntaxError: missing ) after argument list".
  // A document named "Owner's Rent Roll.pdf" took the doc-review list down that way.
  // escJs escapes for the JS string first, then for the attribute.
  function escJs(s) {
    return escAttr(String(s == null ? '' : s)
      .replace(/\\/g, '\\\\')
      .replace(/'/g, "\\'")
      .replace(/[\r\n\u2028\u2029]+/g, ' '));
  }
  function formatDate(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      var now = new Date();
      var diffMs = now - d;
      var diffH = diffMs / (1000 * 60 * 60);
      if (diffH < 1) return Math.max(1, Math.round(diffMs / 60000)) + ' min ago';
      if (diffH < 24) return Math.round(diffH) + ' hr ago';
      if (diffH < 24 * 7) return Math.round(diffH / 24) + ' days ago';
      return d.toLocaleDateString();
    } catch (e) { return '—'; }
  }
  function formatDateOnly(s) {
    if (!s) return '—';
    try { return new Date(s + 'T00:00:00').toLocaleDateString(); }
    catch (e) { return s; }
  }

  // ── Style + modal injection ──────────────────────────────────────
  function injectStylesOnce() {
    if (_stylesInjected) return;
    _stylesInjected = true;
    var s = document.createElement('style');
    s.id = 'drStyles';
    s.textContent = [
      '.dr-root { --dr-green:#15803d; --dr-green-light:rgba(21,128,61,0.10); --dr-green-border:rgba(21,128,61,0.40); --dr-red:#b91c1c; --dr-red-light:rgba(185,28,28,0.10); --dr-red-border:rgba(185,28,28,0.40); --dr-amber:#b45309; --dr-amber-light:rgba(180,83,9,0.10); --dr-amber-border:rgba(180,83,9,0.40); --dr-blue:#1e40af; --dr-blue-light:rgba(30,64,175,0.10); --dr-blue-border:rgba(30,64,175,0.40); }',
      '.dr-root .summary { background:#fff; border:1px solid var(--border, #ddd8d0); border-radius:10px; padding:18px 22px; margin-bottom:1rem; display:flex; justify-content:space-between; align-items:flex-start; flex-wrap:wrap; gap:1rem; }',
      '.dr-root .summary-left h2 { font-size:18px; font-weight:600; color:var(--text, #1a1520); }',
      '.dr-root .summary-left .meta-line { font-size:12px; color:var(--muted, #7a7488); margin-top:6px; font-family:"DM Mono", monospace; }',
      '.dr-root .summary-stats { display:flex; gap:24px; align-items:center; }',
      '.dr-root .summary-stat { text-align:right; }',
      '.dr-root .summary-stat .v { font-size:18px; font-weight:600; font-family:"DM Mono", monospace; color:var(--text, #1a1520); }',
      '.dr-root .summary-stat .l { font-size:11px; color:var(--muted, #7a7488); text-transform:uppercase; letter-spacing:0.04em; margin-top:2px; }',
      '.dr-root .type-pill { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }',
      '.dr-root .type-pill.dscr { background:rgba(38,26,54,0.08); color:var(--dark, #261a36); }',
      '.dr-root .type-pill.rtl  { background:rgba(200,129,58,0.18); color:var(--gold-mid, #b5712d); }',
      '.dr-root .investor-pill { display:inline-block; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:500; background:var(--gold-light, rgba(200,129,58,0.10)); color:var(--gold-mid, #b5712d); margin-left:4px; }',
      '.dr-root .summary-link { color:var(--text, #1a1520); text-decoration:none; }',
      '.dr-root .summary-link:hover { color:var(--gold-mid, #b5712d); text-decoration:underline; }',

      '.dr-root .tabs { display:flex; gap:4px; border-bottom:2px solid var(--border, #ddd8d0); margin-bottom:1rem; }',
      '.dr-root .tab { padding:10px 18px; font-size:13px; font-weight:600; color:var(--muted, #7a7488); cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-2px; transition:all 0.15s; }',
      '.dr-root .tab:hover { color:var(--gold-mid, #b5712d); }',
      '.dr-root .tab.active { color:var(--gold-mid, #b5712d); border-bottom-color:var(--gold, #C8813A); }',
      '.dr-root .tab-count { display:inline-block; font-size:11px; color:var(--muted); margin-left:4px; background:var(--border, #ddd8d0); padding:1px 7px; border-radius:10px; font-family:"DM Mono", monospace; }',
      '.dr-root .tab.active .tab-count { background:var(--gold-light, rgba(200,129,58,0.10)); color:var(--gold-mid, #b5712d); }',

      '.dr-root .doc-toolbar { display:flex; gap:10px; align-items:center; margin-bottom:1.25rem; flex-wrap:wrap; }',
      '.dr-root .doc-search { flex:1; min-width:240px; height:36px; padding:0 12px; border:1px solid var(--border, #ddd8d0); border-radius:6px; font-size:13px; font-family:"DM Sans", sans-serif; background:#fff; }',
      '.dr-root .doc-search:focus { outline:none; border-color:var(--gold, #C8813A); }',
      '.dr-root .expand-btn { padding:8px 12px; font-size:12px; font-weight:500; color:var(--muted); background:#fff; border:1px solid var(--border, #ddd8d0); border-radius:6px; cursor:pointer; font-family:"DM Sans", sans-serif; }',
      '.dr-root .expand-btn:hover { border-color:var(--gold, #C8813A); color:var(--gold-mid, #b5712d); }',

      '.dr-root .source-panel { background:#fff; border:1px solid var(--border, #ddd8d0); border-radius:10px; margin-bottom:1.25rem; overflow:hidden; }',
      '.dr-root .source-panel-head { padding:12px 18px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; font-size:13px; font-weight:600; color:var(--text); transition:background 0.1s; }',
      '.dr-root .source-panel-head:hover { background:var(--gold-light, rgba(200,129,58,0.10)); }',
      '.dr-root .source-panel-head .caret { color:var(--muted); font-size:12px; transition:transform 0.15s; }',
      '.dr-root .source-panel-head.open .caret { transform:rotate(90deg); }',
      '.dr-root .source-panel-body { padding:14px 22px 20px; border-top:1px solid var(--border, #ddd8d0); background:#fcfaf6; display:none; }',
      '.dr-root .source-panel-body.open { display:block; }',
      '.dr-root .source-grid { display:grid; grid-template-columns:repeat(auto-fit, minmax(180px, 1fr)); gap:10px 22px; }',
      // Deploy 237.222 -- Underwriting subtab: trays + key metrics. STACKED unless the
      // review column itself is wide enough -- a container query, because this sits inside
      // Loan Details beside a 400px notes column and the window width says nothing about
      // the room actually left. A browser without container queries keeps the stack.
      '.dr-root .dr-review-all { display:flex; align-items:center; gap:10px; margin:2px 0 8px; }', // Deploy 237.226
      '.dr-root .dr-uw-wrap { container-type:inline-size; container-name:druw; }',
      '.dr-root .dr-uw-cols { display:flex; flex-direction:column-reverse; gap:16px; }',
      '.dr-root .dr-uw-main { min-width:0; }',
      '.dr-root .dr-uw-side { min-width:0; }',
      '@container druw (min-width: 900px) {',
      '  .dr-root .dr-uw-cols { display:grid; grid-template-columns:minmax(0,1fr) 320px; gap:18px; align-items:start; }',
      // Deploy 237.223 (Mike: "instead of making it sticky and have a scroll bar ... make
      // it hold its position on the page and remove the scroll bar") -- a plain column now.
      '  .dr-root .dr-uw-side { position:static; }',
      '}',
      '.dr-root .source-grid .k { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:2px; }',
      '.dr-root .source-grid .v { font-size:13px; color:var(--text); font-family:"DM Mono", monospace; word-break:break-word; }',
      '.dr-root .source-section-title { font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; margin:16px 0 8px; padding-top:12px; border-top:1px solid var(--border); }',
      '.dr-root .source-section-title:first-child { margin-top:0; padding-top:0; border-top:0; }',
      '.dr-root .source-empty { padding:1rem; color:var(--muted); font-size:13px; text-align:center; font-style:italic; }',

      // .section here would collide with the host page; use .dr-section.
      '.dr-root .dr-section { margin-bottom:1.5rem; }',
      // Deploy 237.110 (Mike) -- stacked per-guarantor groups inside the Guarantor section.
      '.dr-root .dr-gsec { margin:10px 0 18px; padding:10px 12px 4px; border:1px solid var(--border); border-radius:10px; background:rgba(200,129,58,0.04); }',
      '.dr-root .dr-gsec-head { display:flex; align-items:center; gap:10px; flex-wrap:wrap; margin:0 0 8px; }',
      '.dr-root .dr-gsec-title { font-size:13px; font-weight:700; color:var(--text); }',
      '.dr-root .dr-gsec-meta { font-size:11px; color:var(--muted); margin-left:auto; }',
      '.dr-root .dr-gsec-empty { font-size:12px; color:var(--muted); padding:2px 0 10px; }',
      '.dr-root .section-title { font-size:12px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; padding-left:4px; }',
      // Deploy 236.161 — section header row (title + Show/Hide N hidden toggle).
      '.dr-root .section-title-row { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }',
      '.dr-root .dr-section-toggle { font-size:10px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; padding:3px 10px; color:var(--muted); background:transparent; border:1px solid var(--border); border-radius:20px; cursor:pointer; font-family:"DM Sans", sans-serif; }',
      '.dr-root .dr-section-toggle:hover { color:var(--gold-mid); border-color:var(--gold); }',
      // Deploy 236.162 — "+ Add Document" gets a slightly more
      // pronounced look so it doesn't blend with the hidden toggle.
      '.dr-root .dr-add-doc-btn { color:var(--gold-mid); border-color:var(--gold-border, rgba(200,129,58,0.28)); }',
      // Deploy 236.520 — invite-borrower button + borrower/manual-review badges.
      '.dr-root .dr-invite-btn { margin-top:10px; font-size:12px; font-weight:600; padding:7px 14px; border-radius:20px; cursor:pointer; color:#fff; background:var(--gold-mid, #b5712d); border:1px solid var(--gold-mid, #b5712d); font-family:"DM Sans", sans-serif; }',
      '.dr-root .dr-invite-btn:hover { background:#935a20; }',
      // Deploy 236.533 — invite box (borrower/broker) + status line.
      '.dr-root .dr-invite-box { margin-top:12px; }',
      '.dr-root .dr-invite-status { font-size:12px; color:var(--muted,#7a7488); margin-bottom:6px; line-height:1.55; }',
      '.dr-root .dr-invite-status .who { font-weight:600; color:var(--text,#1a1520); }',
      '.dr-root .dr-invite-status .never { color:#b5712d; font-weight:600; }',
      '.dr-root .dr-invite-btn.secondary { color:var(--gold-mid,#b5712d); background:#fff; margin-left:8px; }',
      '.dr-root .dr-invite-btn.secondary:hover { background:#faf3ea; }',
      '.dr-root .dr-mr-badge { display:inline-block; margin-top:6px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:#1e40af; background:rgba(30,64,175,0.10); border:1px solid rgba(30,64,175,0.25); border-radius:20px; padding:2px 9px; }',
      '.dr-root .dr-br-badge { display:inline-block; margin-top:6px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); background:var(--bg, #f7f5f1); border:1px solid var(--border); border-radius:20px; padding:2px 9px; }',
      // Deploy 236.945 — borrower-form status chip + its inline actions.
      '.dr-root .dr-form-badge { display:inline-block; margin-top:6px; font-size:10.5px; font-weight:600; color:var(--muted); background:var(--bg, #f7f5f1); border:1px solid var(--border); border-radius:20px; padding:2px 9px; }',
      '.dr-root .dr-form-badge.done { color:var(--dr-green-text, #1f6b3a); border-color:var(--dr-green-border, #bfe0c9); background:rgba(46,125,79,0.08); }',
      '.dr-root .dr-form-act { cursor:pointer; text-decoration:underline; margin-left:8px; color:var(--gold-mid); }',
      /* Deploy 237.042 — open VOM follow-up (send to landlord / lender). */
      '.dr-root .dr-follow-badge { display:inline-block; margin-top:6px; font-size:10.5px; font-weight:700; color:#7c1f1f; background:rgba(124,31,31,0.08); border:1px solid rgba(124,31,31,0.35); border-radius:20px; padding:2px 9px; }',
      '.dr-modal-wrap { position:fixed; inset:0; background:rgba(26,21,32,0.45); z-index:9000; display:flex; align-items:center; justify-content:center; padding:20px; }',
      '.dr-modal { background:#fff; border-radius:12px; width:100%; max-width:520px; max-height:90vh; overflow:auto; padding:20px 22px; box-shadow:0 18px 50px rgba(0,0,0,0.25); font-size:13px; }',
      '.dr-modal h3 { margin:0 0 12px; font-size:16px; }',
      '.dr-modal label { display:block; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); margin:10px 0 4px; }',
      '.dr-modal input, .dr-modal textarea { width:100%; padding:8px 10px; border:1.5px solid var(--border,#E4DFD4); border-radius:6px; font-family:inherit; font-size:13px; box-sizing:border-box; }',
      '.dr-modal .dr-modal-btns { display:flex; gap:8px; justify-content:flex-end; margin-top:16px; }',
      '.dr-modal button { padding:8px 14px; border-radius:6px; font-family:inherit; font-size:13px; font-weight:600; cursor:pointer; border:1px solid var(--border,#E4DFD4); background:#fff; }',
      '.dr-modal button.primary { background:var(--gold-mid, #C8813A); border-color:var(--gold-mid, #C8813A); color:#fff; }',
      // Deploy 236.501 — "Other Documents" catch-all. Deploy 237.150 (Dan) made it
      // one real section at the bottom instead of a band inside every section, so the
      // block/head/title rules went with it; only the empty-state line is left.
      '.dr-root .dr-other-empty { font-size:12px; color:var(--muted); font-style:italic; padding:6px 2px 2px; }',
      // Deploy 236.502 — auto-compressed badge (amber, informational).
      '.dr-root .dr-comp-badge { display:inline-block; margin-top:6px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--gold-mid); background:rgba(200,129,58,0.10); border:1px solid var(--gold-border, rgba(200,129,58,0.28)); border-radius:20px; padding:2px 9px; cursor:help; }',
      // Deploy 236.164 — bulk-approve button uses the green palette
      // so it reads as a "safe positive action" at a glance.
      '.dr-root .dr-bulk-approve-btn { color:var(--dr-green); border-color:var(--dr-green-border); }',
      '.dr-root .dr-bulk-approve-btn:hover { background:var(--dr-green-light); }',
      // Deploy 236.165 — expiration / staleness badge under the
      // tray name. Severity colors mirror the verdict palette so
      // the visual language is consistent.
      '.dr-root .dr-exp-badge { display:inline-block; margin-top:6px; padding:2px 10px; border-radius:12px; font-size:10px; font-weight:600; font-family:"DM Mono", monospace; letter-spacing:0.02em; }',
      '.dr-root .dr-exp-badge.expired         { background:var(--dr-red-light);   color:var(--dr-red);   border:1px solid var(--dr-red-border); }',
      '.dr-root .dr-exp-badge.expiring-soon   { background:var(--gold-light);     color:var(--gold-mid); border:1px solid var(--gold-border, rgba(200,129,58,0.28)); }',
      '.dr-root .dr-exp-badge.expiring-future { background:#f3f1ec;               color:var(--muted);    border:1px solid var(--border); }',
      // Deploy 236.163 — multi-doc-per-tray collapsible for hidden
      // (replaced) docs. Renders below the live docs in the tray
      // body, dimmer than the live list.
      '.dr-root .dr-hidden-docs { margin-top:8px; padding:6px 0; border-top:1px dashed var(--border); }',
      '.dr-root .dr-hidden-docs summary { font-size:11px; color:var(--muted); cursor:pointer; padding:4px 0; }',
      '.dr-root .dr-hidden-docs summary:hover { color:var(--gold-mid); }',
      '.dr-root .current-doc.is-hidden-doc { opacity:0.65; }',
      // Inline rename pencil on custom tray names.
      '.dr-root .tray-name { display:flex; align-items:center; gap:6px; flex-wrap:wrap; }',
      '.dr-root .tray-name-text { word-break:break-word; }',
      '.dr-root .dr-tray-rename-btn { background:transparent; border:none; cursor:pointer; padding:1px 4px; font-size:11px; color:var(--muted); border-radius:4px; }',
      '.dr-root .dr-tray-rename-btn:hover { background:var(--gold-light, rgba(200,129,58,0.10)); color:var(--gold-mid); }',
      '.dr-root .tray { background:#fff; border:1px solid var(--border, #ddd8d0); border-radius:8px; margin-bottom:6px; overflow:hidden; }',
      // Deploy 237.136 (Mike: "the tray is narrower") -- tighter header now that the
      // rubric subtext is gone.
      '.dr-root .tray-status { font-size:11px; font-weight:700; padding:3px 8px; border-radius:20px; border:1px solid transparent; font-family:inherit; cursor:pointer; max-width:150px; }',
      // Deploy 237.140 -- the per-status colours moved to _STATUS_STYLE so the
      // dropdown's options can use them too; only the shape stays in CSS.
      '.dr-root .tray.approved { border-color:var(--dr-green-border); }',
      '.dr-root .tray.issues   { border-color:var(--dr-red-border); }',
      '.dr-root .tray.na       { border-color:var(--dr-blue-border); }',
      // Deploy 236.161 — Awaiting Review states. Tray border + badge
      // match the AI verdict color so the LO sees the AI pre-screen
      // at a glance, while the badge text makes clear it still
      // needs processor confirmation.
      '.dr-root .tray.awaiting-ok     { border-color:var(--dr-green-border); }',
      '.dr-root .tray.awaiting-issues { border-color:var(--dr-red-border); }',
      '.dr-root .tray.awaiting        { border-color:var(--gold-border, rgba(200,129,58,0.28)); }',
      '.dr-root .tray.is-hidden { opacity:0.55; }',
      '.dr-root .tray.is-hidden .tray-name::after { content:" (hidden)"; color:var(--muted); font-weight:500; font-size:11px; }',
      '.dr-root .tray-head { padding:8px 12px; display:flex; justify-content:space-between; align-items:center; gap:10px; cursor:pointer; }',
      '.dr-root .tray-head:hover { background:var(--gold-light, rgba(200,129,58,0.10)); }',
      '.dr-root .tray-name { font-size:13px; font-weight:600; color:var(--text); }',
      '.dr-root .tray-conditions { font-size:11px; color:var(--muted); margin-top:4px; line-height:1.5; }',
      '.dr-root .tray-verdict { font-size:11px; font-weight:600; padding:3px 10px; border-radius:20px; white-space:nowrap; }',
      '.dr-root .tray-verdict.pending  { background:var(--gold-light); color:var(--muted); border:1px solid var(--border); }',
      '.dr-root .tray-verdict.approved { background:var(--dr-green-light); color:var(--dr-green); border:1px solid var(--dr-green-border); }',
      '.dr-root .tray-verdict.issues   { background:var(--dr-red-light); color:var(--dr-red); border:1px solid var(--dr-red-border); }',
      '.dr-root .tray-verdict.na       { background:var(--dr-blue-light); color:var(--dr-blue); border:1px solid var(--dr-blue-border); }',
      // Deploy 236.972 — uncleared UW conditions flip the chip amber.
      '.dr-root .tray-verdict.conditions { background:var(--gold-light); color:var(--gold-mid); border:1px solid var(--gold-border, rgba(200,129,58,0.28)); }',
      '.dr-root .tray.conditions { border-color:var(--gold-border, rgba(200,129,58,0.28)); }',
      // Deploy 236.161 — Awaiting Review badge variants.
      '.dr-root .tray-verdict.awaiting-ok     { background:var(--dr-green-light); color:var(--dr-green); border:1px solid var(--dr-green-border); }',
      '.dr-root .tray-verdict.awaiting-issues { background:var(--dr-red-light); color:var(--dr-red); border:1px solid var(--dr-red-border); }',
      '.dr-root .tray-verdict.awaiting        { background:var(--gold-light); color:var(--gold-mid); border:1px solid var(--gold-border, rgba(200,129,58,0.28)); }',
      // Deploy 237.071 (Mike, item 9) -- loud chips + a thick left border once a human has acted,
      // so approved vs not-approved reads at a glance on the UW / Reviewed tabs.
      '.dr-root .tray-verdict.uw-pending { background:#b45309; color:#fff; border:1px solid #b45309; }',
      '.dr-root .tray-verdict.uw-approved { background:var(--dr-green); color:#fff; border:1px solid var(--dr-green); }',
      '.dr-root .tray-verdict.uw-na { background:var(--dr-blue); color:#fff; border:1px solid var(--dr-blue); }',
      '.dr-root .tray-verdict.hidden-confirm { background:#7a7488; color:#fff; border:1px solid #7a7488; }',
      '.dr-root .tray-verdict.hidden-ok { background:#e9e5de; color:#4a4458; border:1px solid #d6cfc0; }',
      '.dr-root .tray-verdict.ai-ok { background:var(--dr-green-light); color:var(--dr-green); border:1px solid var(--dr-green-border); margin-right:6px; }',
      '.dr-root .tray-verdict.ai-bad { background:var(--dr-red-light); color:var(--dr-red); border:1px solid var(--dr-red-border); margin-right:6px; }',
      '.dr-root .tray-verdict.ai-unclear { background:var(--gold-light); color:var(--gold-mid); border:1px solid var(--gold-border, rgba(200,129,58,0.28)); margin-right:6px; }',
      '.dr-root .tray.uw-pending { border-color:#b45309; border-left:5px solid #b45309; }',
      '.dr-root .tray.uw-approved { border-color:var(--dr-green); border-left:5px solid var(--dr-green); }',
      '.dr-root .tray.uw-na { border-color:var(--dr-blue); border-left:5px solid var(--dr-blue); }',
      '.dr-root .tray.hidden-confirm { border-left:5px solid #7a7488; opacity:1; }',
      // Deploy 237.071 (item 5) -- the AI review folds up on Ready for UW.
      '.dr-root .dr-ai-collapse { margin-top:10px; }',
      '.dr-root .dr-ai-collapse > summary { cursor:pointer; font-size:12px; font-weight:600; color:var(--muted); padding:6px 0; list-style:none; }',
      '.dr-root .dr-ai-collapse > summary::before { content:"\u25b8 "; }',
      '.dr-root .dr-ai-collapse[open] > summary::before { content:"\u25be "; }',
      // Deploy 237.072 (Mike, items 3 + 8) -- what-to-verify panel + full-file tracker.
      '.dr-root .dr-verify { margin-bottom:10px; padding:10px 14px; border:1px solid var(--gold-border, rgba(200,129,58,0.28)); background:var(--gold-light, rgba(200,129,58,0.08)); border-radius:8px; font-size:12px; line-height:1.5; }',
      '.dr-root .dr-verify h5 { margin:0 0 6px; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--gold-mid); }',
      '.dr-root .dr-verify ul { margin:0 0 8px; padding-left:18px; }',
      '.dr-root .dr-verify li { margin:2px 0; }',
      '.dr-root .dr-verify .kv { display:flex; flex-direction:column; gap:3px; }', // Deploy 237.079 (Mike) -- one item per line
      '.dr-root .dr-verify .kv span { display:block; line-height:1.35; }',
      '.dr-root .dr-verify .kv b { color:var(--text); }',
      '.dr-root .dr-fullfile { margin:0 0 16px; padding:12px 16px; border:1px solid var(--border); background:#fff; border-radius:10px; font-size:12px; }',
      '.dr-root .dr-fullfile.complete { border-color:var(--dr-green-border); background:var(--dr-green-light); }',
      '.dr-root .dr-fullfile .ff-head { display:flex; justify-content:space-between; align-items:center; gap:12px; font-weight:700; font-size:13px; }',
      '.dr-root .dr-fullfile .ff-pct { font-size:12px; color:var(--muted); }',
      '.dr-root .dr-fullfile .ff-bar { height:8px; border-radius:4px; background:#ece7df; margin:8px 0; overflow:hidden; }',
      '.dr-root .dr-fullfile .ff-fill { height:100%; background:var(--gold-mid, #b5712d); border-radius:4px; }',
      '.dr-root .dr-fullfile.complete .ff-fill { background:var(--dr-green); }',
      '.dr-root .dr-fullfile .ff-missing-label { display:inline-block; font-size:10.5px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; color:var(--dr-red); margin:4px 0; }',
      '.dr-root .dr-fullfile .ff-sec { margin:2px 0; line-height:1.5; }',
      '.dr-root .dr-fullfile .ff-note { margin-top:6px; font-size:11px; color:var(--muted); }',
      '.dr-root .tray-body { padding:4px 18px 18px; border-top:1px solid var(--border); background:#fcfaf6; }',
      '.dr-root .tray-body.collapsed { display:none; }',

      '.dr-root .dropzone { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; border:2px dashed var(--gold-border, rgba(200,129,58,0.28)); border-radius:8px; padding:1.75rem 1rem; text-align:center; color:var(--muted); font-size:12px; cursor:pointer; transition:all 0.15s; background:#fff; margin-top:14px; width:100%; box-sizing:border-box; }',
      '.dr-root .dropzone:hover, .dr-root .dropzone.dragover { border-color:var(--gold, #C8813A); background:var(--gold-light); color:var(--gold-mid); }',
      '.dr-root .dropzone .dz-icon { font-size:24px; line-height:1; }',
      '.dr-root .dropzone .dz-text { font-weight:500; }',
      '.dr-root .dropzone .dz-hint { font-size:11px; color:var(--muted); }',
      '.dr-root .dropzone input[type=file] { display:none; }',

      '.dr-root .current-doc { display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#fff; border:1px solid var(--border); border-radius:6px; margin-top:12px; font-size:12px; }',
      '.dr-root .current-doc .doc-name { font-weight:600; color:var(--text); }',
      '.dr-root .current-doc .doc-meta { color:var(--muted); margin-top:2px; font-family:"DM Mono", monospace; font-size:11px; }',
      '.dr-root .current-doc .doc-actions { display:flex; gap:6px; }',
      '.dr-root .small-btn { padding:5px 10px; font-size:11px; font-weight:600; color:var(--muted); background:transparent; border:1px solid var(--border); border-radius:5px; cursor:pointer; text-decoration:none; transition:all 0.15s; font-family:"DM Sans", sans-serif; }',
      '.dr-root .small-btn:hover { border-color:var(--gold); color:var(--gold-mid); }',
      '.dr-root .small-btn.danger:hover { border-color:var(--dr-red); color:var(--dr-red); }',

      '.dr-root .notes-area { width:100%; min-height:60px; padding:8px 12px; border:1px solid var(--border); border-radius:6px; font-size:12px; font-family:"DM Sans", sans-serif; resize:vertical; }',
      '.dr-root .notes-area:focus { outline:none; border-color:var(--gold); }',
      // Deploy 236.158 — notes header (label + autosave indicator).
      '.dr-root .dr-notes-wrap { margin-top:10px; }',
      '.dr-root .dr-notes-label { display:flex; justify-content:space-between; align-items:center; font-size:11px; font-weight:600; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:4px; }',
      '.dr-root .dr-notes-status { font-size:10px; font-weight:500; text-transform:none; letter-spacing:0; min-height:14px; transition:opacity 0.2s; }',
      '.dr-root .dr-notes-status.saving { color:var(--muted); }',
      '.dr-root .dr-notes-status.saved  { color:var(--dr-green); }',
      '.dr-root .dr-notes-status.failed { color:var(--dr-red); }',
      /* Deploy 237.066 — per-document note log */
      '.dr-root .dr-note-list { display:flex; flex-direction:column; gap:6px; margin-bottom:8px; }',
      '.dr-root .dr-note { border:1px solid var(--border,#ddd8d0); border-left:3px solid var(--gold,#C8813A); border-radius:6px; background:#fff; padding:7px 10px; }',
      '.dr-root .dr-note.editing { border-left-color:#261a36; }',
      '.dr-root .dr-note-head { display:flex; align-items:center; gap:8px; font-size:11px; color:var(--muted); margin-bottom:3px; }',
      '.dr-root .dr-note-who { font-weight:700; color:var(--text,#1a1520); }',
      '.dr-root .dr-note-when { font-size:10.5px; }',
      '.dr-root .dr-note-act { cursor:pointer; text-decoration:underline; color:var(--gold-mid,#b5712d); font-size:10.5px; }',
      '.dr-root .dr-note-act.danger { color:var(--dr-red,#7c1f1f); }',
      '.dr-root .dr-note-text { font-size:12.5px; line-height:1.5; white-space:pre-wrap; word-break:break-word; }',
      '.dr-root .dr-note-add .notes-area { min-height:54px; }',
      '.dr-root .dr-note-btns { display:flex; align-items:center; gap:8px; margin-top:5px; }',
      '.dr-root .dr-note-btns .small-btn.primary { background:#261a36; color:#fff; border-color:#261a36; }',
      '.dr-root .dr-note-hint { font-size:10.5px; color:var(--muted); }',
      // Deploy 236.158 — inline rename UI on doc-name.
      '.dr-root .doc-name { display:flex; align-items:center; gap:6px; min-width:0; }',
      '.dr-root .doc-name-text { word-break:break-all; }',
      '.dr-root .dr-rename-btn { background:transparent; border:none; cursor:pointer; padding:2px 4px; font-size:12px; color:var(--muted); border-radius:4px; opacity:0; transition:opacity 0.15s; }',
      '.dr-root .current-doc:hover .dr-rename-btn { opacity:0.85; }',
      '.dr-root .dr-rename-btn:hover { background:var(--gold-light, rgba(200,129,58,0.10)); color:var(--gold-mid); opacity:1; }',
      '.dr-root .dr-rename-input { flex:1; min-width:0; padding:4px 8px; font-size:13px; font-family:"DM Sans", sans-serif; border:1.5px solid var(--gold); border-radius:5px; }',
      '.dr-root .dr-rename-input:focus { outline:none; }',
      '.dr-root .dr-rename-save  { color:var(--dr-green); border-color:var(--dr-green-border); }',
      '.dr-root .dr-rename-cancel { color:var(--muted); }',
      '.dr-root .verdict-actions { display:flex; gap:8px; margin-top:12px; flex-wrap:wrap; }',
      '.dr-root .v-btn { padding:7px 14px; font-size:12px; font-weight:600; border:1px solid var(--border); background:#fff; border-radius:6px; cursor:pointer; transition:all 0.15s; font-family:"DM Sans", sans-serif; }',
      '.dr-root .v-btn.approve  { color:var(--dr-green); border-color:var(--dr-green-border); }',
      '.dr-root .v-btn.approve:hover  { background:var(--dr-green-light); }',
      '.dr-root .v-btn.issues   { color:var(--dr-red); border-color:var(--dr-red-border); }',
      '.dr-root .v-btn.issues:hover { background:var(--dr-red-light); }',
      '.dr-root .v-btn.na { color:var(--dr-blue); border-color:var(--dr-blue-border); }',
      '.dr-root .v-btn.na:hover { background:var(--dr-blue-light); }',
      '.dr-root .v-btn.unapprove { color:var(--muted); }',
      '.dr-root .v-btn.unapprove:hover { border-color:var(--gold); color:var(--gold-mid); }',

      '.dr-root .ai-block { margin-top:12px; padding:10px 14px; border-radius:8px; border:1px solid var(--border); background:#fff; }',
      '.dr-root .ai-block.approved { border-color:var(--dr-green-border); background:var(--dr-green-light); }',
      '.dr-root .ai-block.issues   { border-color:var(--dr-red-border);   background:var(--dr-red-light); }',
      '.dr-root .ai-block.pending  { border-color:var(--gold-border, rgba(200,129,58,0.28));  background:var(--gold-light, rgba(200,129,58,0.10)); }',
      // Deploy 236.669 — document-integrity / tampering-risk badge
      '.dr-root .di-block { margin-top:10px; padding:9px 12px; border-radius:8px; border:1px solid var(--border); font-size:12.5px; }',
      '.dr-root .di-block.di-high { border-color:var(--dr-red-border); background:var(--dr-red-light); }',
      '.dr-root .di-block.di-med  { border-color:var(--gold-border, rgba(200,129,58,0.28)); background:var(--gold-light, rgba(200,129,58,0.10)); }',
      '.dr-root .di-block.di-low  { border-color:var(--border); background:#fafafa; }',
      '.dr-root .di-head { font-weight:700; font-size:12px; }',
      '.dr-root .di-block.di-high .di-head { color:#b91c1c; }',
      '.dr-root .di-block.di-med .di-head { color:#b5712d; }',
      '.dr-root .di-block.di-low .di-head { color:#166534; }',
      '.dr-root .di-sigs { margin:6px 0 0; padding-left:18px; }',
      '.dr-root .di-sigs li { margin:2px 0; line-height:1.35; }',
      '.dr-root .di-sigs li.di-lvl-high { color:#7c1f1f; font-weight:600; }',
      '.dr-root .di-info { margin-top:6px; font-size:11px; color:var(--muted); }',
      '.dr-root .di-note { margin-top:7px; font-size:10.5px; color:var(--muted); font-style:italic; }',
      '.dr-root .ai-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; }',
      '.dr-root .ai-label { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }',
      '.dr-root .ai-label.approved { color:var(--dr-green); }',
      '.dr-root .ai-label.issues   { color:var(--dr-red); }',
      '.dr-root .ai-label.pending  { color:var(--gold-mid); }',
      '.dr-root .ai-cost { font-size:10px; color:var(--muted); font-family:"DM Mono", monospace; }',
      '.dr-root .ai-summary { font-size:12px; color:var(--text); margin-top:6px; line-height:1.5; }',
      // Deploy 237.070 (Mike) -- compact AI block: verdict + per-condition checks only;
      // the summary and each finding's detail sit behind the Details toggle.
      '.dr-root .ai-block.compact .ai-summary, .dr-root .ai-block.compact .f-detail { display:none; }',
      '.dr-root .ai-findings { margin-top:8px; }',
      '.dr-root .ai-finding { display:flex; gap:8px; align-items:flex-start; font-size:11px; padding:4px 0; line-height:1.5; border-top:1px dashed var(--border); padding-top:6px; margin-top:6px; }',
      '.dr-root .ai-finding:first-child { border-top:0; padding-top:0; margin-top:0; }',
      '.dr-root .ai-finding .f-icon { flex-shrink:0; font-weight:700; width:14px; }',
      '.dr-root .ai-finding.met     .f-icon { color:var(--dr-green); }',
      '.dr-root .ai-finding.not_met .f-icon { color:var(--dr-red); }',
      '.dr-root .ai-finding.unclear .f-icon { color:var(--dr-amber); }',
      '.dr-root .ai-finding .f-text { flex:1; }',
      '.dr-root .ai-finding .f-cond { font-weight:600; color:var(--text); }',
      '.dr-root .ai-finding .f-detail { color:var(--muted); margin-top:2px; }',
      '.dr-root .ai-spinner { display:inline-block; width:11px; height:11px; border:2px solid var(--gold-light); border-top-color:var(--gold); border-radius:50%; animation:dr-spin 0.8s linear infinite; vertical-align:middle; margin-right:4px; }',
      '@keyframes dr-spin { to { transform: rotate(360deg); } }',

      '.dr-root .history-accordion { margin-top:14px; }',
      '.dr-root .history-accordion summary { font-size:11px; color:var(--muted); cursor:pointer; padding:6px 0; user-select:none; }',
      '.dr-root .history-accordion summary:hover { color:var(--gold-mid); }',
      '.dr-root .history-row { padding:8px 12px; background:#fff; border:1px solid var(--border); border-radius:6px; margin-top:6px; font-size:11px; color:var(--muted); }',
      '.dr-root .history-row .h-filename { font-weight:600; color:var(--text); }',
      '.dr-root .history-row .h-meta { margin-top:2px; font-family:"DM Mono", monospace; }',
      '.dr-root .history-row .h-notes { margin-top:4px; font-style:italic; }',

      '.dr-root .consistency-card { background:#fff; border:1px solid var(--border); border-radius:10px; padding:1.25rem 1.5rem; margin-top:1.5rem; }',
      '.dr-root .consistency-card h3 { font-size:14px; font-weight:600; margin-bottom:6px; }',
      '.dr-root .consistency-card p { font-size:12px; color:var(--muted); line-height:1.5; }',
      '.dr-root .ai-soon { display:inline-block; font-size:10px; font-weight:600; color:var(--gold-mid); background:var(--gold-light); border:1px solid var(--gold-border); padding:2px 8px; border-radius:10px; text-transform:uppercase; letter-spacing:0.04em; margin-left:6px; }',
      // Deploy 236.517 — cross-document consistency check.
      '.dr-root .consistency-card.has-mismatch { border-color:var(--dr-red-border, rgba(124,31,31,0.28)); box-shadow:inset 3px 0 0 var(--danger, #7c1f1f); }',
      '.dr-root .dr-cc-head { display:flex; align-items:center; justify-content:space-between; gap:10px; margin-bottom:4px; }',
      '.dr-root .dr-cc-head h3 { margin:0; }',
      '.dr-root .dr-cc-badge { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; padding:3px 10px; border-radius:20px; white-space:nowrap; }',
      '.dr-root .dr-cc-badge.fail { color:var(--danger, #7c1f1f); background:rgba(124,31,31,0.10); border:1px solid rgba(124,31,31,0.28); }',
      '.dr-root .dr-cc-badge.ok { color:var(--dr-green, #166534); background:rgba(21,128,61,0.10); border:1px solid rgba(21,128,61,0.25); }',
      '.dr-root .dr-cc-badge.none { color:var(--muted); background:var(--bg, #f7f5f1); border:1px solid var(--border); }',
      '.dr-root .dr-cc-sub { font-size:12px; color:var(--muted); line-height:1.5; margin-bottom:12px; }',
      '.dr-root .dr-cc-rows { display:flex; flex-direction:column; }',
      '.dr-root .dr-cc-row { display:grid; grid-template-columns:180px 1fr; gap:12px; padding:9px 0; border-top:1px solid rgba(0,0,0,0.05); font-size:13px; }',
      '.dr-root .dr-cc-row:first-child { border-top:0; }',
      '.dr-root .dr-cc-field { font-weight:600; color:var(--text, #1a1520); }',
      '.dr-root .dr-cc-row.mismatch .dr-cc-field { color:var(--danger, #7c1f1f); }',
      '.dr-root .dr-cc-row.ok .dr-cc-field { color:var(--dr-green, #166534); }',
      '.dr-root .dr-cc-row.none .dr-cc-field, .dr-root .dr-cc-row.single .dr-cc-field { color:var(--muted); font-weight:500; }',
      '.dr-root .dr-cc-val { font-family:"DM Mono", monospace; font-weight:600; }',
      '.dr-root .dr-cc-agree, .dr-root .dr-cc-only { color:var(--muted); font-size:12px; }',
      '.dr-root .dr-cc-variant { display:flex; flex-wrap:wrap; align-items:baseline; gap:4px 10px; padding:3px 8px; margin-bottom:4px; background:rgba(124,31,31,0.06); border-radius:6px; }',
      '.dr-root .dr-cc-variant:last-child { margin-bottom:0; }',
      '.dr-root .dr-cc-srcs { font-size:11px; color:var(--muted); }',
      '.dr-root .loading-page { padding:4rem; text-align:center; color:var(--muted); font-size:13px; }',

      // Modals — body-mounted, dr- prefixed so they don't collide with
      // host-page modals on loan-details (.modal-bg / .modal are taken).
      '.dr-modal-bg { position:fixed; inset:0; background:rgba(38,26,54,0.45); display:none; align-items:center; justify-content:center; z-index:900; }',
      '.dr-modal-bg.show { display:flex; }',
      '.dr-modal { background:#fff; border-radius:10px; padding:1.5rem; max-width:460px; width:90%; font-family:"DM Sans", sans-serif; color:#1a1520; }',
      '.dr-modal h3 { font-size:15px; font-weight:600; margin-bottom:12px; }',
      '.dr-modal p { font-size:13px; color:#7a7488; margin-bottom:14px; }',
      '.dr-modal-actions { display:flex; gap:10px; justify-content:flex-end; margin-top:1rem; }',
      '.dr-modal .notes-area { width:100%; min-height:80px; padding:8px 12px; border:1px solid #ddd8d0; border-radius:6px; font-size:12px; font-family:"DM Sans", sans-serif; resize:vertical; }',
      '.dr-modal .notes-area:focus { outline:none; border-color:#C8813A; }',
      '.dr-modal-btn { padding:7px 14px; font-size:12px; font-weight:600; border:1px solid #ddd8d0; background:#fff; border-radius:6px; cursor:pointer; font-family:"DM Sans", sans-serif; }',
      '.dr-modal-btn:hover { border-color:#C8813A; color:#b5712d; }',
      '.dr-modal-btn.approve { color:#15803d; border-color:rgba(21,128,61,0.40); }',
      '.dr-modal-btn.approve:hover { background:rgba(21,128,61,0.10); }',
      '.dr-modal-btn.danger { color:#b91c1c; border-color:rgba(185,28,28,0.40); }',
      '.dr-modal-btn.danger:hover { background:rgba(185,28,28,0.10); }',

      '.dr-toast { position:fixed; top:20px; right:20px; padding:12px 18px; background:#fff; border:1px solid #ddd8d0; border-radius:8px; font-size:13px; box-shadow:0 4px 16px rgba(0,0,0,0.08); z-index:1000; max-width:360px; display:none; font-family:"DM Sans", sans-serif; }',
      '.dr-toast.show { display:block; }',
      '.dr-toast.success { border-color:rgba(21,128,61,0.40); color:#15803d; }',
      '.dr-toast.error   { border-color:rgba(185,28,28,0.40); color:#b91c1c; }',
      '.dr-toast.info    { border-color:rgba(200,129,58,0.28); color:#b5712d; }',
    ].join('\n');
    document.head.appendChild(s);
  }

  function injectModalsOnce() {
    if (_modalsInjected) return;
    _modalsInjected = true;
    var html = [
      // Override modal
      '<div class="dr-modal-bg" id="dr-overrideModal"><div class="dr-modal">',
        '<h3>Override AI verdict</h3>',
        '<p>Tell us why the AI got this wrong. Your reason will be saved for admin review so the AI can be retrained.</p>',
        '<textarea id="dr-overrideReason" class="notes-area" style="min-height:100px" placeholder="e.g., AI flagged this Operating Agreement as missing a signature page but page 6 has all signatures."></textarea>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeOverrideModal()">Cancel</button>',
          '<button class="dr-modal-btn approve" onclick="dr_confirmOverride()">Approve anyway</button>',
        '</div>',
      '</div></div>',
      // Deploy 236.746 — Flag Issue modal: the processor states WHAT is wrong.
      // The reason lands on the tray (flagReason), in the loan\'s Notes &
      // Activity stream, and on the borrower portal with a re-upload prompt.
      '<div class="dr-modal-bg" id="dr-flagModal"><div class="dr-modal">',
        '<h3>Flag an issue</h3>',
        '<p>Describe the problem with this document. The borrower will see this on their portal and be asked to upload a corrected version; it\'s also saved to the loan\'s note stream.</p>',
        '<textarea id="dr-flagReason" class="notes-area" style="min-height:100px" placeholder="e.g., Bank statement is missing pages 3-4 — please upload the complete statement."></textarea>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeFlagModal()">Cancel</button>',
          '<button class="dr-modal-btn" style="color:#92400e;border-color:rgba(146,64,14,0.40)" onclick="dr_confirmFlag()">Flag Issue</button>',
        '</div>',
      '</div></div>',
      // N/A modal
      '<div class="dr-modal-bg" id="dr-naModal"><div class="dr-modal">',
        '<h3>Mark as Not Applicable</h3>',
        '<p>Why doesn\'t this document apply to this loan?</p>',
        '<textarea id="dr-naReason" class="notes-area" placeholder="e.g., No assignment of contract on this loan — direct purchase."></textarea>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeNaModal()">Cancel</button>',
          '<button class="dr-modal-btn" style="color:#1e40af;border-color:rgba(30,64,175,0.40)" onclick="dr_confirmNa()">Mark N/A</button>',
        '</div>',
      '</div></div>',
      // Deploy 237.071 (item 6) -- Hide tray modal: who + why, for the underwriter to confirm.
      '<div class="dr-modal-bg" id="dr-hideModal"><div class="dr-modal">',
        '<h3>Hide this tray</h3>',
        '<p>Why does this loan not need this document? The underwriter sees your name and reason on the Underwriting tab and confirms the hide.</p>',
        '<textarea id="dr-hideReason" class="notes-area" placeholder="e.g., Refinance — no purchase contract on this loan."></textarea>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeHideModal()">Cancel</button>',
          '<button class="dr-modal-btn" onclick="dr_confirmHide()">Hide tray</button>',
        '</div>',
      '</div></div>',
      // Deploy 236.162 — Add Custom Document modal.
      '<div class="dr-modal-bg" id="dr-addDocModal"><div class="dr-modal">',
        '<h3>Add a document category</h3>',
        '<p style="font-size:12px;color:#7a7488;margin-bottom:14px">Adds a new category (tray) to the <span id="dr-addDocSection" style="font-weight:600;color:#1a1520"></span> section — for a document type that isn\'t listed, or an additional version you need to review. You can rename it later by clicking the pencil next to the tray name, or hide it with "⊘ Hide tray".</p>',
        '<input type="text" id="dr-addDocName" class="notes-area" style="min-height:auto;font-size:13px" placeholder="e.g., 2nd Appraisal, Investor-specific addendum, Lien waiver, ..." />',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeAddDocModal()">Cancel</button>',
          '<button class="dr-modal-btn approve" onclick="dr_confirmAddDoc()">Add Category</button>',
        '</div>',
      '</div></div>',
      // Deploy 236.675 — Move-to-category modal. Body (the source label +
      // destination <select>) is rebuilt per-open in dr_openMoveModal.
      '<div class="dr-modal-bg" id="dr-moveModal"><div class="dr-modal">',
        '<h3>Move document to another category</h3>',
        '<p style="font-size:12px;color:#7a7488;margin-bottom:12px">Moves the file(s) from <span id="dr-moveFromLabel" style="font-weight:600;color:#1a1520"></span> into the category you pick, then re-runs the AI review against that category\'s checklist. Useful when a document landed in the wrong bucket (e.g. an appraisal that came in as "Other").</p>',
        '<select id="dr-moveTarget" class="notes-area" style="min-height:auto;font-size:13px"></select>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeMoveModal()">Cancel</button>',
          '<button class="dr-modal-btn approve" onclick="dr_confirmMove()">Move &amp; Review</button>',
        '</div>',
      '</div></div>',
      // Deploy 236.163 — Replace-or-Add modal for multi-doc uploads.
      // Body content (the existing-docs list + radios) is rebuilt
      // per-open in dr_openReplaceOrAddModal so it reflects the
      // current tray state.
      '<div class="dr-modal-bg" id="dr-replaceOrAddModal"><div class="dr-modal" style="max-width:520px">',
        '<h3>Is this replacing or in addition?</h3>',
        '<p style="font-size:12px;color:#7a7488;margin-bottom:12px">This tray already has a document. Replacing hides the original (it stays on the record so you can unhide later). Adding keeps both visible side-by-side.</p>',
        '<div id="dr-replaceOrAddBody"></div>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeReplaceOrAddModal()">Cancel</button>',
          '<button class="dr-modal-btn approve" onclick="dr_confirmReplaceOrAdd()">Continue</button>',
        '</div>',
      '</div></div>',
      // Finalize modal
      '<div class="dr-modal-bg" id="dr-finalizeModal"><div class="dr-modal">',
        '<h3>Finalize this review?</h3>',
        '<p>This marks the review complete and <strong>deletes every uploaded document</strong> from SLA\'s storage (final docs live in your LOS). The review record + verdicts stay for audit. This cannot be undone.</p>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeFinalizeModal()">Cancel</button>',
          '<button class="dr-modal-btn approve" onclick="dr_confirmFinalize()">Finalize &amp; Purge Docs</button>',
        '</div>',
      '</div></div>',
      // Delete modal
      '<div class="dr-modal-bg" id="dr-deleteModal"><div class="dr-modal">',
        '<h3>Delete this review?</h3>',
        '<p>This permanently removes the review record, every uploaded document, and the entire audit trail of verdicts and notes. <strong>This cannot be undone.</strong></p>',
        '<p style="font-size:11px;color:#7a7488;margin-bottom:0">If you only want to wrap up a finished review while keeping the verdict history, use Finalize instead.</p>',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeDeleteModal()">Cancel</button>',
          '<button class="dr-modal-btn danger" id="dr-deleteConfirmBtn" onclick="dr_confirmDeleteReview()">Delete Review</button>',
        '</div>',
      '</div></div>',
      // Toast
      '<div class="dr-toast" id="dr-toast"></div>',
    ].join('');
    var wrap = document.createElement('div');
    wrap.id = 'dr-modal-wrap';
    wrap.innerHTML = html;
    document.body.appendChild(wrap);
  }

  function showToast(msg, kind) {
    var t = document.getElementById('dr-toast');
    if (!t) return;
    t.className = 'dr-toast show ' + (kind || 'info');
    t.textContent = msg;
    setTimeout(function() { t.classList.remove('show'); }, 3500);
  }

  // ── Lifecycle ────────────────────────────────────────────────────
  function mount(rootEl, opts) {
    if (!rootEl) throw new Error('SLA.DocReview.mount: rootEl required');
    opts = opts || {};
    if (!opts.reviewId) throw new Error('SLA.DocReview.mount: opts.reviewId required');

    injectStylesOnce();
    injectModalsOnce();

    _root = rootEl;
    _opts = opts;
    _liveLoan = opts.loan || global._loan || null; // Deploy 237.078
    _user = opts.user || (global.netlifyIdentity && global.netlifyIdentity.currentUser && global.netlifyIdentity.currentUser());
    // Reset module state per-mount so reopening a different review
    // doesn't leak prior _expanded / _activeTab.
    _review = null;
    _activeTab = 'processor';
    _expanded = {};
    _aiDetailsOpen = {}; // Deploy 237.070
    _aiOpenTray = {};    // Deploy 237.221
    _mxSig = null;       // Deploy 237.222 -- a new review is a new baseline, not a change
    _pendingOverride = null;
    _pendingNa = null;
    _pendingHide = null; // Deploy 237.071
    _docSearch = '';
    _sourceOpen = false;
    _uploadingSlug = null;
    _uploadQueue = []; // Deploy 237.105

    rootEl.classList.add('dr-root');
    rootEl.innerHTML = '<div class="loading-page">Loading review…</div>';
    loadReview();
  }

  function loadReview() {
    global.SLA.LoanReviews.get(_opts.reviewId).then(function(r) {
      _review = r.review;
      render();
      try { _autoSyncIfStale(); } catch (_) {} // Deploy 237.078
      // Deploy 236.677 — self-heal: backfill any standard checklist categories
      // this review is missing (created before the category existed). Runs after
      // the first paint so it never delays load; re-renders only if it added
      // trays. Idempotent + processor-gated — a non-processor viewer just skips it.
      if (global.SLA.LoanReviews.syncCategories) {
        global.SLA.LoanReviews.syncCategories(_opts.reviewId).then(function(sr) {
          // Deploy 237.239 -- a re-name (237.237) changes what every document is
          // CALLED without adding a tray, so the old `added.length` test left the
          // page showing the names it had already painted and the fix only appeared
          // on the next load. Re-render whenever the sync changed anything.
          if (sr && sr.review && ((sr.added && sr.added.length) || sr.renamed)) {
            _review = sr.review;
            render();
          }
        }).catch(function() { /* non-fatal — page already rendered */ });
      }
    }).catch(function(err) {
      _root.innerHTML = '<div class="loading-page">Failed to load: ' + escHtml(err.message || 'Unknown error') + '</div>';
    });
  }

  // ── Render ───────────────────────────────────────────────────────
  // Deploy 237.046 (Dan, via Mike) -- render() replaces the root's innerHTML. On the
  // Pending tab an approved tray leaves the list, everything below it shifts up
  // and the browser keeps the old scrollY, so the processor landed "in a random
  // spot partway down the doc list". Anchor on the first tray visible before the
  // re-render and restore its viewport offset afterwards; if that tray is gone
  // (approved / N/A -> moved to the Reviewed tab) the next surviving tray in the
  // old order takes its place on screen, so the next document to review appears
  // exactly where the approved one was. No visible trays (scrolled below the
  // list) => leave the browser alone.
  function _captureScrollAnchor() {
    if (!_root) return null;
    var trays = _root.querySelectorAll('.tray[id^="dr-tray_"]');
    if (!trays.length) return null;
    var slugs = [], top = null;
    for (var i = 0; i < trays.length; i++) {
      var r = trays[i].getBoundingClientRect();
      if (top === null) {
        if (r.bottom <= 0) continue;   // already scrolled past this tray
        top = r.top;
      }
      slugs.push(trays[i].id.slice('dr-tray_'.length));
    }
    return top === null ? null : { slugs: slugs, top: top };
  }
  function _restoreScrollAnchor(a) {
    if (!a || !_root) return;
    for (var i = 0; i < a.slugs.length; i++) {
      var el = document.getElementById('dr-tray_' + a.slugs[i]);
      if (!el) continue;
      var delta = el.getBoundingClientRect().top - a.top;
      if (Math.abs(delta) > 1) window.scrollTo(window.pageXOffset || 0, (window.pageYOffset || 0) + delta);
      return;
    }
  }

  // Per-tray fields still on the record: verdict + approvedAt / approvedBy
  // (processor), uwVerdict / uwApprovedAt / uwApprovedBy / uwConditionsAt /
  // uwConditionsBy (237.071/.100 — now written by dr_setStatus, read by the
  // backend counts), hidden + hiddenBy / hiddenAt / hiddenReason +
  // hiddenConfirmedBy / hiddenConfirmedAt. Any processor-tier user may set any
  // status (Mike's call; there is no separate underwriter role).
  // Deploy 237.138 (Dan Austin's list, via Mike) -- the six statuses. The notes Dan
  // put in parentheses are BEHAVIOUR, not labels:
  //   Outstanding -- the base status until a document is uploaded (red)
  //   Received    -- applied AUTOMATICALLY when a borrower or processor uploads
  //                  one (blue; see the four upload endpoints)
  //   PTD / PTF   -- Prior To Docs / Prior To Funding, the two condition kinds the
  //                  per-tray condition list already tracks as priorTo docs|funding
  // Deploy 237.140 (Mike: "make the colors appear in the drop down menu. Currently
  // its all the same color when you open the drop down") -- an <option> only takes a
  // colour from an inline style / its own rule, so the chip AND every option are
  // painted from this one table. Chrome + Firefox honour it; Safari on macOS draws
  // the native popup plain, which is why the chip itself stays colour-coded.
  var _STATUS_STYLE = {
    outstanding:        { bg: '#e03e3e', fg: '#ffffff', bd: '#e03e3e' },
    received:           { bg: '#1155cc', fg: '#ffffff', bd: '#1155cc' },
    processor_approved: { bg: '#d81b76', fg: '#ffffff', bd: '#d81b76' },
    ptd_condition:      { bg: '#e8912d', fg: '#ffffff', bd: '#e8912d' },
    ptf_condition:      { bg: '#f0cf3f', fg: '#4a3a00', bd: '#d9b92c' },
    condition_addressed:{ bg: '#0f766e', fg: '#ffffff', bd: '#0f766e' }, // Deploy 237.213 (Jessy) -- teal: neither a condition colour nor approved-green
    uw_approved:        { bg: '#166534', fg: '#ffffff', bd: '#166534' },
    na:                 { bg: '#e9e5de', fg: '#4a4458', bd: '#d6cfc0' },
  };
  function _statusCss(key) {
    var c = _STATUS_STYLE[key] || { bg: '#ffffff', fg: '#4a4458', bd: '#ddd8d0' };
    return 'background:' + c.bg + ';color:' + c.fg + ';border-color:' + c.bd;
  }
  var _STATUSES = [
    { key: 'outstanding',        label: 'Outstanding'          },
    { key: 'received',           label: 'Received'             },
    { key: 'processor_approved', label: 'Processor Approved'   },
    { key: 'ptd_condition',      label: 'PTD Condition'        },
    { key: 'ptf_condition',      label: 'PTF Condition'        },
    // Deploy 237.213 (Jessy, via Mike) -- the processor's half of a condition: "I have
    // dealt with it, it is yours again." Dee marks PTD, the tray goes to Conditions;
    // Raissa resolved it and set Received, which sent the tray BACK to Underwriting and
    // left Dee hunting for it among every newly uploaded doc. This status keeps it on
    // the Conditions tab. Only offered on a tray that IS under a condition -- on any
    // other tray it would be a claim about a condition nobody made.
    { key: 'condition_addressed', label: 'Condition Addressed', onlyUnderCondition: true },
    { key: 'uw_approved',        label: 'Underwriter Approved' },
  ];
  // Trays marked N/A before Dan's list replaced that option. Kept so the old data
  // still reads correctly, and offered in the dropdown ONLY on a tray that already
  // holds it -- it is not a choice on anything else.
  var _LEGACY_STATUSES = [{ key: 'na', label: 'Not Applicable' }];
  // Statuses that mean the processor is DONE with the tray -> Underwriting tab.
  // Outstanding / Received are collection work, so they stay with the processor.
  // Deploy 237.213 -- Condition Addressed is on the UNDERWRITER's desk, not the processor's.
  var _UW_STATUS = { processor_approved: 1, ptd_condition: 1, ptf_condition: 1, condition_addressed: 1, uw_approved: 1, na: 1 };
  function _condPriorTo(d) {
    var open = (Array.isArray(d && d.conditions) ? d.conditions : []).filter(function(c) { return c && c.status !== 'cleared'; });
    for (var i = 0; i < open.length; i++) if (open[i].priorTo === 'funding') return 'funding';
    return 'docs';
  }
  function _statusOf(slug) {
    var d = (_review && _review.docs && _review.docs[slug]) || {};
    // Deploy 237.213 (Jessy) -- an upload onto a conditioned tray used to stamp it
    // Received (Dan's auto-rule), and uploads have never touched uwVerdict. So
    // "Received, but uwVerdict still says conditions" can only mean a new document
    // landed on a tray the underwriter conditioned -- which IS Condition Addressed.
    // Reading it that way puts the trays Dee is hunting for today back on her tab
    // without migrating anything. (New uploads store the real status: doc-status.mjs.)
    if (d.status === 'received' && d.uwVerdict === 'conditions') return 'condition_addressed';
    if (d.status) return d.status;
    // Trays reviewed before this deploy: derive from the old verdict pair.
    if (d.verdict === 'na') return 'na';
    if (d.uwVerdict === 'approved') return 'uw_approved';
    if (d.uwVerdict === 'conditions') return _condPriorTo(d) === 'funding' ? 'ptf_condition' : 'ptd_condition';
    if (d.verdict === 'approved') return 'processor_approved';
    // 'issues' was the retired Rejected -- that document is work outstanding again.
    if (d.verdict === 'issues') return 'outstanding';
    return _trayHasDoc(d) ? 'received' : 'outstanding';
  }
  function _statusLabel(key) {
    var all = _STATUSES.concat(_LEGACY_STATUSES);
    for (var i = 0; i < all.length; i++) if (all[i].key === key) return all[i].label;
    return '';
  }
  function _openCondCount(d) {
    return (Array.isArray(d && d.conditions) ? d.conditions : []).filter(function(c) { return c && c.status !== 'cleared'; }).length;
  }
  // Mike: "When conditions are cleared they are removed from the Conditions tab."
  // A tray just marked PTD / PTF with nothing listed yet still shows, so the
  // underwriter can go add the items.
  function _onConditionsTab(slug) {
    var d = (_review && _review.docs && _review.docs[slug]) || {};
    if (d.hidden) return false;
    if (_openCondCount(d) > 0) return true;
    var st = _statusOf(slug);
    // Deploy 237.213 (Jessy) -- Condition Addressed stays HERE until the underwriter
    // moves it, items or no items. Dee reviews the new document, clears the item and
    // approves; if clearing the last item made the tray vanish first she would be back
    // to hunting for it in Underwriting, which is the whole complaint.
    if (st === 'condition_addressed') return true;
    return (st === 'ptd_condition' || st === 'ptf_condition') && !(Array.isArray(d.conditions) && d.conditions.length);
  }
  // Is this tray under an underwriter's condition right now? Mirrors isUnderCondition()
  // in _shared/doc-status.mjs (the gate runs both against the same trays).
  function _underCondition(slug) {
    var d = (_review && _review.docs && _review.docs[slug]) || {};
    if (_openCondCount(d) > 0) return true;
    var st = _statusOf(slug);
    if (st === 'ptd_condition' || st === 'ptf_condition' || st === 'condition_addressed') return true;
    return d.uwVerdict === 'conditions';
  }
  // Deploy 237.160 (Jessy: "2nd guarantor has been removed but still shows guarantor
  // doc trays") -- the roster keeps everyone who has EVER been a guarantor so their
  // documents survive; `removed` marks who is off the loan now. Mirrors
  // activeGuarantors() in _shared/guarantor-trays.mjs.
  function _activeGuarantors() {
    var all = (_review && Array.isArray(_review.guarantors)) ? _review.guarantors : [];
    return all.filter(function(g) { return g && !g.removed; });
  }
  // The section a tray renders under. Mirrors displaySection() in
  // _shared/loan-review-checklists.mjs -- the page, the loan-file ZIP and the e-sign
  // picker have to agree, and no stored `section` is rewritten to do it.
  function _secOf(slug) {
    var base = String(slug || '').replace(/__[pg]\d+$/, '');
    if (APP_SLUGS[base]) return 'application';
    // Deploy 237.150 (Dan) -- one Other Documents section at the very bottom.
    if (_isOtherSlug(slug)) return 'other';
    var stored = (_review && _review.docs && _review.docs[slug]) || {};
    var meta = DOC_META[slug] || DOC_META[base] || {};
    var sec = meta.section || stored.section || '';
    // Deploy 237.150 (Dan) -- 'loan' is retired; it renders under the application.
    if (sec === 'loan') return 'application';
    for (var i = 0; i < SECTIONS.length; i++) if (SECTIONS[i].key === sec) return sec;
    return 'other';
  }
  function _trayHasDoc(dd) {
    return !!(dd && (dd.currentDocId || (Array.isArray(dd.documents) && dd.documents.some(function(x) { return x && !x.hidden; }))));
  }
  function _stageOf(slug) {
    var dd = (_review && _review.docs && _review.docs[slug]) || {};
    // A hidden tray waits for the underwriter to confirm the hide, then drops out
    // of both tabs into the section's "Show N hidden".
    if (dd.hidden) return dd.hiddenConfirmedAt ? 'hiddenDone' : 'uw';
    return _UW_STATUS[_statusOf(slug)] ? 'uw' : 'processor';
  }
  // Deploy 237.150 (Dan: "if a processor doesn't approve a document the empty tray
  // still doesn't appear in the UW tab. I would like this to happen so that the UW
  // can see which docs are ready to review from one screen") -- Underwriting lists
  // EVERY tray whatever its status; the status chip says where each one stands. The
  // Processor tab stays the narrow one: only what still needs a processor's call.
  // _stageOf keeps its old meaning (whose desk is this on) for the Processor tab and
  // for the hidden-tray hand-off.
  function _bucketTabs(slugs, hidden) {
    var out = { processor: [], uw: (slugs || []).slice() };
    (slugs || []).forEach(function(s) { if (_stageOf(s) === 'processor') out.processor.push(s); });
    (hidden || []).forEach(function(s) { if (_stageOf(s) === 'uw') out.uw.push(s); });
    return out;
  }
  var STAGE_EMPTY = {
    processor:  'Nothing waiting on the processor \u2014 every collected document has been reviewed. \uD83C\uDF89',
    uw:         'No document trays on this loan yet.', // Deploy 237.150 -- this tab shows them all
    conditions: 'No open conditions on this loan.',
  };
  function _tabHtml(key, label, n) {
    return '<div class="tab ' + (_activeTab === key ? 'active' : '') + '" onclick="dr_switchTab(\'' + key + '\')">' +
      label + ' <span class="tab-count">' + n + '</span></div>';
  }

  function render() {
    var _anchor = _captureScrollAnchor(); // Deploy 237.046 -- keep the viewport steady across the re-render
    var docs = _review.docs || {};
    // Deploy 237.228 (Dan: "Remove the document tray for insurance invoice") -- a
    // retired tray that nobody filed anything into stops rendering. One that HOLDS
    // a document stays exactly where it was: taking a category off the checklist
    // must never make an uploaded file unreachable.
    var allSlugs = Object.keys(docs).filter(function(s) {
      if (!RETIRED_SLUGS[String(s).replace(/__[pg]\d+$/, '')]) return true;
      return _trayHasDoc(docs[s]);
    });
    // Deploy 236.778 (Mike) — publish felony findings so Loan Details can raise
    // its top-of-page banner (above the tabs) straight from the document review,
    // instead of waiting on the AI's loan-field write to land.
    try {
      var _felAlerts = [];
      ['entity_background_check', 'guarantor_background_check'].forEach(function(sg) {
        var dd = docs[sg] || {};
        if (dd.felonyAlert) _felAlerts.push(String(dd.felonyAlert));
      });
      global.SLA_DOC_ALERTS = { felony: _felAlerts };
      if (typeof global.refreshFelonyBanner === 'function') global.refreshFelonyBanner();
    } catch (e) { /* banner is a nicety — never break the doc review over it */ }
    // Deploy 236.161 — split hidden trays out of the main count.
    // Hidden trays stay in the data, just don't render in the
    // normal tabs / counters; a per-section "Show N hidden" toggle
    // reveals them when the LO wants.
    var slugs  = allSlugs.filter(function(s) { return !docs[s] || !docs[s].hidden; });
    var hidden = allSlugs.filter(function(s) { return docs[s] && docs[s].hidden; });
    // Deploy 237.136 -- two stages (see _stageOf); Conditions is a VIEW of uw.
    // Hidden trays awaiting the underwriter's confirmation ride along in Underwriting.
    var stageSlugs = _bucketTabs(slugs, hidden); // Deploy 237.150
    var condSlugs = slugs.filter(_onConditionsTab);
    // Deploy 237.150 -- was _statusOf(s) === 'approved', a status that stopped
    // existing in 237.138, so this stat had been stuck on 0. "Reviewed" means the
    // processor has made a call on it, which is what _stageOf calls the uw stage.
    var reviewedSlugs = slugs.filter(function(s) { return _stageOf(s) === 'uw'; });

    var amt = _review.loanAmount ? '$' + Number(_review.loanAmount).toLocaleString() : '—';
    var lo = _review.loEmail || '—';
    var proc = _review.processorEmail || '—';
    var closeDate = formatDateOnly(_review.expectedCloseDate);

    var addressHtml = escHtml(_review.address || '(no address)');

    var summary =
      '<div class="summary">' +
        '<div class="summary-left">' +
          '<h2>' + addressHtml + '</h2>' +
          '<div class="meta-line">' +
            escHtml(_review.borrowerName || '—') + ' &middot; ' +
            '<span class="type-pill ' + escAttr((_review.loanType||'').toLowerCase()) + '">' + escHtml((_review.loanType||'').toUpperCase()) + '</span>' +
            (_review.investor ? '<span class="investor-pill">' + escHtml(_review.investor) + '</span>' : '') +
            ' &middot; LO: ' + escHtml(lo) +
            ' &middot; Processor: ' + escHtml(proc) +
          '</div>' +
          // Deploy 236.533 — invite the borrower OR broker to the portal, with
          // a persistent status line (recipient · date sent · last sign-in).
          (function(){
            var _cl = _review.sourceClientSnapshot || {};
            var _ln = _review.sourceLoanSnapshot || {};
            var _brok = (_ln && _ln.brokerEmail) || '';
            var _borr = (_cl && _cl.email) || '';
            return '<div class="dr-invite-box">' +
              '<div class="dr-invite-status" id="dr-invite-status"></div>' +
              '<button type="button" class="dr-invite-btn" onclick="dr_invite(\'borrower\')" title="' + escAttr(_borr || 'borrower on file') + '">✉ Invite Borrower to Portal</button>' +
              (_brok ? '<button type="button" class="dr-invite-btn secondary" onclick="dr_invite(\'broker\')" title="' + escAttr(_brok) + '">✉ Invite Broker</button>' : '') +
            '</div>';
          })() +
        '</div>' +
        '<div class="summary-stats">' +
          '<div class="summary-stat"><div class="v">' + amt + '</div><div class="l">Loan Amount</div></div>' +
          '<div class="summary-stat"><div class="v">' + closeDate + '</div><div class="l">Expected Close</div></div>' +
          '<div class="summary-stat"><div class="v">' + reviewedSlugs.length + ' / ' + slugs.length + '</div><div class="l">Reviewed</div></div>' +
          ((global.SLA && global.SLA.isAdmin && global.SLA.isAdmin(_user)) ? '<div class="summary-stat"><div class="v">$' + ((_review.aiCostCents || 0) / 100).toFixed(2) + '</div><div class="l">AI Cost</div></div>' : '') +
        '</div>' +
      '</div>';

    var sourcePanel = renderSourcePanel();

    // Deploy 237.136 (Mike) -- Processor / Underwriting / Conditions.
    var tabs =
      '<div class="tabs">' +
        _tabHtml('processor',  'Processor',    stageSlugs.processor.length) +
        _tabHtml('uw',         'Underwriting', stageSlugs.uw.length) +
        _tabHtml('conditions', 'Conditions',   condSlugs.length) +
      '</div>';

    var toolbar =
      '<div class="doc-toolbar">' +
        '<input type="text" class="doc-search" id="dr-docSearch" placeholder="Search documents by name…" value="' + escAttr(_docSearch) + '" oninput="dr_onDocSearch(this.value)" />' +
        '<button class="expand-btn" onclick="dr_expandAll(true)">Expand all</button>' +
        '<button class="expand-btn" onclick="dr_expandAll(false)">Collapse all</button>' +
        // Deploy 236.159 — one-click ZIP of every uploaded doc on
        // this review. Server bundles current + history per tray.
        '<button class="expand-btn" id="dr-zipBtn" onclick="dr_downloadZip(this)">⬇ Download all (ZIP)</button>' +
        // Deploy 236.208 — bulk zip upload. Client extracts, AI
        // classifies filenames into checklist slugs, high-confidence
        // matches auto-upload, ambiguous ones surface in a modal.
        '<button class="expand-btn" id="dr-uploadZipBtn" onclick="dr_startUploadZip()">⬆ Upload ZIP</button>' +
        // Deploy 236.746 — send the borrower a corrected-docs email on demand.
        '<button class="expand-btn" id="dr-notifyFixBtn" onclick="dr_notifyBorrowerFixes(this)">✉ Email borrower re: flagged docs</button>' +
        // Deploy 236.818 — refresh the review's point of truth (snapshot +
        // signed app) from the CURRENT loan record and re-run reviewed docs.
        // For when the application changed (guarantor added/removed, etc.).
        '<button class="expand-btn" id="dr-truthBtn" onclick="dr_refreshTruth(this)" title="Re-sync borrower/guarantor data + the signed application from the current loan record, then re-run the AI reviews against it">↻ Sync application data</button>' +
        '<input type="file" id="dr-uploadZipFile" accept=".zip,application/zip,application/x-zip-compressed" style="display:none" onchange="dr_onUploadZipPick(event)" />' +
      '</div>';

    var activeSlugs = (_activeTab === 'conditions') ? condSlugs : (stageSlugs[_activeTab] || stageSlugs.processor); // Deploy 237.136
    if (_docSearch) {
      var q = _docSearch.toLowerCase();
      activeSlugs = activeSlugs.filter(function(slug) {
        var meta = DOC_META[slug] || { label: slug };
        return (meta.label + ' ' + slug).toLowerCase().indexOf(q) >= 0;
      });
    }
    var traysHtml = renderSections(activeSlugs);

    var bottom = renderConsistencyCard(_review);
    // Deploy 236.161 — removed Delete Review + Finalize buttons per
    // Mike. The handlers + modals remain in the DOM (commented
    // refs only) so a future re-add doesn't have to re-wire the
    // backend path.

    var fullFileHtml = (_activeTab === 'uw') ? _renderFullFileCard() : ''; // Deploy 237.072 (item 8)
    // Deploy 237.222 (Mike) -- the key metrics sit beside the trays on Underwriting,
    // between them and the notes / audit column. Only where loan-uw-metrics.js is loaded
    // (Loan Details) and only for a review tied to the loan on screen; anywhere else this
    // is the single column it always was.
    var _mx = (_activeTab === 'uw') ? _metricsHtml() : '';
    var _body = _mx
      ? '<div class="dr-uw-wrap"><div class="dr-uw-cols"><div class="dr-uw-main">' + fullFileHtml + traysHtml + '</div>' +
          '<aside class="dr-uw-side">' + _mx + '</aside></div></div>'
      : fullFileHtml + traysHtml;
    _root.innerHTML = summary + sourcePanel + tabs + toolbar + _body + bottom;
    try { _metricsAfterRender(); } catch (_mxErr) { console.warn('[SLA] doc-review: metrics hook failed:', _mxErr); } // never let the panel break the trays
    _restoreScrollAnchor(_anchor); // Deploy 237.046

    // Deploy 236.533 — fill the borrower/broker invite status line async.
    try { dr_loadInviteStatus(); } catch (_) {}

    // Deploy 236.762 — resume background-review polling for any tray still
    // marked aiReviewing (covers page reloads mid-review).
    try { _resumeBackgroundPolls(); } catch (_) {}

    if (_docSearch) {
      var input = document.getElementById('dr-docSearch');
      if (input) {
        input.focus();
        var len = input.value.length;
        try { input.setSelectionRange(len, len); } catch (e) {}
      }
    }
  }

  // ── Deploy 236.517 — Cross-Document Consistency Check (Phase 2) ──────
  // Deterministic, NO new AI call: compares the entities each document's
  // review ALREADY extracted (aiExtractedEntities) against each other AND
  // against the loan of record. Flags when the same LLC / borrower name /
  // property address / loan amount disagrees across documents — the class
  // of typo/mismatch that's expensive to catch at the closing table.
  // Values are grouped by a normalized form so trivial formatting diffs
  // ("123 Main St" vs "123 Main Street") don't false-flag; the RAW value
  // each doc reported is shown so the underwriter sees exactly what differs.
  // Deploy 237.122 (Mike) — smarter matching. Values are CLUSTERED with
  // field-aware rules instead of grouped by an exact normalized string:
  //   Entity   — case, punctuation, word order and the legal suffix (LLC,
  //              L.L.C., Inc, Corp, Co, LP…) are ignored. A different WORD is
  //              still a different name ("Park Dr" ≠ "Park Drive").
  //   People   — "Waggoner, Timothy Blaise" = "TIMOTHY WAGGONER" = "Timothy
  //              B. Waggoner" (first + last must agree; middle names and
  //              initials don't split a group). Joint values ("Timothy
  //              Waggoner / Hannah Waggoner") count toward each person. Every
  //              guarantor on the loan is an EXPECTED name; only a name that
  //              isn't a guarantor (nickname, stranger) is a mismatch.
  //   Address  — dashes, commas, periods, case, Street/St, state names, ZIP+4,
  //              county notes and "USA" are ignored; two addresses agree when
  //              house number + street agree and ZIP / unit agree when both
  //              have one. Guarantor residences and other-property documents
  //              (a tray named for a different address) are shown as
  //              "other property", not as a mismatch.
  //   Amount   — payoff / mortgage-statement / VOM documents report OTHER
  //              debts, so they are not compared to the loan amount.
  var _CC_ENTITY_SUFFIX = { LLC: 1, LC: 1, INC: 1, INCORPORATED: 1, CORP: 1, CORPORATION: 1, CO: 1, COMPANY: 1,
    LP: 1, LLP: 1, LLLP: 1, LTD: 1, LIMITED: 1, PLLC: 1, PC: 1, PA: 1, THE: 1, SERIES: 1 };
  function _ccEntityKey(s) {
    var t = String(s == null ? '' : s).toUpperCase()
      .replace(/&/g, ' AND ')
      .replace(/\bL\.?\s?L\.?\s?C\.?/g, ' LLC ')
      .replace(/[^A-Z0-9]+/g, ' ').trim();
    var toks = t.split(/\s+/).filter(function(w) { return w && !_CC_ENTITY_SUFFIX[w]; });
    return toks.sort().join(' ');
  }
  var _CC_NAME_SUFFIX = { JR: 1, SR: 1, II: 1, III: 1, IV: 1, MR: 1, MRS: 1, MS: 1, DR: 1 };
  function _ccPeople(s) {
    // one value may name several people ("A / B", "A & B", "A and B", "A; B")
    return String(s == null ? '' : s).split(/\s*(?:\/|&|;|\band\b)\s*/i).map(function(one) {
      var raw = one.trim();
      if (!raw) return null;
      var last, rest;
      if (raw.indexOf(',') > 0) { last = raw.slice(0, raw.indexOf(',')); rest = raw.slice(raw.indexOf(',') + 1); }
      var clean = function(x) { return String(x || '').toUpperCase().replace(/[^A-Z ]+/g, ' ').split(/\s+/).filter(function(w) { return w && !_CC_NAME_SUFFIX[w]; }); };
      var toks;
      if (last != null) { var l = clean(last), r = clean(rest); if (!l.length || !r.length) return null; toks = r.concat(l); }
      else toks = clean(raw);
      if (toks.length < 2) return null;
      return { raw: raw, first: toks[0], last: toks[toks.length - 1], middle: toks.slice(1, -1) };
    }).filter(Boolean);
  }
  function _ccSamePerson(a, b) {
    if (a.last !== b.last) return false;
    if (a.first === b.first) return true;
    // an initial matches the name it abbreviates
    return (a.first.length === 1 && b.first.charAt(0) === a.first) || (b.first.length === 1 && a.first.charAt(0) === b.first);
  }
  var _CC_STATES = { alabama:'al', alaska:'ak', arizona:'az', arkansas:'ar', california:'ca', colorado:'co', connecticut:'ct',
    delaware:'de', florida:'fl', georgia:'ga', hawaii:'hi', idaho:'id', illinois:'il', indiana:'in', iowa:'ia', kansas:'ks',
    kentucky:'ky', louisiana:'la', maine:'me', maryland:'md', massachusetts:'ma', michigan:'mi', minnesota:'mn',
    mississippi:'ms', missouri:'mo', montana:'mt', nebraska:'ne', nevada:'nv', ohio:'oh', oklahoma:'ok', oregon:'or',
    pennsylvania:'pa', tennessee:'tn', texas:'tx', utah:'ut', vermont:'vt', virginia:'va', washington:'wa',
    wisconsin:'wi', wyoming:'wy' };
  var _CC_STREET = { street:'st', str:'st', st:'st', avenue:'ave', av:'ave', ave:'ave', road:'rd', rd:'rd', drive:'dr', dr:'dr',
    lane:'ln', ln:'ln', boulevard:'blvd', blvd:'blvd', court:'ct', ct:'ct', place:'pl', pl:'pl', highway:'hwy', hwy:'hwy',
    way:'way', wy:'way', circle:'cir', cir:'cir', terrace:'ter', ter:'ter', parkway:'pkwy', pkwy:'pkwy', trail:'trl', trl:'trl',
    loop:'loop', square:'sq', sq:'sq', railroad:'rr', rr:'rr', pike:'pike', run:'run', row:'row', path:'path', alley:'aly', aly:'aly' };
  var _CC_DIR = { north:'n', south:'s', east:'e', west:'w', northeast:'ne', northwest:'nw', southeast:'se', southwest:'sw' };
  var _CC_UNIT = { unit: 1, apt: 1, apartment: 1, ste: 1, suite: 1, lot: 1, bldg: 1, building: 1, fl: 1, floor: 1, rm: 1, room: 1 };
  function _ccAddrParts(s) {
    var t = String(s == null ? '' : s).toLowerCase()
      .replace(/\([^)]*\)/g, ' ')                  // "(ADAMS)" county notes
      .replace(/\b(\d{5})-\d{4}\b/g, '$1')          // ZIP+4 -> ZIP
      .replace(/#\s*/g, ' unit ')
      .replace(/([a-z0-9])-([a-z0-9])/g, '$1$2')     // "C-204" -> "c204"
      .replace(/[^a-z0-9 ]+/g, ' ')
      .replace(/\b(united states|usa|us)\s*$/, ' ')
      .replace(/\b[a-z]+ county\b/g, ' ');
    var toks = t.split(/\s+/).filter(Boolean).map(function(w) { return _CC_STATES[w] || _CC_DIR[w] || w; });
    if (!toks.length || !/^\d+[a-z]?$/.test(toks[0])) return null;
    var num = toks[0], street = [], unit = '', zip = '';
    var i = 1;
    for (; i < toks.length; i++) {
      var w = toks[i];
      if (_CC_UNIT[w]) break;
      street.push(_CC_STREET[w] || w);
      if (_CC_STREET[w] && street.length >= 2) { i++; break; }
      if (street.length >= 4) { i++; break; }
    }
    for (; i < toks.length; i++) {
      if (_CC_UNIT[toks[i]] && toks[i + 1]) {
        unit = toks[i + 1]; i++;
        if (/^[a-z]$/.test(unit) && /^\d+$/.test(toks[i + 1] || '') && !/^\d{5}$/.test(toks[i + 1])) { unit += toks[i + 1]; i++; }
        continue;
      }
      if (/^\d{5}$/.test(toks[i])) zip = toks[i];
    }
    return { num: num, street: street.join(' '), unit: unit, zip: zip };
  }
  function _ccSameAddr(a, b) {
    if (!a || !b) return false;
    if (a.num !== b.num || a.street !== b.street) return false;
    if (a.zip && b.zip && a.zip !== b.zip) return false;
    if (a.unit && b.unit && a.unit !== b.unit) return false;
    return true;
  }
  function _ccNormMoney(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
    return (isFinite(n) && n > 0) ? String(Math.round(n)) : '';
  }
  function _ccMoney(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.]/g, ''));
    return isFinite(n) ? '$' + Math.round(n).toLocaleString() : String(v);
  }
  function _ccIsBlank(v) {
    var t = String(v == null ? '' : v).trim();
    return t === '' || /^(null|n\/?a|none|unknown|not (found|present|specified))$/i.test(t);
  }
  // Third parties whose own entity name is on the document (title company, escrow).
  var _CC_THIRD_PARTY = /^(title_eo_insurance|title_escrow_contact|wire_instructions|appraisal_receipt)$/;
  // Documents about OTHER debts / properties — their amount is not this loan's.
  var _CC_OTHER_DEBT = /^(payoff_demand|mortgage_statements?_payoffs|mortgage_statement|vom|voh_corrfirst|track_record(_reo)?|pfs|reo_schedule)$/;
  var _CC_OTHER_DEBT_LABEL = /payoff|mortgage statement|mortgage customer|verification of mortgage|\bvom\b|\bvor\b|track record|\breo\b|financial statement/i;

  function buildConsistencyReport(review) {
    review = review || {};
    var docs = review.docs || {};
    var client = review.sourceClientSnapshot || {};
    var loanSnap = review.sourceLoanSnapshot || review.snapshotLoan || {};
    var srcs = [];
    Object.keys(docs).forEach(function(slug) {
      var d = docs[slug];
      if (!d || d.hidden) return;
      var base = String(slug).replace(/__[pg]\d+$/, '');
      var meta = DOC_META[base] || {};
      var label = d.label || (DOC_META[slug] && DOC_META[slug].label) || meta.label || slug;
      srcs.push({ slug: slug, base: base, label: label, ee: d.aiExtractedEntities || {},
        guarantorDoc: /__g\d+$/.test(slug) || meta.section === 'guarantor' || d.section === 'guarantor' });
    });
    function valuesFor(key) {
      return srcs.filter(function(s) { return !_ccIsBlank(s.ee[key]); }).map(function(s) { return { src: s, raw: String(s.ee[key]).trim() }; });
    }

    // ── Entity ──────────────────────────────────────────────────────────
    var entityRef = client.entityName || _vestingName(loanSnap);
    var entity = (function() {
      var groups = [], byKey = {};
      function add(raw, label, info) {
        var k = _ccEntityKey(raw); if (!k) return;
        if (!byKey[k]) { byKey[k] = { raw: raw, labels: [], info: !!info, note: info ? 'third party (title / escrow) — not compared' : '' }; groups.push(byKey[k]); }
        if (!info) { byKey[k].info = false; byKey[k].note = ''; }
        byKey[k].labels.push(label);
      }
      if (!_ccIsBlank(entityRef)) add(String(entityRef), 'Loan File (of record)', false);
      valuesFor('llcName').forEach(function(v) { add(v.raw, v.src.label, _CC_THIRD_PARTY.test(v.src.base)); });
      return groups;
    })();

    // ── People ──────────────────────────────────────────────────────────
    var roster = [];
    (Array.isArray(review.guarantorNames) && review.guarantorNames.length ? review.guarantorNames : [review.borrowerName]).forEach(function(n) {
      _ccPeople(n).forEach(function(p) { if (!roster.some(function(r) { return _ccSamePerson(r, p); })) roster.push(p); });
    });
    var people = (function() {
      var clusters = [];
      function add(raw, label) {
        _ccPeople(raw).forEach(function(p) {
          var c = null;
          for (var i = 0; i < clusters.length; i++) { if (_ccSamePerson(clusters[i].person, p)) { c = clusters[i]; break; } }
          if (!c) { c = { person: p, raw: p.raw, labels: [] }; clusters.push(c); }
          if (p.middle.length > c.person.middle.length || (p.first.length > c.person.first.length && p.middle.length >= c.person.middle.length)) c.person = p; // keep the fullest form
          if (c.labels.indexOf(label) < 0) c.labels.push(label);
        });
      }
      if (!_ccIsBlank(review.borrowerName)) add(review.borrowerName, 'Loan File (of record)');
      valuesFor('borrowerName').forEach(function(v) { add(v.raw, v.src.label); });
      var tc = function(w) { return w.charAt(0) + w.slice(1).toLowerCase(); };
      clusters.forEach(function(c) {
        c.raw = [c.person.first].concat(c.person.middle, [c.person.last]).map(tc).join(' ');
        var idx = -1;
        for (var i = 0; i < roster.length; i++) { if (_ccSamePerson(roster[i], c.person)) { idx = i; break; } }
        c.guarantorIdx = idx;
        c.info = false;
        c.note = idx >= 0 ? (roster.length > 1 ? 'Guarantor ' + (idx + 1) : 'guarantor') : 'does not match a guarantor (nickname or wrong person?)';
      });
      // roster order first, strangers last
      clusters.sort(function(a, b) {
        var ai = a.guarantorIdx < 0 ? 99 : a.guarantorIdx, bi = b.guarantorIdx < 0 ? 99 : b.guarantorIdx;
        return ai !== bi ? ai - bi : b.labels.length - a.labels.length;
      });
      return clusters;
    })();

    // ── Address ─────────────────────────────────────────────────────────
    var subject = _ccAddrParts(review.address || loanSnap.address);
    var address = (function() {
      var clusters = [];
      function add(raw, src) {
        String(raw).split(/\s*;\s*/).forEach(function(one) {
          if (!one) return;
          var parts = _ccAddrParts(one);
          var key = parts ? null : one.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
          var c = null;
          for (var i = 0; i < clusters.length; i++) {
            var x = clusters[i];
            if (parts ? _ccSameAddr(x.parts, parts) : (x.key && x.key === key)) { c = x; break; }
          }
          if (!c) { c = { parts: parts, key: key, raw: one, labels: [], otherOnly: true }; clusters.push(c); }
          if (!src) c.refRaw = one;
          if (one.length > c.raw.length && parts && c.parts && (!c.parts.zip || parts.zip)) c.raw = one;
          if (c.labels.indexOf(src ? src.label : 'Loan File (of record)') < 0) c.labels.push(src ? src.label : 'Loan File (of record)');
          // a source counts as "other property" when it is a guarantor document or a
          // tray/label that names this very (non-subject) address
          var other = !!src && (src.guarantorDoc || _CC_OTHER_DEBT.test(src.base) ||
            (parts && new RegExp('\\b' + parts.num + '\\b', 'i').test(src.label) && !_ccSameAddr(parts, subject)));
          if (!other) c.otherOnly = false;
        });
      }
      if (!_ccIsBlank(review.address || loanSnap.address)) add(review.address || loanSnap.address, null);
      valuesFor('propertyAddress').forEach(function(v) { add(v.raw, v.src); });
      clusters.forEach(function(c) {
        c.isSubject = !!(subject && c.parts && _ccSameAddr(subject, c.parts));
        if (c.refRaw) c.raw = c.refRaw;
        c.info = !c.isSubject && c.otherOnly;
        c.note = c.isSubject ? 'subject property' : (c.info ? 'other property / residence — not compared' : '');
      });
      clusters.sort(function(a, b) {
        if (a.isSubject !== b.isSubject) return a.isSubject ? -1 : 1;
        if (a.info !== b.info) return a.info ? 1 : -1;
        return b.labels.length - a.labels.length;
      });
      return clusters;
    })();

    // ── Loan amount ─────────────────────────────────────────────────────
    var amount = (function() {
      var groups = [], byKey = {};
      function add(raw, label, info) {
        var k = _ccNormMoney(raw); if (!k) return;
        if (!byKey[k]) { byKey[k] = { raw: raw, labels: [], info: true, note: '' }; groups.push(byKey[k]); }
        if (!info) byKey[k].info = false;
        byKey[k].labels.push(label);
      }
      if (!_ccIsBlank(review.loanAmount)) add(review.loanAmount, 'Loan File (of record)', false);
      valuesFor('loanAmount').forEach(function(v) {
        var other = _CC_OTHER_DEBT.test(v.src.base) || _CC_OTHER_DEBT_LABEL.test(v.src.label);
        add(v.raw, v.src.label, other);
      });
      groups.forEach(function(g) { g.note = g.info ? 'another debt (payoff / mortgage / REO) — not compared' : ''; });
      groups.sort(function(a, b) { if (a.info !== b.info) return a.info ? 1 : -1; return b.labels.length - a.labels.length; });
      return groups;
    })();

    function finish(key, label, groups, opts) {
      opts = opts || {};
      var live = groups.filter(function(g) { return !g.info; });
      var comparable = live.reduce(function(n, g) { return n + g.labels.length; }, 0);
      var mismatch = opts.mismatch != null ? opts.mismatch : live.length > 1;
      return {
        key: key, label: label, money: !!opts.money, groups: groups, comparable: comparable,
        status: mismatch ? 'mismatch' : (comparable >= 2 ? 'ok' : (comparable === 1 ? 'single' : (groups.length ? 'info' : 'none'))),
      };
    }
    var strangers = people.filter(function(c) { return c.guarantorIdx < 0; });
    return [
      finish('llcName', 'Entity / LLC Name', entity),
      finish('borrowerName', 'Borrower / Guarantor Names', people, { mismatch: roster.length ? strangers.length > 0 : people.length > 1 }),
      finish('propertyAddress', 'Property Address', address),
      finish('loanAmount', 'Loan Amount', amount, { money: true }),
    ];
  }

  function renderConsistencyCard(review) {
    var report = buildConsistencyReport(review);
    var mism = report.filter(function(r) { return r.status === 'mismatch'; });
    var okCount = report.filter(function(r) { return r.status === 'ok'; }).length;

    var headBadge = mism.length
      ? '<span class="dr-cc-badge fail">⚠ ' + mism.length + ' mismatch' + (mism.length === 1 ? '' : 'es') + '</span>'
      : (okCount ? '<span class="dr-cc-badge ok">✓ consistent</span>' : '<span class="dr-cc-badge none">awaiting docs</span>');

    var rows = report.map(function(r) {
      if (r.status === 'none') {
        return '<div class="dr-cc-row none"><div class="dr-cc-field">' + escHtml(r.label) + '</div>' +
          '<div class="dr-cc-detail">Not extracted from any document yet.</div></div>';
      }
      var fmt = function(g) { return r.money ? _ccMoney(g.raw) : g.raw; };
      // Deploy 237.122 -- expected / informational groups (other guarantors, other
      // properties, other debts, third parties) render muted with their note.
      var noteHtml = function(g) { return g.note ? ' <span class="dr-cc-note" style="font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:0.03em;color:' + (g.info ? 'var(--muted)' : (g.guarantorIdx != null && g.guarantorIdx < 0 ? 'var(--danger, #7c1f1f)' : 'var(--dr-green, #166534)')) + '">' + escHtml(g.note) + '</span>' : ''; };
      var variantHtml = function(g, quiet) {
        return '<div class="dr-cc-variant"' + (quiet ? ' style="background:rgba(0,0,0,0.03)"' : '') + '><span class="dr-cc-val"' + (g.info ? ' style="color:var(--muted);font-weight:500"' : '') + '>' + escHtml(fmt(g)) + '</span>' + noteHtml(g) +
          '<span class="dr-cc-srcs">' + escHtml(g.labels.join(', ')) + '</span></div>';
      };
      if (r.status === 'info') {
        return '<div class="dr-cc-row single"><div class="dr-cc-field">' + escHtml(r.label) + '</div>' +
          '<div class="dr-cc-detail">' + r.groups.map(function(g) { return variantHtml(g, true); }).join('') + '</div></div>';
      }
      if (r.status === 'single') {
        var g0 = r.groups[0];
        return '<div class="dr-cc-row single"><div class="dr-cc-field">' + escHtml(r.label) + '</div>' +
          '<div class="dr-cc-detail"><span class="dr-cc-val">' + escHtml(fmt(g0)) + '</span> ' +
          '<span class="dr-cc-only">— only on ' + escHtml(g0.labels.join(', ')) + '; nothing to cross-check yet</span></div></div>';
      }
      if (r.status === 'ok') {
        var live = r.groups.filter(function(g) { return !g.info; });
        var extra = r.groups.filter(function(g) { return g.info; });
        // people: every guarantor listed; otherwise the single agreed value + any muted extras
        if (r.key === 'borrowerName' && live.length > 1) {
          return '<div class="dr-cc-row ok"><div class="dr-cc-field">✓ ' + escHtml(r.label) + '</div>' +
            '<div class="dr-cc-detail">' + r.groups.map(function(g) { return variantHtml(g, true); }).join('') + '</div></div>';
        }
        var gk = live[0];
        return '<div class="dr-cc-row ok"><div class="dr-cc-field">✓ ' + escHtml(r.label) + '</div>' +
          '<div class="dr-cc-detail"><span class="dr-cc-val">' + escHtml(fmt(gk)) + '</span> ' +
          '<span class="dr-cc-agree">— matches across ' + gk.labels.length + ' sources</span>' +
          (extra.length ? '<div style="margin-top:6px">' + extra.map(function(g) { return variantHtml(g, true); }).join('') + '</div>' : '') +
          '</div></div>';
      }
      // mismatch
      var gl = r.groups.map(function(g) {
        var quiet = g.info || (r.key === 'borrowerName' && g.guarantorIdx >= 0) || g.isSubject;
        return variantHtml(g, quiet);
      }).join('');
      return '<div class="dr-cc-row mismatch"><div class="dr-cc-field">⚠ ' + escHtml(r.label) + '</div>' +
        '<div class="dr-cc-detail">' + gl + '</div></div>';
    }).join('');

    return '<div class="consistency-card' + (mism.length ? ' has-mismatch' : '') + '">' +
      '<div class="dr-cc-head"><h3>Cross-Document Consistency Check</h3>' + headBadge + '</div>' +
      '<div class="dr-cc-sub">Compares the LLC name, borrower name, property address, and loan amount the AI read off each document — and the loan of record — and flags anything that disagrees before closing.</div>' +
      '<div class="dr-cc-rows">' + rows + '</div>' +
    '</div>';
  }

  // Deploy 236.533 — invite the borrower OR broker to the portal + show status.
  global.dr_invite = function(recipient) {
    var src = (_review && _review.source) || {};
    var loanId = src.loanId || '', clientId = src.clientId || '';
    if (!loanId || !clientId) { showToast('This review has no loan reference to invite against.', 'error'); return; }
    var body = { loanId: loanId, primaryClientId: clientId, recipient: recipient };
    if (_review.loEmail) body.owner = _review.loEmail;
    showToast('Sending invite…', 'info');
    // Deploy 237.236 -- a broker is invited to the Preferred Partner portal, not the borrower portal.
    var path = recipient === 'broker' ? '/api/broker-portal-invite' : '/api/borrower-intake-invite';
    global.SLA.api('POST', path, body).then(function(r) {
      if (r && r.ok) {
        showToast((recipient === 'broker' ? '✓ Broker portal invite sent to ' : '✓ Invite sent to ') + (r.email || recipient) +
          (r.emailed ? '' : (recipient === 'broker' ? ' (email did not send: ' + (r.emailError || 'unknown') + ')' : ' (access granted; email pending)')), r.emailed === false ? 'error' : 'success');
        if (r.linkNote) showToast(r.linkNote, 'error');
        dr_loadInviteStatus();
      }
      else showToast('Invite failed.', 'error');
    }).catch(function(err) {
      showToast('Invite failed: ' + ((err && err.message) || 'unknown'), 'error');
    });
  };

  function dr_loadInviteStatus() {
    var el = document.getElementById('dr-invite-status'); if (!el) return;
    var src = (_review && _review.source) || {};
    if (!src.loanId) { el.innerHTML = ''; return; }
    var url = '/api/borrower-intake-invite?loanId=' + encodeURIComponent(src.loanId) +
      (_review.loEmail ? '&owner=' + encodeURIComponent(_review.loEmail) : '');
    global.SLA.api('GET', url).then(function(st) {
      el.innerHTML = dr_renderInviteStatus(st);
    }).catch(function() { el.innerHTML = ''; });
  }
  function dr_renderInviteStatus(st) {
    var lines = [];
    ['borrower', 'broker'].forEach(function(who) {
      var e = st && st[who];
      if (!e || !e.email) return;
      var sent = e.sentAt ? formatDateOnly(e.sentAt) : '—';
      var last = e.lastSignInAt ? formatDateOnly(e.lastSignInAt) : '<span class="never">not yet logged in</span>';
      // Deploy 237.236 -- a broker invited before the split got a BORROWER login; say so, so it gets re-sent.
      var whoLabel = who === 'broker' ? (e.portal === 'broker' ? 'Broker (partner portal)' : 'Broker (old borrower-portal invite — re-send)') : 'Borrower';
      lines.push('<span class="who">' + whoLabel + ':</span> ' +
        escHtml(e.email) + ' &middot; invited ' + sent + ' &middot; last login ' + last);
    });
    return lines.join('<br>');
  }

  function renderSourcePanel() {
    var loan = _review.sourceLoanSnapshot;
    var client = _review.sourceClientSnapshot;
    var headOpen = _sourceOpen ? ' open' : '';

    var bodyContent;
    if (!loan && !client) {
      bodyContent = '<div class="source-empty">No source data — this review was started from a manual loan stub, or it was created before snapshots were enabled. Delete this review and start a fresh one from Loan Details to populate.</div>';
    } else {
      var fd = (loan && loan.formData) || {};
      function f(key, dflt) {
        if (loan && loan[key] != null && loan[key] !== '') return loan[key];
        if (fd[key] != null && fd[key] !== '') return fd[key];
        return dflt != null ? dflt : '';
      }
      function money(v) { return (v != null && v !== '') ? '$' + Number(v).toLocaleString() : '—'; }
      function num(v, decimals)   {
        if (v == null || v === '') return '—';
        var n = Number(v); if (!isFinite(n)) return String(v);
        return decimals != null ? n.toFixed(decimals) : String(n);
      }
      function pct(v, decimals)   {
        if (v == null || v === '') return '—';
        var n = Number(v); if (!isFinite(n)) return String(v) + '%';
        return n.toFixed(decimals != null ? decimals : 3) + '%';
      }
      function txt(v) { return (v != null && v !== '') ? String(v) : '—'; }
      function label(map, v) { return v && map[v] ? map[v] : (v ? String(v) : '—'); }
      function gridFor(rows) {
        var nonEmpty = rows.filter(function(r){ return r.v && r.v !== '—'; });
        if (!nonEmpty.length) return '';
        return '<div class="source-grid">' + nonEmpty.map(function(r){
          return '<div><div class="k">' + escHtml(r.k) + '</div><div class="v">' + escHtml(r.v) + '</div></div>';
        }).join('') + '</div>';
      }

      // Deploy 236.744 — GUC is its own program: it used to fall into the
      // "not rtl → DSCR" bucket and render as "DSCR (GUC)".
      var _srcTool = String(loan && loan.toolType || _review.loanType || '').toLowerCase();
      var isGucSrc = _srcTool === 'guc';
      var isDscr = !isGucSrc && _srcTool !== 'rtl';

      var loanRows = [
        { k: 'Loan type',       v: isGucSrc ? 'GUC (Ground-Up Construction)' : ((isDscr ? 'DSCR' : 'RTL') + ' (' + ((loan && loan.toolType) ? String(loan.toolType).toUpperCase() : '—') + ')') },
        { k: 'Loan purpose',    v: label(LOAN_PURPOSE_LABELS, f('loanPurpose', '')) },
        { k: 'Loan amount',     v: money(f('loanAmt', '')) },
        { k: 'Note rate',       v: pct(f('rate', ''), 3) },
        { k: 'Points',          v: f('points', '') !== '' ? num(f('points', ''), 2) + ' pts' : '—' },
        { k: 'Prepay penalty',  v: txt(f('prepay', '') || f('prepayPenalty', '')) },
        { k: 'Loan term',       v: txt(f('loanTerm', '') || f('term', '')) },
        { k: 'Funding date',    v: txt(f('fundingDate', '')) },
        { k: 'LTV',             v: f('ltv', '') !== '' ? num(f('ltv', ''), 1) + '%' : '—' },
        { k: 'Origination fee', v: f('originationFee', '') !== '' ? num(f('originationFee', ''), 2) + ' pts' : '—' },
        { k: 'Rate buydown',    v: f('rateBuydown', '') !== '' ? num(f('rateBuydown', ''), 2) + ' pts' : '—' },
      ];

      var propRows = [
        { k: 'Property address', v: txt(f('address', '') || (loan && loan.address)) },
        { k: 'Property type',    v: label(PROP_TYPE_LABELS, f('propType', '')) },
        { k: 'Property value',   v: money(f('propValue', '')) },
        { k: 'Bedrooms',         v: f('bedrooms', '') !== '' ? String(f('bedrooms', '')) : '—' },
        { k: 'Bathrooms',        v: f('bathrooms', '') !== '' ? String(f('bathrooms', '')) : '—' },
        { k: 'Sq ft',            v: f('sqft', '') !== '' ? Number(f('sqft', '')).toLocaleString() : '—' },
        { k: 'Existing loan',    v: money(f('existingLoanAmount', '') || f('existingLoanAmt', '')) },
        { k: 'Monthly rent',     v: money(f('monthlyRent', '')) },
        { k: 'Monthly taxes',    v: money(f('monthlyTaxes', '')) },
        { k: 'Monthly insurance',v: money(f('monthlyInsurance', '')) },
        { k: 'Monthly HOA',      v: money(f('monthlyHoa', '')) },
        { k: 'FICO',             v: txt(f('fico', '')) },
        { k: 'DSCR',             v: f('dscr', '') !== '' ? num(f('dscr', ''), 2) + 'x' : '—' },
        { k: 'Rental type',      v: label(RENTAL_TYPE_LABELS, f('rentalType', '')) },
      ];

      var rtlRows = !isDscr ? [
        { k: 'Purchase price',   v: money(f('purchasePrice', '')) },
        { k: 'As-is value',      v: money(f('asIsValue', '') || f('propValue', '')) },
        { k: 'After-repair value', v: money(f('arv', '') || f('afterRepairValue', '')) },
        { k: 'Rehab cost',       v: money(f('rehabCost', '') || f('constructionCost', '') || f('rehabBudget', '')) },
        { k: 'Holding months',   v: txt(f('holdMonths', '') || f('holdingPeriod', '')) },
        { k: 'Experience',       v: txt(f('experience', '') || f('numFlips', '')) },
        { k: 'Loan to ARV',      v: f('ltarv', '') !== '' ? num(f('ltarv', ''), 1) + '%' : '—' },
        { k: 'Loan to cost',     v: f('ltc', '') !== '' ? num(f('ltc', ''), 1) + '%' : '—' },
        { k: 'Dutch / Non-Dutch', v: txt(f('dutch', '') || f('dutchToggle', '')) },
      ] : [];

      var borrowerRows = [
        { k: 'Borrower',  v: client ? ((client.firstName || '') + ' ' + (client.lastName || '')).trim() : '—' },
        { k: 'Email',     v: client ? txt(client.email) : '—' },
        { k: 'Phone',     v: client ? txt(client.phone) : '—' },
        { k: 'Vesting Entity', v: txt((client && client.entityName) || _vestingName(loan)) }, // Deploy 237.080
      ];

      var hasBroker = loan && (loan.brokerId || loan.brokerName || loan.brokerEmail || (parseFloat(loan.brokerFee || 0) > 0));
      var brokerRows = hasBroker ? [
        { k: 'Broker',       v: txt(loan.brokerName || loan.brokerCompany) },
        { k: 'Broker email', v: txt(loan.brokerEmail) },
        { k: 'Broker phone', v: txt(loan.brokerPhone) },
        { k: 'Broker fee',   v: f('brokerFee', '') !== '' ? num(loan.brokerFee, 2) + ' pts' : '—' },
      ] : [];

      var SKIP_RAW = {
        id:1, createdAt:1, updatedAt:1, _editingLoanId:1, _editingClientId:1,
        notesLog:1, formData:1, pricingSnapshot:1, _pricingSnapshot:1,
      };
      var allFields = {};
      if (loan) Object.keys(loan).forEach(function(k){ if (!SKIP_RAW[k]) allFields[k] = loan[k]; });
      if (fd)   Object.keys(fd).forEach(function(k){ if (!SKIP_RAW[k] && allFields[k] == null) allFields[k] = fd[k]; });
      var rawRows = Object.keys(allFields).sort().map(function(k){
        var v = allFields[k];
        if (v == null || v === '') return null;
        if (typeof v === 'object') return null;
        return { k: k, v: String(v) };
      }).filter(Boolean);

      bodyContent =
        '<div class="source-section-title">Loan Terms (Rate Sheet)</div>' + gridFor(loanRows) +
        '<div class="source-section-title">Property + Loan Application</div>' + gridFor(propRows) +
        (rtlRows.length ? '<div class="source-section-title">RTL Details</div>' + gridFor(rtlRows) : '') +
        '<div class="source-section-title">Borrower</div>' + gridFor(borrowerRows) +
        (brokerRows.length ? '<div class="source-section-title">Broker</div>' + gridFor(brokerRows) : '') +
        (rawRows.length ? '<details style="margin-top:18px"><summary style="cursor:pointer;font-size:11px;color:var(--muted);padding:6px 0;">Show all raw loan-record fields (' + rawRows.length + ')</summary>' + gridFor(rawRows) + '</details>' : '');
    }

    return '<div class="source-panel">' +
      '<div class="source-panel-head' + headOpen + '" onclick="dr_toggleSourcePanel()">' +
        '<span>📋 Source Data — Rate Sheet + Loan Application</span>' +
        '<span class="caret">▶</span>' +
      '</div>' +
      '<div class="source-panel-body' + (_sourceOpen ? ' open' : '') + '">' + bodyContent + '</div>' +
    '</div>';
  }

  // ── Deploy 237.222 (Mike) -- key-metrics panel on the Underwriting subtab ──────────
  // Drawn by loan-uw-metrics.js from the SAME registry, calc engine and save path as the
  // Underwriting tab; this module only gives it a column and tells it when to look again.
  var _mxSig = null;
  var _mxSubscribed = false;
  function _metricsLoan() {
    var L = _liveFor(_review); // the loan ON SCREEN, and only when this review belongs to it
    return (L && global.SLA_UW_METRICS && global.SLA_UW_METRICS.html) ? L : null;
  }
  function _metricsHtml() {
    var L = _metricsLoan();
    if (!L) return '';
    try { return global.SLA_UW_METRICS.html(L); }
    catch (e) { console.warn('[SLA] doc-review: metrics panel failed:', e); return ''; }
  }
  // "Read from documents as they're uploaded": a review landing is the moment the loan's
  // numbers can change, and EVERY path that finishes one (sync upload, background poll,
  // retry, ZIP, borrower upload seen on reload) stamps aiReviewedAt. So watch that stamp,
  // not the fifteen places that assign _review.
  function _metricsSig() {
    var docs = (_review && _review.docs) || {};
    return Object.keys(docs).sort().map(function(s) {
      var d = docs[s] || {};
      // Deploy 237.226 -- per-document too: a review of a tray's second, third, fourth
      // document stamps its OWN entry, never the tray, and used to land without a refresh.
      var per = (Array.isArray(d.documents) ? d.documents : []).map(function(e) {
        return e ? (e.docId + ':' + (e.aiReviewedAt || '') + (e.aiReviewing ? 'r' : '')) : '';
      }).join(',');
      return s + ':' + (d.aiReviewedAt || '') + ':' + (d.aiReviewing ? 'r' : '') + '[' + per + ']';
    }).join('|');
  }
  function _metricsAfterRender() {
    if (!global.SLA_UW_METRICS) return;
    if (!_mxSubscribed && global.SLA_UW_TAB && global.SLA_UW_TAB.subscribe) {
      _mxSubscribed = true;
      global.SLA_UW_TAB.subscribe(function(loan) {
        if (loan && _liveLoan && loan.id === _liveLoan.id) _liveLoan = loan; // a save swaps the object
        var side = _root && _root.querySelector('.dr-uw-side');
        if (side && _activeTab === 'uw') side.innerHTML = _metricsHtml();
      });
    }
    var sig = _metricsSig();
    if (_mxSig !== null && sig !== _mxSig && _metricsLoan()) {
      try { global.SLA_UW_METRICS.refresh(); } catch (_) {}
    }
    _mxSig = sig;
  }

  function renderSections(slugs) {
    if (!slugs.length) {
      return '<div class="loading-page">' +
        (STAGE_EMPTY[_activeTab] || STAGE_EMPTY.processor) + // Deploy 237.136
        '</div>';
    }
    var bySection = {};
    slugs.forEach(function(slug) {
      // Deploy 236.162 — custom trays fall back to docs[slug].section
      // (captured when the LO created the tray) so they land in the
      // section they were added to.
      var sec = _secOf(slug); // Deploy 237.136 -- Application & Terms overrides the checklist section
      if (!bySection[sec]) bySection[sec] = [];
      bySection[sec].push(slug);
    });
    // Deploy 237.150 -- Application & Terms now also holds what used to be "Loan
    // Documents" (commitment letter, LOI, revised terms, exception request), so pin
    // the application and term sheet to the top of it by APP_SLUGS order.
    // Deploy 237.228 (Dan) -- and every OTHER section is ordered too, by the
    // checklist's TRAY_ORDER rather than by the order the review happened to mint
    // the trays in. _trayRank keeps the application rule intact.
    Object.keys(bySection).forEach(function(k) { bySection[k].sort(_byTrayOrder); });
    // Deploy 236.161 — section header now includes a "Show N hidden"
    // toggle when this section has any hidden trays. Hidden trays
    // are rendered below the visible ones, dimmed, with an "Unhide"
    // button replacing the verdict actions.
    var docs = _review.docs || {};
    var hiddenBySection = {};
    Object.keys(docs).forEach(function(s) {
      if (!docs[s] || !docs[s].hidden) return;
      if (!docs[s].hiddenConfirmedAt) return; // Deploy 237.071 -- unconfirmed hides live in Ready for UW
      (hiddenBySection[_secOf(s)] = hiddenBySection[_secOf(s)] || []).push(s);
    });
    Object.keys(hiddenBySection).forEach(function(k) { hiddenBySection[k].sort(_byTrayOrder); }); // Deploy 237.228
    return SECTIONS.map(function(sec) {
      var slugsInSec = bySection[sec.key] || [];
      var hiddenInSec = hiddenBySection[sec.key] || [];
      // Deploy 237.111 (Mike) -- a 2+ guarantor review always shows the Guarantor section
      // (and every guarantor's group) on every tab, even when nothing is on the tab.
      var _multiG = _activeGuarantors().length > 1; // Deploy 237.160 -- active only
      // Deploy 237.150 -- the Other section stays on the Processor tab even when
      // empty, because its header carries the "+ Add Category" button.
      var _keepEmpty = (sec.key === 'guarantor' && _multiG) || (sec.key === 'other' && _activeTab === 'processor');
      if (!slugsInSec.length && !hiddenInSec.length && !_keepEmpty) return '';
      var showHidden = _showHidden[sec.key] === true;
      var hiddenToggle = hiddenInSec.length
        ? '<button class="dr-section-toggle" onclick="dr_toggleHiddenInSection(\'' + escJs(sec.key) + '\')">' +
            (showHidden ? 'Hide ' : 'Show ') + hiddenInSec.length + ' hidden' +
          '</button>'
        : '';
      var hiddenHtml = (showHidden && hiddenInSec.length)
        ? hiddenInSec.map(renderTray).join('')
        : '';
      // Deploy 236.162 — "+ Add Document" creates a custom tray in this
      // section. Deploy 237.150 — only the Other Documents section shows it now
      // (a custom tray renders there wherever it is filed), plus each guarantor's
      // own "+ Add" in the guarantor groups below.
      var addBtn = '<button class="dr-section-toggle dr-add-doc-btn" onclick="dr_openAddDocModal(\'' + escJs(sec.key) + '\',\'' + escJs(sec.label) + '\')" title="Add a document category to this section — a type that isn\'t listed, or an additional version to review">+ Add Category</button>';
      // Deploy 236.164 — bulk "Approve all pending" per section.
      // Counts trays in this section that have a doc uploaded AND
      // verdict is still pending (i.e. awaiting processor click).
      // Skips trays with no doc, hidden trays, already-approved /
      // issues / na trays. Button only renders when there's
      // something to bulk-approve.
      // Deploy 237.138 -- one sweep button that follows the tab: on Processor it
      // approves collected documents, on Underwriting it signs off what the processor
      // already approved.
      var _bulkUw = (_activeTab === 'uw');
      var bulkable = slugsInSec.filter(function(s) {
        var dd = docs[s] || {};
        if (dd.hidden) return false;
        if ((DOC_META[s] && DOC_META[s].noReview) || dd.noReview) return false; // Deploy 236.752 — storage-only trays aren't approvable
        var st = _statusOf(s);
        if (_bulkUw) return st === 'processor_approved';
        return st === 'received' && _trayHasDoc(dd);
      });
      var bulkBtn = bulkable.length
        ? '<button class="dr-section-toggle dr-bulk-approve-btn" onclick="dr_bulkApprove(\'' + escJs(sec.key) + '\')" title="' +
            (_bulkUw ? 'Underwriter-approve every processor-approved document in this section' : 'Processor-approve every collected document in this section that has not been reviewed') + '">\u2713 ' +
            (_bulkUw ? 'UW approve ' : 'Approve ') + bulkable.length + '</button>'
        : '';

      // Deploy 237.150 (Dan: "There seems to be two other documents sections. Just
      // keep one at the very bottom of the doc list") -- the per-section "Other
      // Documents" block is gone. Every non-checklist tray resolves to the 'other'
      // section (see _secOf) and so renders in the one section at the bottom, with
      // the same header, hidden toggle and Add button every other section has.
      var standardInSec = slugsInSec;
      var isOtherSec    = (sec.key === 'other');
      var otherAddBtn   = (isOtherSec && _activeTab === 'processor') ? addBtn : '';
      var otherEmpty    = (isOtherSec && !slugsInSec.length && _activeTab === 'processor')
        ? '<div class="dr-other-empty">Nothing here yet. Use “+ Add Category” for a document type that isn’t on the checklist, or route uncategorized files here from an “Upload ZIP”.</div>'
        : '';

      // Deploy 236.690 — Portfolio: the Collateral section gets a Property 1 / 2 /…
      // tab strip; each property has its OWN collateral trays (slug "<base>__p<i>",
      // tagged with propertyIndex at review-create). Only the active property's
      // trays render. Non-portfolio reviews (no _review.properties) are unchanged.
      var _propTabsHtml = '';
      var _stdToRender = standardInSec;
      if (sec.key === 'collateral' && Array.isArray(_review.properties) && _review.properties.length > 1) {
        var _ap = _activeCollateralProperty || 0;
        if (_ap >= _review.properties.length) _ap = 0;
        _propTabsHtml = '<div class="dr-prop-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px">' +
          _review.properties.map(function(p, i) {
            var on = (i === _ap);
            var lbl = p.label || ('Property ' + (i + 1));
            return '<button type="button" onclick="dr_setCollateralProperty(' + i + ')" title="' + escAttr(p.address || lbl) + '" ' +
              'style="padding:6px 12px;font-size:12px;font-weight:600;border:1px solid ' + (on ? '#C8813A' : '#ddd8d0') + ';background:' + (on ? '#C8813A' : '#fff') + ';color:' + (on ? '#fff' : '#1a1520') + ';border-radius:8px;cursor:pointer">' + escHtml(lbl) + '</button>';
          }).join('') + '</div>';
        var _apAddr = (_review.properties[_ap] && _review.properties[_ap].address) || '';
        if (_apAddr) _propTabsHtml += '<div style="font-size:12px;color:#7a7488;margin:0 0 10px">Collateral for <strong>' + escHtml(_apAddr) + '</strong></div>';
        _stdToRender = standardInSec.filter(function(s) {
          var pi = (_review.docs[s] || {}).propertyIndex;
          return (pi == null) || pi === _ap; // untagged collateral (shared) always shows
        });
      }
      // Deploy 237.106 (Raissa) — 2+ guarantors: each person has their OWN ID / credit /
      // background / OFAC / citizenship / LOE / PFS trays ("<base>__g<i>", tagged
      // guarantorIndex); untagged guarantor trays are shared. The Guarantor 1/2 tab strip
      // was replaced by stacked groups in 237.110 (Mike) -- the old block is kept below
      // behind `false` for reference only.
      if (sec.key === 'guarantor' && _multiG) { // Deploy 237.160
        // Deploy 237.110 (Mike) -- STACKED per-guarantor groups instead of the Guarantor 1/2
        // tab strip: every guarantor's own trays under their own header (name, n/N
        // collected, approved count, a "+ Add" that files a custom tray under them), then
        // the shared trays (Credit Authorization, inbox, custom) under "All guarantors".
        // Groups with nothing on the current tab are skipped.
        var _shared = [], _byG = {};
        standardInSec.forEach(function(s) {
          var gi = (_review.docs[s] || {}).guarantorIndex;
          if (gi == null) _shared.push(s); else (_byG[gi] = _byG[gi] || []).push(s);
        });
        _propTabsHtml = _review.guarantors.map(function(g, i) {
          // Deploy 237.160 -- a removed guarantor has no group. Their trays are hidden
          // (guarantor-trays.setGuarantorTraysHidden), so they are still reachable from the
          // section's "Show N hidden" with every document in them.
          if (g && g.removed) return '';
          var list = _byG[i] || [];   // Deploy 237.111 -- empty groups still render (Mike)
          var have = list.filter(function(s) { var dd = _review.docs[s] || {}; return _trayHasDoc(dd) || dd.verdict === 'na'; }).length;
          // Deploy 237.150 -- was _stageOf(s) === 'reviewed', a stage that has not
          // existed since 237.136, so this count was silently always 0.
          var ok = list.filter(function(s) { return _statusOf(s) === 'uw_approved'; }).length;
          var title = (g.label || ('Guarantor ' + (i + 1))) + (g.name ? ' \u2014 ' + g.name : '');
          return '<div class="dr-gsec">' +
            '<div class="dr-gsec-head">' +
              '<span class="dr-gsec-title">' + escHtml(title) + '</span>' +
              '<span class="dr-gsec-meta">' + (list.length ? have + '/' + list.length + ' collected' + (ok ? ' \u00b7 ' + ok + ' approved' : '') : 'nothing on this tab') + '</span>' +
              (_activeTab === 'processor' ? '<button type="button" class="dr-section-toggle dr-add-doc-btn" onclick="dr_openAddDocModal(\'guarantor\',\'\',' + i + ')" title="Add a document tray for this guarantor">+ Add</button>' : '') +
            '</div>' +
            (list.length ? list.map(renderTray).join('') : '<div class="dr-gsec-empty">No documents for this guarantor on this tab.</div>') +
          '</div>';
        }).join('') +
        (_shared.length
          ? '<div class="dr-gsec"><div class="dr-gsec-head"><span class="dr-gsec-title">All guarantors \u2014 shared</span>' +
            '<span class="dr-gsec-meta">' + _shared.length + ' tray' + (_shared.length === 1 ? '' : 's') + '</span></div>' + _shared.map(renderTray).join('') + '</div>'
          : '');
        _stdToRender = []; // rendered above, grouped
      }
      if (false && sec.key === 'guarantor' && Array.isArray(_review.guarantors) && _review.guarantors.length > 1) {
        var _ag = _activeGuarantor || 0;
        if (_ag >= _review.guarantors.length) _ag = 0;
        _propTabsHtml = '<div class="dr-prop-tabs" style="display:flex;gap:6px;flex-wrap:wrap;margin:0 0 8px">' +
          _review.guarantors.map(function(g, i) {
            var on = (i === _ag);
            var lbl = (g.label || ('Guarantor ' + (i + 1))) + (g.name ? ' · ' + g.name : '');
            return '<button type="button" onclick="dr_setGuarantor(' + i + ')" title="' + escAttr(g.name || lbl) + '" ' +
              'style="padding:6px 12px;font-size:12px;font-weight:600;border:1px solid ' + (on ? '#C8813A' : '#ddd8d0') + ';background:' + (on ? '#C8813A' : '#fff') + ';color:' + (on ? '#fff' : '#1a1520') + ';border-radius:8px;cursor:pointer">' + escHtml(lbl) + '</button>';
          }).join('') + '</div>';
        var _agName = (_review.guarantors[_ag] && _review.guarantors[_ag].name) || '';
        if (_agName) _propTabsHtml += '<div style="font-size:12px;color:#7a7488;margin:0 0 10px">Documents for <strong>' + escHtml(_agName) + '</strong></div>';
        _stdToRender = standardInSec.filter(function(s) {
          var gi = (_review.docs[s] || {}).guarantorIndex;
          return (gi == null) || gi === _ag;
        });
      }

      return '<div class="dr-section">' +
        '<div class="section-title-row">' +
          '<div class="section-title">' + escHtml(sec.label) + '</div>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + otherAddBtn + bulkBtn + hiddenToggle + '</div>' +
        '</div>' +
        _propTabsHtml +
        _stdToRender.map(renderTray).join('') +
        otherEmpty +
        hiddenHtml +
      '</div>';
    }).join('');
  }

  // Deploy 236.501 — a slug is an "Other" (non-checklist) doc when it was
  // created via the Add-Other flow or a bulk-zip Other route. Standard
  // checklist slugs live in DOC_META; custom ones carry isCustom + a
  // custom_/other_ prefix.
  function _isOtherSlug(slug) {
    // Deploy 237.150 -- _secOf calls this for every tray now, so guard _review too.
    var d = (_review && _review.docs && _review.docs[slug]) || {};
    return d.isCustom === true || /^(custom_|other_)/.test(String(slug || ''));
  }

  // ── Deploy 237.072 (Mike, UW phase 3) — "what to verify" + full-file tracker ─────
  // On Ready for UW each tray leads with the rubric's checks and the loan's
  // EXPECTED values for that document (entity name of record, guarantors,
  // amounts, liquidity requirement, freshness window) so the underwriter
  // verifies instead of re-deriving. Facts come from the review's loan / client
  // snapshot + the Articles tray's extracted name; nothing is computed the UW
  // can't see the basis for.
  function _fmtMoney(v) { var n = _num(v); return n ? '$' + Math.round(n).toLocaleString() : ''; }
  function _num(v) { var n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }
  // Deploy 237.078 (Mike, Marianne's 1401 loan) -- the verify panel computed the liquidity
  // requirement off the review's SNAPSHOT (loan $228,750 from 8/29) while the live loan
  // had been re-priced to $217,500 off the BPO -- a bigger down payment the UW never
  // saw. The panel now overlays the CURRENT loan's material terms (Loan Details hands
  // its _loan in), flags the drift, and queues the truth refresh once so the AI
  // re-reviews against the same numbers. Field list mirrors review-truth.mjs
  // TRUTH_MATERIAL_FIELDS.
  var _TRUTH_FIELDS = ['loanAmt', 'purchasePrice', 'rehabBudget', 'arv', 'arvBpo', 'aivBpo', 'propValue', 'currentLoanAmt',
    'rate', 'points', 'loanTerm', 'loanType', 'isIO', 'downPayment', 'initialAdvance', 'holdback',
    'loanPurpose', 'purpose', 'transactionType', 'address', 'entityName', 'llcName', 'rent', 'monthlyRent',
    'toolType', 'fundingDate', 'expectedCloseDate', 'closeDate', 'vestingLLCs'];
  function _liveFor(review) {
    var src = (review && review.source) || {};
    return (_liveLoan && _liveLoan.id && src.loanId && _liveLoan.id === src.loanId) ? _liveLoan : null;
  }
  function _termsDrift(review) {
    var live = _liveFor(review); if (!live) return [];
    var snap = review.sourceLoanSnapshot || review.snapshotLoan || {};
    // Deploy 237.105 -- the review snapshot (blob) carries no vestingLLCs while Postgres returns [],
    // so every page load saw 'terms changed' and re-ran AI on every tray. Empty == empty;
    // entity lists compare by name; numeric strings compare as numbers.
    function norm(v) {
      if (v == null) return '';
      if (Array.isArray(v)) return v.map(function(x) { return x && typeof x === 'object' ? String(x.name || '').trim().toLowerCase() : String(x == null ? '' : x).trim().toLowerCase(); }).filter(Boolean).join('|');
      if (typeof v === 'object') { var ks = Object.keys(v).sort(); return ks.length ? JSON.stringify(ks.map(function(k) { return [k, v[k]]; })) : ''; }
      var t = String(v).trim();
      return (t !== '' && isFinite(Number(t))) ? String(Number(t)) : t;
    }
    return _TRUTH_FIELDS.filter(function(k) { return norm(snap[k]) !== norm(live[k]); });
  }
  function _autoSyncIfStale() {
    if (!_review || !_review.id) return;
    if (document.body.classList.contains('dr-lo-readonly')) return;
    if (global.SLA && typeof global.SLA.isProcessor === 'function' && !global.SLA.isProcessor(_user)) return;
    var drift = _termsDrift(_review);
    // Deploy 237.081 -- reviews created before the roster existed: a loan with linked co-guarantors
    // but no review.guarantorNames gets one refresh so Guarantor 2+ appear.
    var lv = _liveFor(_review);
    if (!Array.isArray(_review.guarantorNames) && lv && Array.isArray(lv.guarantorClientIds) && lv.guarantorClientIds.length) drift = drift.concat(['guarantorRoster']);
    if (!drift.length) return;
    var key = _review.id + '|' + drift.join(',');
    if (_autoSynced[key]) return;
    try { if (global.sessionStorage && global.sessionStorage.getItem('dr-autosync:' + key)) return; } catch (_) {}
    _autoSynced[key] = true;
    try { global.sessionStorage.setItem('dr-autosync:' + key, '1'); } catch (_) {}
    var src = _review.source || {};
    var clientId = (global._client && global._client.id) || src.clientId;
    var loanId = global._loanId || src.loanId;
    var owner = (typeof global._ldOwnerOverride === 'function' && global._ldOwnerOverride()) || (global._loEmail || src.ownerKey || '');
    if (!clientId || !loanId || !owner) return;
    SLA.getToken().then(function(tok) {
      return fetch('/api/loan-review-refresh-truth', {
        method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: owner, clientId: clientId, loanId: loanId, reason: 'loan terms changed since the review snapshot: ' + drift.slice(0, 6).join(', ') }),
      });
    }).then(function(r) {
      if (r.status === 202 || r.ok) { showToast('Loan terms changed since the last review (' + drift.slice(0, 4).join(', ') + ') — snapshot refreshed, AI re-reviews queued.', 'info'); setTimeout(function() { loadReview(); }, 5000); }
    }).catch(function() {});
  }
  // Deploy 237.079 (Mike) -- every party list is one row per party, numbered Guarantor 1, 2, …
  // (plus the entity where the entity is an acceptable party), so a multi-guarantor
  // file reads top-to-bottom instead of a slash-joined blob.
  function _partyRows(out, what, f, withEntity) {
    if (withEntity && f.entity) out.push([what + ' — Vesting Entity', f.entity + (f.entityOfRecord ? ' (per recorded Articles)' : ' (per loan record)')]); // Deploy 237.080
    f.guarantors.forEach(function(g, i) { out.push([what + ' — Guarantor ' + (i + 1), g]); });
    if (!f.guarantors.length && !(withEntity && f.entity)) out.push([what, '—']);
  }
  function _idNameFor(g, idNames, guarantorCount) {
    var parts = String(g || '').toLowerCase().split(/\s+/).filter(Boolean); var last = parts[parts.length - 1] || ''; var first = parts[0] || '';
    var hit = idNames.filter(function(n) { var l = n.toLowerCase(); return last && l.indexOf(last) >= 0 && (!first || l.indexOf(first) >= 0 || l.charAt(0) === first.charAt(0)); });
    if (hit.length) return hit[0];
    return (guarantorCount === 1 && idNames.length === 1) ? idNames[0] : '';
  }
  // Deploy 237.080 (Mike) -- the ENTITY on a loan is the Vesting Entity (loan.vestingLLCs[0], the
  // 'Vesting Entity Info' section on Loan Details), not client.entityName -- which is blank
  // on most files, so entity docs showed no entity to verify against until the Articles
  // were reviewed. Entries are strings or {name}.
  function _vestingName(L) {
    var v = (L && Array.isArray(L.vestingLLCs)) ? L.vestingLLCs[0] : null;
    return typeof v === 'string' ? v.trim() : ((v && v.name) ? String(v.name).trim() : '');
  }
  // Deploy 237.075 (Mike) -- legal names per the ID tray, expected mortgagee (mirrors
  // _shared/loan-review-checklists.mjs expectedMortgagee), per-guarantor coverage,
  // and valuation minimums (RTL caps from window.SLA_RTL, loaded on Loan Details).
  function _idNamesOf() {
    var docs = _review.docs || {}; var out = [];
    function push(n) { n = String(n || '').replace(/\s+/g, ' ').trim(); if (!n || /^(null|n\/?a|none|unknown)$/i.test(n)) return; for (var i = 0; i < out.length; i++) if (out[i].toLowerCase() === n.toLowerCase()) return; out.push(n); }
    // Deploy 237.106 — the ID lives in guarantor_id OR the per-guarantor guarantor_id__g<i> trays.
    Object.keys(docs).forEach(function(s) {
      if (!/^guarantor_id(__g\d+)?$/.test(s)) return;
      var tray = docs[s] || {};
      (tray.documents || []).forEach(function(d) { if (d && !d.hidden && d.aiReviewedAt && d.aiExtractedEntities) push(d.aiExtractedEntities.borrowerName); });
      if (tray.aiReviewedAt && tray.aiExtractedEntities) push(tray.aiExtractedEntities.borrowerName);
    });
    return out;
  }
  function _expectedMortgagee(L) {
    var inv = String(L.investorName || '') + ' ' + String(_review.investor || '');
    if (/diya|re investments/i.test(inv)) return 'RE Investments Loans LLC, ISAOA/ATIMA';
    if (/king arthur|\bkaf\b/i.test(inv)) return 'King Arthur Fund 1 LLC, ISAOA/ATIMA';
    if (/sir lends|sla capital|\bsla\b/i.test(inv)) return 'Sir Lends A Lot LLC, ISAOA/ATIMA';
    if (String(_review.loanType || '').toLowerCase() === 'dscr') return 'RE Investments Loans LLC, ISAOA/ATIMA';
    return 'Sir Lends A Lot LLC, ISAOA/ATIMA or King Arthur Fund 1 LLC, ISAOA/ATIMA';
  }
  function _coverageFor(slug, guarantors) {
    var tray = (_review.docs || {})[slug] || {};
    var docs = (tray.documents || []).filter(function(d) { return d && !d.hidden; });
    var names = docs.map(function(d) { var ee = d.aiExtractedEntities || {}; return String((ee.borrowerName || '') + ' ' + (d.filename || '')).toLowerCase(); });
    // Deploy 237.076 -- auto-attached docs (Xactus credit pull, background checks) can carry only the
    // tray-level currentFilename / extraction with no documents[] entry; 3528 Park's credit
    // report showed "missing" for the very guarantor it was pulled for.
    if (tray.currentDocId) { var tee = tray.aiExtractedEntities || {}; names.push(String((tee.borrowerName || '') + ' ' + (tray.currentFilename || '')).toLowerCase()); }
    return guarantors.map(function(g) {
      var parts = String(g).toLowerCase().split(/\s+/).filter(Boolean); var last = parts[parts.length - 1] || ''; var first = parts[0] || '';
      var ok = !!last && names.some(function(n) { return n.indexOf(last) >= 0 && (!first || n.indexOf(first) >= 0 || n.indexOf(first.charAt(0) + ' ') >= 0 || n.indexOf(first.charAt(0) + '.') >= 0); });
      return { name: g, ok: ok };
    });
  }
  function _valuationFacts(L, loanAmt, pp, rehab, arv, isDscr, purpose) {
    var fd = L.formData || {};
    var bpo = (_review.docs || {}).bpo_valuation || {}; var apr = (_review.docs || {}).appraisal || {};
    function xf(dd, k) { var f = dd.aiExtractedFields && dd.aiExtractedFields[k]; return (f && f.found !== false) ? _num(f.value) : 0; }
    function xe(dd, k) { return _num((dd.aiExtractedEntities || {})[k]); }
    var aiv = _num(L.aivBpo) || xf(bpo, 'aivBpo') || xe(bpo, 'asIsValue') || xf(apr, 'asIsPrice') || xe(apr, 'asIsValue');
    var docArv = _num(L.arvBpo) || xf(bpo, 'arvBpo') || xe(bpo, 'afterRepairValue') || xe(apr, 'afterRepairValue');
    var out = { aiv: aiv, docArv: docArv, minArv: 0, minAiv: 0, caps: '', flags: [] };
    var isRefi = /cash|rate|refi/i.test(purpose);
    if (!isDscr && window.SLA_RTL && typeof window.SLA_RTL.priceRTL === 'function') {
      try {
        var core = window.SLA_RTL.priceRTL({ lt: fd.loanType || L.loanType || 'light', fr: parseInt(fd.fico || L.fico, 10) || 0, exp: parseInt(fd.experience || fd.numFlips || 0, 10) || 0, pt: fd.propType || L.propType || 'sfr', pp: pp, arv: arv, rb: rehab, term: parseInt(fd.loanTerm || L.loanTerm || 12, 10) || 12, purp: fd.loanPurpose || L.loanPurpose || 'purchase', zhvi: fd.zhvi || '', sa: fd.propState || '', state: fd.propState || '' });
        if (core && !core.rErr) {
          if (isRefi && core.refiLtv > 0) { out.minAiv = loanAmt / core.refiLtv; out.caps = 'max LTV ' + Math.round(core.refiLtv * 100) + '%'; }
          else {
            if (core.mLarv > 0) out.minArv = loanAmt / core.mLarv;
            if (core.mLtp > 0) { var initial = (rehab && loanAmt > rehab) ? loanAmt - rehab : loanAmt; out.minAiv = initial / core.mLtp; }
            out.caps = [core.mLtp > 0 ? 'max LTP ' + Math.round(core.mLtp * 100) + '%' : '', core.mLtc > 0 ? 'max LTC ' + Math.round(core.mLtc * 100) + '%' : '', core.mLarv > 0 ? 'max LTARV ' + Math.round(core.mLarv * 100) + '%' : ''].filter(Boolean).join(', ');
          }
        }
      } catch (e) {}
    }
    if (isDscr) { var pv = _num(L.propValue); if (pv && loanAmt) { out.minAiv = pv; out.caps = 'priced at ' + (Math.round(loanAmt / pv * 1000) / 10) + '% LTV off ' + _fmtMoney(pv); } }
    if (aiv && pp && aiv < pp) out.flags.push('as-is value ' + _fmtMoney(aiv) + ' is BELOW the purchase price ' + _fmtMoney(pp));
    if (aiv && loanAmt && aiv < loanAmt) out.flags.push('as-is value ' + _fmtMoney(aiv) + ' is BELOW the loan amount ' + _fmtMoney(loanAmt));
    if (out.minAiv && aiv && aiv < out.minAiv) out.flags.push('as-is value is below the ' + _fmtMoney(out.minAiv) + ' minimum needed to hold the loan amount at max leverage');
    if (out.minArv && docArv && docArv < out.minArv) out.flags.push('ARV ' + _fmtMoney(docArv) + ' is BELOW the ' + _fmtMoney(out.minArv) + ' minimum needed for this loan amount');
    return out;
  }
  function _loanFacts() {
    var L = _review.sourceLoanSnapshot || _review.snapshotLoan || {}; // Deploy 237.074 -- borrower-created reviews store snapshotLoan
    // Deploy 237.078 -- overlay the LIVE loan's material terms so the UW sees today's numbers.
    var _drift = _termsDrift(_review);
    if (_drift.length) { var _lv = _liveFor(_review); L = Object.assign({}, L); _TRUTH_FIELDS.forEach(function(k) { if (_lv[k] != null && _lv[k] !== '') L[k] = _lv[k]; else if (_drift.indexOf(k) >= 0) L[k] = _lv[k]; }); }
    var C = _review.sourceClientSnapshot || _review.snapshotClient || {};
    var art = (_review.docs || {}).articles_of_organization || {};
    var ee = art.aiExtractedEntities || {};
    var entityOfRecord = (art.aiReviewedAt && typeof ee.llcName === 'string' && ee.llcName.trim()) ? ee.llcName.trim() : '';
    var entity = entityOfRecord || _vestingName(L) || C.entityName || L.entityName || L.llcName || ''; // Deploy 237.080 -- Vesting Entity first
    var borrower = _review.borrowerName || ((C.firstName || '') + ' ' + (C.lastName || '')).trim();
    var gs = (Array.isArray(L.guarantors) ? L.guarantors : []).map(function(g) {
      return g ? (((g.firstName || '') + ' ' + (g.lastName || '')).trim() || g.name || '') : '';
    }).filter(Boolean);
    // Deploy 237.081 -- the resolved roster (primary + linked co-guarantors + long-app co-borrowers)
    if (Array.isArray(_review.guarantorNames) && _review.guarantorNames.length) gs = _review.guarantorNames.slice();
    if (!gs.length && borrower) gs = [borrower];
    var loanAmt = _num(L.loanAmt) || _num(_review.loanAmount);
    var pp = _num(L.purchasePrice), rehab = _num(L.rehabBudget), arv = _num(L.arv);
    var rate = _num(L.rate); if (rate > 0 && rate < 1) rate = rate * 100;
    var points = _num(L.points);
    var isDscr = String(_review.loanType || '').toLowerCase() === 'dscr';
    var purpose = String(L.loanPurpose || L.purpose || L.transactionType || '');
    var cashOut = /cash/i.test(purpose);
    var liq = [];
    if (isDscr) {
      var months = loanAmt > 2000000 ? 9 : loanAmt > 1000000 ? 6 : 3;
      liq.push(months + ' months PITIA' + (loanAmt ? ' (loan ' + (loanAmt > 2000000 ? '> $2M' : loanAmt > 1000000 ? '$1M–$2M' : '≤ $1M') + ')' : ''));
      if (cashOut) liq.push('+ 3 months (cash-out)');
      if (loanAmt) liq.push('liquid net worth post-close ≥ ' + _fmtMoney(loanAmt * 0.05) + ' (5% of loan)');
    } else {
      var initial = (loanAmt && rehab && loanAmt > rehab) ? loanAmt - rehab : loanAmt;
      var down = (pp && initial && pp > initial) ? pp - initial : 0;
      var twenty = rehab ? rehab * 0.2 : 0;
      var interest6 = (loanAmt && rate) ? loanAmt * (rate / 100) / 12 * 6 : 0;
      var total = down + twenty + interest6;
      liq.push('down payment ' + (down ? _fmtMoney(down) : '(purchase price − initial loan)') +
        ' + 20% of rehab ' + (twenty ? _fmtMoney(twenty) : '') +
        ' + 6 months interest ' + (interest6 ? _fmtMoney(interest6) : '') +
        (total ? ' = ' + _fmtMoney(total) : ''));
    }
    var idNames = _idNamesOf(); // Deploy 237.075
    var mortgagee = _expectedMortgagee(L);
    var val = _valuationFacts(L, loanAmt, pp, rehab, arv, isDscr, purpose);
    return {
      entity: entity, entityOfRecord: entityOfRecord, borrower: borrower, guarantors: gs, idNames: idNames, mortgagee: mortgagee, val: val,
      address: _review.address || L.address || '', loanAmt: loanAmt, purchasePrice: pp, rehab: rehab, arv: arv,
      rate: rate, points: points, rent: _num(L.rent), isDscr: isDscr, liquidity: liq.join('; '), term: _num(L.loanTerm), // Deploy 237.075
      drift: _drift, // Deploy 237.078
      close: _review.expectedCloseDate || L.fundingDate || L.closeDate || '',
    };
  }
  var _EXPECT_RULES = [
    // Deploy 237.074 (Mike) -- entity docs are compared to the LLC name (the Articles are its source); the
    // guarantor list is NOT what these documents are checked against. COGS: entity + the
    // certificate's own date (90-day window). EIN / W-9: entity + the letter's date. Only the
    // Operating Agreement (members / owners) still lists the people.
    [/^articles_of_organization$/, ['llcToFind']],
    [/^certificate_of_good_standing$/, ['entity', 'docDate', 'fresh']],
    [/^(ein_or_w9|ein_letter)$/, ['entity', 'docDate']],
    [/^(ofac_entity|entity_background_check|foreign_entity_registration)$/, ['entity']],
    [/^operating_agreement$/, ['entity', 'members']],
    // Deploy 237.075 (Mike) -- every guarantor listed; legal name per the ID (incl. middle name, no
    // nicknames); per-guarantor trays show which guarantors have a copy on file.
    // Deploy 237.152 (Mike) -- credit_authorization moved up into the per-person group:
    // each guarantor signs their own, so the panel shows WHICH guarantors have one on file.
    [/^(guarantor_id|proof_of_citizenship|guarantor_background_check|ofac_personal|pfs|credit_authorization)$/, ['guarantorsAll', 'legalName', 'copies']],
    [/^(guarantor_loe|borrower_loe|track_record|track_record_reo|vom|voh_corrfirst)$/, ['guarantorsAll', 'legalName']],
    [/^credit_report$/, ['guarantorsAll', 'legalName', 'copies', 'fico', 'fresh']],
    [/^bank_stmt_(current|previous)$/, ['holder', 'liquidity', 'fresh']],
    [/^(voided_check|voided_check_ach|executed_ach_form|draw_wire_form)$/, ['holderOnly']], // Deploy 237.074 -- entity (per Articles) or any guarantor
    // Deploy 237.075 (Mike) -- term sheet + application: every party and every pricing term, so the UW can match them.
    [/^(loan_application|term_sheet|commitment_letter|revised_loan_terms|letter_of_intent|outstanding_conditions|exception_request)$/, ['borrower', 'guarantorsAll', 'legalName', 'entity', 'address', 'loanAmt', 'purchasePrice', 'rehab', 'arv', 'rate', 'points', 'term', 'close']],
    // Deploy 237.075 (Mike) -- PSA: buyer is the entity or a guarantor, price, address, closing date, signatures.
    // Assignment: seller on it = the PSA buyer; assignee = entity / guarantor; fee stated and at most 15% of price.
    [/^psa$/, ['buyerParty', 'purchasePrice', 'address', 'close', 'signed']],
    [/^assignment_agreement$/, ['assignor', 'buyerParty', 'assignmentFee', 'purchasePrice', 'address', 'close', 'signed']],
    [/^cost_basis$/, ['buyer', 'purchasePrice', 'address']],
    [/^sow$/, ['rehabTerms', 'address']],
    [/^cpl$/, ['borrowerEntity', 'lender', 'address']], // Deploy 237.075 (Mike) -- CPL: borrower/entity + lender name
    // Deploy 237.075 (Mike) -- valuations: AIV to verify, minimum ARV / AIV for the loan amount, flags.
    [/^(appraisal|bpo_valuation|cda_report)/, ['address', 'purchasePrice', 'loanAmt', 'aiv', 'arvMin', 'valuationFlags']],
    [/^(appraisal_receipt|air|property_profile|property_condition_assessment|environmental_survey|feasibility_study)/, ['address', 'purchasePrice', 'arv', 'loanAmt']],
    // Deploy 237.075 (Mike) -- EOI: named insured (entity or guarantor), expected mortgagee, policy number;
    // paid-in-full: $0 owed + address + policy number only (coverage is not verified there).
    [/^(evidence_of_insurance|property_insurance_binder|flood_insurance_policy|condo_insurance)$/, ['insured', 'mortgagee', 'address', 'coverage', 'policy']],
    [/^(proof_of_insurance_pif|insurance_invoice)$/, ['pifBalance', 'address', 'policy']],
    [/^(flood_certificate|condo_documents|condo_hoa_docs|architectural_plans|building_permits|gc_review)$/, ['address']],
    [/^(lease_agreements|proof_of_security_deposit|property_mgmt_summary|property_mgmt_agreement|property_mgmt_questionnaire)$/, ['landlord', 'address', 'rent']],
    [/^(title_commitment|cpl|title_eo_insurance|title_escrow_contact|prelim_settlement|final_hud|tax_certificate|wire_instructions|emd_receipt|borrower_closing_funds_receipt|payoff_demand|mortgage_statements_payoffs|closing_w9|executed_closing_documents|executed_deed|original_doc_tracking|invoice)$/, ['entity', 'address', 'loanAmt', 'title', 'close']],
  ];
  function _expectedFor(slug, meta) {
    var base = String(slug || '').replace(/__[pg]\d+$/, ''); // 237.106: __g<i> too
    var keys = ['borrower', 'entity', 'address', 'loanAmt'];
    for (var i = 0; i < _EXPECT_RULES.length; i++) { if (_EXPECT_RULES[i][0].test(base)) { keys = _EXPECT_RULES[i][1]; break; } }
    var f = _loanFacts();
    // Deploy 237.106 — a per-guarantor tray is verified against THAT guarantor only.
    var _gi = ((_review.docs || {})[slug] || {}).guarantorIndex;
    if (_gi != null && f.guarantors && f.guarantors[_gi]) { f = Object.assign({}, f, { guarantors: [f.guarantors[_gi]] }); }
    var out = [];
    if (f.drift && f.drift.length) out.push(['⚠ Terms changed', 'the loan changed since the AI last reviewed (' + f.drift.slice(0, 5).join(', ') + ') — figures below are the CURRENT loan; the AI re-review is queued automatically']); // Deploy 237.078
    var ficoM = /(\d{3})/.exec(String((meta && meta.conditions) || ''));
    var staleDays = { bank_stmt_current: 60, bank_stmt_previous: 60, certificate_of_good_standing: 90, entity_background_check: 90, guarantor_background_check: 90, ofac_entity: 90, ofac_personal: 90, credit_report: 120, appraisal: 120, appraisal_receipt: 120 };
    keys.forEach(function(k) {
      switch (k) {
        case 'entity':   out.push([f.entityOfRecord ? 'Entity name (per recorded Articles)' : 'Vesting Entity (per loan record — the Articles govern once reviewed)', f.entity || 'no Vesting Entity on the loan — set it in Vesting Entity Info on Loan Details']); break; // Deploy 237.080
        case 'borrower': if (f.borrower) out.push(['Borrower', f.borrower]); break;
        case 'guarantors': if (f.guarantors.length) out.push(['Guarantor' + (f.guarantors.length > 1 ? 's' : ''), f.guarantors.join(', ')]); break;
        // Deploy 237.074 (Mike) -- every acceptable holder listed; 100% owned by those parties.
        case 'holder':   _partyRows(out, 'Account holder (any ONE)', f, true); out.push(['Ownership', '100% by the entity / guarantors above — no non-guarantor person or other entity on the account']); out.push(['Format', 'Full bank-generated statement or Account Transaction History — not a screenshot or photo']); break; // Deploy 237.079
        case 'llcToFind': out.push(['LLC name to identify', 'the entity name as filed with the state' + (f.entity ? ' — expected: ' + f.entity + (f.entityOfRecord ? ' (per this tray\'s last review)' : ' (per loan record; the Articles govern if they differ)') : '')]); out.push(['Not the', 'organizer / member / guarantor name']); break;
        case 'members':  f.guarantors.forEach(function(g, i) { out.push(['Member / Guarantor ' + (i + 1), g]); }); break; // Deploy 237.079
        // Deploy 237.075 (Mike) -- guarantor roster / legal names / copies per guarantor; valuation minimums; insurance.
        case 'guarantorsAll': f.guarantors.forEach(function(g, i) { out.push(['Guarantor ' + (i + 1), g]); }); break; // Deploy 237.079
        case 'legalName': f.guarantors.forEach(function(g, i) { var nm = _idNameFor(g, f.idNames, f.guarantors.length); out.push(['Guarantor ' + (i + 1) + ' legal name (per ID)', nm ? nm : 'no ID reviewed yet for ' + g + ' — compare to the driver\'s license before approving']); }); out.push(['Name rule', 'every document must match the ID INCLUDING the middle name — no nicknames']); break; // Deploy 237.079
        case 'copies': (function () { var cov = _coverageFor(slug, f.guarantors); if (!cov.length) return; cov.forEach(function(c, i) { out.push(['Guarantor ' + (i + 1) + ' copy on file', c.name + (c.ok ? ' ✓' : ' ✗ missing')]); }); })(); break; // Deploy 237.079
        case 'aiv': out.push(['As-is value (AIV)', (f.val.aiv ? _fmtMoney(f.val.aiv) + ' per the valuation' : 'read it off the report') + (f.val.minAiv ? ' — minimum ' + _fmtMoney(f.val.minAiv) + ' to hold the loan amount' : '') + (f.purchasePrice ? '; must not be below the purchase price ' + _fmtMoney(f.purchasePrice) : '') + (f.loanAmt ? ' or the loan amount ' + _fmtMoney(f.loanAmt) : '')]); break;
        case 'arvMin': if (!f.isDscr) out.push(['ARV', (f.val.docArv ? _fmtMoney(f.val.docArv) + ' per the valuation' : (f.arv ? _fmtMoney(f.arv) + ' per the loan' : 'read it off the report')) + (f.val.minArv ? ' — minimum ' + _fmtMoney(f.val.minArv) + ' to keep this loan amount within ' + (f.val.caps || 'the LTARV cap') : (f.val.caps ? ' — ' + f.val.caps : ''))]); else if (f.val.caps) out.push(['Value', f.val.caps]); break;
        case 'valuationFlags': if (f.val.flags.length) out.push(['⚠ FLAG', f.val.flags.join('; ')]); break;
        case 'mortgagee': out.push(['Mortgagee clause', f.mortgagee]); break;
        case 'policy': (function () { var dd = (_review.docs && _review.docs[slug]) || {}; var pn = String(((dd.aiExtractedEntities || {}).policyNumber) || '').trim(); var eoi = (_review.docs || {}).evidence_of_insurance || {}; var epn = String(((eoi.aiExtractedEntities || {}).policyNumber) || '').trim(); var isEoi = slug === 'evidence_of_insurance'; out.push(['Policy number', pn ? pn + (!isEoi && epn && epn !== pn ? ' — EOI shows ' + epn + ' (MISMATCH)' : '') : (!isEoi && epn ? epn + ' (per the EOI) — confirm it matches' : 'read it off the document')]); })(); break;
        case 'pifBalance': out.push(['Balance owed', '$0 — paid in full (coverage amounts are not verified on this document)']); break;
        case 'buyerParty': _partyRows(out, 'Buyer (any ONE)', f, true); break; // Deploy 237.079
        case 'assignor': (function () { var psa = (_review.docs || {}).psa || {}; var pe = psa.aiExtractedEntities || {}; var pb = String(pe.buyerName || pe.llcName || pe.borrowerName || '').trim(); out.push(['Seller on the assignment', pb ? 'must be the PSA buyer: ' + pb : 'must be the buyer named on the PSA (PSA not reviewed yet — check it by hand)']); })(); break;
        case 'assignmentFee': (function () { var dd = (_review.docs && _review.docs[slug]) || {}; var fee = _num((dd.aiExtractedEntities || {}).assignmentFee); var cap = f.purchasePrice ? f.purchasePrice * 0.15 : 0; out.push(['Assignment fee', (fee ? _fmtMoney(fee) + ' per the assignment' : 'must be clearly stated — read it off the assignment') + (cap ? ' — maximum ' + _fmtMoney(cap) + ' (15% of the ' + _fmtMoney(f.purchasePrice) + ' purchase price)' : '') + (fee && cap && fee > cap ? ' ⚠ OVER THE 15% LIMIT' : '')]); })(); break;
        case 'signed': out.push(['Signatures', 'fully signed AND dated by every party' + (slug === 'assignment_agreement' ? ' (assignor and assignee)' : ' (buyer and seller)')]); break;
        case 'rehabTerms': out.push(['Rehab budget per the term sheet', f.rehab ? _fmtMoney(f.rehab) + ' — the SOW total must match it' : 'no rehab budget on the loan record — confirm against the term sheet']); break;
        case 'term':     if (f.term) out.push(['Term', f.term + ' months']); break;
        case 'borrowerEntity': _partyRows(out, 'Borrower / entity', f, true); break; // Deploy 237.079
        case 'lender':   out.push(['Lender name', String(f.mortgagee || '').replace(/, ISAOA\/ATIMA/g, '')]); break;
        case 'holderOnly': _partyRows(out, 'Account holder (any ONE)', f, true); break; // Deploy 237.079
        case 'docDate':  (function () { var dd = (_review.docs && _review.docs[slug]) || {}; var ee = dd.aiExtractedEntities || {}; var dt = String(ee.documentDate || ee.expirationDate || '').trim(); out.push(['Document date', dt ? dt + ' (per the last AI read — confirm on the document)' : 'confirm the issue date printed on the document']); })(); break;
        case 'buyer':    if (f.entity) out.push(['Buyer', f.entity]); break;
        case 'insured':  _partyRows(out, 'Named insured (any ONE)', f, true); break; // Deploy 237.079
        case 'landlord': if (f.entity) out.push(['Landlord', f.entity]); break;
        case 'address':  if (f.address) out.push(['Property', f.address]); break;
        case 'loanAmt':  if (f.loanAmt) out.push(['Loan amount', _fmtMoney(f.loanAmt)]); break;
        case 'purchasePrice': if (f.purchasePrice) out.push(['Purchase price', _fmtMoney(f.purchasePrice)]); break;
        case 'arv':      if (f.arv) out.push(['ARV', _fmtMoney(f.arv)]); break;
        case 'rehab':    if (f.rehab) out.push(['Rehab budget', _fmtMoney(f.rehab)]); break;
        case 'rate':     if (f.rate) out.push(['Rate', f.rate.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + '%']); break;
        case 'points':   if (f.points) out.push(['Points', String(f.points)]); break;
        case 'rent':     if (f.rent) out.push(['Monthly rent', _fmtMoney(f.rent)]); break;
        case 'fico':     if (ficoM) out.push(['Minimum middle score', ficoM[1]]); break;
        case 'liquidity': if (f.liquidity) out.push(['Liquidity required', f.liquidity]); break;
        case 'coverage': if (f.loanAmt) out.push(['Coverage', '≥ ' + _fmtMoney(f.loanAmt) + ' (loan amount) or 100% replacement cost; $1M liability']); break;
        case 'title':    if (f.loanAmt) out.push(["Lender's title coverage", _fmtMoney(f.loanAmt * 1.25) + ' (125% of loan)']); break;
        case 'close':    if (f.close) out.push(['Expected close', f.close]); break;
        case 'fresh':    if (staleDays[base]) out.push(['Max age', staleDays[base] + ' days']); break;
      }
    });
    return out;
  }
  function _renderVerifyPanel(slug, d, meta) {
    // (no lookbehind -- older Safari in the field offices can't parse it; the split eats the period, which is fine)
    var checks = String((meta && meta.conditions) || '').split(/[.;?]\s+(?=[A-Z“"(])/).map(function(s) { return s.replace(/[.;?]\s*$/, '').trim(); }).filter(Boolean).slice(0, 10);
    var expected = _expectedFor(slug, meta);
    if (!checks.length && !expected.length) return '';
    return '<div class="dr-verify">' +
      '<h5>What to verify</h5>' +
      (checks.length ? '<ul>' + checks.map(function(c) { return '<li>' + escHtml(c) + '</li>'; }).join('') + '</ul>' : '') +
      (expected.length ? '<div class="kv">' + expected.map(function(kv) { return '<span><b>' + escHtml(kv[0]) + ':</b> ' + escHtml(kv[1]) + '</span>'; }).join('') + '</div>' : '') +
    '</div>';
  }
  // Full-file tracker (item 8): required trays = docs[slug].required (stamped at
  // review creation from the checklist); hidden trays don't count; a tray is "in"
  // with a live document or an N/A. Mirrors _shared/review-full-file.mjs.
  function _fullFileStatus() {
    var docs = (_review && _review.docs) || {};
    var required = 0, have = 0, missing = [];
    Object.keys(docs).forEach(function(s) {
      var dd = docs[s] || {};
      if (dd.required !== true || dd.hidden) return;
      required++;
      if (_trayHasDoc(dd) || dd.verdict === 'na') have++; else missing.push(s);
    });
    return { required: required, have: have, missing: missing, complete: required > 0 && have === required };
  }
  function _renderFullFileCard() {
    var st = _fullFileStatus();
    if (!st.required) return '';
    var pct = Math.round(st.have / st.required * 100);
    var bySec = {};
    st.missing.forEach(function(s) {
      var dd = _review.docs[s] || {};
      var m = DOC_META[s] || DOC_META[String(s).replace(/__[pg]\d+$/, '')] || {}; // Deploy 237.110 -- per-guarantor / per-property trays resolve by base
      var sec = _secOf(s); // Deploy 237.136 -- same display section as the trays
      var _gl = m.label || dd.label || s;
      if (dd.guarantorIndex != null && Array.isArray(_review.guarantors) && _review.guarantors[dd.guarantorIndex] && _review.guarantors[dd.guarantorIndex].name) _gl += ' (' + _review.guarantors[dd.guarantorIndex].name + ')'; // Deploy 237.110
      (bySec[sec] = bySec[sec] || []).push(_gl);
    });
    var missingHtml = st.missing.length
      ? SECTIONS.map(function(sec) {
          var list = bySec[sec.key] || [];
          if (!list.length) return '';
          return '<div class="ff-sec"><b>' + escHtml(sec.label) + ':</b> ' + list.map(escHtml).join(' · ') + '</div>';
        }).join('')
      : '';
    return '<div class="dr-fullfile' + (st.complete ? ' complete' : '') + '">' +
      '<div class="ff-head"><span class="ff-title">' + (st.complete ? '\u2713 Full file — every required document is in' : 'Full file: ' + st.have + ' of ' + st.required + ' required documents in') + '</span>' +
        '<span class="ff-pct">' + pct + '%</span></div>' +
      '<div class="ff-bar"><div class="ff-fill" style="width:' + pct + '%"></div></div>' +
      (missingHtml ? '<div class="ff-missing"><span class="ff-missing-label">Missing (' + st.missing.length + ')</span>' + missingHtml + '</div>' : '') +
      (_review.fullFileNotifiedAt ? '<div class="ff-note">Processor + admins notified ' + escHtml(formatDate(_review.fullFileNotifiedAt)) + '</div>' : '') +
    '</div>';
  }

  function renderTray(slug) {
    var d = _review.docs[slug] || {};
    // Deploy 236.162 — custom trays store label/conditions/section
    // on the doc itself (no entry in DOC_META). Resolve from there
    // when the slug isn't in the standard checklist.
    var meta = DOC_META[slug] || {
      label:      d.label      || slug,
      conditions: d.conditions || '',
      section:    d.section    || 'loan',
    };
    // Deploy 236.924 (Mike: "reduce all the secondary text in the buckets for
    // those different properties in Collateral Docs") -- a per-property tray
    // (<base>__p<i>) is self-describing and carries the FULL checklist rubric
    // as its conditions, so a portfolio's Collateral section showed a
    // paragraph under every tray where a single-property review shows the
    // DOC_META one-liner. Show the base slug's one-liner instead; the rubric
    // stays on the tray and still drives the AI review server-side.
    var _pBase = /__[pg]\d+$/.test(slug) ? slug.replace(/__[pg]\d+$/, '') : ''; // 237.106: per-guarantor trays too
    if (_pBase && DOC_META[_pBase]) {
      meta = {
        label:      meta.label   || DOC_META[_pBase].label,
        conditions: DOC_META[_pBase].conditions || '',
        section:    meta.section || DOC_META[_pBase].section || 'collateral',
      };
    }
    var verdict = d.verdict || 'pending';
    var hasDoc = !!d.currentDocId;
    var _status = _statusOf(slug);           // Deploy 237.136
    var _openConds = _openCondCount(d);
    // Deploy 236.689 -- for a multi-doc tray the AI chip reflects the WORST live doc.
    var _trayAi = d.aiVerdict || '';
    var _ldsForAgg = _liveDocs(slug);
    if (_ldsForAgg.length > 1) {
      var _aiRank = { issues: 3, needs_manual_review: 2, approved: 1 };
      _trayAi = '';
      _ldsForAgg.forEach(function(ld) {
        var v = _docAiSrc(d, ld).aiVerdict || '';
        if ((_aiRank[v] || 0) > (_aiRank[_trayAi] || 0)) _trayAi = v;
      });
    }
    var _aiChip = '';
    if (!d.hidden && hasDoc && _trayAi && _trayAi !== 'stored') {
      // Deploy 237.221 (Mike: "when the little AI X button is clicked ... it pops down the
      // AI review information"). It looked like a button and did nothing: the review sat
      // two clicks away (open the tray, then "expand"). The chip is that shortcut now.
      var _aiChipAttrs = ' role="button" tabindex="0" style="cursor:pointer" ' +
        'onclick="event.stopPropagation();dr_openAi(\'' + escJs(slug) + '\')" ' +
        'onkeydown="if(event.key===\'Enter\'||event.key===\' \'){event.preventDefault();event.stopPropagation();dr_openAi(\'' + escJs(slug) + '\')}"';
      _aiChip = _trayAi === 'approved' ? '<span class="tray-verdict ai-ok"' + _aiChipAttrs + ' title="AI verdict: looks good \u2014 click to see the review">AI \u2713</span>'
              : _trayAi === 'issues'   ? '<span class="tray-verdict ai-bad"' + _aiChipAttrs + ' title="AI verdict: issues found \u2014 click to see the review">AI \u2717</span>'
              : '<span class="tray-verdict ai-unclear"' + _aiChipAttrs + ' title="AI could not fully verify this document \u2014 click to see the review">AI ?</span>';
    }
    // Deploy 237.136 (Mike) -- the chip on the right IS the status now: one dropdown,
    // set by whoever is working the tray. A hidden tray keeps its own chip.
    var _statusHtml;
    if (d.hidden) {
      _statusHtml = '<span class="tray-verdict ' + (d.hiddenConfirmedAt ? 'hidden-ok' : 'hidden-confirm') + '">' +
        (d.hiddenConfirmedAt ? 'Hidden \u00b7 UW confirmed' : 'Hidden \u2014 UW to confirm') + '</span>';
    } else {
      _statusHtml =
        (_openConds > 0 ? '<span class="tray-verdict conditions" title="' + _openConds + ' uncleared condition' + (_openConds === 1 ? '' : 's') + ' \u2014 expand the tray to view or clear">\u2691 ' + _openConds + '</span>' : '') +
        '<select class="tray-status" style="' + _statusCss(_status) + '" onclick="event.stopPropagation()" ' +
          'onchange="dr_setStatus(\'' + escJs(slug) + '\',this.value)" title="Set this document\u2019s status">' +
          // Deploy 237.138 -- Outstanding is the base status, so there is no blank
          // option; a legacy N/A tray keeps N/A selectable until it is moved off.
          // Deploy 237.213 -- Condition Addressed only where there IS a condition.
          _STATUSES.filter(function(st) { return !st.onlyUnderCondition || st.key === _status || _underCondition(slug); })
            .concat(_status === 'na' ? _LEGACY_STATUSES : []).map(function(st) {
            // Deploy 237.140 -- each option carries its own colour.
            return '<option value="' + escAttr(st.key) + '" style="' + _statusCss(st.key) + '"' + (st.key === _status ? ' selected' : '') + '>' + escHtml(st.label) + '</option>';
          }).join('') +
        '</select>';
    }
    var expanded = _expanded[slug] === true;

    // Deploy 236.163 — render EVERY live (non-hidden) doc on the
    // tray, not just the legacy currentDocId. Hidden docs (replaced
    // via the replace flow) pile up under a per-tray "Show N hidden"
    // toggle. Each doc has its own View / Remove / Rename — rename
    // operates on documents[i].filename for multi-doc trays, or on
    // currentFilename for legacy single-doc trays (unchanged path).
    var liveDocsList = _liveDocs(slug);
    var hiddenDocsList = _hiddenDocs(slug);
    var currentHtml = '';
    liveDocsList.forEach(function(ld, idx) {
      var sizeKb = Math.round((ld.size || 0) / 1024);
      currentHtml +=
        '<div class="current-doc">' +
          '<div style="min-width:0;flex:1">' +
            '<div class="doc-name" id="dr-docname_' + escAttr(slug) + '_' + idx + '">' +
              '<span class="doc-name-text">' + escHtml(ld.filename || '(unnamed)') + '</span>' +
              '<button class="dr-rename-btn" title="Rename" onclick="dr_renameDocAt(\'' + escJs(slug) + '\',\'' + escJs(ld.docId) + '\')">&#x270e;</button>' +
            '</div>' +
            '<div class="doc-meta">' + sizeKb + ' KB &middot; uploaded ' + formatDate(ld.uploadedAt) + '</div>' +
          '</div>' +
          '<div class="doc-actions">' +
            '<button class="small-btn" onclick="dr_viewDoc(\'' + escJs(ld.docId) + '\')">View</button>' +
            '<button class="small-btn" onclick="dr_downloadOneDoc(\'' + escJs(ld.docId) + '\',\'' + escJs(ld.filename || ld.docId) + '\')" title="Download this PDF">⬇</button>' +
            '<button class="small-btn danger" onclick="dr_removeDocAt(\'' + escJs(slug) + '\',\'' + escJs(ld.docId) + '\')">Remove</button>' +
          '</div>' +
        '</div>';
    });
    // Deploy 237.226 (Mike: Luna's four bank statements, "it only grabbed one") -- a Retry
    // reads the tray's CURRENT document; the others only ever had the review they got at
    // upload. One button reads every document on the tray, one after another.
    if (liveDocsList.length > 1 && !d.hidden && !d.noReview) {
      currentHtml +=
        '<div class="dr-review-all">' +
          '<button class="small-btn" onclick="dr_reviewAllDocs(\'' + escJs(slug) + '\',this)" title="Run the AI against every document on this tray, one after another">\u21bb Review all ' + liveDocsList.length + ' documents</button>' +
          '<span class="doc-meta">each document is read for its own values</span>' +
        '</div>';
    }
    if (hiddenDocsList.length) {
      currentHtml += '<details class="dr-hidden-docs"><summary>Show ' + hiddenDocsList.length + ' hidden document' + (hiddenDocsList.length === 1 ? '' : 's') + '</summary>';
      hiddenDocsList.forEach(function(hd) {
        var sizeKb = Math.round((hd.size || 0) / 1024);
        currentHtml +=
          '<div class="current-doc is-hidden-doc">' +
            '<div style="min-width:0;flex:1">' +
              '<div class="doc-name"><span class="doc-name-text">' + escHtml(hd.filename || '(unnamed)') + '</span><span style="font-size:10px;color:#7a7488;font-weight:500;margin-left:6px">(hidden)</span></div>' +
              '<div class="doc-meta">' + sizeKb + ' KB &middot; uploaded ' + formatDate(hd.uploadedAt) + '</div>' +
            '</div>' +
            '<div class="doc-actions">' +
              '<button class="small-btn" onclick="dr_viewDoc(\'' + escJs(hd.docId) + '\')">View</button>' +
              '<button class="small-btn" onclick="dr_unhideDoc(\'' + escJs(slug) + '\',\'' + escJs(hd.docId) + '\')" title="Unhide this document">↩ Unhide</button>' +
            '</div>' +
          '</div>';
      });
      currentHtml += '</details>';
    }

    // Deploy 236.689 — per-document AI: a tray with multiple live docs shows one
    // AI block PER document (each with its own verdict + Retry), so e.g. two
    // people's IDs both get reviewed. A single-doc tray keeps the one block.
    var aiHtml;
    if (liveDocsList.length > 1) {
      aiHtml = liveDocsList.map(function(ld) {
        var src = _docAiSrc(d, ld);
        return '<div class="ai-doc-label" style="font-size:11px;font-weight:700;color:#7a7488;text-transform:uppercase;letter-spacing:.03em;margin:14px 0 3px">📄 ' + escHtml(ld.filename || 'Document') + '</div>' +
               renderAiBlock(src, slug, ld.docId);
      }).join('');
    } else {
      aiHtml = renderAiBlock(d, slug, (d.currentDocId || ''));
    }
    // Deploy 237.071 (item 5) -- on Ready for UW the AI review folds up so the
    // underwriter clicks through trays quickly; the summary line carries the verdict.
    // Deploy 237.150 -- keyed to the TAB now that Underwriting lists every tray,
    // so the underwriter gets the same compact row for all of them.
    if (_activeTab === 'uw' && aiHtml && hasDoc && !d.hidden) {
      var _aiSum = _trayAi === 'approved' ? '\u2713 AI: looks good' : _trayAi === 'issues' ? '\u26a0 AI: issues found' : _trayAi === 'needs_manual_review' ? '\u26a0 AI: needs manual review' : 'AI review';
      aiHtml = '<details class="dr-ai-collapse" id="dr-ai_' + escAttr(slug) + '"' + (_aiOpenTray[slug] ? ' open' : '') + '><summary>' + escHtml(_aiSum) + ' — expand</summary>' + aiHtml + '</details>';
    }

    var dz =
      '<label class="dropzone" id="dr-dz_' + escAttr(slug) + '" ondragover="dr_dzOver(event,\'' + escJs(slug) + '\')" ondragleave="dr_dzLeave(event,\'' + escJs(slug) + '\')" ondrop="dr_dzDrop(event,\'' + escJs(slug) + '\')">' +
        '<div class="dz-icon">📄</div>' +
        // Deploy 237.011 (Mike) — say "Add document": a new upload is kept in
        // ADDITION to the current one by default (the Add/Replace modal defaults
        // to Add). "Replace" made it sound like the old doc was discarded.
        '<div class="dz-text">' + (d.currentDocId ? 'Add document' : 'Drop a PDF here') + '</div>' +
        '<div class="dz-hint">' + (d.currentDocId ? 'Adds alongside the current doc (or choose to replace)' : 'or click to choose a file') + '</div>' +
        // Deploy 236.166 — accept images alongside PDFs. Drivers
        // licenses, voided checks, IDs commonly come in as JPEG /
        // PNG / HEIC; the AI helper now routes them through the
        // image block. The file picker still hides everything else
        // by default but the LO can switch to "All files" if
        // needed.
        '<input type="file" accept="application/pdf,.pdf,image/jpeg,image/png,image/gif,image/webp,image/heic" onchange="dr_dzPick(event,\'' + escJs(slug) + '\')" />' +
      '</label>';

    // Deploy 237.066 (Mike) — processor notes are a per-document NOTE LOG now
    // (a mini version of the loan's Notes & Activity): each save is its own
    // dated, authored entry; entries can be edited or deleted; the legacy
    // single processorNotes string shows as the first entry and is kept in
    // sync (derived) so history snapshots and older readers still see text.
    var notes = _renderDocNotes(d, slug);

    // Deploy 236.561 — per-document underwriting Conditions, below the processor
    // notes. Stored on _review.docs[slug].conditions[] (patched like notes). The
    // underwriter adds; the processor/closer clears (status outstanding→received
    // →cleared). Audited (createdBy/clearedBy).
    var conds = _renderDocConditions(d, slug);

    // Deploy 237.072 (item 3) -- what the underwriter should be checking, up top.
    var verifyHtml = (_activeTab === 'uw' && hasDoc && !d.hidden) ? _renderVerifyPanel(slug, d, meta) : ''; // Deploy 237.150
    // Deploy 237.136 (Mike) -- the stage buttons (Approve / N-A / UW Approve /
    // Conditions Pending / Send back) are gone: the status dropdown in the header is
    // the one control. What is left are the actions that are not a status.
    var verdictBtns = '';
    if (d.hidden) {
      if (!d.hiddenConfirmedAt) verdictBtns += '<button class="v-btn approve" onclick="dr_confirmHidden(\'' + escJs(slug) + '\')">\u2713 Confirm hidden</button>';
      verdictBtns += '<button class="v-btn unapprove" onclick="dr_toggleHideTray(\'' + escJs(slug) + '\', false)" title="Unhide this tray">\u21a9 Unhide</button>';
    } else {
      verdictBtns += '<button class="v-btn unapprove" onclick="dr_toggleHideTray(\'' + escJs(slug) + '\', true)" title="Hide this tray (not relevant to this loan)">\u2298 Hide tray</button>';
    }
    // Deploy 236.675 -- move this tray's document(s) into a different category so they
    // are reviewed against that category's checklist.
    if (hasDoc) {
      verdictBtns +=
        '<button class="v-btn unapprove" onclick="dr_openMoveModal(\'' + escJs(slug) + '\')" title="Move this document to a different category so it is reviewed against that category&#39;s checklist">\u21c4 Move to\u2026</button>';
    }

    var naBlock = verdict === 'na' && d.naReason
      ? '<div style="margin-top:10px;padding:10px 14px;background:var(--dr-blue-light);border:1px solid var(--dr-blue-border);border-radius:6px;font-size:12px;color:var(--dr-blue);"><strong>N/A:</strong> ' + escHtml(d.naReason) + '</div>'
      : '';

    // Deploy 237.071 (item 6) -- who hid this tray and why, for the underwriter to confirm.
    var hiddenBlock = d.hidden
      ? '<div style="margin-top:10px;padding:10px 14px;background:rgba(122,116,136,0.10);border:1px solid rgba(122,116,136,0.35);border-radius:6px;font-size:12px;color:#4a4458">' +
          '<strong>Hidden</strong> by ' + escHtml(d.hiddenBy || 'unknown') + (d.hiddenAt ? ' on ' + escHtml(formatDate(d.hiddenAt)) : '') +
          (d.hiddenReason ? ': ' + escHtml(d.hiddenReason) : ' (no reason recorded)') +
          (d.hiddenConfirmedAt ? '<br><span style="color:var(--dr-green)">\u2713 Confirmed by ' + escHtml(d.hiddenConfirmedBy || '') + ' on ' + escHtml(formatDate(d.hiddenConfirmedAt)) + '</span>' : '') +
        '</div>'
      : '';
    var historyHtml = '';
    if (Array.isArray(d.history) && d.history.length) {
      historyHtml = '<details class="history-accordion"><summary>Prior reviews (' + d.history.length + ')</summary>' +
        d.history.map(function(h) {
          return '<div class="history-row">' +
            '<div class="h-filename">' + escHtml(h.filename || '(unnamed)') + '</div>' +
            '<div class="h-meta">' + formatDate(h.uploadedAt) + ' &middot; verdict: ' + escHtml(h.verdict || 'pending') + '</div>' +
            (h.processorNotes ? '<div class="h-notes">Notes: ' + escHtml(h.processorNotes) + '</div>' : '') +
            '<div style="margin-top:6px;"><button class="small-btn" onclick="dr_viewDoc(\'' + escJs(h.docId) + '\')">View</button></div>' +
          '</div>';
        }).join('') +
      '</details>';
    }

    // Deploy 236.162 — custom trays get a pencil next to the name
    // for inline rename of the TRAY LABEL (separate from the file
    // rename pencil on currentFilename below). Standard checklist
    // trays don't show the pencil — their labels are spec'd.
    var trayNameHtml = '<span class="tray-name-text">' + escHtml(meta.label) + '</span>';
    // Deploy 237.106 — per-guarantor trays say whose they are; a shared per-person
    // tray on a multi-guarantor review (a borrower-portal upload landed there) says
    // it needs filing to a guarantor.
    if (d.guarantorIndex != null) {
      trayNameHtml += ' <span style="font-size:11px;font-weight:600;color:#7a5218;background:rgba(200,129,58,0.12);border:1px solid rgba(200,129,58,0.35);border-radius:10px;padding:1px 8px;vertical-align:middle">' + escHtml((d.guarantorLabel || ('Guarantor ' + (d.guarantorIndex + 1))) + (d.guarantorName ? ' · ' + d.guarantorName : '')) + '</span>';
    } else if (_activeGuarantors().length > 1 && /^(guarantor_id|proof_of_citizenship|credit_report|guarantor_background_check|ofac_personal|guarantor_loe|pfs)$/.test(slug)) { // Deploy 237.160
      trayNameHtml += ' <span style="font-size:11px;font-weight:600;color:#7c1f1f;background:rgba(124,31,31,0.08);border:1px solid rgba(124,31,31,0.3);border-radius:10px;padding:1px 8px;vertical-align:middle" title="Uploaded without a guarantor (borrower portal). Use Move to file it under the right guarantor.">shared — file to a guarantor</span>';
    }
    if (d.isCustom) {
      trayNameHtml +=
        '<button class="dr-tray-rename-btn" title="Rename tray" onclick="event.stopPropagation();dr_renameTrayLabel(\'' + escJs(slug) + '\')">&#x270e;</button>';
      // Deploy 236.920 (Mike) — ask the borrower for this category. Flagged
      // trays show on the borrower's document page with an Upload button.
      trayNameHtml +=
        '<button class="dr-tray-rename-btn" title="' + (d.borrowerRequested ? 'Requested from the borrower — click to stop requesting' : 'Request this document from the borrower') + '" onclick="event.stopPropagation();dr_toggleBorrowerRequest(\'' + escJs(slug) + '\')">' + (d.borrowerRequested ? '&#x1F4E8;' : '&#x2709;') + '</button>';
    }
    // Deploy 236.945 (Mike) — trays that have a borrower form (W-9, PM
    // questionnaire, draw wire info, commitment letter) get a send button:
    // the borrower completes + signs it on a token page and the signed PDF
    // files itself into this tray.
    var _bf = _borrowerFormFor(slug);
    if (_bf && !d.hidden) {
      trayNameHtml +=
        '<button class="dr-tray-rename-btn" title="Send the ' + escAttr(_bf.label) + ' to the borrower to complete and sign" onclick="event.stopPropagation();dr_sendBorrowerForm(\'' + escJs(slug) + '\')">&#x1F4DD;</button>';
    }
    // Deploy 236.165 — expiration badge. Surfaces when the AI
    // extracted a document/expiration date or when per-slug rules
    // computed a stale-by date. Red = past due; amber = within
    // 14 days; gray = future, just informational. Click goes to
    // the tray body so the LO can see the AI's dateNotes.
    var expBadge = _expirationBadge(d);
    // Deploy 236.502 — flag docs the browser auto-compressed to fit the
    // upload limit so the processor verifies legibility vs. the original.
    var compBadge = d.autoCompressed
      ? '<div class="dr-comp-badge" title="This file was too large for direct upload, so it was auto-compressed in the browser. Verify small print is legible against the borrower’s original.">↓ Auto-compressed' + (d.originalSizeBytes ? ' from ' + (d.originalSizeBytes / 1024 / 1024).toFixed(1) + ' MB' : '') + ' — verify legibility</div>'
      : '';
    // Deploy 236.520 — borrower-intake signals: manual-review request wins the
    // slot; otherwise flag borrower-uploaded docs so the processor knows the
    // source. Accepting the tray (verdict → approved) clears it from the
    // borrower's portal list.
    // Deploy 236.920 — the team asked the borrower for this tray.
    var reqBadge = d.borrowerRequested
      ? '<div class="dr-br-badge" title="' + escAttr(d.borrowerHint ? 'Note to borrower: ' + d.borrowerHint : '') + '">&#x1F4E8; Requested from borrower' +
          (d.borrowerRequestedAt ? ' · ' + new Date(d.borrowerRequestedAt).toLocaleDateString() : '') +
          (d.borrowerHint ? ' — “' + escHtml(d.borrowerHint) + '”' : '') + '</div>'
      : '';
    // Deploy 236.945 — where the borrower form stands.
    var _bfs = d.borrowerForm;
    var formBadge = '';
    if (_bfs && _bfs.status === 'sent') {
      formBadge = '<div class="dr-form-badge">&#x1F4DD; Form sent ' + (_bfs.sentAt ? new Date(_bfs.sentAt).toLocaleDateString() : '') + ' to ' + escHtml(_bfs.to || '') + ' — awaiting the borrower' +
        '<span class="dr-form-act" onclick="event.stopPropagation();dr_copyBorrowerFormLink(\'' + escJs(slug) + '\')">Copy link</span>' +
        '<span class="dr-form-act" onclick="event.stopPropagation();dr_voidBorrowerForm(\'' + escJs(slug) + '\')">Cancel</span></div>';
    } else if (_bfs && _bfs.status === 'completed') {
      formBadge = '<div class="dr-form-badge done">&#x1F4DD; Completed and signed by the borrower ' + (_bfs.completedAt ? new Date(_bfs.completedAt).toLocaleDateString() : '') + '</div>';
    }
    // Deploy 237.042 (Mike) — a VOM back from the borrower is Part I only: flag
    // it until a processor has sent it to the landlord / mortgage company.
    var _fu = d.followUp;
    if (_fu && _fu.kind === 'vom_send') {
      var _who = (_fu.creditor && _fu.creditor.name) || 'the landlord / mortgage company';
      if (!_fu.done) {
        formBadge += '<div class="dr-follow-badge" title="' + escAttr([_fu.creditor && _fu.creditor.address, _fu.creditor && _fu.creditor.phone].filter(Boolean).join(' · ')) + '">&#x26A0; Still needs to be sent to ' + escHtml(_who) + ' for Part II' +
          '<span class="dr-form-act" onclick="event.stopPropagation();dr_followUpDone(\'' + escJs(slug) + '\')">Mark as sent</span></div>';
      } else {
        formBadge += '<div class="dr-form-badge done">&#x2709; Sent to ' + escHtml(_who) + (_fu.doneAt ? ' ' + new Date(_fu.doneAt).toLocaleDateString() : '') + (_fu.doneBy ? ' by ' + escHtml(String(_fu.doneBy).split('@')[0]) : '') +
          '<span class="dr-form-act" onclick="event.stopPropagation();dr_followUpDone(\'' + escJs(slug) + '\', true)">Undo</span></div>';
      }
    }
    var mrBadge = d.manualReviewRequested
      ? '<div class="dr-mr-badge" title="' + escAttr(d.manualReviewNote || 'The borrower asked for a manual review of this document.') + '">⚠ Manual review requested by borrower</div>'
      : (d.uploadedByBorrower ? '<div class="dr-br-badge">⬆ Uploaded by borrower</div>' : '');

    return '<div class="tray st-' + escAttr(_status || 'none') + (d.hidden ? ' is-hidden' : '') + '" id="dr-tray_' + escAttr(slug) + '">' +
      '<div class="tray-head" onclick="dr_toggleExpand(\'' + escJs(slug) + '\')">' +
        '<div style="min-width:0;flex:1">' +
          '<div class="tray-name" id="dr-tray-name_' + escAttr(slug) + '">' + trayNameHtml + '</div>' +
          // Deploy 237.136 (Mike: "remove the subtext on each tray so it just says the
          // document name") -- the rubric one-liner moved off the header; it still
          // drives the AI review and shows in the What-to-verify panel.
          expBadge +
          compBadge +
          mrBadge +
          reqBadge +
          formBadge +
        '</div>' +
        _aiChip +
        _statusHtml + // Deploy 237.136
      '</div>' +
      '<div class="tray-body' + (expanded ? '' : ' collapsed') + '">' +
        // Deploy 236.767 (Mike) — BPO reprice flag. Set server-side when the
        // BPO's as-is value lands under the purchase price; shown right on the
        // BPO tray so it's visible in Documents, not just on Loan Details.
        (d.bpoAlert
          ? '<div class="ai-block issues" style="margin-bottom:10px"><div class="ai-head">' +
              '<span class="ai-label issues">⛔ Needs repricing</span></div>' +
              '<div class="ai-summary">' + escHtml(d.bpoAlert) + '</div></div>'
          : '') +
        // Deploy 236.777 (Mike) — felony hard stop on a background check, shown
        // the same way as the BPO alert. Cleared from the Loan Details banner
        // via "Exception granted"; the tray keeps the finding on the record.
        (d.felonyAlert
          ? '<div class="ai-block issues" style="margin-bottom:10px"><div class="ai-head">' +
              '<span class="ai-label issues">⛔ Felony found — hard stop</span></div>' +
              '<div class="ai-summary">' + escHtml(d.felonyAlert) + '</div></div>'
          : '') +
        // Deploy 236.987 (processing team) — Conditions + processor notes
        // LEAD the tray, above the document list: they are the action items,
        // and at the bottom they were off-screen on any tray with docs.
        verifyHtml + // Deploy 237.072
        conds +
        notes +
        currentHtml +
        aiHtml +
        dz +
        naBlock +
        hiddenBlock + // Deploy 237.071
        '<div class="verdict-actions">' + verdictBtns + '</div>' +
        historyHtml +
      '</div>' +
    '</div>';
  }

  // Deploy 236.561 — per-document underwriting Conditions (below processor notes).
  var _noteEditing = null;   // { slug, id } — which note is open in the inline editor
  var _noteDrafts = {};      // slug → unsaved "add a note" text (survives re-renders)
  function _docNoteLog(d) {
    var log = Array.isArray(d.noteLog) ? d.noteLog.slice() : [];
    // Legacy: a tray that only has the old free-text field shows it as the first entry.
    if (!log.length && d.processorNotes && String(d.processorNotes).trim()) {
      log.push({ id: 'legacy', ts: d.aiReviewedAt || d.uploadedAt || '', author: 'Earlier note', authorEmail: '', text: String(d.processorNotes), legacy: true });
    }
    return log;
  }
  function _noteCanEdit(n) {
    var me = String((_user && _user.email) || '').toLowerCase();
    if (!me) return false;
    if (n.legacy || !n.authorEmail) return true;
    return String(n.authorEmail).toLowerCase() === me || !!(global.SLA && global.SLA.isAdmin && global.SLA.isAdmin(_user));
  }
  function _renderDocNotes(d, slug) {
    var log = _docNoteLog(d);
    var rows = log.map(function(n) {
      var editing = _noteEditing && _noteEditing.slug === slug && _noteEditing.id === n.id;
      var when = n.ts ? formatDate(n.ts) : '';
      var head = '<div class="dr-note-head"><span class="dr-note-who">' + escHtml(n.author || n.authorEmail || 'Note') + '</span>' +
        (when ? '<span class="dr-note-when">' + escHtml(when) + '</span>' : '') +
        (n.editedAt ? '<span class="dr-note-when" title="Edited ' + escAttr(formatDate(n.editedAt)) + (n.editedBy ? ' by ' + escAttr(n.editedBy) : '') + '">(edited)</span>' : '') +
        '<span style="flex:1"></span>' +
        (!editing && _noteCanEdit(n)
          ? '<span class="dr-note-act" onclick="dr_noteEdit(\'' + escJs(slug) + '\',\'' + escJs(n.id) + '\')">Edit</span>' +
            '<span class="dr-note-act danger" onclick="dr_noteDelete(\'' + escJs(slug) + '\',\'' + escJs(n.id) + '\')">Delete</span>'
          : '') +
        '</div>';
      var body = editing
        ? '<textarea class="notes-area" id="dr-note-edit_' + escAttr(slug) + '" onkeydown="if((event.ctrlKey||event.metaKey)&&event.key===\'Enter\')dr_noteEditSave(\'' + escJs(slug) + '\',\'' + escJs(n.id) + '\')">' + escHtml(n.text || '') + '</textarea>' +
          '<div class="dr-note-btns"><button class="small-btn" onclick="dr_noteEditSave(\'' + escJs(slug) + '\',\'' + escJs(n.id) + '\')">Save</button>' +
          '<button class="small-btn" onclick="dr_noteEditCancel()">Cancel</button></div>'
        : '<div class="dr-note-text">' + escHtml(n.text || '') + '</div>';
      return '<div class="dr-note' + (editing ? ' editing' : '') + '">' + head + body + '</div>';
    }).join('');
    var draft = _noteDrafts[slug] || '';
    var add = '<div class="dr-note-add">' +
        '<textarea class="notes-area" id="dr-note-new_' + escAttr(slug) + '" placeholder="' + (log.length ? 'Add another note…' : 'Add a note about this document…') + '" oninput="dr_noteDraft(\'' + escJs(slug) + '\',this.value)" onkeydown="if((event.ctrlKey||event.metaKey)&&event.key===\'Enter\')dr_noteAdd(\'' + escJs(slug) + '\')">' + escHtml(draft) + '</textarea>' +
        '<div class="dr-note-btns"><button class="small-btn primary" onclick="dr_noteAdd(\'' + escJs(slug) + '\')">Save note</button><span class="dr-note-hint">Ctrl+Enter saves</span></div>' +
      '</div>';
    return '<div class="dr-notes-wrap">' +
        '<div class="dr-notes-label">' +
          '<span>Processor notes' + (log.length ? ' (' + log.length + ')' : '') + '</span>' +
          '<span class="dr-notes-status" id="dr-notes-status_' + escAttr(slug) + '"></span>' +
        '</div>' +
        (rows ? '<div class="dr-note-list">' + rows + '</div>' : '') +
        add +
      '</div>';
  }

  function _renderDocConditions(d, slug) {
    var conds = Array.isArray(d.conditions) ? d.conditions : [];
    var CS = { outstanding: 'Outstanding', received: 'Received', cleared: 'Cleared' };
    var rows = conds.map(function(c) {
      var cleared = c.status === 'cleared';
      var col = cleared ? '#166534' : (c.status === 'received' ? '#b5712d' : '#7c1f1f');
      var bg  = cleared ? 'rgba(37,105,64,0.10)' : (c.status === 'received' ? 'rgba(200,129,58,0.10)' : 'rgba(124,31,31,0.08)');
      var opts = Object.keys(CS).map(function(s){ return '<option value="' + s + '"' + (s === c.status ? ' selected' : '') + '>' + CS[s] + '</option>'; }).join('');
      var sub = 'prior to ' + (c.priorTo === 'funding' ? 'funding' : 'docs') + (cleared && c.clearedBy ? ' · cleared by ' + escHtml(c.clearedBy) : '');
      return '<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border:1px solid var(--border,#ddd8d0);border-radius:6px;margin-bottom:6px;background:' + (cleared ? 'rgba(37,105,64,0.04)' : '#fff') + '">' +
          '<div style="flex:1;min-width:0;font-size:12px' + (cleared ? ';text-decoration:line-through;opacity:0.7' : '') + '">' + escHtml(c.title || '') +
            '<span style="color:var(--muted);font-size:10px"> · ' + escHtml(sub) + '</span></div>' +
          '<select onchange="dr_condStatus(\'' + escJs(slug) + '\',\'' + escJs(c.id) + '\',this.value)" style="font-size:11px;padding:3px 6px;border-radius:5px;border:1px solid transparent;color:' + col + ';background:' + bg + ';font-weight:600;font-family:inherit">' + opts + '</select>' +
          '<button title="Remove condition" onclick="dr_condRemove(\'' + escJs(slug) + '\',\'' + escJs(c.id) + '\')" style="border:none;background:transparent;color:var(--muted);cursor:pointer;font-size:12px">✕</button>' +
        '</div>';
    }).join('');
    var openN = conds.filter(function(c){ return c.status !== 'cleared'; }).length;
    return '<div class="dr-conds-wrap" style="margin-top:12px">' +
        '<div style="font-size:11px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:6px">Conditions' + (conds.length ? ' (' + openN + ' open)' : '') + '</div>' +
        rows +
        '<div style="display:flex;gap:6px;margin-top:4px;flex-wrap:wrap">' +
          '<input id="dr-cond-input_' + escAttr(slug) + '" type="text" placeholder="Add a condition for this document…" onkeydown="if(event.key===\'Enter\')dr_addCond(\'' + escJs(slug) + '\')" style="flex:1;min-width:160px;font-size:12px;padding:6px 9px;border:1px solid var(--border,#ddd8d0);border-radius:6px;font-family:inherit" />' +
          // Deploy 237.138 -- a PTF Condition tray adds Prior to Funding items by default.
          '<select id="dr-cond-prior_' + escAttr(slug) + '" style="font-size:12px;padding:6px 8px;border:1px solid var(--border,#ddd8d0);border-radius:6px;font-family:inherit">' +
            '<option value="docs"' + (_statusOf(slug) === 'ptf_condition' ? '' : ' selected') + '>Prior to Docs</option>' +
            '<option value="funding"' + (_statusOf(slug) === 'ptf_condition' ? ' selected' : '') + '>Prior to Funding</option></select>' +
          '<button onclick="dr_addCond(\'' + escJs(slug) + '\')" style="font-size:12px;font-weight:600;padding:6px 12px;background:#261a36;color:#fff;border:none;border-radius:6px;cursor:pointer;font-family:inherit">+ Add</button>' +
        '</div>' +
      '</div>';
  }

  // Deploy 236.689 — resolve the AI-bearing object for one live doc: its own
  // per-doc fields if reviewed, else the tray-level result (which belongs to the
  // current/primary doc), else an empty object (not yet reviewed).
  function _docAiSrc(d, ld) {
    if (ld && (ld.aiVerdict || ld.aiError || ld.aiReviewedAt)) return ld;
    if (ld && d && ld.docId === d.currentDocId) return d;
    return ld || {};
  }

  // Deploy 236.689 — renders ONE document's AI result. `src` carries the AI
  // fields (either the tray docState for a single-doc tray, or a per-document
  // entry for a multi-doc tray); `docId` (when set) targets the per-doc retry so
  // each document in a tray gets its own review + Retry.
  function renderAiBlock(src, slug, docId) {
    src = src || {};
    var _retryArgs = "'" + escAttr(slug) + "', this" + (docId ? ", '" + escAttr(docId) + "'" : '');
    // Deploy 236.752 — storage-only trays (Executed Closing Documents) are a
    // record-keeping vault: no AI review, no verdict, no retry — a neutral note.
    // Deploy 236.766 — ONLY once a document is actually filed. It used to render
    // on an EMPTY tray too, which read as "saved" when nothing had uploaded (an
    // LO hit this when a large closing package was rejected by the size limit).
    if ((DOC_META[slug] && DOC_META[slug].noReview) || src.noReview || src.aiVerdict === 'stored') {
      var _hasDoc = !!(docId || src.currentDocId ||
        (Array.isArray(src.documents) && src.documents.some(function(x){ return x && !x.hidden; })));
      if (!_hasDoc) return '';
      return '<div class="ai-block"><div class="ai-head">' +
        '<span class="ai-label" style="color:var(--muted)">📁 Filed for record-keeping — not AI reviewed.</span>' +
      '</div></div>';
    }
    // Deploy 236.754 — a long doc was handed off to the 15-min background reviewer:
    // keep a spinner until it writes the verdict (the page polls for it).
    // Deploy 236.778 — the "no docId" guard made this spinner DEAD CODE:
    // renderAiBlock is ALWAYS called with a docId once the tray holds a document
    // (see the single-doc call ~line 1230), so a doc under background review fell
    // through to the "Not yet reviewed" branch below — that was the flicker LOs
    // saw between the upload spinner and the verdict. Consult the TRAY's flag too,
    // since the per-document entry doesn't always carry it.
    var _trayState = (_review && _review.docs && _review.docs[slug]) || {};
    var _reviewingNow = !!(src.aiReviewing ||
      (_trayState.aiReviewing && (!docId || docId === _trayState.currentDocId)));
    if (_reviewingNow) {
      return '<div class="ai-block pending">' +
        '<div class="ai-head"><span class="ai-label pending"><span class="ai-spinner"></span> AI is reviewing this large document…</span></div>' +
        '<div class="ai-summary">This document is long, so the review is running in the background — the verdict will appear here automatically (usually under a minute). Advisory only.</div>' +
      '</div>';
    }
    // The "AI is reviewing…" spinner for the in-flight upload. Deploy 236.778 —
    // same dead-guard flaw: on a RE-upload the tray already has a currentDocId, so
    // this never fired either. Match the tray's current doc instead.
    // Deploy 237.105 -- waiting its turn behind the current upload.
    var _qPos = -1;
    for (var _qi = 0; _qi < _uploadQueue.length; _qi++) { if (_uploadQueue[_qi].slug === slug) { _qPos = _qi; break; } }
    if (_qPos >= 0 && _uploadingSlug !== slug) {
      return '<div class="ai-block pending"><div class="ai-head"><span class="ai-label pending">\u23f3 Queued \u2014 uploads run one at a time (position ' + (_qPos + 1) + ')</span></div></div>';
    }
    if (_uploadingSlug === slug && (!docId || docId === _trayState.currentDocId)) {
      // Deploy 236.839 — live IN-TRAY upload status (Mike: the compressing/
      // uploading toasts in the corner were easy to miss). doUpload's
      // onStatus callback updates #dr-upstatus directly through the phases
      // (compressing → part i of N → assembling → AI review).
      return '<div class="ai-block pending">' +
        '<div class="ai-head">' +
          '<span class="ai-label pending"><span class="ai-spinner"></span> <span id="dr-upstatus">' + escHtml(_uploadStatusMsg || 'Uploading…') + '</span></span>' +
        '</div>' +
        '<div class="ai-summary">Keep this page open until the upload finishes — navigating away cancels it (the browser will warn you). Progress updates right here.</div>' +
      '</div>';
    }
    if (!src.aiVerdict) {
      if (src.aiError) {
        return '<div class="ai-block issues">' +
          '<div class="ai-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
            '<span class="ai-label issues">⚠ AI review failed</span>' +
            '<button class="small-btn" onclick="dr_retryAi(' + _retryArgs + ')" title="Re-run the AI against this document">↻ Retry AI Review</button>' +
          '</div>' +
          '<div class="ai-summary">' + escHtml(src.aiNotes || 'No details.') + '</div>' +
        '</div>';
      }
      // Nothing reviewed yet for this doc — offer a Review button when it's a
      // per-doc block (so a not-yet-reviewed 2nd doc can be reviewed on demand).
      if (docId) {
        return '<div class="ai-block pending">' +
          '<div class="ai-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
            '<span class="ai-label pending">Not yet reviewed</span>' +
            '<button class="small-btn" onclick="dr_retryAi(' + _retryArgs + ')" title="Run the AI against this document">↻ Review this doc</button>' +
          '</div>' +
        '</div>';
      }
      return '';
    }
    // 'needs_manual_review' renders YELLOW ("pending"), approved GREEN, else RED.
    var cls, icon;
    if (src.aiVerdict === 'approved') { cls = 'approved'; icon = '✓ AI verdict: looks good'; }
    else if (src.aiVerdict === 'needs_manual_review') { cls = 'pending'; icon = '⚠ Needs manual review'; }
    else { cls = 'issues'; icon = '⚠ AI verdict: issues found'; }
    var findingsHtml = '';
    if (Array.isArray(src.aiFindings) && src.aiFindings.length) {
      findingsHtml = '<div class="ai-findings">' + src.aiFindings.map(function(f) {
        var st = f.status === 'met' ? 'met' : (f.status === 'not_met' ? 'not_met' : 'unclear');
        var ico = st === 'met' ? '✓' : (st === 'not_met' ? '✗' : '?');
        return '<div class="ai-finding ' + st + '">' +
          '<span class="f-icon">' + ico + '</span>' +
          '<div class="f-text">' +
            '<div class="f-cond">' + escHtml(f.condition || '') + '</div>' +
            (f.detail ? '<div class="f-detail">' + escHtml(f.detail) + '</div>' : '') +
          '</div>' +
        '</div>';
      }).join('') + '</div>';
    }
    // Deploy 237.070 (Mike) -- compact by default: the verdict + the per-condition
    // checks only; the AI's summary and per-finding detail sit behind "Details"
    // (remembered per doc for the page session) so a tray reads in one glance.
    var _dkey = slug + '|' + (docId || '');
    // Deploy 237.221 -- opened from the chip means opened all the way: the findings,
    // not a second "Details" click away.
    var _compact = !(_aiDetailsOpen[_dkey] || _aiOpenTray[slug]);
    var _hasDetails = !!(src.aiNotes || (Array.isArray(src.aiFindings) && src.aiFindings.some(function(f) { return f && f.detail; })));
    return '<div class="ai-block ' + cls + (_compact ? ' compact' : '') + '" data-dkey="' + escAttr(_dkey) + '">' +
      '<div class="ai-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        '<span class="ai-label ' + cls + '">' + icon + '</span>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          (src.aiReviewedAt ? '<span class="ai-cost">' + formatDate(src.aiReviewedAt) + '</span>' : '') +
          (_hasDetails ? '<button class="small-btn" onclick="dr_toggleAiDetails(this)" title="Show the AI\'s summary and the detail behind each check">' + (_compact ? 'Details \u25b8' : 'Hide details \u25be') + '</button>' : '') +
          '<button class="small-btn" onclick="dr_retryAi(' + _retryArgs + ')" title="Re-run the AI against this document">↻ Retry</button>' +
        '</div>' +
      '</div>' +
      (src.aiNotes ? '<div class="ai-summary">' + escHtml(src.aiNotes) + '</div>' : '') +
      findingsHtml +
      _integrityHtml(src) +
    '</div>';
  }

  // Deploy 236.669 — document-integrity / tampering-risk badge (advisory). Shown
  // for financial docs + IDs when the upload endpoint attached d.integrity. High/
  // medium call for a look; low reassures the processor the check ran.
  function _integrityHtml(d) {
    var it = d && d.integrity;
    if (!it || !it.risk) return '';
    var all = Array.isArray(it.signals) ? it.signals : [];
    var flags = all.filter(function(s){ return s && s.level !== 'info'; });
    var infos = all.filter(function(s){ return s && s.level === 'info'; });
    var cls, label;
    if (it.risk === 'high')   { cls = 'di-high'; label = '⚠ Integrity: HIGH — possible tampering'; }
    else if (it.risk === 'medium') { cls = 'di-med'; label = '⚠ Integrity: review recommended'; }
    else { cls = 'di-low'; label = '✓ Integrity: no structural red flags'; }
    var sigHtml = flags.length
      ? '<ul class="di-sigs">' + flags.map(function(s){ return '<li class="di-lvl-' + (s.level || 'medium') + '">' + escHtml(s.label || '') + '</li>'; }).join('') + '</ul>'
      : '';
    var infoHtml = infos.length
      ? '<div class="di-info">' + infos.map(function(s){ return escHtml(s.label || ''); }).join(' · ') + '</div>'
      : '';
    return '<div class="di-block ' + cls + '">' +
      '<div class="di-head">' + label + '</div>' +
      sigHtml + infoHtml +
      '<div class="di-note">Advisory only — a human makes the final call. Based on file metadata + AI consistency checks; not a definitive forgery test.</div>' +
    '</div>';
  }

  // ── Actions exposed via dr_* globals (inline onclick handlers) ───
  global.dr_toggleExpand = function(slug) {
    _expanded[slug] = !(_expanded[slug] === true);
    render();
  };
  global.dr_switchTab = function(tab) { _activeTab = tab; render(); };
  global.dr_expandAll = function(open) {
    var docs = _review && _review.docs ? Object.keys(_review.docs) : [];
    if (open) docs.forEach(function(s) { _expanded[s] = true; });
    else _expanded = {};
    render();
  };
  global.dr_toggleSourcePanel = function() { _sourceOpen = !_sourceOpen; render(); };
  global.dr_onDocSearch = function(value) { _docSearch = String(value || ''); render(); };

  global.dr_dzOver = function(e, slug) { e.preventDefault(); var el = document.getElementById('dr-dz_' + slug); if (el) el.classList.add('dragover'); };
  global.dr_dzLeave = function(e, slug) { var el = document.getElementById('dr-dz_' + slug); if (el) el.classList.remove('dragover'); };
  global.dr_dzDrop = function(e, slug) {
    e.preventDefault();
    var el = document.getElementById('dr-dz_' + slug); if (el) el.classList.remove('dragover');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) doUpload(slug, f);
  };
  global.dr_dzPick = function(e, slug) {
    var f = e.target.files && e.target.files[0];
    if (f) doUpload(slug, f);
  };

  // Deploy 237.105 (Jessy) -- start the next queued upload once the current one settles.
  function _startNextUpload() {
    if (_uploadingSlug || !_uploadQueue.length) return;
    var next = _uploadQueue.shift();
    setTimeout(function() { doUpload(next.slug, next.file, next.opts); }, 50);
  }
  function doUpload(slug, file, opts) {
    opts = opts || {};
    // Deploy 236.163 — when the tray already has 1+ LIVE (non-hidden)
    // docs and the caller didn't pre-decide the mode, pop the
    // "Replace or Add?" modal first. The modal captures the choice
    // (replace which docs vs. add alongside) and re-fires doUpload
    // with opts.mode + opts.replaceDocIds set.
    if (!opts.mode) {
      var live = _liveDocs(slug);
      if (live.length >= 1) {
        _openReplaceOrAddModal(slug, file, live);
        return;
      }
    }

    // Deploy 237.105 (Jessy: "starting a second upload cancels the one in progress")
    // -- ONE upload at a time per page. A second pick used to overwrite the in-flight
    // state (the first looked cancelled; server-side the two saves clobbered each
    // other -- fixed there too). Extra picks wait their turn; each review then reuses
    // the loan's cached context instead of all missing the cache at the same instant.
    if (_uploadingSlug) {
      _uploadQueue.push({ slug: slug, file: file, opts: opts });
      _expanded[slug] = true;
      showToast('Queued: ' + (file.name || 'file') + ' uploads when the current one finishes.', 'info');
      render();
      return;
    }
    _uploadingSlug = slug;
    _expanded[slug] = true;
    // Deploy 236.839 — the tray shows a LIVE status line through every phase
    // (compress / chunk i of N / assemble / AI). onStatus updates the DOM
    // element directly so progress paints without a full re-render.
    _uploadStatusMsg = (file.size || 0) > 4.2 * 1024 * 1024
      ? 'Preparing large file (' + ((file.size || 0) / 1024 / 1024).toFixed(1) + ' MB)…'
      : 'Uploading ' + (file.name || 'file') + '…';
    render();
    showToast(_uploadStatusMsg, 'info');
    // Deploy 236.839 — leaving the page kills an in-flight upload (the browser
    // aborts the requests), so warn before navigation while one is running.
    _armDocUploadGuard();
    var uploadOpts = {};
    if (opts.mode)           uploadOpts.mode = opts.mode;
    if (opts.replaceDocIds)  uploadOpts.replaceDocIds = opts.replaceDocIds;
    uploadOpts.onStatus = function(m) {
      _uploadStatusMsg = m;
      var el = document.getElementById('dr-upstatus');
      if (el) el.textContent = m;
    };
    global.SLA.LoanReviews.uploadDoc(_review.id, slug, file, uploadOpts).then(function(r) {
      _review = r.review;
      _uploadingSlug = null;
      _uploadStatusMsg = '';
      _disarmDocUploadGuard();
      _startNextUpload(); // Deploy 237.105
      var dd = r.review.docs[slug] || {};
      // Deploy 236.502 — surface that the stored copy was auto-compressed
      // so the processor knows to verify legibility against the original.
      if (dd.autoCompressed) {
        var wasMb = dd.originalSizeBytes ? (dd.originalSizeBytes / 1024 / 1024).toFixed(1) : '';
        var nowMb = dd.currentSize ? (dd.currentSize / 1024 / 1024).toFixed(1) : '';
        showToast('Uploaded — auto-compressed' + (wasMb ? ' from ' + wasMb + ' MB to ' + nowMb + ' MB' : '') + ' to fit. Please verify legibility.', 'info');
      } else if (dd.aiReviewing) {
        showToast('Uploaded — this document is long, so AI review is running in the background. The verdict will appear here shortly.', 'info');
      } else {
        var verdict = dd.aiVerdict || '';
        if (verdict === 'approved')      showToast('Uploaded — AI says looks good.', 'success');
        else if (verdict === 'issues')   showToast('Uploaded — AI flagged issues. Review below.', 'info');
        else                             showToast('Uploaded.', 'success');
      }
      render();
      if (dd.aiReviewing) _pollBackgroundReview(slug);
    }).catch(function(err) {
      _uploadingSlug = null;
      _uploadStatusMsg = '';
      _disarmDocUploadGuard();
      _startNextUpload(); // Deploy 237.105
      showToast('Upload failed: ' + (err.message || 'Unknown'), 'error');
      render();
    });
  }

  // Deploy 236.839 — beforeunload guard for single-doc uploads (the bulk-zip
  // flow has had its own since 236.211). The browser cannot keep sending file
  // bytes after the page unloads, so the honest fix is a warning prompt while
  // an upload is in flight.
  function _docUploadBeforeUnload(e) {
    e.preventDefault();
    e.returnValue = 'A document upload is still in progress — leaving will cancel it.';
    return e.returnValue;
  }
  var _docUploadGuardArmed = false;
  function _armDocUploadGuard() {
    if (_docUploadGuardArmed) return;
    _docUploadGuardArmed = true;
    global.addEventListener('beforeunload', _docUploadBeforeUnload);
  }
  function _disarmDocUploadGuard() {
    if (!_docUploadGuardArmed) return;
    _docUploadGuardArmed = false;
    global.removeEventListener('beforeunload', _docUploadBeforeUnload);
  }

  // Deploy 236.754 — poll for a background AI review (long docs handed off by the
  // upload) until the tray's aiReviewing flag clears, then re-render + toast the
  // verdict. Bounded so a stuck review stops spinning after ~3 min.
  var _pollTimers = {};
  function _pollBackgroundReview(slug) {
    if (_pollTimers[slug]) return; // already polling this tray
    var tries = 0, MAX = 36; // 36 × 5s = 3 min
    _pollTimers[slug] = setInterval(function() {
      tries++;
      global.SLA.LoanReviews.get(_review.id).then(function(r) {
        if (!r || !r.review) return;
        _review = r.review;
        var dd = (_review.docs && _review.docs[slug]) || {};
        if (!dd.aiReviewing || tries >= MAX) {
          clearInterval(_pollTimers[slug]); delete _pollTimers[slug];
          render();
          if (!dd.aiReviewing) {
            var v = dd.aiVerdict || '';
            if (v === 'approved')                 showToast('Background review done — AI says looks good.', 'success');
            else if (v === 'issues')              showToast('Background review done — AI flagged issues. Review below.', 'info');
            else if (v === 'needs_manual_review') showToast('Background review done — manual review required.', 'info');
            else                                  showToast('Background review finished.', 'success');
          } else {
            showToast('The background review is taking longer than expected — refresh the page shortly to see the result.', 'info');
          }
        }
        // Deploy 236.762 — no per-tick render() while still reviewing: the
        // full innerHTML rebuild every 5s destroyed processor typing +
        // focus (notes save on blur). The spinner is static anyway; we
        // only re-render on completion above.
      }).catch(function() { /* transient network — keep polling */ });
    }, 5000);
  }

  // Deploy 236.762 — resume polling after a page reload: the poll was only
  // started from the upload callback, so reloading mid-background-review
  // left a spinner that never resolved (despite promising "the verdict
  // will appear here automatically"). Called from render().
  function _resumeBackgroundPolls() {
    var docs = (_review && _review.docs) || {};
    Object.keys(docs).forEach(function(slug) {
      if (docs[slug] && docs[slug].aiReviewing) _pollBackgroundReview(slug);
    });
  }

  // Deploy 236.163 — list the LIVE (visible) docs on a tray. Handles
  // both the legacy single-doc shape (currentDocId only) and the new
  // documents[] array; legacy docs are synthesized into a single-
  // entry list on the fly.
  function _liveDocs(slug) {
    var d = _review.docs[slug] || {};
    if (Array.isArray(d.documents) && d.documents.length) {
      return d.documents.filter(function(x) { return x && !x.hidden; });
    }
    if (d.currentDocId) {
      return [{
        docId:      d.currentDocId,
        filename:   d.currentFilename || '',
        size:       d.currentSize || 0,
        mimeType:   d.currentMimeType || 'application/pdf',
        uploadedAt: d.currentUploadedAt || '',
        hidden:     false,
      }];
    }
    return [];
  }
  function _hiddenDocs(slug) {
    var d = _review.docs[slug] || {};
    if (Array.isArray(d.documents) && d.documents.length) {
      return d.documents.filter(function(x) { return x && x.hidden; });
    }
    return [];
  }

  // Deploy 236.165 — expiration badge for the tray head. Renders
  // when the AI extracted a documentDate / expirationDate (or when
  // the per-slug stale rule applied) on upload. Severity colors:
  //   red    = past due (current date >= stale-by / expiration)
  //   amber  = within 14 days (warning window)
  //   gray   = future, informational
  function _expirationBadge(d) {
    var due = d && (d.expirationDate || d.staleByDate);
    if (!due || !/^\d{4}-\d{2}-\d{2}$/.test(due)) return '';
    var label = d.expirationDate ? 'Expires' : 'Stale after';
    var today = new Date();
    var todayUTC = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    var parts = due.split('-');
    var dueUTC = Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
    var deltaDays = Math.round((dueUTC - todayUTC) / 86400000);
    var cls = deltaDays < 0 ? 'expired' : deltaDays <= 14 ? 'expiring-soon' : 'expiring-future';
    var text = deltaDays < 0
      ? 'EXPIRED ' + due + ' (' + Math.abs(deltaDays) + 'd ago)'
      : (label + ' ' + due + ' (in ' + deltaDays + 'd)');
    var titleAttr = d.dateNotes ? ' title="' + escAttr(d.dateNotes) + '"' : '';
    return '<div class="dr-exp-badge ' + cls + '"' + titleAttr + '>📅 ' + escHtml(text) + '</div>';
  }

  // Deploy 236.163 — multi-doc-aware variants. Rename / remove
  // now operate on a specific docId in documents[]. Backward-compat
  // shims for the old single-doc helpers stay below.
  global.dr_renameDocAt = function(slug, docId) {
    var live = _liveDocs(slug);
    var target = live.find(function(x) { return x.docId === docId; });
    if (!target) return;
    var next = prompt('New filename for this document:', target.filename || '');
    if (next == null) return;
    next = String(next).trim();
    if (!next) { showToast('Filename can\'t be empty.', 'error'); return; }
    if (next === (target.filename || '')) return;
    // Patch: write new documents[] with the renamed entry.
    var docState = _review.docs[slug] || {};
    var docs = (docState.documents || []).map(function(d) {
      if (!d) return d;
      if (d.docId !== docId) return d;
      return Object.assign({}, d, { filename: next, nameManual: true }); // Deploy 237.133 -- a hand-typed name is never auto-renamed
    });
    var patch = { docs: {} };
    patch.docs[slug] = { documents: docs };
    // Keep legacy currentFilename in sync when this is documents[0].
    if (docState.currentDocId === docId) patch.docs[slug].currentFilename = next;
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Renamed.', 'success');
      render();
    }).catch(function(err) {
      showToast('Rename failed: ' + (err.message || 'Unknown'), 'error');
    });
  };
  global.dr_removeDocAt = function(slug, docId) {
    if (!confirm('Remove this document from the tray? (Deletes the file from storage.)')) return;
    global.SLA.LoanReviews.deleteDoc(_review.id, slug, docId).then(function(r) {
      _review = r.review;
      // Deploy 237.130 -- the endpoint strips documents[] and promotes the next
      // live document itself (the old page-side promotion compared against a
      // currentDocId the server had already blanked, so it never ran).
      render();
      showToast('Removed.', 'success');
    }).catch(function(err) {
      showToast('Failed to remove: ' + (err.message || 'Unknown'), 'error');
    });
  };
  // Deploy 236.166 — re-run Claude vision against the tray's
  // current doc. Surfaces when the AI errored (per renderAiBlock
  // branch above) AND on every successful AI block as a "fresh
  // take" button. Updates the AI fields + the 236.165 date
  // badges on success.
  // Deploy 236.689 — optional docId reviews a SPECIFIC document in the tray.
  global.dr_retryAi = function(slug, btn, docId) {
    if (!_review || !_review.id) return;
    var originalHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Reviewing…'; }
    global.SLA.LoanReviews.retryAi(_review.id, slug, docId).then(function(r) {
      _review = r.review || _review;
      // Report the reviewed doc's verdict (per-doc when a docId was given).
      var ds = _review.docs[slug] || {};
      // Deploy 236.768 — a long doc is handed to the 15-min background reviewer
      // instead of timing out; keep the spinner up and poll for the verdict.
      if (ds.aiReviewing) {
        showToast('This document is long — the review is running in the background. The verdict will appear here shortly.', 'info');
        render();
        _pollBackgroundReview(slug);
        return;
      }
      var v = '';
      if (docId && Array.isArray(ds.documents)) {
        var de = ds.documents.find(function(x){ return x && x.docId === docId; });
        v = (de && de.aiVerdict) || '';
      } else { v = ds.aiVerdict || ''; }
      if (v === 'approved')                 showToast('Re-reviewed — AI says looks good.', 'success');
      else if (v === 'issues')              showToast('Re-reviewed — AI flagged issues. See below.', 'info');
      else if (v === 'needs_manual_review') showToast('Re-reviewed — manual review required.', 'info');
      else                                  showToast('Re-reviewed.', 'success');
      render();
    }).catch(function(err) {
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
      showToast('Retry failed: ' + ((err && err.message) || 'unknown'), 'error');
    });
  };

  // Deploy 237.226 (Mike) -- review every live document on a tray, in turn. Each one
  // takes the same path as its own Retry (a long one is handed to the background reviewer);
  // the button counts up; when the last returns, anything still in the background is polled
  // per DOCUMENT, because the tray-level flag only ever tracks the current one.
  global.dr_reviewAllDocs = function(slug, btn) {
    if (!_review || !_review.id) return;
    var ids = _liveDocs(slug).map(function(ld) { return ld.docId; });
    if (ids.length < 2) return;
    var originalHTML = btn ? btn.innerHTML : '';
    var i = 0, background = 0, failed = 0;
    function step() {
      if (i >= ids.length) return done();
      if (btn) { btn.disabled = true; btn.innerHTML = 'Reviewing ' + (i + 1) + ' of ' + ids.length + '\u2026'; }
      var id = ids[i++];
      global.SLA.LoanReviews.retryAi(_review.id, slug, id).then(function(r) {
        _review = (r && r.review) || _review;
        if (r && r.aiReviewing) background++;
        step();
      }).catch(function(err) {
        failed++;
        showToast('Document ' + i + ' of ' + ids.length + ' could not be reviewed: ' + ((err && err.message) || 'unknown'), 'error');
        step();
      });
    }
    function done() {
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
      render();
      if (background) {
        showToast((ids.length - failed - background) + ' reviewed; ' + background + ' long document' + (background === 1 ? ' is' : 's are') + ' finishing in the background.', 'info');
        _pollDocsReviewing(slug);
      } else if (!failed) {
        showToast('All ' + ids.length + ' documents reviewed.', 'success');
      }
    }
    step();
  };
  function _docsStillReviewing(dd) {
    if (!dd) return false;
    if (dd.aiReviewing) return true;
    return (Array.isArray(dd.documents) ? dd.documents : []).some(function(e) { return e && !e.hidden && e.aiReviewing; });
  }
  function _pollDocsReviewing(slug) {
    if (_pollTimers['docs:' + slug]) return;
    var tries = 0, MAX = 60; // 60 × 5s = 5 min: several long documents can queue behind each other
    _pollTimers['docs:' + slug] = setInterval(function() {
      tries++;
      global.SLA.LoanReviews.get(_review.id).then(function(r) {
        if (!r || !r.review) return;
        _review = r.review;
        var dd = (_review.docs && _review.docs[slug]) || {};
        if (!_docsStillReviewing(dd) || tries >= MAX) {
          clearInterval(_pollTimers['docs:' + slug]); delete _pollTimers['docs:' + slug];
          render();
          showToast(_docsStillReviewing(dd) ? 'The background reviews are taking longer than expected \u2014 refresh the page shortly.' : 'Background reviews done.', _docsStillReviewing(dd) ? 'info' : 'success');
        }
      }).catch(function() { /* transient network — keep polling */ });
    }, 5000);
  }

  // Deploy 236.690 — switch the active Collateral property tab (portfolio loans).
  global.dr_setCollateralProperty = function(i) {
    _activeCollateralProperty = i || 0;
    render();
  };
  // Deploy 237.106 — switch the active Guarantor tab (2+ guarantors).
  global.dr_setGuarantor = function(i) {
    _activeGuarantor = i || 0;
    render();
  };

  global.dr_unhideDoc = function(slug, docId) {
    var docState = _review.docs[slug] || {};
    var docs = (docState.documents || []).map(function(d) {
      if (!d || d.docId !== docId) return d;
      return Object.assign({}, d, { hidden: false });
    });
    var patch = { docs: {} };
    patch.docs[slug] = { documents: docs };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Unhidden.', 'success');
      render();
    }).catch(function(err) { showToast('Unhide failed: ' + (err.message || 'Unknown'), 'error'); });
  };
  global.dr_downloadOneDoc = function(docId, filename) {
    if (!_review || !_review.id) return;
    // Deploy 236.530 — token via SLA.getToken() (Supabase + Netlify). The old
    // netlifyIdentity.currentUser() gate wrongly showed "Not signed in" to
    // Supabase-logged-in processors.
    var _tok = (global.SLA && global.SLA.getToken) ? global.SLA.getToken() : Promise.resolve('');
    _tok.then(function(token) {
      if (!token) { showToast('Not signed in.', 'error'); return; }
      return fetch('/api/loan-review-doc-get?reviewId=' + encodeURIComponent(_review.id) +
                   '&docId=' + encodeURIComponent(docId), {
        headers: { 'Authorization': 'Bearer ' + token },
      });
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob().then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename || 'document.pdf';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
      });
    }).catch(function(err) {
      showToast('Download failed: ' + ((err && err.message) || 'unknown'), 'error');
    });
  };

  global.dr_removeDoc = function(slug, docId) {
    if (!confirm('Remove this uploaded document?')) return;
    global.SLA.LoanReviews.deleteDoc(_review.id, slug, docId).then(function(r) {
      _review = r.review;
      showToast('Removed.', 'success');
      render();
    }).catch(function(err) {
      showToast('Failed to remove: ' + (err.message || 'Unknown'), 'error');
    });
  };

  global.dr_viewDoc = function(docId) {
    _openDocViewer(docId); // Deploy 237.070 -- in-page viewer (was a new tab)
  };
  // ── Deploy 237.070 (Mike) — in-page document viewer ──────────────────
  // "View" used to fetch the bytes and pop a NEW TAB (popup blockers, tab
  // sprawl, losing the review). Now it opens a full-height overlay with the
  // PDF (iframe) or image inline; "Open in new tab" and Esc/click-outside are
  // there for the odd file the browser can't render inline.
  var _viewerUrl = null, _viewerDocId = null;
  function _docFilename(docId) {
    var docs = (_review && _review.docs) || {};
    var slugs = Object.keys(docs);
    for (var i = 0; i < slugs.length; i++) {
      var d = docs[slugs[i]] || {};
      var list = Array.isArray(d.documents) ? d.documents : [];
      for (var j = 0; j < list.length; j++) { if (list[j] && list[j].docId === docId) return list[j].filename || d.currentFilename || ''; }
      if (d.currentDocId === docId) return d.currentFilename || '';
      var hist = Array.isArray(d.history) ? d.history : [];
      for (var k = 0; k < hist.length; k++) { if (hist[k] && hist[k].docId === docId) return hist[k].filename || ''; }
    }
    return '';
  }
  function _ensureViewer() {
    var v = document.getElementById('dr-viewer');
    if (v) return v;
    v = document.createElement('div');
    v.id = 'dr-viewer';
    v.style.cssText = 'display:none;position:fixed;inset:0;z-index:10000;background:rgba(20,14,26,0.72);align-items:center;justify-content:center;padding:18px;box-sizing:border-box';
    v.innerHTML =
      '<div style="background:#fff;border-radius:12px;width:min(1200px,100%);height:100%;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 50px rgba(0,0,0,0.35)">' +
        '<div style="display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid #e6e0d6">' +
          '<strong id="dr-viewer-title" style="flex:1;font-size:13px;color:#1a1520;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">Document</strong>' +
          '<button class="small-btn" onclick="dr_viewerNewTab()">Open in new tab</button>' +
          '<button class="small-btn" onclick="dr_closeDocViewer()">\u2715 Close</button>' +
        '</div>' +
        '<div id="dr-viewer-body" style="flex:1;min-height:0;background:#2b2530;display:flex;align-items:center;justify-content:center"></div>' +
      '</div>';
    v.addEventListener('click', function(e) { if (e.target === v) global.dr_closeDocViewer(); });
    document.addEventListener('keydown', function(e) { if (e.key === 'Escape' && v.style.display !== 'none') global.dr_closeDocViewer(); });
    document.body.appendChild(v);
    return v;
  }
  function _openDocViewer(docId) {
    var v = _ensureViewer();
    var body = document.getElementById('dr-viewer-body');
    var title = document.getElementById('dr-viewer-title');
    if (title) title.textContent = _docFilename(docId) || 'Document';
    if (body) body.innerHTML = '<div style="color:#fff;font-size:13px"><span class="ai-spinner"></span> Loading\u2026</div>';
    v.style.display = 'flex';
    if (_viewerUrl) { try { URL.revokeObjectURL(_viewerUrl); } catch (_) {} _viewerUrl = null; }
    _viewerDocId = docId;
    var url = global.SLA.LoanReviews.docUrl(_review.id, docId);
    global.SLA.getToken().then(function(token) {
      return fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
    }).then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function(blob) {
      if (_viewerDocId !== docId) return; // another doc was opened meanwhile
      _viewerUrl = URL.createObjectURL(blob);
      var isImg = /^image\//.test(blob.type || '');
      if (!body) return;
      body.innerHTML = isImg
        ? '<img src="' + _viewerUrl + '" alt="" style="max-width:100%;max-height:100%;object-fit:contain">'
        : '<iframe src="' + _viewerUrl + '" title="Document" style="width:100%;height:100%;border:0;background:#fff"></iframe>';
    }).catch(function(err) {
      if (body) body.innerHTML = '<div style="color:#fff;font-size:13px;padding:20px;text-align:center">Could not load this document (' + escHtml((err && err.message) || 'unknown') + ').<br>' +
        '<button class="small-btn" style="margin-top:10px" onclick="dr_viewerNewTab()">Try opening in a new tab</button></div>';
    });
  }
  global.dr_closeDocViewer = function() {
    var v = document.getElementById('dr-viewer');
    if (!v) return;
    v.style.display = 'none';
    var body = document.getElementById('dr-viewer-body');
    if (body) body.innerHTML = '';
    if (_viewerUrl) { try { URL.revokeObjectURL(_viewerUrl); } catch (_) {} _viewerUrl = null; }
    _viewerDocId = null;
  };
  global.dr_viewerNewTab = function() {
    if (_viewerUrl) { window.open(_viewerUrl, '_blank'); return; }
    if (_viewerDocId) {
      global.SLA.LoanReviews.viewDoc(_review.id, _viewerDocId).catch(function(err) {
        showToast('Could not open doc: ' + (err.message || 'Unknown'), 'error');
      });
    }
  };
  // Deploy 237.221 (Mike) -- the AI chip on a tray header. Opens the tray AND the AI
  // review inside it (on Underwriting the review is folded into a <details>); a second
  // click folds the review away again and leaves the tray open.
  global.dr_openAi = function(slug) {
    var wasOpen = _expanded[slug] === true && _aiOpenTray[slug] === true;
    _aiOpenTray[slug] = !wasOpen;
    _expanded[slug] = true;
    render();
    if (wasOpen) return;
    try {
      var el = document.getElementById('dr-ai_' + slug) || document.getElementById('dr-tray_' + slug);
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (_) {}
  };
  // Deploy 237.070 -- "Details" toggle on the compact AI block (per doc, page session).
  global.dr_toggleAiDetails = function(btn) {
    var block = btn && btn.closest ? btn.closest('.ai-block') : null;
    if (!block) return;
    var key = block.getAttribute('data-dkey') || '';
    var opening = block.classList.contains('compact');
    block.classList.toggle('compact', !opening);
    _aiDetailsOpen[key] = opening;
    btn.textContent = opening ? 'Hide details \u25be' : 'Details \u25b8';
  };


  // Deploy 236.161 — hide / unhide a tray on the review record.
  // Patches docs[slug].hidden = true|false; render() filters
  // hidden trays out of the main flow and into a per-section
  // collapsible.
  global.dr_toggleHideTray = function(slug, hide) {
    if (hide) { global.dr_openHideModal(slug); return; } // Deploy 237.071 (item 6) -- a reason is required
    var patch = { docs: {} };
    patch.docs[slug] = { hidden: false, hiddenConfirmedBy: '', hiddenConfirmedAt: '' };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Tray unhidden.', 'success');
      render();
    }).catch(function(err) {
      showToast('Unhide failed: ' + (err.message || 'Unknown'), 'error');
    });
  };
  // ── Deploy 237.071 (Mike, UW phase 2) — underwriter + hide-with-reason actions ───
  // Deploy 237.136 -- dr_uwSet (UW Approve / Conditions Pending / Back to UW)
  // retired with the stage tabs; dr_setStatus is the one writer now.
  // Deploy 237.136 -- dr_bulkUwApprove retired with the Ready-for-UW tab;
  // dr_bulkApprove now sets the one status straight to Approved.
  global.dr_confirmHidden = function(slug) {
    var patch = { docs: {} };
    patch.docs[slug] = { hiddenConfirmedBy: (_user && _user.email) || '', hiddenConfirmedAt: new Date().toISOString() };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Hide confirmed.', 'success');
      render();
    }).catch(function(err) { showToast('Save failed: ' + (err.message || 'Unknown'), 'error'); });
  };
  global.dr_openHideModal = function(slug) {
    _pendingHide = slug;
    var ta = document.getElementById('dr-hideReason');
    if (ta) ta.value = '';
    document.getElementById('dr-hideModal').classList.add('show');
  };
  global.dr_closeHideModal = function() {
    _pendingHide = null;
    document.getElementById('dr-hideModal').classList.remove('show');
  };
  global.dr_confirmHide = function() {
    var reason = (document.getElementById('dr-hideReason').value || '').trim();
    if (!reason) { showToast('Say why this tray is being hidden.', 'error'); return; }
    var slug = _pendingHide;
    if (!slug) return;
    var patch = { docs: {} };
    patch.docs[slug] = { hidden: true, hiddenBy: (_user && _user.email) || '', hiddenAt: new Date().toISOString(), hiddenReason: reason, hiddenConfirmedBy: '', hiddenConfirmedAt: '' };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      global.dr_closeHideModal();
      showToast('Tray hidden — the underwriter will confirm.', 'success');
      render();
    }).catch(function(err) { showToast('Hide failed: ' + (err.message || 'Unknown'), 'error'); });
  };
  global.dr_toggleHiddenInSection = function(sectionKey) {
    _showHidden[sectionKey] = !_showHidden[sectionKey];
    render();
  };

  // Deploy 236.164 — bulk "Approve all pending" in a section.
  // Walks the docs in this section, finds the ones with a doc
  // uploaded but still pending, and patches them all to
  // approved in a single round-trip. AI verdicts of "issues"
  // are SKIPPED — those need a manual override-reason via the
  // existing override modal, which we don't want to bypass
  // silently.
  global.dr_bulkApprove = function(sectionKey) {
    // Deploy 237.138 -- the sweep matches the tab (see renderSections): Processor
    // Approved from the Processor tab, Underwriter Approved from Underwriting.
    var toUw = (_activeTab === 'uw');
    var docs = _review.docs || {};
    var targets = [];
    var aiIssuesSkipped = 0;
    var manualReviewSkipped = 0;   // Deploy 236.590 — no-rubric / manual-review docs
    Object.keys(docs).forEach(function(s) {
      var dd = docs[s] || {};
      if (dd.hidden) return;
      if (_secOf(s) !== sectionKey) return;
      if ((DOC_META[s] && DOC_META[s].noReview) || dd.noReview) return;
      var st = _statusOf(s);
      if (toUw) { if (st === 'processor_approved') targets.push(s); return; }
      if (st !== 'received' || !_trayHasDoc(dd)) return;
      if (dd.aiVerdict === 'issues') { aiIssuesSkipped++; return; }
      // Deploy 236.590 — a doc with no rubric (or a non-AI-reviewable file type) was
      // never actually auto-verified, so it must NOT be swept into a green bulk
      // approve. The processor opens it and approves it individually.
      if (dd.aiVerdict === 'needs_manual_review') { manualReviewSkipped++; return; }
      targets.push(s);
    });
    if (!targets.length) {
      showToast((aiIssuesSkipped || manualReviewSkipped)
        ? 'Nothing to bulk-approve. ' + (aiIssuesSkipped + manualReviewSkipped) + ' doc(s) need manual review — open them individually.'
        : 'Nothing to bulk-approve in this section.', 'info');
      return;
    }
    var msg = (toUw ? 'Underwriter-approve ' : 'Processor-approve ') + targets.length + ' document' + (targets.length === 1 ? '' : 's') + ' in this section?';
    if (aiIssuesSkipped) msg += '\n\n(' + aiIssuesSkipped + ' doc(s) with AI-flagged issues will be SKIPPED — open those individually to override.)';
    if (manualReviewSkipped) msg += '\n\n(' + manualReviewSkipped + ' doc(s) need manual review — no rubric — and will be SKIPPED. Open them individually to approve.)';
    if (!confirm(msg)) return;

    var now = new Date().toISOString();
    var actor = (_user && _user.email) || '';
    var patch = { docs: {} };
    targets.forEach(function(s) {
      patch.docs[s] = toUw
        ? { status: 'uw_approved', statusAt: now, statusBy: actor, verdict: 'approved', approvedAt: now, approvedBy: actor, uwVerdict: 'approved', uwApprovedAt: now, uwApprovedBy: actor }
        : { status: 'processor_approved', statusAt: now, statusBy: actor, verdict: 'approved', approvedAt: now, approvedBy: actor, uwVerdict: '', uwApprovedAt: '', uwApprovedBy: '' };
    });
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast((toUw ? 'UW approved ' : 'Approved ') + targets.length + ' document' + (targets.length === 1 ? '' : 's') + '.', 'success');
      render();
    }).catch(function(err) {
      showToast('Bulk approve failed: ' + ((err && err.message) || 'unknown'), 'error');
    });
  };

  // Deploy 236.162 — custom tray flow. Modal capture → patch
  // review.docs[custom_<ts>_<rand>] with label/section/conditions
  // plus the standard doc fields the renderer + upload endpoint
  // expect. The upload endpoint doesn't validate against the
  // checklist — it just checks the slug exists in review.docs —
  // so uploads to custom slugs work without backend changes.
  global.dr_openAddDocModal = function(sectionKey, sectionLabel, guarantorIndex) {
    // Deploy 237.110 -- a guarantor's "+ Add" passes only the index (names never ride
    // inside inline JS); the label is derived here and the new tray is filed under them.
    if (guarantorIndex != null && Array.isArray(_review.guarantors) && _review.guarantors[guarantorIndex]) {
      var _g = _review.guarantors[guarantorIndex];
      sectionLabel = (_g.label || ('Guarantor ' + (guarantorIndex + 1))) + (_g.name ? ' \u2014 ' + _g.name : '');
    }
    _pendingAddDoc = { sectionKey: sectionKey, sectionLabel: sectionLabel, guarantorIndex: (guarantorIndex == null ? null : guarantorIndex) };
    var lbl = document.getElementById('dr-addDocSection');
    if (lbl) lbl.textContent = sectionLabel;
    var inp = document.getElementById('dr-addDocName');
    if (inp) inp.value = '';
    var modal = document.getElementById('dr-addDocModal');
    if (modal) modal.classList.add('show');
    setTimeout(function() { if (inp) inp.focus(); }, 50);
  };
  global.dr_closeAddDocModal = function() {
    _pendingAddDoc = null;
    var modal = document.getElementById('dr-addDocModal');
    if (modal) modal.classList.remove('show');
  };
  // Deploy 236.501 — the blank custom-doc shape, shared by the manual
  // Add-Other flow and the bulk-zip "Other" route so both mint identical
  // trays the renderer + upload endpoint understand.
  function _blankCustomDoc(slug, name, section) {
    return {
      slug:             slug,
      isCustom:         true,
      label:            name,
      section:          section,
      conditions:       'This document was added and needs to be manually reviewed.',
      required:         false,
      verdict:          'pending',
      processorNotes:   '',
      naReason:         '',
      currentDocId:     '',
      currentFilename:  '',
      currentSize:      0,
      currentUploadedAt:'',
      currentMimeType:  '',
      aiVerdict:        '',
      aiNotes:          '',
      aiFindings:       [],
      aiExtractedEntities: {},
      aiReviewedAt:     '',
      aiError:          '',
      processorOverrideReason: '',
      approvedAt:       '',
      approvedBy:       '',
      history:          [],
    };
  }
  // Deploy 236.501 — create an "Other" tray in a section and return its
  // slug. Patches the review (merges into review.docs) then updates the
  // in-memory copy so a follow-up upload can target the new slug.
  function _createOtherTray(sectionKey, name) {
    var slug = 'other_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var patch = { docs: {} };
    patch.docs[slug] = _blankCustomDoc(slug, name, sectionKey);
    return global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      return slug;
    });
  }

  global.dr_confirmAddDoc = function() {
    if (!_pendingAddDoc) return;
    var inp = document.getElementById('dr-addDocName');
    var name = (inp && inp.value || '').trim();
    if (!name) { showToast('Enter a document name.', 'error'); return; }
    var section = _pendingAddDoc.sectionKey;
    var slug = 'custom_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    var patch = { docs: {} };
    patch.docs[slug] = _blankCustomDoc(slug, name, section);
    if (_pendingAddDoc.guarantorIndex != null) patch.docs[slug].guarantorIndex = _pendingAddDoc.guarantorIndex; // Deploy 237.110
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      global.dr_closeAddDocModal();
      showToast('Added "' + name + '".', 'success');
      // Auto-expand the new tray so the LO sees the dropzone.
      _expanded[slug] = true;
      render();
    }).catch(function(err) {
      showToast('Add failed: ' + (err.message || 'Unknown'), 'error');
    });
  };

  // Deploy 236.675 — move a document into a different category. Populates the
  // destination <select> with every OTHER (non-hidden) tray on the review,
  // standard categories first, then custom/"Other" trays.
  var _pendingMove = null;
  global.dr_openMoveModal = function(fromSlug) {
    if (!_review || !_review.docs || !_review.docs[fromSlug]) return;
    _pendingMove = fromSlug;
    var fromMeta = DOC_META[fromSlug] || _review.docs[fromSlug] || {};
    var fromLbl = document.getElementById('dr-moveFromLabel');
    if (fromLbl) fromLbl.textContent = (fromMeta.label || fromSlug);

    // Destinations: EVERY standard category (from DOC_META, grouped by section) so
    // a mis-bucketed doc can be filed anywhere — even a category not on this loan's
    // own checklist (the backend creates it with the right rubric). Plus the
    // review's existing custom/"Other" trays. Excludes the source + hidden trays.
    // Deploy 237.150 -- the checklist still files these under 'loan'; the picker
    // shows them where the page does.
    // Deploy 237.228 (Dan) -- Post Close is a section now; without it here its
    // trays would have no optgroup and quietly disappear as move destinations.
    var SEC_LABELS = { loan: 'Application & Terms', borrower: 'Borrower', guarantor: 'Guarantor', collateral: 'Collateral', closing: 'Closing', post_close: 'Post Close' };
    var SEC_ORDER = ['loan', 'borrower', 'guarantor', 'collateral', 'closing', 'post_close'];
    var stdBySec = {}, cust = [];
    // Standard categories from the client checklist mirror.
    Object.keys(DOC_META).forEach(function(s) {
      if (s === fromSlug) return;
      if (RETIRED_SLUGS[s]) return; // Deploy 237.228 -- retired: not a destination
      var onReview = _review.docs[s];
      if (onReview && onReview.hidden) return;         // hidden on this review — skip
      var m = DOC_META[s];
      var sec = (m && m.section) || 'loan';
      (stdBySec[sec] = stdBySec[sec] || []).push({ slug: s, label: (m && m.label) || s });
    });
    // Existing custom trays on the review (not in DOC_META).
    Object.keys(_review.docs).forEach(function(s) {
      if (s === fromSlug || DOC_META[s]) return;
      var dd = _review.docs[s] || {};
      if (dd.hidden) return;
      // Deploy 237.106 — tagged trays (per-guarantor "__g<i>", per-property "__p<i>")
      // are real destinations too, labelled with whose / which they are.
      if (dd.guarantorIndex != null || dd.propertyIndex != null) {
        var tag = dd.guarantorIndex != null ? ((dd.guarantorLabel || ('Guarantor ' + (dd.guarantorIndex + 1))) + (dd.guarantorName ? ' · ' + dd.guarantorName : ''))
                                            : ((dd.propertyLabel || ('Property ' + (dd.propertyIndex + 1))) + (dd.propertyAddress ? ' · ' + dd.propertyAddress : ''));
        var secKey = dd.section || (dd.guarantorIndex != null ? 'guarantor' : 'collateral');
        (stdBySec[secKey] = stdBySec[secKey] || []).push({ slug: s, label: (dd.label || s) + ' — ' + tag });
        return;
      }
      if (!_isOtherSlug(s)) return;
      cust.push({ slug: s, label: dd.label || s });
    });
    Object.keys(stdBySec).forEach(function(k) { stdBySec[k].sort(function(a, b) { return a.label.localeCompare(b.label); }); });
    cust.sort(function(a, b) { return a.label.localeCompare(b.label); });

    var sel = document.getElementById('dr-moveTarget');
    if (sel) {
      var html = '';
      var anyStd = SEC_ORDER.some(function(k) { return (stdBySec[k] || []).length; });
      if (!anyStd && !cust.length) {
        html = '<option value="">No other categories available</option>';
      } else {
        SEC_ORDER.forEach(function(k) {
          var list = stdBySec[k] || [];
          if (!list.length) return;
          html += '<optgroup label="' + escAttr(SEC_LABELS[k] || k) + '">';
          list.forEach(function(o) { html += '<option value="' + escAttr(o.slug) + '">' + escHtml(o.label) + '</option>'; });
          html += '</optgroup>';
        });
        if (cust.length) {
          html += '<optgroup label="Custom / Other (on this review)">';
          cust.forEach(function(o) { html += '<option value="' + escAttr(o.slug) + '">' + escHtml(o.label) + '</option>'; });
          html += '</optgroup>';
        }
      }
      sel.innerHTML = html;
    }
    var modal = document.getElementById('dr-moveModal');
    if (modal) modal.classList.add('show');
  };
  global.dr_closeMoveModal = function() {
    _pendingMove = null;
    var modal = document.getElementById('dr-moveModal');
    if (modal) modal.classList.remove('show');
  };
  global.dr_confirmMove = function() {
    if (!_pendingMove || !_review || !_review.id) return;
    var sel = document.getElementById('dr-moveTarget');
    var toSlug = sel && sel.value;
    if (!toSlug) { showToast('Pick a destination category.', 'error'); return; }
    var fromSlug = _pendingMove;
    var toLabel = (DOC_META[toSlug] && DOC_META[toSlug].label)
      || (_review.docs[toSlug] && _review.docs[toSlug].label) || toSlug;
    global.dr_closeMoveModal();
    showToast('Moving to "' + toLabel + '" — reviewing…', 'info');
    global.SLA.LoanReviews.moveDoc(_review.id, fromSlug, toSlug).then(function(r) {
      _review = r.review || _review;
      _expanded[toSlug] = true;          // expand the destination so the result is visible
      render();
      // Re-review the moved doc against the destination's rubric.
      return global.SLA.LoanReviews.retryAi(_review.id, toSlug);
    }).then(function(r2) {
      _review = (r2 && r2.review) || _review;
      var v = (_review.docs[toSlug] && _review.docs[toSlug].aiVerdict) || '';
      if (v === 'approved')                 showToast('Moved to "' + toLabel + '" — AI says looks good.', 'success');
      else if (v === 'issues')              showToast('Moved to "' + toLabel + '" — AI flagged issues. See below.', 'info');
      else if (v === 'needs_manual_review') showToast('Moved to "' + toLabel + '" — manual review required.', 'info');
      else                                  showToast('Moved to "' + toLabel + '".', 'success');
      render();
    }).catch(function(err) {
      showToast('Move failed: ' + ((err && err.message) || 'unknown'), 'error');
      render();
    });
  };

  // Deploy 236.162 — inline rename of a CUSTOM TRAY's label.
  // Distinct from dr_renameDoc which renames the uploaded file's
  // currentFilename. The tray's display name (meta.label) lives
  // on docs[slug].label for custom trays; this swaps it inline
  // and patches via SLA.LoanReviews.patch.
  // Deploy 236.920 (Mike: "add an additional tray and request it from the
  // borrower") — flag a custom tray as requested. It then shows on the
  // borrower's document page with an Upload button; optionally email them.
  // Deploy 236.945 (Mike) — borrower forms: which trays have one, the send
  // modal, copy-link and cancel. Server side: borrower-form-send.mjs.
  var BORROWER_FORMS = {
    closing_w9: 'Form W-9',
    property_mgmt_questionnaire: 'Property Management Questionnaire',
    vom: 'Verification of Mortgage / Rent', // Deploy 237.039
    draw_wire_form: 'Construction Draw Wire Information Form',
    commitment_letter: 'Loan Commitment Letter',
  };
  function _borrowerFormFor(slug) {
    var base = String(slug || '').replace(/__[pg]\d+$/, ''); // 237.106: __g<i> too
    return BORROWER_FORMS[base] ? { label: BORROWER_FORMS[base] } : null;
  }
  function _drModal(title, bodyHtml, submitLabel, onSubmit) {
    // Deploy 236.949 — one panel at a time (a double-click stacked two).
    Array.prototype.forEach.call(document.querySelectorAll('.dr-modal-wrap'), function(w) { w.remove(); });
    var wrap = document.createElement('div');
    wrap.className = 'dr-modal-wrap';
    wrap.innerHTML = '<div class="dr-modal"><h3>' + escHtml(title) + '</h3>' + bodyHtml +
      '<div class="dr-modal-btns"><button type="button" class="dr-modal-cancel">Cancel</button>' +
      '<button type="button" class="primary dr-modal-ok">' + escHtml(submitLabel) + '</button></div></div>';
    document.body.appendChild(wrap);
    wrap.querySelector('.dr-modal-cancel').onclick = function() { wrap.remove(); };
    wrap.addEventListener('click', function(e) { if (e.target === wrap) wrap.remove(); });
    var ok = wrap.querySelector('.dr-modal-ok');
    ok.onclick = function() { onSubmit(wrap, ok); };
    return wrap;
  }
  global.dr_sendBorrowerForm = function(slug) {
    var bf = _borrowerFormFor(slug);
    if (!bf || !_review) return;
    var d = (_review.docs && _review.docs[slug]) || {};
    global.SLA.api('POST', '/api/borrower-form-send', { reviewId: _review.id, slug: slug, prepare: true }).then(function(p) {
      var body = '<div style="font-size:12.5px;color:var(--muted);margin-bottom:6px">The borrower gets an email with a private link, completes the form online, and types their name to sign. The signed PDF lands in this tray.</div>';
      if (d.borrowerForm && d.borrowerForm.status === 'sent') body += '<div style="font-size:12px;color:var(--gold-mid);margin-bottom:6px">A request is already out (sent ' + escHtml(new Date(d.borrowerForm.sentAt).toLocaleDateString()) + '). Sending again replaces it.</div>';
      body += '<label>Send to</label><input type="email" id="bfm-email" value="' + escAttr((p.recipient && p.recipient.email) || '') + '" placeholder="borrower@example.com" />';
      (p.staffFields || []).forEach(function(f) {
        body += '<label>' + escHtml(f.label) + (f.required ? ' *' : '') + '</label><input type="' + (f.type === 'date' ? 'date' : 'text') + '" id="bfm-sf-' + escAttr(f.key) + '" value="' + escAttr(f.value == null ? '' : f.value) + '" />';
      });
      body += '<label>Note to the borrower (optional)</label><textarea id="bfm-note" rows="2" placeholder="Anything they should know"></textarea>';
      // Deploy 236.948 (Mike) — see the document before it goes out.
      body += '<div style="margin-top:12px;display:flex;align-items:center;gap:10px"><button type="button" id="bfm-preview-btn">Preview the document</button>' +
        '<span id="bfm-preview-note" style="font-size:11.5px;color:var(--muted)">Exactly what the borrower will see, with your entries filled in and their fields blank.</span></div>' +
        '<div id="bfm-preview" style="display:none;margin-top:10px"><iframe id="bfm-preview-frame" title="Preview" style="width:100%;height:62vh;border:1px solid var(--border,#E4DFD4);border-radius:6px;background:#fff"></iframe></div>';
      var wrapRef = _drModal('Send ' + bf.label + ' to the borrower', body, 'Send', function(wrap, btn) {
        var email = String((document.getElementById('bfm-email') || {}).value || '').trim();
        if (email.indexOf('@') < 1) { showToast('Enter the borrower\'s email address', 'error'); return; }
        var staffValues = {};
        (p.staffFields || []).forEach(function(f) { staffValues[f.key] = String((document.getElementById('bfm-sf-' + f.key) || {}).value || '').trim(); });
        btn.disabled = true; btn.textContent = 'Sending…';
        global.SLA.api('POST', '/api/borrower-form-send', {
          reviewId: _review.id, slug: slug, email: email, note: String((document.getElementById('bfm-note') || {}).value || ''), staffValues: staffValues,
        }).then(function(r) {
          wrap.remove();
          if (r && r.review) _review = r.review;
          showToast(bf.label + (r && r.emailed ? ' sent to ' + email + '.' : ' created — the email did NOT go out; use Copy link.'), (r && r.emailed) ? 'success' : 'error');
          render();
        }).catch(function(err) {
          btn.disabled = false; btn.textContent = 'Send';
          var msg = (err && err.message) || 'Unknown';
          if (err && err.data && err.data.errors) msg += ' (' + Object.keys(err.data.errors).join(', ') + ')';
          showToast('Send failed: ' + msg, 'error');
        });
      });
      var pv = wrapRef.querySelector('#bfm-preview-btn');
      if (pv) pv.onclick = function() {
        var staffValues = {};
        (p.staffFields || []).forEach(function(f) { staffValues[f.key] = String((document.getElementById('bfm-sf-' + f.key) || {}).value || '').trim(); });
        pv.disabled = true; pv.textContent = 'Rendering…';
        global.SLA.api('POST', '/api/borrower-form-send', { reviewId: _review.id, slug: slug, preview: true, staffValues: staffValues }).then(function(r) {
          pv.disabled = false; pv.textContent = 'Refresh preview';
          var bin = atob(r.pdfBase64 || ''), arr = new Uint8Array(bin.length);
          for (var i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
          var url = URL.createObjectURL(new Blob([arr], { type: 'application/pdf' }));
          var box = wrapRef.querySelector('#bfm-preview'), frame = wrapRef.querySelector('#bfm-preview-frame');
          frame.src = url + '#toolbar=0&view=FitH';
          box.style.display = '';
          wrapRef.querySelector('.dr-modal').style.maxWidth = '900px';
          wrapRef.querySelector('#bfm-preview-note').textContent = 'Change any entry above and refresh to see it again. The preview is watermarked; the borrower\'s copy is not.';
        }).catch(function(err) { pv.disabled = false; pv.textContent = 'Preview the document'; showToast('Preview failed: ' + ((err && err.message) || 'Unknown'), 'error'); });
      };
    }).catch(function(err) { showToast('Could not prepare the form: ' + ((err && err.message) || 'Unknown'), 'error'); });
  };
  global.dr_copyBorrowerFormLink = function(slug) {
    var d = (_review && _review.docs && _review.docs[slug]) || {};
    var link = d.borrowerForm && d.borrowerForm.link;
    if (!link) { showToast('No open request on this tray', 'error'); return; }
    var done = function() { showToast('Link copied — send it to the borrower any way you like.', 'success'); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, function() { prompt('Copy this link:', link); });
    else prompt('Copy this link:', link);
  };
  global.dr_voidBorrowerForm = function(slug) {
    var bf = _borrowerFormFor(slug);
    if (!bf || !_review || !confirm('Cancel the ' + bf.label + ' request? The borrower\'s link will stop working.')) return;
    global.SLA.api('POST', '/api/borrower-form-send', { reviewId: _review.id, slug: slug, void: true }).then(function(r) {
      if (r && r.review) _review = r.review;
      showToast('Request cancelled.', 'success');
      render();
    }).catch(function(err) { showToast('Cancel failed: ' + ((err && err.message) || 'Unknown'), 'error'); });
  };
  // Deploy 237.042 — VOM follow-up: mark the Part II send-out done (or undo).
  global.dr_followUpDone = function(slug, reopen) {
    var body = { reviewId: _review.id, slug: slug, followUpDone: !reopen };
    if (!reopen) {
      var note = window.prompt('Mark the VOM as sent to the landlord / mortgage company?\n\nOptional note (how it was sent, confirmation #):', '');
      if (note === null) return;
      if (note) body.note = note;
    }
    global.SLA.api('POST', '/api/borrower-form-send', body).then(function(r) {
      if (r && r.review) _review = r.review;
      showToast(reopen ? 'Reopened — still needs to be sent.' : 'Marked as sent.', 'success');
      render();
      try { if (global.SLANav && global.SLANav.refreshTaskBadge) global.SLANav.refreshTaskBadge(); } catch (_) {}
    }).catch(function(err) { showToast('Update failed: ' + ((err && err.message) || 'Unknown'), 'error'); });
  };
  global.dr_toggleBorrowerRequest = function(slug) {
    var d = (_review && _review.docs && _review.docs[slug]) || {};
    var name = d.label || slug;
    var requested = !d.borrowerRequested;
    var hint = '', notify = false;
    if (requested) {
      hint = prompt('Request "' + name + '" from the borrower.\n\nOptional note they will see (what it is, why you need it):', d.borrowerHint || '');
      if (hint === null) return;
      notify = confirm('Email the borrower about this now?\n\nOK = send the email\nCancel = just add it to their document list');
    } else if (!confirm('Stop requesting "' + name + '" from the borrower? It will drop off their document page.')) {
      return;
    }
    global.SLA.api('POST', '/api/loan-review-request-borrower', {
      reviewId: _review.id, slug: slug, requested: requested, hint: hint, notify: notify,
    }).then(function(r) {
      if (r && r.review) _review = r.review;
      var msg = requested
        ? ('Requested from the borrower' + (notify ? (r && r.emailed ? ' — email sent.' : ' — email NOT sent' + (r && r.emailReason ? ' (' + r.emailReason + ')' : '') + '.') : '.'))
        : 'No longer requested from the borrower.';
      showToast(msg, (requested && notify && !(r && r.emailed)) ? 'error' : 'success');
      render();
    }).catch(function(err) {
      showToast('Request failed: ' + (err && err.message || 'Unknown'), 'error');
    });
  };
  global.dr_renameTrayLabel = function(slug) {
    var d = _review.docs[slug] || {};
    var nameEl = document.getElementById('dr-tray-name_' + slug);
    if (!nameEl) return;
    var current = d.label || slug;
    nameEl.innerHTML =
      '<input class="dr-rename-input" type="text" value="' + escAttr(current) + '" onclick="event.stopPropagation()" />' +
      '<button class="small-btn dr-rename-save" onclick="event.stopPropagation();dr_commitTrayRename(\'' + escJs(slug) + '\')">Save</button>' +
      '<button class="small-btn dr-rename-cancel" onclick="event.stopPropagation();dr_cancelTrayRename(\'' + escJs(slug) + '\')">Cancel</button>';
    var input = nameEl.querySelector('.dr-rename-input');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter')  { e.preventDefault(); global.dr_commitTrayRename(slug); }
        if (e.key === 'Escape') { e.preventDefault(); global.dr_cancelTrayRename(slug); }
      });
    }
  };
  global.dr_cancelTrayRename = function(slug) { render(); };
  global.dr_commitTrayRename = function(slug) {
    var nameEl = document.getElementById('dr-tray-name_' + slug);
    if (!nameEl) return;
    var input = nameEl.querySelector('.dr-rename-input');
    var next = (input && input.value || '').trim();
    if (!next) { showToast('Tray name can\'t be empty.', 'error'); return; }
    var d = _review.docs[slug] || {};
    if (next === (d.label || '')) { render(); return; }
    var patch = { docs: {} };
    patch.docs[slug] = { label: next };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Renamed.', 'success');
      render();
    }).catch(function(err) {
      showToast('Rename failed: ' + (err.message || 'Unknown'), 'error');
      render();
    });
  };

  // Deploy 236.163 — Replace-or-Add modal. Built per-open so the
  // list of existing docs reflects current state. When the LO
  // confirms, dr_confirmReplaceOrAdd re-fires doUpload with the
  // captured file + the chosen mode.
  function _openReplaceOrAddModal(slug, file, liveDocs) {
    _pendingUpload = { slug: slug, file: file, liveDocs: liveDocs };
    var body = '';
    body += '<div style="display:flex;gap:12px;margin-bottom:14px">';
    body += '<label style="flex:1;padding:10px 12px;border:1.5px solid #ddd8d0;border-radius:6px;cursor:pointer;font-size:12px"><input type="radio" name="dr-mode" value="add" checked style="margin-right:6px" /><strong>Add alongside</strong><br><span style="color:#7a7488;font-size:11px">Both files stay visible. New one gets a V2 suffix.</span></label>';
    body += '<label style="flex:1;padding:10px 12px;border:1.5px solid #ddd8d0;border-radius:6px;cursor:pointer;font-size:12px"><input type="radio" name="dr-mode" value="replace" style="margin-right:6px" /><strong>Replace</strong><br><span style="color:#7a7488;font-size:11px">Hides the original (stays on record, recoverable).</span></label>';
    body += '</div>';
    if (liveDocs.length > 1) {
      body += '<div id="dr-replaceTargets" style="display:none;padding:10px 12px;background:#faf8f3;border-radius:6px">';
      body += '<div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.04em;color:#7a7488;margin-bottom:8px">Which one(s) to replace?</div>';
      body += '<label style="display:block;padding:6px 0;font-size:12px"><input type="checkbox" id="dr-replaceAll" value="ALL" style="margin-right:6px" />Replace ALL current documents</label>';
      liveDocs.forEach(function(ld) {
        body += '<label style="display:block;padding:6px 0;font-size:12px;border-top:1px dashed #ddd8d0;margin-top:4px"><input type="checkbox" class="dr-replaceItem" value="' + escAttr(ld.docId) + '" style="margin-right:6px" />' + escHtml(ld.filename || ld.docId) + '</label>';
      });
      body += '</div>';
    } else {
      body += '<input type="hidden" id="dr-replaceTargets-single" value="' + escAttr(liveDocs[0].docId) + '" />';
    }
    var bodyEl = document.getElementById('dr-replaceOrAddBody');
    if (bodyEl) bodyEl.innerHTML = body;
    // Wire mode change so the targets list shows/hides.
    var radios = document.querySelectorAll('input[name="dr-mode"]');
    Array.prototype.forEach.call(radios, function(r) {
      r.onchange = function() {
        var t = document.getElementById('dr-replaceTargets');
        if (t) t.style.display = (r.value === 'replace' && r.checked) ? 'block' : 'none';
      };
    });
    // ALL checkbox disables the per-doc ones.
    var allCb = document.getElementById('dr-replaceAll');
    if (allCb) {
      allCb.onchange = function() {
        var items = document.querySelectorAll('.dr-replaceItem');
        Array.prototype.forEach.call(items, function(i) {
          i.disabled = allCb.checked;
          if (allCb.checked) i.checked = false;
        });
      };
    }
    var modal = document.getElementById('dr-replaceOrAddModal');
    if (modal) modal.classList.add('show');
  }
  global.dr_closeReplaceOrAddModal = function() {
    _pendingUpload = null;
    var modal = document.getElementById('dr-replaceOrAddModal');
    if (modal) modal.classList.remove('show');
  };
  global.dr_confirmReplaceOrAdd = function() {
    if (!_pendingUpload) return;
    var modeEl = document.querySelector('input[name="dr-mode"]:checked');
    var mode = modeEl ? modeEl.value : 'add';
    var opts = { mode: mode };
    if (mode === 'replace') {
      var allCb = document.getElementById('dr-replaceAll');
      var singleEl = document.getElementById('dr-replaceTargets-single');
      if (allCb && allCb.checked) {
        opts.replaceDocIds = ['ALL'];
      } else if (singleEl) {
        opts.replaceDocIds = [singleEl.value];
      } else {
        var ids = [];
        Array.prototype.forEach.call(document.querySelectorAll('.dr-replaceItem:checked'), function(i) {
          ids.push(i.value);
        });
        if (!ids.length) { showToast('Pick at least one document to replace, or choose Replace ALL.', 'error'); return; }
        opts.replaceDocIds = ids;
      }
    }
    var p = _pendingUpload;
    _pendingUpload = null;
    var modal = document.getElementById('dr-replaceOrAddModal');
    if (modal) modal.classList.remove('show');
    doUpload(p.slug, p.file, opts);
  };

  // Deploy 236.159 — ZIP every uploaded doc on this review.
  // Authed fetch + blob URL (same pattern as SLA.LoanReviews.viewDoc;
  // plain <a href> would 401 because /api/loan-review-zip-download
  // requires the Netlify Identity JWT). Filename comes from the
  // Content-Disposition header set by the backend.
  // Deploy 237.136 (Mike: "This will help simplify the zip folder feature too so we
  // wont need to select tabs anymore with that") -- with one reviewed tab there is
  // nothing to pick: the button bundles every live document again. The endpoint
  // still accepts ?slugs= / ?prior=1 (237.133) for anything that wants a subset.
  global.dr_downloadZip = function(btn) { _zipFetch('', btn); };
  function _zipFetch(query, btn) {
    if (!_review || !_review.id) return;
    var originalHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Building ZIP…'; }
    // Deploy 236.530 — token via SLA.getToken() (Supabase + Netlify safe).
    var _tok = (global.SLA && global.SLA.getToken) ? global.SLA.getToken() : Promise.resolve('');
    _tok.then(function(token) {
      if (!token) {
        if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
        showToast('Not signed in.', 'error');
        return;
      }
      return fetch('/api/loan-review-zip-download?reviewId=' + encodeURIComponent(_review.id) + (query || ''), {
        headers: { 'Authorization': 'Bearer ' + token },
      });
    }).then(function(r) {
      if (!r.ok) {
        return r.json().catch(function() { return {}; }).then(function(d) {
          throw new Error(d.error || 'Download failed (HTTP ' + r.status + ')');
        });
      }
      return r.blob().then(function(blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        var cd = r.headers.get('Content-Disposition') || '';
        var m = /filename="([^"]+)"/.exec(cd);
        a.download = m ? m[1] : 'loan-documents.zip';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
      });
    }).then(function() {
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
    }).catch(function(err) {
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
      showToast('ZIP download failed: ' + ((err && err.message) || 'unknown'), 'error');
    });
  };

  // ── Deploy 236.208 — Bulk Zip Upload ─────────────────────────
  // Client-side pipeline: user picks a .zip → JSZip parses it →
  // filenames go to /api/loan-review-zip-classify → high-confidence
  // matches auto-upload → low + unknown surface in a picker modal
  // where the processor assigns slugs or skips.
  //
  // Deploy 236.211 — replaced the single-line status text with a live
  // progress table (per-file rows + top progress bar), and added a
  // beforeunload guard so the browser prompts before nav-away.
  var _bulkZipInFlight = null;
  var _bulkZipRows = []; // { filename, slug, status: 'queued'|'uploading'|'done'|'failed'|'skipped', error? }

  function _bulkZipBeforeUnload(e) {
    if (!_bulkZipInFlight) return undefined;
    // Native browsers ignore the message on modern versions, but the
    // dialog still appears — the string is required for legacy IE/FF.
    var msg = 'A bulk document upload is still running. Leaving now will cancel remaining uploads.';
    (e || global.event).returnValue = msg;
    return msg;
  }
  function _bulkZipArmUnloadGuard() {
    global.addEventListener('beforeunload', _bulkZipBeforeUnload);
  }
  function _bulkZipDisarmUnloadGuard() {
    global.removeEventListener('beforeunload', _bulkZipBeforeUnload);
  }

  function _ensureJSZipLoaded() {
    if (global.JSZip) return Promise.resolve(global.JSZip);
    return new Promise(function(resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
      s.onload = function() { resolve(global.JSZip); };
      s.onerror = function() { reject(new Error('Failed to load JSZip library')); };
      document.head.appendChild(s);
    });
  }

  global.dr_startUploadZip = function() {
    if (_bulkZipInFlight) { showToast('A zip upload is already in progress.', 'info'); return; }
    document.getElementById('dr-uploadZipFile').click();
  };

  global.dr_onUploadZipPick = function(e) {
    var file = e.target.files && e.target.files[0];
    e.target.value = ''; // allow re-picking the same file later
    if (!file) return;
    if (file.size > 200 * 1024 * 1024) {
      showToast('Zip too large (max 200MB).', 'error');
      return;
    }
    _bulkZipInFlight = { total: 0, done: 0, uploaded: 0, skipped: 0, failed: 0 };
    _bulkZipRows = [];
    _bulkZipArmUnloadGuard();
    _openBulkZipModal();
    _bulkZipStatus('Loading zip parser…');
    _ensureJSZipLoaded().then(function(JSZip) {
      _bulkZipStatus('Extracting zip…');
      return JSZip.loadAsync(file);
    }).then(function(zip) {
      var entries = [];
      zip.forEach(function(path, entry) {
        if (entry.dir) return;
        if (/(^|\/)\.[^/]|(^|\/)__MACOSX(\/|$)/.test(path)) return;
        entries.push({ path: path, entry: entry, filename: path.split('/').pop() });
      });
      if (!entries.length) throw new Error('The zip contained no files.');
      _bulkZipInFlight.total = entries.length;
      _bulkZipStatus('Classifying ' + entries.length + ' file' + (entries.length === 1 ? '' : 's') + ' with AI…');
      return global.SLA.api('POST', '/api/loan-review-zip-classify', {
        reviewId: _review.id,
        filenames: entries.map(function(e) { return e.filename; }),
      }).then(function(resp) {
        if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'Classification failed');
        return { entries: entries, assignments: resp.assignments || [] };
      });
    }).then(function(payload) {
      var merged = payload.entries.map(function(e, i) {
        var a = payload.assignments[i] || { slug: null, confidence: 'unknown' };
        return Object.assign({}, e, { slug: a.slug, confidence: a.confidence, reason: a.reason || '' });
      });
      var high = merged.filter(function(x) { return x.slug && x.confidence === 'high'; });
      var ambiguous = merged.filter(function(x) { return !(x.slug && x.confidence === 'high'); });

      // Seed the rows table with everything, then upload the confident
      // ones first.
      _bulkZipRows = merged.map(function(x) {
        return {
          filename: x.filename,
          slug: x.slug || null,
          status: x.confidence === 'high' ? 'queued' : 'awaiting',
          confidence: x.confidence,
          reason: x.reason || '',
        };
      });
      _bulkZipRenderProgress();
      return _bulkZipUploadAll(high).then(function() {
        if (!ambiguous.length) return null;
        return _bulkZipAmbiguousPicker(ambiguous);
      }).then(function(picked) {
        if (!picked || !picked.length) return;
        // Mark picked rows as queued with their chosen slug.
        picked.forEach(function(p) {
          var row = _findRowByFilename(p.filename);
          if (row) { row.slug = p.slug; row.status = 'queued'; }
        });
        _bulkZipRenderProgress();
        return _bulkZipUploadAll(picked);
      });
    }).then(function() {
      var s = _bulkZipInFlight;
      _bulkZipStatus('Done — ' + s.uploaded + ' uploaded, ' + s.skipped + ' skipped, ' + s.failed + ' failed.');
      _bulkZipShowCloseButton();
      _bulkZipInFlight = null;
      _bulkZipDisarmUnloadGuard();
      render();
    }).catch(function(err) {
      _bulkZipStatus('Error: ' + ((err && err.message) || 'unknown'));
      _bulkZipShowCloseButton();
      _bulkZipInFlight = null;
      _bulkZipDisarmUnloadGuard();
    });
  };

  function _findRowByFilename(filename) {
    for (var i = 0; i < _bulkZipRows.length; i++) {
      if (_bulkZipRows[i].filename === filename) return _bulkZipRows[i];
    }
    return null;
  }

  function _bulkZipUploadAll(items) {
    // Serial to avoid stampeding the AI-review pipeline; each upload
    // itself waits on Claude. Concurrency > 1 would drive costs up
    // without meaningful wall-clock savings.
    var i = 0;
    function next() {
      if (i >= items.length) return Promise.resolve();
      var item = items[i++];
      var row = _findRowByFilename(item.filename);
      if (row) { row.status = 'uploading'; row.slug = item.slug; }
      _bulkZipStatus('Uploading (' + i + ' / ' + items.length + ')…');
      _bulkZipRenderProgress();
      return item.entry.async('blob').then(function(blob) {
        var mime = _mimeFromFilename(item.filename) || blob.type || 'application/octet-stream';
        var f = new File([blob], item.filename, { type: mime });
        // Deploy 236.502 — auto-compress oversize files; surface progress
        // on the shared status line + the row so a slow pass isn't silent.
        var onStatus = function(m) {
          if (row) { row.status = 'compressing'; row.note = m; }
          _bulkZipStatus(m);
          _bulkZipRenderProgress();
        };
        return global.SLA.LoanReviews.uploadDoc(_review.id, item.slug, f, { mode: 'add', onStatus: onStatus });
      }).then(function(r) {
        if (r && r.review) _review = r.review;
        _bulkZipInFlight.uploaded++;
        if (row) row.status = 'done';
        _bulkZipRenderProgress();
      }).catch(function(err) {
        console.warn('bulk upload failed for', item.filename, err);
        _bulkZipInFlight.failed++;
        if (row) { row.status = 'failed'; row.error = (err && err.message) || 'unknown'; }
        _bulkZipRenderProgress();
      }).then(next);
    }
    return next();
  }

  // Deploy 236.211 — visual progress table.
  function _bulkZipRenderProgress() {
    var body = document.getElementById('dr-bulkZipBody');
    if (!body) return;
    var s = _bulkZipInFlight || { total: 0, uploaded: 0, failed: 0, skipped: 0 };
    var doneCount = _bulkZipRows.filter(function(r) { return r.status === 'done' || r.status === 'failed' || r.status === 'skipped'; }).length;
    var totalCount = _bulkZipRows.length || s.total || 0;
    var pct = totalCount ? Math.round((doneCount / totalCount) * 100) : 0;
    body.innerHTML =
      '<div style="margin-bottom:14px">' +
        '<div style="height:10px;background:#f4efe2;border-radius:5px;overflow:hidden">' +
          '<div style="height:100%;background:#166534;width:' + pct + '%;transition:width .2s ease"></div>' +
        '</div>' +
        '<div style="margin-top:4px;font-size:11px;color:#7a7488;font-variant-numeric:tabular-nums">' +
          pct + '% · ' + doneCount + ' / ' + totalCount + ' · ' +
          '✓ ' + s.uploaded + '  ⚠ ' + s.failed + '  ⤼ ' + s.skipped +
        '</div>' +
      '</div>' +
      '<div style="border:1px solid #ddd8d0;border-radius:8px;max-height:340px;overflow:auto">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;font-family:\'DM Sans\',sans-serif">' +
          '<thead><tr style="background:#faf8f3;position:sticky;top:0">' +
            '<th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#7a7488;font-weight:600">Status</th>' +
            '<th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#7a7488;font-weight:600">Filename</th>' +
            '<th style="text-align:left;padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.04em;color:#7a7488;font-weight:600">Assigned to</th>' +
          '</tr></thead><tbody>' +
          _bulkZipRows.map(function(r) {
            var badge = _bulkZipStatusBadge(r.status);
            var slug = r.slug ? _slugLabel(r.slug) : (r.status === 'awaiting' ? '(awaiting picker)' : '(none)');
            return '<tr style="border-top:1px solid #f4efe2">' +
              '<td style="padding:5px 10px;white-space:nowrap">' + badge + '</td>' +
              '<td style="padding:5px 10px;word-break:break-all">' + escH(r.filename) + (r.error ? '<div style="font-size:10px;color:#991b1b;margin-top:2px">' + escH(r.error) + '</div>' : '') + '</td>' +
              '<td style="padding:5px 10px;color:#57534e">' + escH(slug) + '</td>' +
            '</tr>';
          }).join('') +
        '</tbody></table>' +
      '</div>';
  }

  function _bulkZipStatusBadge(status) {
    var map = {
      queued:    { text: 'Queued',    color: '#7a7488', bg: 'rgba(122,116,136,0.10)' },
      compressing: { text: 'Compressing', color: '#b5712d', bg: 'rgba(200,129,58,0.10)' },
      uploading: { text: 'Uploading', color: '#b5712d', bg: 'rgba(200,129,58,0.10)' },
      done:      { text: 'Uploaded',  color: '#166534', bg: 'rgba(21,128,61,0.10)' },
      failed:    { text: 'Failed',    color: '#991b1b', bg: 'rgba(153,27,27,0.10)' },
      skipped:   { text: 'Skipped',   color: '#7a7488', bg: 'rgba(122,116,136,0.10)' },
      awaiting:  { text: 'Awaiting',  color: '#1e40af', bg: 'rgba(30,64,175,0.10)' },
    };
    var m = map[status] || map.queued;
    return '<span style="display:inline-block;padding:2px 7px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:' + m.color + ';background:' + m.bg + '">' + m.text + '</span>';
  }

  function _bulkZipShowCloseButton() {
    var footer = document.getElementById('dr-bulkZipFooter');
    if (footer) footer.innerHTML = '<button class="dr-modal-btn primary" onclick="_closeBulkZipModalGlobal()">Close</button>';
  }
  global._closeBulkZipModalGlobal = function() { _closeBulkZipModal(); };

  function _mimeFromFilename(fn) {
    var ext = String(fn || '').toLowerCase().replace(/^.*\./, '');
    var map = {
      pdf: 'application/pdf',
      jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
      heic: 'image/heic', webp: 'image/webp', gif: 'image/gif',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      csv: 'text/csv',
    };
    return map[ext] || '';
  }

  function _openBulkZipModal() {
    var existing = document.getElementById('dr-bulkZipModal');
    if (existing) existing.remove();
    var m = document.createElement('div');
    m.id = 'dr-bulkZipModal';
    m.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9500;display:flex;align-items:center;justify-content:center;padding:24px';
    m.innerHTML =
      '<div style="background:#fff;max-width:640px;width:100%;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;border-radius:14px">' +
        '<div style="padding:18px 22px;border-bottom:1px solid #ddd8d0"><div style="font-family:\'Lora\',serif;font-size:18px;font-weight:600">Bulk Upload from ZIP</div><div id="dr-bulkZipStatus" style="font-size:12px;color:#7a7488;margin-top:2px">Working…</div></div>' +
        '<div id="dr-bulkZipBody" style="padding:18px 22px;overflow:auto;flex:1"></div>' +
        '<div id="dr-bulkZipFooter" style="padding:14px 22px;border-top:1px solid #ddd8d0;display:flex;justify-content:flex-end;gap:10px;background:#faf8f3"></div>' +
      '</div>';
    document.body.appendChild(m);
  }
  function _closeBulkZipModal() {
    var m = document.getElementById('dr-bulkZipModal'); if (m) m.remove();
  }
  function _bulkZipStatus(text) {
    var el = document.getElementById('dr-bulkZipStatus'); if (el) el.textContent = text;
  }

  // Picker modal for ambiguous files — one row per file with a
  // <select> of every checklist slug on this review + a Skip option.
  // Deploy 236.501 — added an "Other" choice: when picked, a category
  // (section) selector appears and the file is routed into a new "Other
  // Documents" tray in that section instead of a checklist slug.
  var _OTHER_PICK = '__other__';
  function _bulkZipAmbiguousPicker(items) {
    return new Promise(function(resolve) {
      var body = document.getElementById('dr-bulkZipBody');
      var footer = document.getElementById('dr-bulkZipFooter');
      _bulkZipStatus(items.length + ' file' + (items.length === 1 ? '' : 's') + ' need' + (items.length === 1 ? 's' : '') + ' your input — pick a category or skip.');
      var slugOptions = _allSlugsForPicker();
      var sectionOptions = SECTIONS.map(function(s) {
        return '<option value="' + escAttr(s.key) + '">' + escH(s.label) + '</option>';
      }).join('');
      body.innerHTML =
        '<div style="font-size:12px;color:#7a7488;margin-bottom:1rem">The AI wasn\'t confident on these files. Pick which category they belong to, choose <strong>Other</strong> to file it under a section as a non-checklist doc, or leave as Skip to ignore them.</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px">' +
        items.map(function(it, i) {
          var suggested = it.slug || '';
          var suggestedNote = (it.confidence === 'low' && it.slug)
            ? '<div style="font-size:11px;color:#7a7488;font-style:italic;margin-top:2px">AI guess: ' + escH(_slugLabel(it.slug)) + (it.reason ? ' — ' + escH(it.reason) : '') + '</div>'
            : (it.reason ? '<div style="font-size:11px;color:#7a7488;font-style:italic;margin-top:2px">' + escH(it.reason) + '</div>' : '');
          return '<div style="border:1px solid #ddd8d0;border-radius:8px;padding:10px 12px">' +
            '<div style="font-size:13px;font-weight:600;color:#1a1520;word-break:break-all">' + escH(it.filename) + '</div>' +
            suggestedNote +
            '<div style="margin-top:8px"><select id="dr-bulk-pick-' + i + '" onchange="dr_bulkOtherToggle(' + i + ')" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #ddd8d0;border-radius:6px;background:#fff">' +
              '<option value="">— Skip this file —</option>' +
              '<option value="' + _OTHER_PICK + '">📁 Other — file under a category…</option>' +
              slugOptions.map(function(o) {
                var sel = o.slug === suggested ? ' selected' : '';
                return '<option value="' + escAttr(o.slug) + '"' + sel + '>' + escH(o.label) + '</option>';
              }).join('') +
            '</select></div>' +
            '<div id="dr-bulk-secwrap-' + i + '" style="display:none;margin-top:6px">' +
              '<div style="font-size:11px;color:#7a7488;margin-bottom:3px">Which category should this go in?</div>' +
              '<select id="dr-bulk-sec-' + i + '" style="width:100%;padding:6px 8px;font-size:13px;border:1px solid #ddd8d0;border-radius:6px;background:#fff">' +
                sectionOptions +
              '</select>' +
            '</div>' +
          '</div>';
        }).join('') +
        '</div>';
      footer.innerHTML =
        '<button class="dr-modal-btn" onclick="dr_bulkZipCancel()">Cancel</button>' +
        '<button class="dr-modal-btn primary" onclick="dr_bulkZipConfirm()">Upload selected</button>';
      global.dr_bulkOtherToggle = function(i) {
        var sel = document.getElementById('dr-bulk-pick-' + i);
        var wrap = document.getElementById('dr-bulk-secwrap-' + i);
        if (wrap) wrap.style.display = (sel && sel.value === _OTHER_PICK) ? 'block' : 'none';
      };
      global.dr_bulkZipCancel = function() { resolve([]); };
      global.dr_bulkZipConfirm = function() {
        var picked = [];       // files mapped straight to an existing slug
        var otherPicks = [];   // { it, section } → need an Other tray minted first
        items.forEach(function(it, i) {
          var sel = document.getElementById('dr-bulk-pick-' + i);
          var val = sel && sel.value;
          if (val === _OTHER_PICK) {
            var secSel = document.getElementById('dr-bulk-sec-' + i);
            var section = (secSel && secSel.value) || 'other'; // Deploy 237.150
            otherPicks.push({ it: it, section: section });
          } else if (val) {
            picked.push(Object.assign({}, it, { slug: val }));
          } else {
            _bulkZipInFlight.skipped++;
          }
        });
        if (!otherPicks.length) { resolve(picked); return; }
        // Mint an "Other" tray per file (named from the filename), then
        // queue those uploads alongside the straight matches. Sequential
        // so each patch builds on the prior review state.
        _bulkZipStatus('Creating ' + otherPicks.length + ' Other document tray' + (otherPicks.length === 1 ? '' : 's') + '…');
        var idx = 0;
        function nextOther() {
          if (idx >= otherPicks.length) { resolve(picked); return; }
          var op = otherPicks[idx++];
          var name = _filenameToDocName(op.it.filename);
          _createOtherTray(op.section, name).then(function(slug) {
            picked.push(Object.assign({}, op.it, { slug: slug }));
          }).catch(function(err) {
            console.warn('Other tray create failed for', op.it.filename, err);
            var row = _findRowByFilename(op.it.filename);
            if (row) { row.status = 'failed'; row.error = 'Could not create Other tray: ' + ((err && err.message) || 'unknown'); }
            _bulkZipInFlight.failed++;
          }).then(nextOther);
        }
        nextOther();
      };
    });
  }

  // Deploy 236.501 — turn a filename into a readable Other-doc label:
  // strip the extension + a leading version tag, collapse separators.
  function _filenameToDocName(filename) {
    var base = String(filename || 'Document').replace(/\.[^.]+$/, '');
    base = base.replace(/[_]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
    return base || 'Document';
  }

  function _allSlugsForPicker() {
    var docs = (_review && _review.docs) || {};
    var out = [];
    Object.keys(docs).forEach(function(slug) {
      // Deploy 237.228 -- an empty retired tray isn't on the page, so don't offer
      // it as a destination for a file either.
      if (RETIRED_SLUGS[String(slug).replace(/__[pg]\d+$/, '')] && !_trayHasDoc(docs[slug])) return;
      out.push({ slug: slug, label: _slugLabel(slug) });
    });
    out.sort(function(a, b) { return a.label < b.label ? -1 : a.label > b.label ? 1 : 0; });
    return out;
  }
  function _slugLabel(slug) {
    var meta = DOC_META[slug];
    if (meta && meta.label) return meta.label;
    // Deploy 236.501 — custom / Other trays aren't in DOC_META; use the
    // label captured on the doc record so the progress table reads nicely.
    var d = (_review && _review.docs && _review.docs[slug]);
    if (d && d.label) return d.label;
    return slug;
  }

  // Deploy 236.561 — per-document conditions handlers. Persist on
  // _review.docs[slug].conditions[] via the same LoanReviews.patch path as notes.
  function _dr_patchConds(slug, conds) {
    var patch = { docs: {} };
    patch.docs[slug] = { conditions: conds };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      render();
    }).catch(function(err) {
      showToast('Condition save failed: ' + (err && err.message ? err.message : 'Unknown'), 'error');
    });
  }
  global.dr_addCond = function(slug) {
    var input = document.getElementById('dr-cond-input_' + slug);
    var title = (input && input.value) ? input.value.trim() : '';
    if (!title) { if (input) input.focus(); return; }
    var priorEl = document.getElementById('dr-cond-prior_' + slug);
    var priorTo = (priorEl && priorEl.value === 'funding') ? 'funding' : 'docs';
    var d = (_review.docs && _review.docs[slug]) || {};
    var conds = Array.isArray(d.conditions) ? d.conditions.slice() : [];
    conds.push({
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      title: title, status: 'outstanding', priorTo: priorTo,
      createdAt: new Date().toISOString(), createdBy: (_user && _user.email) || '',
      clearedAt: null, clearedBy: null,
    });
    _dr_patchConds(slug, conds);
  };
  global.dr_condStatus = function(slug, id, status) {
    var d = (_review.docs && _review.docs[slug]) || {};
    var now = new Date().toISOString();
    var conds = (Array.isArray(d.conditions) ? d.conditions : []).map(function(c) {
      if (c.id !== id) return c;
      var nc = {}; for (var k in c) nc[k] = c[k];
      nc.status = status;
      if (status === 'cleared') { nc.clearedAt = now; nc.clearedBy = (_user && _user.email) || ''; }
      else { nc.clearedAt = null; nc.clearedBy = null; }
      return nc;
    });
    _dr_patchConds(slug, conds);
  };
  global.dr_condRemove = function(slug, id) {
    var d = (_review.docs && _review.docs[slug]) || {};
    var conds = (Array.isArray(d.conditions) ? d.conditions : []).filter(function(c) { return c.id !== id; });
    _dr_patchConds(slug, conds);
  };

  // Deploy 237.066 — per-document note log actions.
  function _noteAuthor() {
    var meta = (_user && _user.user_metadata) || {};
    return { author: String(meta.full_name || meta.fullName || meta.name || (_user && _user.email) || '').trim(), authorEmail: String((_user && _user.email) || '').toLowerCase() };
  }
  // processorNotes stays a derived, readable transcript of the log so tray
  // history snapshots + anything that still reads the old field keep working.
  function _noteTranscript(log) {
    return (log || []).map(function(n) {
      var who = n.author || n.authorEmail || '';
      var when = n.ts ? new Date(n.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
      var tag = [who, when].filter(Boolean).join(' · ');
      return (tag ? '[' + tag + '] ' : '') + String(n.text || '');
    }).join('\n\n');
  }
  function _dr_patchNotes(slug, log, okMsg) {
    // A legacy entry becomes a real, editable entry the first time the log is written.
    log = log.map(function(n) { if (n.legacy) { var c = Object.assign({}, n); delete c.legacy; c.id = 'dn_legacy'; return c; } return n; });
    var patch = { docs: {} };
    patch.docs[slug] = { noteLog: log, processorNotes: _noteTranscript(log) };
    var statusEl = document.getElementById('dr-notes-status_' + slug);
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'dr-notes-status saving'; }
    return global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      _noteEditing = null;
      render();
      var el2 = document.getElementById('dr-notes-status_' + slug);
      if (el2) { el2.textContent = okMsg || 'Saved ✓'; el2.className = 'dr-notes-status saved'; setTimeout(function() { if (el2.textContent === (okMsg || 'Saved ✓')) { el2.textContent = ''; el2.className = 'dr-notes-status'; } }, 2000); }
    }).catch(function(err) {
      var el3 = document.getElementById('dr-notes-status_' + slug);
      if (el3) { el3.textContent = 'Save failed'; el3.className = 'dr-notes-status failed'; }
      showToast('Note save failed: ' + ((err && err.message) || 'Unknown'), 'error');
    });
  }
  global.dr_noteDraft = function(slug, v) { _noteDrafts[slug] = v; };
  global.dr_noteAdd = function(slug) {
    var ta = document.getElementById('dr-note-new_' + slug);
    var text = String((ta && ta.value) || '').trim();
    if (!text) { if (ta) ta.focus(); return; }
    var d = (_review.docs && _review.docs[slug]) || {};
    var log = _docNoteLog(d);
    var who = _noteAuthor();
    log.push({ id: 'dn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6), ts: new Date().toISOString(), author: who.author, authorEmail: who.authorEmail, text: text.slice(0, 4000) });
    delete _noteDrafts[slug];
    _dr_patchNotes(slug, log, 'Note saved ✓');
  };
  global.dr_noteEdit = function(slug, id) {
    _noteEditing = { slug: slug, id: id };
    render();
    var ta = document.getElementById('dr-note-edit_' + slug);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  };
  global.dr_noteEditCancel = function() { _noteEditing = null; render(); };
  global.dr_noteEditSave = function(slug, id) {
    var ta = document.getElementById('dr-note-edit_' + slug);
    var text = String((ta && ta.value) || '').trim();
    if (!text) { showToast('A note can\'t be empty — use Delete to remove it.', 'error'); return; }
    var d = (_review.docs && _review.docs[slug]) || {};
    var who = _noteAuthor();
    var log = _docNoteLog(d).map(function(n) {
      if (n.id !== id) return n;
      var c = Object.assign({}, n, { text: text.slice(0, 4000) });
      if (n.text !== text) { c.editedAt = new Date().toISOString(); c.editedBy = who.authorEmail; }
      return c;
    });
    _dr_patchNotes(slug, log, 'Note updated ✓');
  };
  global.dr_noteDelete = function(slug, id) {
    if (!global.confirm('Delete this note?')) return;
    var d = (_review.docs && _review.docs[slug]) || {};
    var log = _docNoteLog(d).filter(function(n) { return n.id !== id; });
    _dr_patchNotes(slug, log, 'Note deleted');
  };

  global.dr_saveNotes = function(slug, value) {
    var patch = { docs: {} };
    patch.docs[slug] = { processorNotes: value };
    // Deploy 236.158 — visible per-tray save indicator. Toast spam
    // every blur would be obnoxious; the inline indicator flashes
    // "Saving…" then "Saved ✓" for ~2 seconds.
    var statusEl = document.getElementById('dr-notes-status_' + slug);
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.className = 'dr-notes-status saving'; }
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      if (statusEl) {
        statusEl.textContent = 'Saved ✓';
        statusEl.className = 'dr-notes-status saved';
        setTimeout(function() {
          if (statusEl.textContent === 'Saved ✓') {
            statusEl.textContent = '';
            statusEl.className = 'dr-notes-status';
          }
        }, 2000);
      }
    }).catch(function(err) {
      if (statusEl) { statusEl.textContent = 'Save failed'; statusEl.className = 'dr-notes-status failed'; }
      showToast('Notes save failed: ' + (err.message || 'Unknown'), 'error');
    });
  };

  // Deploy 236.158 — inline rename. Swaps the doc-name span for an
  // input prefilled with the current filename. Enter/blur saves
  // via the same patch endpoint (currentFilename is a per-doc
  // field; loan-reviews-save merges shallowly). Esc cancels.
  global.dr_renameDoc = function(slug) {
    var nameEl = document.getElementById('dr-name_' + slug);
    if (!nameEl) return;
    var d = _review.docs[slug] || {};
    var current = d.currentFilename || '';
    nameEl.innerHTML =
      '<input class="dr-rename-input" type="text" value="' + escAttr(current) + '" />' +
      '<button class="small-btn dr-rename-save" onclick="dr_commitRename(\'' + escJs(slug) + '\')">Save</button>' +
      '<button class="small-btn dr-rename-cancel" onclick="dr_cancelRename(\'' + escJs(slug) + '\')">Cancel</button>';
    var input = nameEl.querySelector('.dr-rename-input');
    if (input) {
      input.focus();
      input.select();
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter')  { e.preventDefault(); global.dr_commitRename(slug); }
        if (e.key === 'Escape') { e.preventDefault(); global.dr_cancelRename(slug); }
      });
    }
  };
  global.dr_cancelRename = function(slug) { render(); };
  global.dr_commitRename = function(slug) {
    var nameEl = document.getElementById('dr-name_' + slug);
    if (!nameEl) return;
    var input = nameEl.querySelector('.dr-rename-input');
    var next = (input && input.value || '').trim();
    var d = _review.docs[slug] || {};
    if (!next) { showToast('Filename can\'t be empty.', 'error'); return; }
    if (next === (d.currentFilename || '')) { render(); return; }
    var patch = { docs: {} };
    patch.docs[slug] = { currentFilename: next, currentNameManual: true }; // Deploy 237.133
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Renamed.', 'success');
      render();
    }).catch(function(err) {
      showToast('Rename failed: ' + (err.message || 'Unknown'), 'error');
      render();
    });
  };

  // Deploy 237.130 -- a tray left with live documents but no primary pointer
  // (a pre-237.130 removal of the primary doc blanked currentDocId and the
  // promotion never ran) gets its most recent live document promoted on the
  // next verdict save, so Approve works again.
  function _primaryHealFields(slug) {
    var dd = (_review && _review.docs && _review.docs[slug]) || {};
    if (dd.currentDocId || !Array.isArray(dd.documents)) return null;
    var live = dd.documents.filter(function(x) { return x && !x.hidden && x.docId; })
      .sort(function(x, y) { return String(y.uploadedAt || '').localeCompare(String(x.uploadedAt || '')); });
    if (!live.length) return null;
    var n = live[0];
    return { currentDocId: n.docId, currentFilename: n.filename || '', currentSize: n.size || 0,
      currentMimeType: n.mimeType || 'application/pdf', currentUploadedAt: n.uploadedAt || '',
      aiVerdict: n.aiVerdict || '', aiNotes: n.aiNotes || '', aiFindings: Array.isArray(n.aiFindings) ? n.aiFindings : [],
      aiExtractedEntities: n.aiExtractedEntities || {}, aiReviewedAt: n.aiReviewedAt || '' };
  }
  // Deploy 237.138 (Dan's list) -- ONE control for where a document stands.
  // `status` is the truth; verdict / uwVerdict are written alongside because the
  // Processing Pipeline tile counts (review-loan-counts.mjs), the full-file tracker
  // and the borrower portal all read that pair. The split now lines up exactly:
  // Processor Approved = verdict approved, Underwriter Approved = + uwVerdict.
  global.dr_setStatus = function(slug, status) {
    var dd = (_review && _review.docs && _review.docs[slug]) || {};
    // Outstanding on a tray that HAS a document means "this one is no good" -- the
    // reason feeds the borrower's please-fix email (236.746). An empty tray is just
    // the base state, so it is set without a prompt.
    if (status === 'outstanding' && _trayHasDoc(dd)) { global.dr_openFlagModal(slug); return; }
    // Deploy 237.213 (Jessy) -- "Raissa ... changes status to 'Received' when she updated
    // doc or resolve condition - which leads the file back to Underwriting tab." On a tray
    // under a condition, Received MEANS "I have dealt with the condition", so that is what
    // it is recorded as, and the tray stays on the Conditions tab for the underwriter.
    // Habit keeps working; nobody has to learn a new click for the fix to reach them.
    var _wasReceived = false;
    if (status === 'received' && _underCondition(slug)) { status = 'condition_addressed'; _wasReceived = true; }
    var now = new Date().toISOString();
    var who = (_user && _user.email) || '';
    var p = { status: status, statusAt: now, statusBy: who };
    if (status === 'uw_approved') {
      p.verdict = 'approved'; p.approvedAt = now; p.approvedBy = who;
      p.uwVerdict = 'approved'; p.uwApprovedAt = now; p.uwApprovedBy = who; p.flagReason = '';
    } else if (status === 'processor_approved') {
      p.verdict = 'approved'; p.approvedAt = now; p.approvedBy = who;
      p.uwVerdict = ''; p.uwApprovedAt = ''; p.uwApprovedBy = ''; p.flagReason = '';
    } else if (status === 'ptd_condition' || status === 'ptf_condition') {
      p.verdict = 'approved'; p.approvedAt = now; p.approvedBy = who;
      p.uwVerdict = 'conditions'; p.uwConditionsAt = now; p.uwConditionsBy = who;
      p.uwApprovedAt = ''; p.uwApprovedBy = '';
    } else if (status === 'condition_addressed') {
      // The processor vouches for it (verdict approved); it is still the UNDERWRITER's
      // call (uwVerdict stays 'conditions', so the pipeline tile does not count it as
      // approved). When the underwriter conditioned it (uwConditionsAt/By) is left alone.
      p.verdict = 'approved'; p.approvedAt = now; p.approvedBy = who;
      p.uwVerdict = 'conditions'; p.uwApprovedAt = ''; p.uwApprovedBy = '';
      p.conditionAddressedAt = now; p.conditionAddressedBy = who;
    } else if (status === 'na') {
      p.verdict = 'na'; p.approvedAt = now; p.approvedBy = who;
      p.uwVerdict = ''; p.uwApprovedAt = ''; p.uwApprovedBy = '';
    } else {
      // Outstanding (empty tray) / Received: nothing is signed off yet.
      p.verdict = 'pending'; p.approvedAt = ''; p.approvedBy = '';
      p.uwVerdict = ''; p.uwApprovedAt = ''; p.uwApprovedBy = '';
    }
    var _heal = _primaryHealFields(slug); // Deploy 237.130
    if (_heal) { for (var _hk in _heal) { if (Object.prototype.hasOwnProperty.call(_heal, _hk)) p[_hk] = _heal[_hk]; } }
    var patch = { docs: {} };
    patch.docs[slug] = p;
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast(_wasReceived
        ? 'This tray is under a condition, so it is marked Condition Addressed \u2014 it stays on the Conditions tab for the underwriter.'
        : ('Set to ' + _statusLabel(status) + '.'), 'success');
      render();
    }).catch(function(err) { showToast('Save failed: ' + (err.message || 'Unknown'), 'error'); });
  };
  global.dr_setVerdict = function(slug, verdict) {
    // Deploy 236.746 — flagging an issue now requires the processor to say
    // WHAT the issue is (modal); the reason flows to the loan note stream,
    // the borrower portal, and the reminder emails.
    if (verdict === 'issues') { global.dr_openFlagModal(slug); return; }
    var now = new Date().toISOString();
    var patch = { docs: {} };
    if (verdict === 'approved') {
      patch.docs[slug] = { status: 'processor_approved', statusAt: now, statusBy: (_user && _user.email) || '', verdict: 'approved', approvedAt: now, approvedBy: (_user && _user.email) || '', uwVerdict: '', uwApprovedAt: '', uwApprovedBy: '' }; // Deploy 237.138
    } else {
      patch.docs[slug] = { status: 'received', statusAt: '', statusBy: '', verdict: 'pending', approvedAt: '', approvedBy: '', flagReason: '', uwVerdict: '', uwApprovedAt: '', uwApprovedBy: '' };
    }
    var _heal = _primaryHealFields(slug); // Deploy 237.130
    if (_heal) { for (var _hk in _heal) { if (Object.prototype.hasOwnProperty.call(_heal, _hk)) patch.docs[slug][_hk] = _heal[_hk]; } }
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Saved.', 'success');
      render();
    }).catch(function(err) { showToast('Save failed: ' + (err.message || 'Unknown'), 'error'); });
  };

  var _pendingFlag = null;
  global.dr_openFlagModal = function(slug) {
    _pendingFlag = slug;
    document.getElementById('dr-flagReason').value = (_review.docs[slug] && _review.docs[slug].flagReason) || '';
    document.getElementById('dr-flagModal').classList.add('show');
  };
  global.dr_closeFlagModal = function() {
    _pendingFlag = null;
    document.getElementById('dr-flagModal').classList.remove('show');
  };
  global.dr_confirmFlag = function() {
    var reason = document.getElementById('dr-flagReason').value.trim();
    if (!reason) { showToast('Please describe the issue so the borrower knows what to fix.', 'error'); return; }
    var slug = _pendingFlag;
    var patch = { docs: {} };
    patch.docs[slug] = {
      // Deploy 237.138 -- flagging a collected document IS "Outstanding" (Dan's
      // base status); verdict 'issues' stays for the borrower portal + fix emails.
      status: 'outstanding', statusAt: new Date().toISOString(), statusBy: (_user && _user.email) || '',
      verdict: 'issues',
      flagReason: reason,
      flaggedAt: new Date().toISOString(),
      flaggedBy: (_user && _user.email) || '',
    };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      global.dr_closeFlagModal();
      showToast('Issue flagged — visible to the borrower on their portal.', 'success');
      render();
    }).catch(function(err) { showToast('Save failed: ' + (err.message || 'Unknown'), 'error'); });
  };

  // Deploy 236.746 — on-demand "email the borrower about flagged docs".
  global.dr_notifyBorrowerFixes = function(btn) {
    var flagged = Object.keys((_review && _review.docs) || {}).filter(function(s){
      return _review.docs[s] && _review.docs[s].verdict === 'issues' && !_review.docs[s].hidden;
    });
    if (!flagged.length) { showToast('No flagged documents — flag an issue first.', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    global.SLA.api('POST', '/api/borrower-fix-notify', { reviewId: _review.id }).then(function(r) {
      if (btn) { btn.disabled = false; btn.textContent = '✉ Email borrower re: flagged docs'; }
      showToast('Email sent to ' + (r.to || 'the borrower') + ' (' + r.flaggedCount + ' flagged doc' + (r.flaggedCount === 1 ? '' : 's') + ').', 'success');
    }).catch(function(err) {
      if (btn) { btn.disabled = false; btn.textContent = '✉ Email borrower re: flagged docs'; }
      showToast('Send failed: ' + (err.message || 'Unknown'), 'error');
    });
  };

  // Deploy 236.818 — point-of-truth refresh. Fires the background refresher
  // (fresh snapshot + signed app + AI re-runs), then reloads the review after
  // a short beat so the "Re-review queued" states show up.
  global.dr_refreshTruth = function(btn) {
    if (!_review || !_review.id) return;
    var src = _review.source || {};
    var clientId = (global._client && global._client.id) || src.clientId;
    var loanId = global._loanId || src.loanId;
    var owner = (typeof global._ldOwnerOverride === 'function' && global._ldOwnerOverride()) ||
      (global._loEmail || src.ownerKey || '');
    if (!clientId || !loanId || !owner) { showToast('Missing loan context for refresh.', 'error'); return; }
    if (btn) { btn.disabled = true; btn.textContent = 'Syncing…'; }
    SLA.getToken().then(function(tok) {
      return fetch('/api/loan-review-refresh-truth', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ owner: owner, clientId: clientId, loanId: loanId, reason: 'manual sync from doc review' }),
      });
    }).then(function(r) {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Sync application data'; }
      if (r.status === 202 || r.ok) {
        showToast('Application data synced — re-reviews queued. Verdicts update as they finish.', 'success');
        setTimeout(function() { loadReview(); }, 4000);
      } else {
        r.json().then(function(d) { showToast('Sync failed: ' + ((d && d.error) || ('HTTP ' + r.status)), 'error'); })
          .catch(function() { showToast('Sync failed: HTTP ' + r.status, 'error'); });
      }
    }).catch(function(err) {
      if (btn) { btn.disabled = false; btn.textContent = '↻ Sync application data'; }
      showToast('Sync failed: ' + (err && err.message || 'Unknown'), 'error');
    });
  };

  global.dr_openNaModal = function(slug) {
    _pendingNa = slug;
    document.getElementById('dr-naReason').value = (_review.docs[slug] && _review.docs[slug].naReason) || '';
    document.getElementById('dr-naModal').classList.add('show');
  };
  global.dr_closeNaModal = function() {
    _pendingNa = null;
    document.getElementById('dr-naModal').classList.remove('show');
  };
  global.dr_confirmNa = function() {
    var reason = document.getElementById('dr-naReason').value.trim();
    if (!reason) { showToast('Please provide a reason for N/A.', 'error'); return; }
    var slug = _pendingNa;
    var now = new Date().toISOString();
    var patch = { docs: {} };
    patch.docs[slug] = {
      status: 'na', statusAt: now, statusBy: (_user && _user.email) || '', // Deploy 237.136 (legacy option)
      verdict: 'na',
      naReason: reason,
      approvedAt: now,
      approvedBy: (_user && _user.email) || '',
      uwVerdict: '', uwApprovedAt: '', uwApprovedBy: '', // Deploy 237.071
    };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Marked N/A.', 'success');
      global.dr_closeNaModal();
      render();
    }).catch(function(err) { showToast('Save failed: ' + (err.message || 'Unknown'), 'error'); });
  };

  global.dr_openOverrideModal = function(slug) {
    _pendingOverride = slug;
    document.getElementById('dr-overrideReason').value = '';
    document.getElementById('dr-overrideModal').classList.add('show');
  };
  global.dr_closeOverrideModal = function() {
    _pendingOverride = null;
    document.getElementById('dr-overrideModal').classList.remove('show');
  };
  global.dr_confirmOverride = function() {
    var reason = document.getElementById('dr-overrideReason').value.trim();
    if (!reason) { showToast('Please tell us why you\'re overriding the AI.', 'error'); return; }
    var slug = _pendingOverride;
    var now = new Date().toISOString();
    var patch = { docs: {} };
    patch.docs[slug] = {
      verdict: 'approved',
      processorOverrideReason: reason,
      approvedAt: now,
      approvedBy: (_user && _user.email) || '',
    };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Override saved for admin retraining.', 'success');
      global.dr_closeOverrideModal();
      render();
    }).catch(function(err) { showToast('Save failed: ' + (err.message || 'Unknown'), 'error'); });
  };

  global.dr_openFinalizeModal  = function() { document.getElementById('dr-finalizeModal').classList.add('show'); };
  global.dr_closeFinalizeModal = function() { document.getElementById('dr-finalizeModal').classList.remove('show'); };
  global.dr_confirmFinalize = function() {
    global.SLA.LoanReviews.patch(_review.id, { status: 'finalized', finalizedAt: new Date().toISOString() }).then(function() {
      return global.SLA.LoanReviews.remove(_review.id);
    }).then(function() {
      showToast('Review finalized + docs purged.', 'success');
      global.dr_closeFinalizeModal();
      if (_opts.onDeleted) try { _opts.onDeleted(_review.id); } catch (_) {}
    }).catch(function(err) { showToast('Finalize failed: ' + (err.message || 'Unknown'), 'error'); });
  };

  global.dr_openDeleteModal  = function() { document.getElementById('dr-deleteModal').classList.add('show'); };
  global.dr_closeDeleteModal = function() {
    document.getElementById('dr-deleteModal').classList.remove('show');
    var btn = document.getElementById('dr-deleteConfirmBtn');
    if (btn) { btn.disabled = false; btn.textContent = 'Delete Review'; }
  };
  global.dr_confirmDeleteReview = function() {
    var btn = document.getElementById('dr-deleteConfirmBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
    global.SLA.LoanReviews.remove(_review.id).then(function() {
      showToast('Review deleted.', 'success');
      global.dr_closeDeleteModal();
      if (_opts.onDeleted) try { _opts.onDeleted(_review.id); } catch (_) {}
    }).catch(function(err) {
      if (btn) { btn.disabled = false; btn.textContent = 'Delete Review'; }
      showToast('Delete failed: ' + (err.message || 'Unknown'), 'error');
    });
  };

  // Public API
  global.SLA = global.SLA || {};
  global.SLA.DocReview = { mount: mount };
})(window);
