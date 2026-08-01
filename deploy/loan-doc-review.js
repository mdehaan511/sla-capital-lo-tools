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
  var SECTIONS = [
    { key: 'borrower',  label: 'Borrower Documents'  },
    { key: 'guarantor', label: 'Guarantor Documents' },
    { key: 'collateral',label: 'Collateral Documents'},
    { key: 'loan',      label: 'Loan Documents'      },
    { key: 'closing',   label: 'Closing Documents'   },
  ];
  var DOC_META = {
    articles_of_organization: { label: 'Articles of Organization', section: 'borrower', conditions: 'Verify LLC name matches loan application.' },
    entity_background_check:  { label: 'Entity Background Check',  section: 'borrower', conditions: 'No bankruptcies, liens, or judgements within 90 days of close date.' },
    bank_stmt_current:        { label: 'Current-Month Bank Statements', section: 'borrower', conditions: 'Liquidity requirements met? Borrower’s ownership of accounts verified?' },
    bank_stmt_previous:       { label: 'Previous-Month Bank Statements', section: 'borrower', conditions: 'Liquidity requirements met? Borrower’s ownership of accounts verified?' },
    certificate_of_good_standing: { label: 'Certificate of Good Standing', section: 'borrower', conditions: 'Within last 90 days; correct LLC listed; state seal; Secretary of State signature.' },
    ein_or_w9:                { label: 'EIN Letter or W9', section: 'borrower', conditions: 'If no EIN letter, request a W9 instead.' },
    ofac_entity:              { label: 'OFAC Check (Entity)', section: 'borrower', conditions: 'Entity name on OFAC report matches AOO exactly.' },
    operating_agreement:      { label: 'Operating Agreement', section: 'borrower', conditions: 'Verify LLC name; identify all owners with 20%+ ownership; all signatures + initials present.' },
    track_record_reo:         { label: 'Track Record / REO Schedule', section: 'borrower', conditions: 'Max of 6 properties needed. Confirm all cells are filled in with reasonable info.' },
    voided_check_ach:         { label: 'Voided Check / ACH Letter', section: 'borrower', conditions: 'Account that borrower wants to make monthly payments from.' },
    track_record:             { label: 'Track Record', section: 'borrower', conditions: 'Max of 8 properties needed for top pricing. Confirm all cells filled in with reasonable info.' },
    voided_check:             { label: 'Voided Check', section: 'borrower', conditions: 'Account borrower wants payment from. If different than borrower name get 3rd-party payee form.' },
    borrower_loe:             { label: 'Borrower Letter of Explanation', section: 'borrower', conditions: 'As required.', optional: true },

    guarantor_background_check:{ label: 'Guarantor Background Check', section: 'guarantor', conditions: 'No bankruptcies, liens, or judgements; criminal report < 90 days old.' },
    credit_authorization:     { label: 'Credit Authorization', section: 'guarantor', conditions: 'Signed by all guarantors.' },
    credit_report:            { label: 'Credit Report', section: 'guarantor', conditions: 'Middle score above 690? Any lates or past-due accounts? Report is < 90 days old?' },
    guarantor_id:             { label: 'Guarantor ID (Driver’s License or Passport)', section: 'guarantor', conditions: 'Matches name on application; not expired; birth date matches.' },
    ofac_personal:            { label: 'OFAC Check (Personal)', section: 'guarantor', conditions: 'Personal name of all guarantors must match exactly.' },
    pfs:                      { label: 'Personal Financial Statement (PFS)', section: 'guarantor', conditions: 'Signed by borrower.' },
    voh_corrfirst:            { label: 'Verification of Housing Cost (CorrFirst Only)', section: 'guarantor', conditions: 'Copy of primary home’s mortgage or lease agreement along with proof of payment.', optional: true },
    guarantor_loe:            { label: 'Guarantor Letter of Explanation', section: 'guarantor', conditions: 'As required.', optional: true },

    assignment_agreement:     { label: 'Assignment Agreement', section: 'collateral', conditions: 'Buyer matches borrower; seller matches the PSA; all parties signed.', optional: true },
    appraisal:                { label: 'Appraisal', section: 'collateral', conditions: 'Value >= loan amount; does NOT say "subject to".' },
    appraisal_receipt:        { label: 'Appraisal Receipt', section: 'collateral', conditions: 'Paid-in-full receipt for the appraisal.' },
    air:                      { label: 'AIR (Appraisal Independence Report)', section: 'collateral', conditions: 'Appraisal Independence Report signed.' },
    cda_report:               { label: 'CDA Report', section: 'collateral', conditions: 'Value >= Appraised value.' },
    evidence_of_insurance:    { label: 'Evidence of Insurance', section: 'collateral', conditions: 'Mortgagee clause; borrower name/LLC; insurance => loan value; $1M liability coverage.' },
    flood_certificate:        { label: 'Flood Certificate & Insurance', section: 'collateral', conditions: 'If property is in a flood zone, request flood insurance EOI.', optional: true },
    proof_of_insurance_pif:   { label: 'Proof of Insurance Paid in Full (PIF)', section: 'collateral', conditions: 'Quote showing policy number and total cost — or — receipt showing $0 owed.' },
    lease_agreements:         { label: 'Lease Agreements', section: 'collateral', conditions: '12 months in length? Non-corporate tenant? Signed by landlord and tenant?' },
    property_mgmt_agreement:  { label: 'Property Management Agreement', section: 'collateral', conditions: 'PMA signed; covers the subject property.' },
    property_mgmt_questionnaire: { label: 'Property Management Questionnaire', section: 'collateral', conditions: 'PMQ completed in full.' },
    psa:                      { label: 'Purchase and Sale Agreement (PSA)', section: 'collateral', conditions: 'Borrower listed as buyer; all parties signed; price matches application.' },
    sow:                      { label: 'Statement of Work (SOW)', section: 'collateral', conditions: 'Budget = Requested rehab $$.' },
    vom:                      { label: 'VOM (Verification of Mortgage)', section: 'collateral', conditions: 'Existing mortgage information verified.', optional: true },
    bpo_valuation:            { label: 'BPO / Valuation', section: 'collateral', conditions: 'Value >= loan amount.' },

    loan_application:         { label: 'Loan Application', section: 'loan', conditions: 'Verify all information filled out and is accurate; signatures present.' },
    term_sheet:               { label: 'Term Sheet', section: 'loan', conditions: 'Ensure it is the most up-to-date terms.' },

    borrower_closing_funds_receipt: { label: 'Borrower Closing Funds Receipt', section: 'closing', conditions: 'Requested day of closing.' },
    cpl:                      { label: 'Closing Protection Letter (CPL)', section: 'closing', conditions: 'Mortgagee Clause; loan number; property address; date.' },
    emd_receipt:              { label: 'EMD Receipt', section: 'closing', conditions: 'Receipt showing borrower provided EMD to the title company.' },
    prelim_settlement:        { label: 'Pre-Lim Settlement Statement', section: 'closing', conditions: 'Loan amount correct; fees correct; prepaid interest; property address; borrower.' },
    final_hud:                { label: 'Final HUD / Settlement Statement', section: 'closing', conditions: 'Final signed settlement statement (HUD / Closing Disclosure) collected AFTER closing. Loan amount, fees, prepaid interest, payoffs, and net wire all reconcile to the approved terms.' },
    tax_certificate:          { label: 'Tax Certificate', section: 'closing', conditions: 'Property address; tax rate and/or taxes paid/owed displayed; tax due dates listed.' },
    title_commitment:         { label: 'Title Commitment', section: 'closing', conditions: 'Mortgagee Clause; loan number; borrower name; property address(es); 125% of loan value; date.' },
    title_eo_insurance:       { label: 'Title E&O Insurance', section: 'closing', conditions: 'Title company name; $1 million in protection; policy dates current.' },
    wire_instructions:        { label: 'Wire Instructions', section: 'closing', conditions: 'Wire instructions for the title company.' },
  };

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
  var _activeTab = 'pending';
  var _expanded = {};
  var _pendingOverride = null;
  var _pendingNa = null;
  var _docSearch = '';
  var _sourceOpen = false;
  var _uploadingSlug = null;
  var _stylesInjected = false;
  // Deploy 236.161 — per-section "Show N hidden" toggle state.
  var _showHidden = {};
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
      '.dr-root .source-grid .k { font-size:10px; color:var(--muted); text-transform:uppercase; letter-spacing:0.04em; margin-bottom:2px; }',
      '.dr-root .source-grid .v { font-size:13px; color:var(--text); font-family:"DM Mono", monospace; word-break:break-word; }',
      '.dr-root .source-section-title { font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.06em; margin:16px 0 8px; padding-top:12px; border-top:1px solid var(--border); }',
      '.dr-root .source-section-title:first-child { margin-top:0; padding-top:0; border-top:0; }',
      '.dr-root .source-empty { padding:1rem; color:var(--muted); font-size:13px; text-align:center; font-style:italic; }',

      // .section here would collide with the host page; use .dr-section.
      '.dr-root .dr-section { margin-bottom:1.5rem; }',
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
      '.dr-root .dr-mr-badge { display:inline-block; margin-top:6px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:#1e40af; background:rgba(30,64,175,0.10); border:1px solid rgba(30,64,175,0.25); border-radius:20px; padding:2px 9px; }',
      '.dr-root .dr-br-badge { display:inline-block; margin-top:6px; font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.04em; color:var(--muted); background:var(--bg, #f7f5f1); border:1px solid var(--border); border-radius:20px; padding:2px 9px; }',
      // Deploy 236.501 — per-section "Other Documents" area: a subtle
      // dashed-top band that separates catch-all docs from the checklist.
      '.dr-root .dr-other-block { margin-top:14px; padding-top:12px; border-top:1px dashed var(--border); }',
      '.dr-root .dr-other-head { display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; margin-bottom:10px; }',
      '.dr-root .dr-other-title { font-size:11px; font-weight:700; color:var(--muted); text-transform:uppercase; letter-spacing:0.05em; }',
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
      '.dr-root .tray { background:#fff; border:1px solid var(--border, #ddd8d0); border-radius:8px; margin-bottom:10px; overflow:hidden; }',
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
      '.dr-root .tray-head { padding:14px 18px; display:flex; justify-content:space-between; align-items:flex-start; gap:1rem; cursor:pointer; }',
      '.dr-root .tray-head:hover { background:var(--gold-light, rgba(200,129,58,0.10)); }',
      '.dr-root .tray-name { font-size:13px; font-weight:600; color:var(--text); }',
      '.dr-root .tray-conditions { font-size:11px; color:var(--muted); margin-top:4px; line-height:1.5; }',
      '.dr-root .tray-verdict { font-size:11px; font-weight:600; padding:3px 10px; border-radius:20px; white-space:nowrap; }',
      '.dr-root .tray-verdict.pending  { background:var(--gold-light); color:var(--muted); border:1px solid var(--border); }',
      '.dr-root .tray-verdict.approved { background:var(--dr-green-light); color:var(--dr-green); border:1px solid var(--dr-green-border); }',
      '.dr-root .tray-verdict.issues   { background:var(--dr-red-light); color:var(--dr-red); border:1px solid var(--dr-red-border); }',
      '.dr-root .tray-verdict.na       { background:var(--dr-blue-light); color:var(--dr-blue); border:1px solid var(--dr-blue-border); }',
      // Deploy 236.161 — Awaiting Review badge variants.
      '.dr-root .tray-verdict.awaiting-ok     { background:var(--dr-green-light); color:var(--dr-green); border:1px solid var(--dr-green-border); }',
      '.dr-root .tray-verdict.awaiting-issues { background:var(--dr-red-light); color:var(--dr-red); border:1px solid var(--dr-red-border); }',
      '.dr-root .tray-verdict.awaiting        { background:var(--gold-light); color:var(--gold-mid); border:1px solid var(--gold-border, rgba(200,129,58,0.28)); }',
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
      '.dr-root .ai-head { display:flex; align-items:center; justify-content:space-between; gap:1rem; }',
      '.dr-root .ai-label { display:inline-flex; align-items:center; gap:6px; font-size:11px; font-weight:600; text-transform:uppercase; letter-spacing:0.04em; }',
      '.dr-root .ai-label.approved { color:var(--dr-green); }',
      '.dr-root .ai-label.issues   { color:var(--dr-red); }',
      '.dr-root .ai-label.pending  { color:var(--gold-mid); }',
      '.dr-root .ai-cost { font-size:10px; color:var(--muted); font-family:"DM Mono", monospace; }',
      '.dr-root .ai-summary { font-size:12px; color:var(--text); margin-top:6px; line-height:1.5; }',
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
      // Deploy 236.162 — Add Custom Document modal.
      '<div class="dr-modal-bg" id="dr-addDocModal"><div class="dr-modal">',
        '<h3>Add a new document</h3>',
        '<p style="font-size:12px;color:#7a7488;margin-bottom:14px">Creates a new tray in the <span id="dr-addDocSection" style="font-weight:600;color:#1a1520"></span> section. You can rename it later by clicking the pencil next to the tray name.</p>',
        '<input type="text" id="dr-addDocName" class="notes-area" style="min-height:auto;font-size:13px" placeholder="e.g., Investor-specific addendum, Lien waiver, ..." />',
        '<div class="dr-modal-actions">',
          '<button class="dr-modal-btn" onclick="dr_closeAddDocModal()">Cancel</button>',
          '<button class="dr-modal-btn approve" onclick="dr_confirmAddDoc()">Add Document</button>',
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
    _user = opts.user || (global.netlifyIdentity && global.netlifyIdentity.currentUser && global.netlifyIdentity.currentUser());
    // Reset module state per-mount so reopening a different review
    // doesn't leak prior _expanded / _activeTab.
    _review = null;
    _activeTab = 'pending';
    _expanded = {};
    _pendingOverride = null;
    _pendingNa = null;
    _docSearch = '';
    _sourceOpen = false;
    _uploadingSlug = null;

    rootEl.classList.add('dr-root');
    rootEl.innerHTML = '<div class="loading-page">Loading review…</div>';
    loadReview();
  }

  function loadReview() {
    global.SLA.LoanReviews.get(_opts.reviewId).then(function(r) {
      _review = r.review;
      render();
    }).catch(function(err) {
      _root.innerHTML = '<div class="loading-page">Failed to load: ' + escHtml(err.message || 'Unknown error') + '</div>';
    });
  }

  // ── Render ───────────────────────────────────────────────────────
  function render() {
    var docs = _review.docs || {};
    var allSlugs = Object.keys(docs);
    // Deploy 236.161 — split hidden trays out of the main count.
    // Hidden trays stay in the data, just don't render in the
    // normal tabs / counters; a per-section "Show N hidden" toggle
    // reveals them when the LO wants.
    var slugs  = allSlugs.filter(function(s) { return !docs[s] || !docs[s].hidden; });
    var hidden = allSlugs.filter(function(s) { return docs[s] && docs[s].hidden; });
    var pendingSlugs  = slugs.filter(function(s) { var v = docs[s].verdict; return v !== 'approved' && v !== 'na'; });
    var reviewedSlugs = slugs.filter(function(s) { var v = docs[s].verdict; return v === 'approved' || v === 'na'; });

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
          // Deploy 236.520 — invite the borrower (or broker) to submit their
          // documents through the portal, with real-time AI review.
          '<button type="button" class="dr-invite-btn" onclick="dr_inviteBorrower()">✉ Invite Borrower to Submit Documents</button>' +
        '</div>' +
        '<div class="summary-stats">' +
          '<div class="summary-stat"><div class="v">' + amt + '</div><div class="l">Loan Amount</div></div>' +
          '<div class="summary-stat"><div class="v">' + closeDate + '</div><div class="l">Expected Close</div></div>' +
          '<div class="summary-stat"><div class="v">' + reviewedSlugs.length + ' / ' + slugs.length + '</div><div class="l">Reviewed</div></div>' +
          ((global.SLA && global.SLA.isAdmin && global.SLA.isAdmin(_user)) ? '<div class="summary-stat"><div class="v">$' + ((_review.aiCostCents || 0) / 100).toFixed(2) + '</div><div class="l">AI Cost</div></div>' : '') +
        '</div>' +
      '</div>';

    var sourcePanel = renderSourcePanel();

    var tabs =
      '<div class="tabs">' +
        '<div class="tab ' + (_activeTab === 'pending' ? 'active' : '') + '" onclick="dr_switchTab(\'pending\')">' +
          'Pending Docs <span class="tab-count">' + pendingSlugs.length + '</span></div>' +
        '<div class="tab ' + (_activeTab === 'reviewed' ? 'active' : '') + '" onclick="dr_switchTab(\'reviewed\')">' +
          'Reviewed Docs <span class="tab-count">' + reviewedSlugs.length + '</span></div>' +
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
        '<input type="file" id="dr-uploadZipFile" accept=".zip,application/zip,application/x-zip-compressed" style="display:none" onchange="dr_onUploadZipPick(event)" />' +
      '</div>';

    var activeSlugs = _activeTab === 'pending' ? pendingSlugs : reviewedSlugs;
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

    _root.innerHTML = summary + sourcePanel + tabs + toolbar + traysHtml + bottom;

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
  function _ccNormName(s) {
    return String(s == null ? '' : s).toUpperCase().replace(/[.,'"]/g, '').replace(/\s+/g, ' ').trim();
  }
  function _ccNormAddr(s) {
    var t = String(s == null ? '' : s).toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/\bstreet\b/g, 'st').replace(/\bavenue\b/g, 'ave').replace(/\broad\b/g, 'rd')
         .replace(/\bdrive\b/g, 'dr').replace(/\blane\b/g, 'ln').replace(/\bboulevard\b/g, 'blvd')
         .replace(/\bcourt\b/g, 'ct').replace(/\bplace\b/g, 'pl').replace(/\bhighway\b/g, 'hwy')
         .replace(/\bapartment\b/g, 'unit').replace(/\bapt\b/g, 'unit').replace(/\bsuite\b/g, 'unit').replace(/\bste\b/g, 'unit')
         .replace(/\bnorth\b/g, 'n').replace(/\bsouth\b/g, 's').replace(/\beast\b/g, 'e').replace(/\bwest\b/g, 'w');
    return t.replace(/\s+/g, ' ').trim();
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

  function buildConsistencyReport(review) {
    review = review || {};
    var docs = review.docs || {};
    var client = review.sourceClientSnapshot || {};
    var FIELDS = [
      { key: 'llcName',         label: 'Entity / LLC Name', norm: _ccNormName, loanRef: client.entityName },
      { key: 'borrowerName',    label: 'Borrower Name',     norm: _ccNormName, loanRef: review.borrowerName },
      { key: 'propertyAddress', label: 'Property Address',  norm: _ccNormAddr, loanRef: review.address },
      { key: 'loanAmount',      label: 'Loan Amount',       norm: _ccNormMoney, money: true, loanRef: review.loanAmount },
    ];
    return FIELDS.map(function(f) {
      var sources = []; // { label, raw, norm, isRef }
      if (!_ccIsBlank(f.loanRef)) {
        sources.push({ label: 'Loan File (of record)', raw: String(f.loanRef), norm: f.norm(f.loanRef), isRef: true });
      }
      Object.keys(docs).forEach(function(slug) {
        var d = docs[slug];
        if (!d || d.hidden) return;
        var ee = d.aiExtractedEntities || {};
        var v = ee[f.key];
        if (_ccIsBlank(v)) return;
        var label = (DOC_META[slug] && DOC_META[slug].label) || d.label || slug;
        sources.push({ label: label, raw: String(v), norm: f.norm(v) });
      });
      // Group by normalized value.
      var groups = [], byNorm = {};
      sources.forEach(function(s) {
        if (!s.norm) return;
        if (!byNorm[s.norm]) { byNorm[s.norm] = { norm: s.norm, raw: s.raw, labels: [] }; groups.push(byNorm[s.norm]); }
        byNorm[s.norm].labels.push(s.label);
      });
      var comparable = sources.filter(function(s) { return s.norm; }).length;
      // Biggest group first so the "majority" value reads at the top.
      groups.sort(function(a, b) { return b.labels.length - a.labels.length; });
      return {
        key: f.key, label: f.label, money: !!f.money, groups: groups, comparable: comparable,
        status: groups.length > 1 ? 'mismatch' : (comparable >= 2 ? 'ok' : (comparable === 1 ? 'single' : 'none')),
      };
    });
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
      if (r.status === 'single') {
        var g0 = r.groups[0];
        return '<div class="dr-cc-row single"><div class="dr-cc-field">' + escHtml(r.label) + '</div>' +
          '<div class="dr-cc-detail"><span class="dr-cc-val">' + escHtml(fmt(g0)) + '</span> ' +
          '<span class="dr-cc-only">— only on ' + escHtml(g0.labels.join(', ')) + '; nothing to cross-check yet</span></div></div>';
      }
      if (r.status === 'ok') {
        var gk = r.groups[0];
        return '<div class="dr-cc-row ok"><div class="dr-cc-field">✓ ' + escHtml(r.label) + '</div>' +
          '<div class="dr-cc-detail"><span class="dr-cc-val">' + escHtml(fmt(gk)) + '</span> ' +
          '<span class="dr-cc-agree">— matches across ' + gk.labels.length + ' sources</span></div></div>';
      }
      // mismatch
      var gl = r.groups.map(function(g) {
        return '<div class="dr-cc-variant"><span class="dr-cc-val">' + escHtml(fmt(g)) + '</span>' +
          '<span class="dr-cc-srcs">' + escHtml(g.labels.join(', ')) + '</span></div>';
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

  // Deploy 236.520 — invite the borrower/broker to submit docs via the portal.
  global.dr_inviteBorrower = function() {
    var src = (_review && _review.source) || {};
    var loanId = src.loanId || '', clientId = src.clientId || '';
    if (!loanId || !clientId) { showToast('This review has no loan reference to invite against.', 'error'); return; }
    var email = window.prompt(
      'Send a document-submission invite.\n\nLeave blank to use the email on file (the broker’s email for broker loans, otherwise the borrower’s application email), or type a specific email to use:',
      ''
    );
    if (email === null) return; // cancelled
    var body = { loanId: loanId, primaryClientId: clientId };
    if (_review.loEmail) body.owner = _review.loEmail;
    if (email && email.trim()) body.emailOverride = email.trim();
    showToast('Sending invite…', 'info');
    global.SLA.api('POST', '/api/borrower-intake-invite', body).then(function(r) {
      if (r && r.ok) showToast('✓ Invite sent to ' + (r.email || 'the borrower') + (r.emailed ? '' : ' (portal access granted; email pending)'), 'success');
      else showToast('Invite failed.', 'error');
    }).catch(function(err) {
      showToast('Invite failed: ' + ((err && err.message) || 'unknown'), 'error');
    });
  };

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

      var isDscr = String(loan && loan.toolType || _review.loanType || '').toLowerCase() !== 'rtl';

      var loanRows = [
        { k: 'Loan type',       v: (isDscr ? 'DSCR' : 'RTL') + ' (' + ((loan && loan.toolType) ? String(loan.toolType).toUpperCase() : '—') + ')' },
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
        { k: 'Entity',    v: client ? txt(client.entityName) : '—' },
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

  function renderSections(slugs) {
    if (!slugs.length) {
      return '<div class="loading-page">' +
        (_activeTab === 'pending' ? 'All docs reviewed. 🎉' : 'No docs reviewed yet.') +
        '</div>';
    }
    var bySection = {};
    slugs.forEach(function(slug) {
      // Deploy 236.162 — custom trays fall back to docs[slug].section
      // (captured when the LO created the tray) so they land in the
      // section they were added to.
      var stored = (_review.docs && _review.docs[slug]) || {};
      var meta = DOC_META[slug] || { section: stored.section || 'loan', label: stored.label || slug, conditions: stored.conditions || '' };
      var sec = meta.section || stored.section || 'loan';
      if (!bySection[sec]) bySection[sec] = [];
      bySection[sec].push(slug);
    });
    // Deploy 236.161 — section header now includes a "Show N hidden"
    // toggle when this section has any hidden trays. Hidden trays
    // are rendered below the visible ones, dimmed, with an "Unhide"
    // button replacing the verdict actions.
    var docs = _review.docs || {};
    var hiddenBySection = {};
    Object.keys(docs).forEach(function(s) {
      if (!docs[s] || !docs[s].hidden) return;
      var meta = DOC_META[s] || { section: (docs[s] && docs[s].section) || 'loan' };
      var sec = meta.section || (docs[s] && docs[s].section) || 'loan';
      (hiddenBySection[sec] = hiddenBySection[sec] || []).push(s);
    });
    return SECTIONS.map(function(sec) {
      var slugsInSec = bySection[sec.key] || [];
      var hiddenInSec = hiddenBySection[sec.key] || [];
      if (!slugsInSec.length && !hiddenInSec.length) return '';
      var showHidden = _showHidden[sec.key] === true;
      var hiddenToggle = hiddenInSec.length
        ? '<button class="dr-section-toggle" onclick="dr_toggleHiddenInSection(\'' + escAttr(sec.key) + '\')">' +
            (showHidden ? 'Hide ' : 'Show ') + hiddenInSec.length + ' hidden' +
          '</button>'
        : '';
      var hiddenHtml = (showHidden && hiddenInSec.length)
        ? hiddenInSec.map(renderTray).join('')
        : '';
      // Deploy 236.162 — "+ Add Document" creates a custom tray in this
      // section. Deploy 236.501 — relabeled "+ Add Other Document" and
      // moved into the per-section "Other Documents" area below.
      var addBtn = '<button class="dr-section-toggle dr-add-doc-btn" onclick="dr_openAddDocModal(\'' + escAttr(sec.key) + '\',\'' + escAttr(sec.label) + '\')">+ Add Other Document</button>';
      // Deploy 236.164 — bulk "Approve all pending" per section.
      // Counts trays in this section that have a doc uploaded AND
      // verdict is still pending (i.e. awaiting processor click).
      // Skips trays with no doc, hidden trays, already-approved /
      // issues / na trays. Button only renders when there's
      // something to bulk-approve.
      var bulkable = slugsInSec.filter(function(s) {
        var dd = docs[s] || {};
        if (dd.hidden) return false;
        if ((dd.verdict || 'pending') !== 'pending') return false;
        return !!(dd.currentDocId || (Array.isArray(dd.documents) && dd.documents.some(function(x) { return x && !x.hidden; })));
      });
      var bulkBtn = bulkable.length
        ? '<button class="dr-section-toggle dr-bulk-approve-btn" onclick="dr_bulkApprove(\'' + escAttr(sec.key) + '\')" title="Approve every uploaded doc in this section that\'s still pending">✓ Approve ' + bulkable.length + ' pending</button>'
        : '';

      // Deploy 236.501 — split this section's visible slugs into standard
      // checklist docs and "Other" (custom / uncategorized) docs so every
      // category gets a standing "Other Documents" area. The Add button +
      // empty-state hint only render on the Pending tab (the working view);
      // on the Reviewed tab we still group any reviewed Other docs here.
      var standardInSec = slugsInSec.filter(function(s) { return !_isOtherSlug(s); });
      var otherInSec    = slugsInSec.filter(function(s) { return _isOtherSlug(s); });
      var showOtherAdd  = (_activeTab === 'pending');
      var otherBlock = '';
      if (otherInSec.length || showOtherAdd) {
        otherBlock =
          '<div class="dr-other-block">' +
            '<div class="dr-other-head">' +
              '<span class="dr-other-title">Other Documents</span>' +
              (showOtherAdd ? addBtn : '') +
            '</div>' +
            (otherInSec.length
              ? otherInSec.map(renderTray).join('')
              : (showOtherAdd
                  ? '<div class="dr-other-empty">Nothing here yet. Use “+ Add Other Document” for a doc that isn’t on the checklist, or route uncategorized files here from an “Upload ZIP”.</div>'
                  : '')) +
          '</div>';
      }

      return '<div class="dr-section">' +
        '<div class="section-title-row">' +
          '<div class="section-title">' + escHtml(sec.label) + '</div>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">' + bulkBtn + hiddenToggle + '</div>' +
        '</div>' +
        standardInSec.map(renderTray).join('') +
        otherBlock +
        hiddenHtml +
      '</div>';
    }).join('');
  }

  // Deploy 236.501 — a slug is an "Other" (non-checklist) doc when it was
  // created via the Add-Other flow or a bulk-zip Other route. Standard
  // checklist slugs live in DOC_META; custom ones carry isCustom + a
  // custom_/other_ prefix.
  function _isOtherSlug(slug) {
    var d = (_review.docs && _review.docs[slug]) || {};
    return d.isCustom === true || /^(custom_|other_)/.test(String(slug || ''));
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
    var verdict = d.verdict || 'pending';
    var hasDoc = !!d.currentDocId;
    // Deploy 236.161 — Awaiting Review: when a doc has been uploaded
    // but the processor hasn't acted yet, the tray takes the AI
    // verdict's color (approved/issues/pending) and the badge reads
    // "Awaiting Review" instead of "Pending". Mike's call — it
    // makes the AI's pre-screen color signal at-a-glance, while
    // making it clear the processor still has to confirm.
    var effectiveVerdict = verdict;
    var verdictLabel;
    if (verdict === 'pending') {
      verdictLabel = hasDoc ? 'Awaiting Review' : 'Pending';
      if (hasDoc && d.aiVerdict === 'approved') effectiveVerdict = 'awaiting-ok';
      else if (hasDoc && d.aiVerdict === 'issues') effectiveVerdict = 'awaiting-issues';
      else if (hasDoc) effectiveVerdict = 'awaiting';
    } else {
      verdictLabel = verdict === 'approved' ? 'Approved'
                   : verdict === 'issues'   ? 'Issues'
                   : verdict === 'na'       ? 'N/A'
                   : 'Pending';
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
              '<button class="dr-rename-btn" title="Rename" onclick="dr_renameDocAt(\'' + escAttr(slug) + '\',\'' + escAttr(ld.docId) + '\')">&#x270e;</button>' +
            '</div>' +
            '<div class="doc-meta">' + sizeKb + ' KB &middot; uploaded ' + formatDate(ld.uploadedAt) + '</div>' +
          '</div>' +
          '<div class="doc-actions">' +
            '<button class="small-btn" onclick="dr_viewDoc(\'' + escAttr(ld.docId) + '\')">View</button>' +
            '<button class="small-btn" onclick="dr_downloadOneDoc(\'' + escAttr(ld.docId) + '\',\'' + escAttr(ld.filename || ld.docId) + '\')" title="Download this PDF">⬇</button>' +
            '<button class="small-btn danger" onclick="dr_removeDocAt(\'' + escAttr(slug) + '\',\'' + escAttr(ld.docId) + '\')">Remove</button>' +
          '</div>' +
        '</div>';
    });
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
              '<button class="small-btn" onclick="dr_viewDoc(\'' + escAttr(hd.docId) + '\')">View</button>' +
              '<button class="small-btn" onclick="dr_unhideDoc(\'' + escAttr(slug) + '\',\'' + escAttr(hd.docId) + '\')" title="Unhide this document">↩ Unhide</button>' +
            '</div>' +
          '</div>';
      });
      currentHtml += '</details>';
    }

    var aiHtml = renderAiBlock(d, slug);

    var dz =
      '<label class="dropzone" id="dr-dz_' + escAttr(slug) + '" ondragover="dr_dzOver(event,\'' + escAttr(slug) + '\')" ondragleave="dr_dzLeave(event,\'' + escAttr(slug) + '\')" ondrop="dr_dzDrop(event,\'' + escAttr(slug) + '\')">' +
        '<div class="dz-icon">📄</div>' +
        '<div class="dz-text">' + (d.currentDocId ? 'Replace document' : 'Drop a PDF here') + '</div>' +
        '<div class="dz-hint">' + (d.currentDocId ? 'A new upload will move the current doc into Prior Reviews' : 'or click to choose a file') + '</div>' +
        // Deploy 236.166 — accept images alongside PDFs. Drivers
        // licenses, voided checks, IDs commonly come in as JPEG /
        // PNG / HEIC; the AI helper now routes them through the
        // image block. The file picker still hides everything else
        // by default but the LO can switch to "All files" if
        // needed.
        '<input type="file" accept="application/pdf,.pdf,image/jpeg,image/png,image/gif,image/webp,image/heic" onchange="dr_dzPick(event,\'' + escAttr(slug) + '\')" />' +
      '</label>';

    // Deploy 236.158 — notes save indicator. The textarea fires on
    // blur (onchange) — the indicator next to the label flashes
    // "Saving…" → "Saved ✓" so the LO can see the autosave landed.
    var notes =
      '<div class="dr-notes-wrap">' +
        '<div class="dr-notes-label">' +
          '<span>Processor notes</span>' +
          '<span class="dr-notes-status" id="dr-notes-status_' + escAttr(slug) + '"></span>' +
        '</div>' +
        '<textarea class="notes-area" placeholder="Processor notes (optional)…" data-slug="' + escAttr(slug) + '" onchange="dr_saveNotes(\'' + escAttr(slug) + '\', this.value)">' +
          escHtml(d.processorNotes || '') +
        '</textarea>' +
      '</div>';

    var verdictBtns;
    if (verdict === 'approved' || verdict === 'na') {
      verdictBtns =
        '<button class="v-btn unapprove" onclick="dr_setVerdict(\'' + escAttr(slug) + '\',\'pending\')">↶ Reopen for editing</button>';
    } else {
      var approveOnclick = (d.aiVerdict === 'issues')
        ? "dr_openOverrideModal('" + escAttr(slug) + "')"
        : "dr_setVerdict('" + escAttr(slug) + "','approved')";
      var approveLabel = (d.aiVerdict === 'issues') ? '✓ Override AI &amp; Approve' : '✓ Approve';
      verdictBtns =
        '<button class="v-btn approve" onclick="' + approveOnclick + '"' + (d.currentDocId ? '' : ' disabled title="Upload a doc first"') + '>' + approveLabel + '</button>' +
        '<button class="v-btn issues" onclick="dr_setVerdict(\'' + escAttr(slug) + '\',\'issues\')">⚠ Flag Issues</button>' +
        '<button class="v-btn na" onclick="dr_openNaModal(\'' + escAttr(slug) + '\')">○ Mark N/A</button>';
    }
    // Deploy 236.161 — hide/unhide control. Trays the LO marks
    // as not relevant disappear from the main flow and pile up
    // under a per-section "Show N hidden" toggle (renderSections).
    // Patches the per-doc hidden flag on the review record.
    verdictBtns += d.hidden
      ? '<button class="v-btn unapprove" onclick="dr_toggleHideTray(\'' + escAttr(slug) + '\', false)" title="Unhide this tray">↩ Unhide</button>'
      : '<button class="v-btn unapprove" onclick="dr_toggleHideTray(\'' + escAttr(slug) + '\', true)" title="Hide this tray (not relevant to this loan)">⊘ Hide tray</button>';

    var naBlock = verdict === 'na' && d.naReason
      ? '<div style="margin-top:10px;padding:10px 14px;background:var(--dr-blue-light);border:1px solid var(--dr-blue-border);border-radius:6px;font-size:12px;color:var(--dr-blue);"><strong>N/A:</strong> ' + escHtml(d.naReason) + '</div>'
      : '';

    var historyHtml = '';
    if (Array.isArray(d.history) && d.history.length) {
      historyHtml = '<details class="history-accordion"><summary>Prior reviews (' + d.history.length + ')</summary>' +
        d.history.map(function(h) {
          return '<div class="history-row">' +
            '<div class="h-filename">' + escHtml(h.filename || '(unnamed)') + '</div>' +
            '<div class="h-meta">' + formatDate(h.uploadedAt) + ' &middot; verdict: ' + escHtml(h.verdict || 'pending') + '</div>' +
            (h.processorNotes ? '<div class="h-notes">Notes: ' + escHtml(h.processorNotes) + '</div>' : '') +
            '<div style="margin-top:6px;"><button class="small-btn" onclick="dr_viewDoc(\'' + escAttr(h.docId) + '\')">View</button></div>' +
          '</div>';
        }).join('') +
      '</details>';
    }

    // Deploy 236.162 — custom trays get a pencil next to the name
    // for inline rename of the TRAY LABEL (separate from the file
    // rename pencil on currentFilename below). Standard checklist
    // trays don't show the pencil — their labels are spec'd.
    var trayNameHtml = '<span class="tray-name-text">' + escHtml(meta.label) + '</span>';
    if (d.isCustom) {
      trayNameHtml +=
        '<button class="dr-tray-rename-btn" title="Rename tray" onclick="event.stopPropagation();dr_renameTrayLabel(\'' + escAttr(slug) + '\')">&#x270e;</button>';
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
    var mrBadge = d.manualReviewRequested
      ? '<div class="dr-mr-badge" title="' + escAttr(d.manualReviewNote || 'The borrower asked for a manual review of this document.') + '">⚠ Manual review requested by borrower</div>'
      : (d.uploadedByBorrower ? '<div class="dr-br-badge">⬆ Uploaded by borrower</div>' : '');

    return '<div class="tray ' + effectiveVerdict + (d.hidden ? ' is-hidden' : '') + '" id="dr-tray_' + escAttr(slug) + '">' +
      '<div class="tray-head" onclick="dr_toggleExpand(\'' + escAttr(slug) + '\')">' +
        '<div style="min-width:0;flex:1">' +
          '<div class="tray-name" id="dr-tray-name_' + escAttr(slug) + '">' + trayNameHtml + '</div>' +
          '<div class="tray-conditions">' + escHtml(meta.conditions) + '</div>' +
          expBadge +
          compBadge +
          mrBadge +
        '</div>' +
        '<span class="tray-verdict ' + effectiveVerdict + '">' + verdictLabel + '</span>' +
      '</div>' +
      '<div class="tray-body' + (expanded ? '' : ' collapsed') + '">' +
        currentHtml +
        aiHtml +
        dz +
        notes +
        naBlock +
        '<div class="verdict-actions">' + verdictBtns + '</div>' +
        historyHtml +
      '</div>' +
    '</div>';
  }

  function renderAiBlock(d, slug) {
    if (!d.currentDocId && _uploadingSlug !== slug) return '';
    if (_uploadingSlug === slug) {
      return '<div class="ai-block pending">' +
        '<div class="ai-head">' +
          '<span class="ai-label pending"><span class="ai-spinner"></span> AI is reviewing this document…</span>' +
        '</div>' +
        '<div class="ai-summary">This usually takes 5–15 seconds. The verdict is advisory — you still confirm with Approve / Flag / N/A.</div>' +
      '</div>';
    }
    if (!d.aiVerdict) {
      if (d.aiError) {
        // Deploy 236.166 — "Retry AI Review" button. Visible whenever
        // the helper errored (Anthropic 400/500/timeout). Also
        // appears at the bottom of the AI block on successful runs
        // (below) so the LO can re-run after tweaking processor
        // notes or replacing the doc.
        return '<div class="ai-block issues">' +
          '<div class="ai-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
            '<span class="ai-label issues">⚠ AI review failed</span>' +
            '<button class="small-btn" onclick="dr_retryAi(\'' + escAttr(slug) + '\', this)" title="Re-run the AI against this document">↻ Retry AI Review</button>' +
          '</div>' +
          '<div class="ai-summary">' + escHtml(d.aiNotes || 'No details.') + '</div>' +
        '</div>';
      }
      return '';
    }
    var cls = d.aiVerdict === 'approved' ? 'approved' : 'issues';
    var icon = d.aiVerdict === 'approved' ? '✓ AI verdict: looks good' : '⚠ AI verdict: issues found';
    var cost = d.aiCostCents ? '$' + (Number(d.aiCostCents) / 100).toFixed(4) : '';
    var findingsHtml = '';
    if (Array.isArray(d.aiFindings) && d.aiFindings.length) {
      findingsHtml = '<div class="ai-findings">' + d.aiFindings.map(function(f) {
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
    return '<div class="ai-block ' + cls + '">' +
      '<div class="ai-head" style="display:flex;justify-content:space-between;align-items:center;gap:12px">' +
        '<span class="ai-label ' + cls + '">' + icon + '</span>' +
        '<div style="display:flex;align-items:center;gap:8px">' +
          (cost ? '<span class="ai-cost">' + cost + ' • ' + formatDate(d.aiReviewedAt) + '</span>' : '') +
          // Deploy 236.166 — re-run on demand. Useful after the
          // processor uploads notes or wants a fresh take.
          '<button class="small-btn" onclick="dr_retryAi(\'' + escAttr(slug) + '\', this)" title="Re-run the AI against this document">↻ Retry</button>' +
        '</div>' +
      '</div>' +
      (d.aiNotes ? '<div class="ai-summary">' + escHtml(d.aiNotes) + '</div>' : '') +
      findingsHtml +
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

    _uploadingSlug = slug;
    _expanded[slug] = true;
    render();
    // Deploy 236.502 — large files get auto-compressed in the browser
    // before upload; warn up front since it can take a few seconds.
    if ((file.size || 0) > 4.2 * 1024 * 1024) {
      showToast('Large file — compressing before upload…', 'info');
    } else {
      showToast('Uploading ' + file.name + '…', 'info');
    }
    var uploadOpts = {};
    if (opts.mode)           uploadOpts.mode = opts.mode;
    if (opts.replaceDocIds)  uploadOpts.replaceDocIds = opts.replaceDocIds;
    global.SLA.LoanReviews.uploadDoc(_review.id, slug, file, uploadOpts).then(function(r) {
      _review = r.review;
      _uploadingSlug = null;
      var dd = r.review.docs[slug] || {};
      // Deploy 236.502 — surface that the stored copy was auto-compressed
      // so the processor knows to verify legibility against the original.
      if (dd.autoCompressed) {
        var wasMb = dd.originalSizeBytes ? (dd.originalSizeBytes / 1024 / 1024).toFixed(1) : '';
        var nowMb = dd.currentSize ? (dd.currentSize / 1024 / 1024).toFixed(1) : '';
        showToast('Uploaded — auto-compressed' + (wasMb ? ' from ' + wasMb + ' MB to ' + nowMb + ' MB' : '') + ' to fit. Please verify legibility.', 'info');
      } else {
        var verdict = dd.aiVerdict || '';
        if (verdict === 'approved')      showToast('Uploaded — AI says looks good.', 'success');
        else if (verdict === 'issues')   showToast('Uploaded — AI flagged issues. Review below.', 'info');
        else                             showToast('Uploaded.', 'success');
      }
      render();
    }).catch(function(err) {
      _uploadingSlug = null;
      showToast('Upload failed: ' + (err.message || 'Unknown'), 'error');
      render();
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
      return Object.assign({}, d, { filename: next });
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
      // Belt-and-suspenders: also strip the entry from documents[]
      // locally in case the backend doesn't (the delete endpoint
      // historically only nulled current* fields).
      var docState = _review.docs[slug] || {};
      if (Array.isArray(docState.documents)) {
        var next = docState.documents.filter(function(d) { return d && d.docId !== docId; });
        if (next.length !== docState.documents.length) {
          var patch = { docs: {} };
          patch.docs[slug] = { documents: next };
          // Promote a new primary if we just removed it.
          if (docState.currentDocId === docId) {
            var newPrimary = next.find(function(d) { return d && !d.hidden; });
            if (newPrimary) {
              patch.docs[slug].currentDocId      = newPrimary.docId;
              patch.docs[slug].currentFilename   = newPrimary.filename || '';
              patch.docs[slug].currentSize       = newPrimary.size || 0;
              patch.docs[slug].currentMimeType   = newPrimary.mimeType || 'application/pdf';
              patch.docs[slug].currentUploadedAt = newPrimary.uploadedAt || '';
            }
          }
          global.SLA.LoanReviews.patch(_review.id, patch).then(function(r2) {
            _review = r2.review;
            render();
          }).catch(function() { render(); });
        } else { render(); }
      } else { render(); }
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
  global.dr_retryAi = function(slug, btn) {
    if (!_review || !_review.id) return;
    var originalHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Reviewing…'; }
    global.SLA.LoanReviews.retryAi(_review.id, slug).then(function(r) {
      _review = r.review || _review;
      var v = (_review.docs[slug] && _review.docs[slug].aiVerdict) || '';
      if (v === 'approved')    showToast('Re-reviewed — AI says looks good.', 'success');
      else if (v === 'issues') showToast('Re-reviewed — AI flagged issues. See below.', 'info');
      else                     showToast('Re-reviewed.', 'success');
      render();
    }).catch(function(err) {
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
      showToast('Retry failed: ' + ((err && err.message) || 'unknown'), 'error');
    });
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
    var u = global.netlifyIdentity && global.netlifyIdentity.currentUser();
    if (!u || !u.jwt) { showToast('Not signed in.', 'error'); return; }
    u.jwt().then(function(token) {
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
    global.SLA.LoanReviews.viewDoc(_review.id, docId).catch(function(err) {
      showToast('Could not open doc: ' + (err.message || 'Unknown'), 'error');
    });
  };

  // Deploy 236.161 — hide / unhide a tray on the review record.
  // Patches docs[slug].hidden = true|false; render() filters
  // hidden trays out of the main flow and into a per-section
  // collapsible.
  global.dr_toggleHideTray = function(slug, hide) {
    var patch = { docs: {} };
    patch.docs[slug] = { hidden: !!hide };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast(hide ? 'Tray hidden.' : 'Tray unhidden.', 'success');
      render();
    }).catch(function(err) {
      showToast('Hide/unhide failed: ' + (err.message || 'Unknown'), 'error');
    });
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
    var docs = _review.docs || {};
    var targets = [];
    var aiIssuesSkipped = 0;
    Object.keys(docs).forEach(function(s) {
      var dd = docs[s] || {};
      if (dd.hidden) return;
      var meta = DOC_META[s] || { section: dd.section || 'loan' };
      if ((meta.section || dd.section || 'loan') !== sectionKey) return;
      if ((dd.verdict || 'pending') !== 'pending') return;
      var hasDoc = !!(dd.currentDocId || (Array.isArray(dd.documents) && dd.documents.some(function(x) { return x && !x.hidden; })));
      if (!hasDoc) return;
      if (dd.aiVerdict === 'issues') { aiIssuesSkipped++; return; }
      targets.push(s);
    });
    if (!targets.length) {
      showToast(aiIssuesSkipped
        ? 'Nothing to bulk-approve. ' + aiIssuesSkipped + ' doc(s) need a manual AI-issues override.'
        : 'Nothing to bulk-approve in this section.', 'info');
      return;
    }
    var msg = 'Approve ' + targets.length + ' pending document' + (targets.length === 1 ? '' : 's') + ' in this section?';
    if (aiIssuesSkipped) msg += '\n\n(' + aiIssuesSkipped + ' doc(s) with AI-flagged issues will be SKIPPED — open those individually to override.)';
    if (!confirm(msg)) return;

    var now = new Date().toISOString();
    var actor = (_user && _user.email) || '';
    var patch = { docs: {} };
    targets.forEach(function(s) {
      patch.docs[s] = { verdict: 'approved', approvedAt: now, approvedBy: actor };
    });
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Approved ' + targets.length + ' document' + (targets.length === 1 ? '' : 's') + '.', 'success');
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
  global.dr_openAddDocModal = function(sectionKey, sectionLabel) {
    _pendingAddDoc = { sectionKey: sectionKey, sectionLabel: sectionLabel };
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

  // Deploy 236.162 — inline rename of a CUSTOM TRAY's label.
  // Distinct from dr_renameDoc which renames the uploaded file's
  // currentFilename. The tray's display name (meta.label) lives
  // on docs[slug].label for custom trays; this swaps it inline
  // and patches via SLA.LoanReviews.patch.
  global.dr_renameTrayLabel = function(slug) {
    var d = _review.docs[slug] || {};
    var nameEl = document.getElementById('dr-tray-name_' + slug);
    if (!nameEl) return;
    var current = d.label || slug;
    nameEl.innerHTML =
      '<input class="dr-rename-input" type="text" value="' + escAttr(current) + '" onclick="event.stopPropagation()" />' +
      '<button class="small-btn dr-rename-save" onclick="event.stopPropagation();dr_commitTrayRename(\'' + escAttr(slug) + '\')">Save</button>' +
      '<button class="small-btn dr-rename-cancel" onclick="event.stopPropagation();dr_cancelTrayRename(\'' + escAttr(slug) + '\')">Cancel</button>';
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
  global.dr_downloadZip = function(btn) {
    if (!_review || !_review.id) return;
    var originalHTML = btn ? btn.innerHTML : '';
    if (btn) { btn.disabled = true; btn.innerHTML = 'Building ZIP…'; }
    var u = global.netlifyIdentity && global.netlifyIdentity.currentUser();
    if (!u || !u.jwt) {
      if (btn) { btn.disabled = false; btn.innerHTML = originalHTML; }
      showToast('Not signed in.', 'error');
      return;
    }
    u.jwt().then(function(token) {
      return fetch('/api/loan-review-zip-download?reviewId=' + encodeURIComponent(_review.id), {
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
            var section = (secSel && secSel.value) || 'loan';
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
      '<button class="small-btn dr-rename-save" onclick="dr_commitRename(\'' + escAttr(slug) + '\')">Save</button>' +
      '<button class="small-btn dr-rename-cancel" onclick="dr_cancelRename(\'' + escAttr(slug) + '\')">Cancel</button>';
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
    patch.docs[slug] = { currentFilename: next };
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Renamed.', 'success');
      render();
    }).catch(function(err) {
      showToast('Rename failed: ' + (err.message || 'Unknown'), 'error');
      render();
    });
  };

  global.dr_setVerdict = function(slug, verdict) {
    var now = new Date().toISOString();
    var patch = { docs: {} };
    if (verdict === 'approved') {
      patch.docs[slug] = { verdict: 'approved', approvedAt: now, approvedBy: (_user && _user.email) || '' };
    } else if (verdict === 'issues') {
      patch.docs[slug] = { verdict: 'issues' };
    } else {
      patch.docs[slug] = { verdict: 'pending', approvedAt: '', approvedBy: '' };
    }
    global.SLA.LoanReviews.patch(_review.id, patch).then(function(r) {
      _review = r.review;
      showToast('Saved.', 'success');
      render();
    }).catch(function(err) { showToast('Save failed: ' + (err.message || 'Unknown'), 'error'); });
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
      verdict: 'na',
      naReason: reason,
      approvedAt: now,
      approvedBy: (_user && _user.email) || '',
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
