/**
 * loan-application-pdf.mjs — Render the signed Loan Application PDF
 *
 * Deploy 179. Produces the canonical printable record of a borrower's
 * signed loan application. Sections:
 *
 *   1. Header with SLA branding + document title + execution date
 *   2. Borrower / Guarantor block(s) — primary + co-guarantor if any
 *   3. Property & Loan block — address, type, purpose, amount, etc.
 *   4. Entity / Vesting block — LLC info if vesting in LLC
 *   5. Borrower Certifications — the text from ESIGN consent body
 *   6. Signature block — typed signature + signer name + timestamp
 *   7. Audit trail — IP, user agent, data hash, seal
 *
 * Returns a Buffer of PDF bytes.
 *
 * Designed to be functional and dense rather than fancy — this is a
 * legal record, not marketing collateral. Single-column layout, full-
 * width section headers, label/value rows with clear hierarchy.
 */
import PDFDocument from 'pdfkit';
import {
  ESIGN_CONSENT_TEXT,
  LOAN_ACKNOWLEDGEMENT_TEXT,
  PREQUAL_CREDIT_AUTH_TEXT,
  INFO_RELEASE_AUTH_TEXT,
} from './esign.mjs';
import { decryptField } from './crypto.mjs';
// Deploy 231.2 — parse the single-line Google formatted_address that
// the long app sometimes stores in g.address so we can render
// "Street, City, ST ZIP" on the Home/Previous/Mailing/Entity rows
// even when the form only captured a combined string.
import { parseAddress } from './address.mjs';

// SLA brand colors (RGB to match the rest of the app)
const PLUM       = '#261A36';
const GOLD       = '#C8813A';
const GOLD_LIGHT = '#F5E9D8';
const TEXT       = '#1A1520';
const MUTED      = '#7A7488';
const BORDER     = '#E4DFD4';

// Deploy 236.83 — map a signer's role string to the display label used
// in the PDF. Generalized from the prior borrower1/borrower2 ternary
// so we can render up to 4 borrowers without code duplication.
function roleLabelFor(role) {
  switch (role) {
    case 'borrower1': return 'Borrower / Guarantor 1';
    case 'borrower2': return 'Co-Borrower / Guarantor 2';
    case 'borrower3': return 'Co-Borrower / Guarantor 3';
    case 'borrower4': return 'Co-Borrower / Guarantor 4';
    default:          return 'Borrower / Guarantor 1';
  }
}

/**
 * Render the signed loan application PDF.
 *
 * @param {object} params
 * @param {object} params.record    - The borrower_info blob record
 * @param {object} params.client    - The client blob record (for entity fallback)
 * @param {Array<object>} params.signers - Array of signers. Each entry:
 *     { role: 'borrower1' | 'borrower2' | 'borrower3' | 'borrower4',
 *       name: string,
 *       email: string,
 *       audit: object | null,         // null if hasn\u2019t signed yet
 *       signedAuths: string[] }        // which forms they signed
 *   Order matters — first entry is rendered first.
 * @param {string} [params.status] - 'awaiting_borrower2' | 'complete'
 */
// Deploy 236.221 — Phase 4 of Mike's "Loan Details is the point of
// truth" refactor. Accept an optional `loan` param. When passed, the
// renderer prefers loan-level canonical values over the long-app
// snapshot for financial fields (loanAmt, purchasePrice, arv,
// rehabBudget, propValue, propertyAddress, loanType). Signature-flow
// callers (borrower-info-sign, borrower2-auth-sign) intentionally
// omit `loan` so the borrower signs what they typed. Download-flow
// callers (loan-bundle-download, loan-application-pdf-unsigned,
// signed-app-regenerate) pass it so LO-edits round-trip into the
// re-generated PDF.
export function renderSignedApplicationPDF({ record, client, signers, status, unsigned, enteredBy, loan }) {
  signers = signers || [];
  status = status || 'complete';
  // Deploy 231 — `unsigned` mode renders the same document but with no
  // signature claim. Used by the "Generate Application PDF (Unsigned)"
  // button on Loan Details for the save-on-behalf flow where the LO
  // captured the application data but the borrower never signed. The
  // PDF is an internal-use snapshot, not a legal record:
  //   - Title becomes LOAN APPLICATION (UNSIGNED — INTERNAL USE)
  //   - Every sigBlock renders a "[Unsigned — filled by LO on behalf
  //     of borrower]" stamp instead of the signature glyph
  //   - The audit-trail section is replaced with a single "Entered by"
  //     block showing the LO who triggered the generation
  unsigned = !!unsigned;
  enteredBy = enteredBy || {};  // { name, email, at }
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({
        size: 'LETTER',
        margins: { top: 54, bottom: 54, left: 54, right: 54 },
        info: {
          Title: 'SLA Capital — Signed Loan Application',
          Author: 'Sir Lends A Lot LLC dba SLA Capital',
          Subject: 'Loan Application',
          CreationDate: new Date(),
        },
      });

      // Collect output chunks
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      // Helpers
      const data = record.data || {};
      // Deploy 236.221 — Phase 4 override map. Only fields the LO can
      // inline-edit on Loan Details. Empty / null / undefined values
      // on the loan record are skipped so we don't blow away a good
      // long-app value with a blank. Applied as a shallow overlay so
      // the rest of `data.*` render paths are untouched.
      if (loan && typeof loan === 'object') {
        // Deploy 236.314 — DO NOT overwrite data.loanType with
        // loan.loanType. The DSCR sizer stores the TERM STRUCTURE
        // ("30Y Fixed" / "10/6 ARM" / "7/6 ARM" / "5/6 ARM") in
        // loan.loanType — a name collision with the borrower long-app's
        // data.loanType, which stores the LOAN PRODUCT code
        // ('dscr' / 'fix_flip' / 'transactional'). The old override
        // silently poisoned data.loanType, making isDSCR fail and
        // loanTermDisplay() return empty ("Loan Term" printed blank on
        // every DSCR long-app PDF). Prefer loan.toolType (product code)
        // and map 'rtl' → 'fix_flip' so LOAN_TYPE_LABEL resolves.
        const _productFromLoan = (loan.toolType === 'rtl') ? 'fix_flip' : loan.toolType;
        const LOAN_OVERRIDES = {
          loanAmt:         loan.loanAmt,
          requestedLoanAmt: loan.loanAmt,
          purchasePrice:   loan.purchasePrice,
          arv:             loan.arv,
          renoCost:        loan.rehabBudget,   // long-app uses renoCost, loan record uses rehabBudget
          rehabBudget:     loan.rehabBudget,
          propValue:       loan.propValue,
          propertyAddress: loan.address,
          loanType:        _productFromLoan,
        };
        for (const k of Object.keys(LOAN_OVERRIDES)) {
          const v = LOAN_OVERRIDES[k];
          if (v !== undefined && v !== null && v !== '') data[k] = v;
        }
      }
      // Deploy 236.148 — extended to support up to 4 guarantors
      // (g0..g3). The long-app sign flow still only collects g0+g1;
      // g2/g3 land here via the bundle download (loan-bundle-
      // download.mjs) which merges additional sub-form guarantors
      // into the guarantors[] array as positions 2 and 3.
      const guarantors = Array.isArray(data.guarantors) ? data.guarantors : [];
      const g0 = guarantors[0] || {};
      const g1 = guarantors[1] || null;
      const g2 = guarantors[2] || null;
      const g3 = guarantors[3] || null;
      // Truthy when at least one additional guarantor (G2-G4) exists.
      const extraGuarantors = [g1, g2, g3].filter(Boolean);
      const companies = Array.isArray(data.companies) ? data.companies : [];
      const co0 = companies[0] || {};

      const fmtAddr = (a) => {
        if (!a) return '';
        const parts = [a.street || a.address, a.city, [a.state, a.zip].filter(Boolean).join(' ')]
          .filter(Boolean);
        return parts.join(', ');
      };
      // Deploy 231.2 — format an address from either:
      //   - separate { street, city, state, zip } fields (preferred),
      //   - OR a single-line combined string where city/state/zip may
      //     already be embedded (Google formatted_address mode).
      // Robust to both. Avoids double-printing "Stevensville, MI" when
      // the borrower picked from autocomplete AND the form ALSO has
      // city/state filled in via Deploy 228's parser. Always returns
      // "Street, City, ST ZIP" shape when data is available.
      const fmtFullAddress = (street1Source, city, state, zip) => {
        const parsed = parseAddress(street1Source || '');
        const cleanStreet = (parsed.street1 || street1Source || '').trim();
        const cleanCity   = (String(city  || '').trim()) || parsed.city  || '';
        const cleanState  = (String(state || '').trim()) || parsed.state || '';
        const cleanZip    = (String(zip   || '').trim()) || parsed.zip   || '';
        const stateZip = [cleanState, cleanZip].filter(Boolean).join(' ');
        return [cleanStreet, cleanCity, stateZip].filter(Boolean).join(', ');
      };
      const fmtSSN = (ssn) => {
        if (!ssn) return '';
        const digits = String(ssn).replace(/\D/g, '');
        if (digits.length !== 9) return ssn;
        return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
      };
      // Deploy 236.148 — proper EIN formatter. The long-app form's
      // EIN input was previously running through the generic phone
      // mask, producing "(393) 565-836" for a raw 9-digit EIN.
      // Stored values may still be in that broken format — strip
      // all non-digits, reformat as the canonical NN-NNNNNNN at
      // render time so existing records display correctly even
      // before the input mask is fixed.
      const fmtEIN = (ein) => {
        if (!ein) return '';
        const digits = String(ein).replace(/\D/g, '');
        if (digits.length !== 9) return ein;
        return digits.slice(0, 2) + '-' + digits.slice(2);
      };
      // Resolve a guarantor\u2019s SSN for display on the signed PDF.
      // The borrower form encrypts SSNs at rest: plaintext is stripped
      // and the encrypted blob is stored as `ssn_enc`. For the signed
      // loan application we decrypt here so the document includes the
      // full SSN, which is required for underwriting. Note: the
      // resulting PDF (stored in signed_applications + emailed to the
      // borrower) will contain the unmasked SSN \u2014 this is a deliberate
      // tradeoff per business requirement, not a security regression.
      const resolveSSN = (g) => {
        if (!g) return '';
        if (g.ssn_enc) {
          try {
            const plain = decryptField(g.ssn_enc);
            if (plain) return plain;
          } catch (_) { /* fall through */ }
        }
        return g.ssn || '';
      };
      const fmtMoney = (n) => {
        const num = parseFloat(String(n || '').replace(/[$,]/g, ''));
        if (!isFinite(num) || num === 0) return '';
        return '$' + Math.round(num).toLocaleString('en-US');
      };

      // Derive the "executed" date for the header — use the most
      // recent signer\u2019s signed-at, or fall back to now if no signer
      // has signed yet (shouldn\u2019t happen in normal flow but defensive).
      const signedSigners = signers.filter((s) => s && s.audit && s.audit.signedAt);
      const latestSignedAt = signedSigners.length
        ? signedSigners.map((s) => s.audit.signedAt).sort().slice(-1)[0]
        : new Date().toISOString();

      // ── HEADER ──────────────────────────────────────────────────
      const startY = doc.y;
      doc.rect(0, 0, doc.page.width, 70).fill(PLUM);
      doc.fillColor(GOLD).font('Times-Bold').fontSize(20)
        .text('Sir Lends A Lot LLC', 54, 22);
      doc.fillColor(GOLD_LIGHT).font('Helvetica').fontSize(8)
        .text('SLA CAPITAL  ·  LOAN APPLICATION', 54, 46);
      // Doc date on the right
      doc.fillColor(GOLD_LIGHT).fontSize(8)
        .text('Executed: ' + new Date(latestSignedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
              doc.page.width - 250, 30, { width: 200, align: 'right' });
      // Gold rule under the header
      doc.rect(0, 70, doc.page.width, 2).fill(GOLD);

      doc.fillColor(TEXT).y = 90;

      // ── DOCUMENT TITLE ──────────────────────────────────────────
      // IMPORTANT: pass x + width explicitly. The previous text() call
      // (the Executed-date stamp on the right of the header) left the
      // sticky pdfkit text position at x \u2248 doc.page.width - 250 with
      // a 200px width. Without resetting here, "SIGNED LOAN
      // APPLICATION" centers inside that 200px box on the right edge
      // of the page instead of across the full content width.
      // Deploy 231 \u2014 title and banner depend on signed vs unsigned mode.
      const titleText = unsigned
        ? 'LOAN APPLICATION (UNSIGNED \u2014 INTERNAL USE)'
        : 'SIGNED LOAN APPLICATION';
      doc.font('Times-Bold').fontSize(16).fillColor(PLUM)
        .text(titleText, 54, doc.y, {
          width: doc.page.width - 108,
          align: 'center',
        });
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text('Sir Lends A Lot LLC dba SLA Capital  \u00B7  For business-purpose, investment property loans only.',
              54, doc.y, { width: doc.page.width - 108, align: 'center' });
      if (unsigned) {
        doc.moveDown(0.3);
        doc.fillColor('#9B5E1D').font('Helvetica-Bold').fontSize(9)
          .text('\u2014 UNSIGNED INTERNAL COPY \u00B7 Filled by Loan Officer on behalf of borrower \u2014',
                54, doc.y, { width: doc.page.width - 108, align: 'center' });
      } else if (status === 'awaiting_borrower2') {
        // If borrower 2 still hasn't signed, show a clearly-marked
        // "interim" banner so anyone reading the PDF knows it's not
        // yet the final fully-signed version.
        doc.moveDown(0.3);
        doc.fillColor('#9B5E1D').font('Helvetica-Bold').fontSize(9)
          .text('\u2014 INTERIM COPY: Awaiting Co-Borrower Signature \u2014',
                54, doc.y, { width: doc.page.width - 108, align: 'center' });
      }
      doc.moveDown(1.5);

      // ── Section helper ──────────────────────────────────────────
      // CRITICAL: always pass x + y + width explicitly so that any
      // upstream caller that left x positioned somewhere narrow
      // (e.g. the Executed-date stamp in the header, or the
      // Declarations table\u2019s cell text) doesn\u2019t pollute pdfkit\u2019s
      // sticky text position. Without this, the title and following
      // body text inherit a narrow column and wrap mid-word.
      function section(title) {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(9).fillColor(GOLD)
          .text(title.toUpperCase(), 54, doc.y, {
            width: doc.page.width - 108,
          });
        doc.moveTo(54, doc.y + 1).lineTo(doc.page.width - 54, doc.y + 1)
          .strokeColor(GOLD).lineWidth(0.5).stroke();
        doc.moveDown(0.4);
      }

      // Label/value row. Two columns by default — `wide` puts a single
      // value across the full width for things like addresses that
      // shouldn't be cramped.
      function row(label, value, opts) {
        opts = opts || {};
        if (doc.y > doc.page.height - 80) doc.addPage();
        const yStart = doc.y;
        const labelW = 130;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text(label, 54, yStart, { width: labelW });
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor(TEXT)
          .text(value || '—', 54 + labelW + 8, yStart, {
            width: doc.page.width - 54 - 54 - labelW - 8,
          });
        doc.y = Math.max(doc.y, yStart + 14);
      }

      // ── Label maps ──────────────────────────────────────────────
      // Borrower form stores enum codes; the PDF shows human-readable
      // labels matching the docx.
      const LOAN_TYPE_LABEL = {
        fix_flip:     'Fix and Flip Loan',
        dscr:         'DSCR (Rental Purchase or Refi)',
        dscr_2nd:     'DSCR 2nd Position',
        construction: 'New Construction',
      };
      const PROPERTY_TYPE_LABEL = {
        sfr:       'Single Family Home',
        '2-4':     '2-4 Unit Residential',
        mfr:       '5+ Unit Multifamily',
        condo_w:   'Condo - Warrantable',
        condo_nw:  'Condo - Non Warrantable',
        portfolio: 'Portfolio (Multiple Properties)',
        townhome:  'Townhome',
        manuf:     'Manufactured Home',
        rural:     'Rural (5+ Acres)',
      };
      const RENTAL_KIND_LABEL = {
        ltr:   'Long Term Rental (6+ Month leases)',
        str:   'Short Term Rental (AirBNB or leases under 6 months)',
        other: 'Other',
      };
      const PURCHASE_REFI_LABEL = {
        purchase:  'Purchase',
        refinance: 'Refinance',
      };
      const RENTAL_LEASE_LABEL = {
        month:    'Month-to-month',
        '6mo':    '6 months',
        '12mo':   '12 months',
        '24mo_plus': '24 months or longer',
        other:    'Other',
      };
      const YES_NO_LABEL = (v) => v === 'yes' ? 'Yes' : (v === 'no' ? 'No' : (v || ''));
      const CAP1 = (s) => s ? (s.charAt(0).toUpperCase() + s.slice(1)) : '';

      // The form only collects a Number of Units field for propertyType
      // '2-4' and 'mfr' (multifamily). For everything else the unit count
      // is implicitly 1. The docx form always has a Number of Units
      // value, so we resolve it here.
      const MULTI_PROP_TYPES = new Set(['2-4', 'mfr']);
      const resolvedNumUnits = MULTI_PROP_TYPES.has(data.propertyType)
        ? (data.numUnits || '')
        : '1';

      // Deploy 236.313 — hoist loanRec lookup so Section A can fall back
      // to it. When the LO generates the LOI before the borrower has
      // filled the long app (common in Admin Mode), `data.loanType` is
      // empty; without a fallback the "Loan Term" row prints blank.
      const loanRec = (() => {
        if (!record || !record.loanId || !client || !Array.isArray(client.loans)) return null;
        return client.loans.find((l) => l && l.id === record.loanId) || null;
      })();
      const pf = record.prefill || {};

      // Deploy 236.313 — fall back to the loan record's toolType when
      // the borrower hasn't filled the long app. RTL sizers store
      // toolType='rtl' but the LOAN_TYPE_LABEL key is 'fix_flip'.
      const loanType = data.loanType
                    || (loanRec && (loanRec.toolType === 'rtl' ? 'fix_flip' : loanRec.toolType))
                    || (pf.loan && pf.loan.toolType === 'rtl' ? 'fix_flip' : (pf.loan && pf.loan.toolType))
                    || '';
      const loanTypeLabel = LOAN_TYPE_LABEL[loanType] || loanType || '';
      const propertyTypeLabel = PROPERTY_TYPE_LABEL[data.propertyType] || data.propertyType || '';

      // The "Requested Loan Amount" field name varies by loan type
      // because the form has separate per-loan-type input fields.
      const requestedLoanAmt =
        data.requestedLoanFF || data.requestedLoanDSCR || data.requestedLoanNC ||
        data.requestedLoanAmt || data.loanAmt ||
        (record.prefill && record.prefill.loanAmt) || '';

      // The "Desired Closing Date" field also varies by loan type.
      const desiredCloseDate = data.ffCloseDate || data.dscrCloseDate || data.ncCloseDate || '';

      const isFF       = loanType === 'fix_flip';
      const isDSCR     = loanType === 'dscr' || loanType === 'dscr_2nd';
      // Deploy 236.313 — collapse the LO's specific sizer selection
      // ('refi_co' / 'refi_rt') back to 'refinance' for the binary
      // purchase/refi widgets in Section A, but let it flow through
      // specifically to the Section A.5 purposeDisplay() below.
      const _sizerPurpose = (loanRec && loanRec.loanPurpose)
        ? String(loanRec.loanPurpose).toLowerCase() : '';
      const _sizerBinary = (_sizerPurpose === 'refi_co' || _sizerPurpose === 'refi_rt')
        ? 'refinance'
        : (_sizerPurpose === 'purchase' ? 'purchase' : '');
      const _binaryPurpose = data.dscrPurchaseRefi || data.purchaseOrRefi
                          || data.loanPurpose || _sizerBinary || '';
      const isPurchase = _binaryPurpose === 'purchase';
      const isRefi     = _binaryPurpose === 'refinance';

      // ── SECTION A: PERSONAL LOAN PROPOSAL & PROPERTY INFO ──────
      // Matches the first table in the SLA Loan Application docx.
      section('Personal Loan Proposal and Property Information');
      row('Subject Property Address', data.propertyAddress
        || (record.prefill && record.prefill.propertyAddress) || '');
      row('Type of Loan Requested', loanTypeLabel);
      row('Property Type', propertyTypeLabel);
      row('Number of Units', resolvedNumUnits);
      row('Purchase or Refinance?', PURCHASE_REFI_LABEL[_binaryPurpose] || '');
      row('Original Purchase Date (if Refi)', isRefi ? (data.originalPurchaseDate || '') : '');
      row('Loan Term', loanTypeLabel);  // The docx labels this redundantly
      row('Requested Loan Amount', fmtMoney(requestedLoanAmt));
      row('Current Market Value (As Is)', fmtMoney(data.currentValue));
      row('Desired Closing Date', desiredCloseDate);
      doc.moveDown(0.5);

      // ── SECTION A.5: LOAN DETAILS ──────────────────────────────
      // Deploy 230 — mirrors the "Preliminary Transaction Details"
      // table on the DIYA LOI. Shows the priced loan terms the LO
      // generated in the sizer (rate, LTV, term, prepay, DSCR, purpose,
      // escrow). Surfaced here so borrowers signing the long
      // application see the pricing alongside the rest of their
      // representations. Backed up by the Disclaimer block below
      // Estimated Fees so borrowers understand these are preliminary.
      //
      // Pulls from the loan record (client.loans matched by
      // record.loanId), falling back to prefill / data when fields
      // aren't on the loan yet. Deploy 236.313 — loanRec + pf are now
      // hoisted above (Section A needs them too), reuse those.

      // Helpers for display formatting.
      const fmtPct = (v, digits) => {
        const n = parseFloat(String(v == null ? '' : v).replace(/[%,\s]/g, ''));
        if (!isFinite(n) || n === 0) return '';
        return n.toFixed(digits == null ? 2 : digits) + '%';
      };
      const fmtRatio = (v) => {
        const n = parseFloat(String(v == null ? '' : v).replace(/[x,\s]/gi, ''));
        if (!isFinite(n) || n === 0) return '';
        return n.toFixed(2) + 'x';
      };
      const calcLTV = () => {
        const amt  = parseFloat(String((loanRec && loanRec.loanAmt) || requestedLoanAmt || '').replace(/[$,]/g, ''));
        const val  = parseFloat(String((loanRec && loanRec.propValue) || data.currentValue || '').replace(/[$,]/g, ''));
        if (!isFinite(amt) || !isFinite(val) || val <= 0) return '';
        return ((amt / val) * 100).toFixed(0) + '%';
      };
      const loanTermDisplay = () => {
        // Deploy 236.314 — for DSCR, prefer the sizer's actual term
        // structure over a generic "360 Months". The sizer stores it in
        // loanRec.loanType as "30Y Fixed" / "10/6 ARM" / "7/6 ARM" /
        // "5/6 ARM" — that's the informative value to print on the app.
        if (loanRec && loanRec.term) return loanRec.term + ' Months';
        if (isDSCR) {
          const sizerTerm = loanRec && loanRec.loanType
            ? String(loanRec.loanType).trim() : '';
          if (/^30Y\s*Fixed$/i.test(sizerTerm))    return '30-Year Fixed (360 Months)';
          if (/^\d+\/\d+\s*ARM$/i.test(sizerTerm)) return sizerTerm + ' (360 Months)';
          if (sizerTerm) return sizerTerm;
          return '360 Months';
        }
        if (isFF)   return '12 Months';
        return '';
      };
      // Prepay codes are stored as compact strings (e.g. "5/4/3/2/1" or
      // "54321"). Show what was saved; if it's a clean compact form
      // expand to a human-readable label.
      const prepayDisplay = () => {
        const raw = (loanRec && loanRec.prepay) || data.prepay || '';
        if (!raw) return '';
        const compact = String(raw).replace(/[^0-9]/g, '');
        if (compact === '54321')  return '5 Year Stepdown (54321)';
        if (compact === '5555')   return '5 Year Flat (5555)';
        if (compact === '4321')   return '4 Year Stepdown (4321)';
        if (compact === '321')    return '3 Year Stepdown (321)';
        if (compact === '00000' || compact === '0') return 'None';
        return String(raw);
      };
      const purposeDisplay = () => {
        // Deploy 236.313 — prefer the LO's sizer selection when it's
        // more specific than the borrower's binary answer. The long-app
        // only asks "Purchase or Refinance" so `data.dscrPurchaseRefi`
        // is 'refinance' for BOTH cashout and rate/term deals — using
        // it first meant every refi printed as "Rate/Term Refi" even
        // when the LO priced it as a cashout. The sizer's loanPurpose
        // ('refi_co' / 'refi_rt' / 'purchase') is authoritative.
        const loRec = (loanRec && loanRec.loanPurpose) ? String(loanRec.loanPurpose).toLowerCase() : '';
        const code = loRec
                  || data.dscrPurchaseRefi || data.purchaseOrRefi || data.loanPurpose
                  || '';
        if (!code) return '';
        const c = String(code).toLowerCase();
        if (c === 'refi_co' || c === 'cashout' || c === 'cashout_refi' || c === 'cashout refi') return 'Cashout Refi';
        if (c === 'refi_rt' || c === 'rate_and_term' || c === 'refinance') return 'Rate/Term Refi';
        if (c === 'purchase') return 'Purchase';
        return PURCHASE_REFI_LABEL[c] || code;
      };

      const interestRateStr = fmtPct(loanRec && loanRec.rate, 3);
      const ltvStr          = calcLTV();
      const dscrStr         = fmtRatio((loanRec && loanRec.dscr) || data.estimatedDSCR);

      // Only render the section if we have at least one meaningful
      // value. Avoids an empty "Loan Details" header on records that
      // pre-date the sizer-priced loan (e.g. legacy app-only flows).
      const hasAnyLoanDetail = !!(interestRateStr || ltvStr || dscrStr || loanRec || data.prepay);
      if (hasAnyLoanDetail) {
        section('Loan Details');
        // Interest Rate gets an asterisk; full footnote rendered below
        // the section.
        if (interestRateStr) row('Interest Rate *', interestRateStr);
        if (ltvStr)          row('Loan-to-Value Ratio (LTV)', ltvStr);
        row('Loan Term', loanTermDisplay());
        const prepayStr = prepayDisplay();
        if (prepayStr)       row('Prepayment Penalty', prepayStr);
        if (dscrStr)         row('Estimated DSCR', dscrStr);
        const purposeStr = purposeDisplay();
        if (purposeStr)      row('Loan Purpose', purposeStr);
        row('Escrow Account', 'Yes (Taxes and Insurance)');

        // Rate-lock footnote (DIYA-style). Small italic muted body.
        doc.moveDown(0.3);
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED)
          .text(
            '* The Interest Rate will be locked following the execution date of this Letter of Intent or after all appraisals have been received, and the rate lock will be for 45 calendar days. Your Loan Interest Rate is based on loan credit parameters, represented by you (and stated in this Letter), and may be changed if differences are found in underwriting, at Originator’s sole discretion.',
            54, doc.y,
            { width: doc.page.width - 108, align: 'justify', lineGap: 1 }
          );
        doc.moveDown(0.6);
      }

      // ── SECTION A.6: ESTIMATED FEES & OTHER DETAILS ────────────
      // Deploy 230 — fees block matching the DIYA LOI. Underwriting +
      // Legal/Doc fees are SLA's standard DSCR fees ($1,695 + $500).
      // Rate Buydown and Origination Fee pull from the loan record so
      // they reflect what the LO actually quoted on the sizer.
      // Deploy 231.1 — separate Rate Buydown from Origination Fee.
      // The DSCR sizer stores loan.points as the COMBINED total
      // (formula in dscr-sizer.html: `_points = (1 + buydown).toFixed(2)
      // + ' pts'`). So `loan.points` carries both the 1pt origination
      // AND the rate-buydown points stacked on top. Mike wants the PDF
      // to show them as two distinct rows matching how the LO quoted
      // them in the sizer: Origination Fee separate from Rate Buydown.
      // Compute origination as (total points − buydown points).
      // For RTL where buydown is zero (no rate-buy concept), this just
      // returns the total points — still correct.
      const buydown      = (loanRec && loanRec.buydown != null) ? parseFloat(loanRec.buydown) : null;
      const totalPoints  = (loanRec && loanRec.points  != null) ? parseFloat(loanRec.points)  : null;
      const buydownNum   = (buydown   != null && isFinite(buydown))   ? buydown   : 0;
      const totalNum     = (totalPoints != null && isFinite(totalPoints)) ? totalPoints : null;
      const origNum      = (totalNum != null) ? Math.max(0, totalNum - buydownNum) : null;
      const fmtPoints = (n) => {
        if (n == null || !isFinite(n)) return '';
        return n.toFixed(n % 1 === 0 ? 0 : 2) + '% of the Loan Amount';
      };
      const buydownStr    = (buydown != null && isFinite(buydown) && buydown > 0) ? fmtPoints(buydown) : '0% of the Loan Amount';
      const origPointsStr = (origNum != null) ? fmtPoints(origNum) : '';

      // Render only when we have something meaningful (any priced loan
      // will, but pre-sizer records may not).
      // Deploy 236.86 — Mike's RTL relabel + fee restructure:
      //   - RTL: "Loan Processing Fee" $1,650 (combines $600 UW +
      //     $900 Doc Prep + $150 Credit/BG from the RTL rate sheet)
      //   - DSCR: unchanged ($1,695 Underwriting Fee)
      //   - Both: "Legal/Doc Fee" -> "Legal/Doc Review" (same $500)
      // Deploy 236.87 — GUC inherits the RTL fee structure (same
      // $1,650 Loan Processing Fee + $500 Legal/Doc Review).
      const _toolType = String((loanRec && loanRec.toolType) || '').toLowerCase();
      const isRtlOrGuc = (_toolType === 'rtl' || _toolType === 'guc');
      if (hasAnyLoanDetail) {
        section('Estimated Fees & Other Details *');
        row('Rate Buydown',  buydownStr);
        row('Origination Fee', origPointsStr || '—');
        if (isRtlOrGuc) {
          row('Loan Processing Fee', '$1,650');
        } else {
          row('Underwriting Fee', '$1,695');
        }
        row('Legal/Doc Review', '$500');
        // Appraisals row — long descriptive paragraph; render full-width.
        if (doc.y > doc.page.height - 100) doc.addPage();
        const apprStartY = doc.y;
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text('Appraisals', 54, apprStartY, { width: 130 });
        doc.font('Helvetica').fontSize(8.5).fillColor(TEXT)
          .text('Costs can vary based on several factors including geographic region, the service provider and the type of report ordered. Costs are controlled by independent third parties, subject to change without notice and are not within the Originator’s control. Borrower to pay appraiser directly.',
                54 + 130 + 8, apprStartY,
                { width: doc.page.width - 54 - 54 - 130 - 8, lineGap: 1 });
        doc.moveDown(0.4);

        // Footnote — matches DIYA LOI.
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED)
          .text(
            '^ The above estimates do not include title fees, borrower’s legal fees, or any other third-party costs incurred while closing the loan. We have a Title/Escrow vendor with whom we have a strong relationship and believe is the cheapest and most efficient option. If you have a strong preference to use another vendor, please let us know.',
            54, doc.y,
            { width: doc.page.width - 108, align: 'justify', lineGap: 1 }
          );
        doc.moveDown(0.6);

        // Deploy 231.3 — Disclaimer block moved to after the
        // Declarations section so it reads as a final clarification on
        // the borrower's representations rather than being interleaved
        // with the application data.
      }

      // ── SECTION B: F&F questions ────────────────────────────────
      if (isFF) {
        section('Questions for Fix and Flip Loans');
        row('Purchase Price', fmtMoney(data.purchasePrice));
        row('Expected ARV', fmtMoney(data.arv));
        row('Renovation Costs', fmtMoney(data.renoCost));
        row('Exit Strategy', CAP1(data.exitStrategy));
        row('Project Summary', data.planDescription || '');
        doc.moveDown(0.5);
      }

      // ── SECTION C: DSCR questions ────────────────────────────────
      if (isDSCR) {
        section('Questions for DSCR Loans');
        // Deploy 236.759 — MF (5+/'mfr') collects a unit-mix answer and an
        // annual operating statement instead of rentalKind + annual T/I/HOA.
        // The lease-length question was removed from the form entirely.
        const isMfrPdf = String(data.propertyType || '') === 'mfr';
        if (isMfrPdf) {
          row('Number of Units', data.numUnits || '');
          row('Are all units Long Term Rentals?', YES_NO_LABEL(data.allLtr));
          if (String(data.allLtr) === 'no') row('Units that are Long Term Rentals', data.ltrUnits || '');
        } else {
          row('What kind of rental is this?', RENTAL_KIND_LABEL[data.rentalKind] || '');
        }
        row('Property currently leased?', YES_NO_LABEL(data.allRented));
        if (String(data.allRented) === 'no' && data.emptyUnits) row('Units currently empty', data.emptyUnits);
        row('Monthly Rent (or Market Rent if vacant)', fmtMoney(data.currentRent));
        if (isMfrPdf) {
          row('Other Monthly Income', fmtMoney(data.otherIncomeMo));
          row('Annual Real Estate Taxes', fmtMoney(data.opexTaxes));
          row('Annual Property Insurance', fmtMoney(data.opexInsurance));
          row('Annual Flood Insurance', fmtMoney(data.opexFlood));
          row('Annual Utilities', fmtMoney(data.opexUtilities));
          row('Annual Repairs & Maintenance', fmtMoney(data.opexRepairs));
          row('Annual Property Management Fee', fmtMoney(data.opexMgmt));
          row('Annual HOA / Special Assessment', fmtMoney(data.opexHOA));
          row('Annual Landscaping', fmtMoney(data.opexLandscaping));
        } else {
          row('Annual Property Taxes', fmtMoney(data.annualTaxes));
          row('Annual Insurance Premium', fmtMoney(data.annualInsurance));
          row('HOA Dues (If Applicable)', fmtMoney(data.annualHOA));
        }
        row('Property in a Flood Zone?', CAP1(data.floodZone));
        doc.moveDown(0.5);
      } else {
        // Non-DSCR: still surface flood zone since the docx asks it
        // outside the DSCR-only table for some loan types
        if (data.floodZone) {
          section('Additional Property Info');
          row('Property in a Flood Zone?', CAP1(data.floodZone));
          if (data.bedrooms)  row('Number of Bedrooms', data.bedrooms);
          if (data.bathrooms) row('Number of Bathrooms', data.bathrooms);
          if (data.sqft)      row('Square Footage', data.sqft);
          doc.moveDown(0.5);
        }
      }

      // ── SECTION D: Guarantor Information ────────────────────────
      function renderGuarantorBlock(g, label) {
        if (!g) return;
        section(label);
        row('Full Legal Name', `${g.firstName || ''} ${g.lastName || ''}`.trim());
        row('Date of Birth', g.dob || '');
        row('Social Security Number', fmtSSN(resolveSSN(g)));
        row('Estimated Credit Score', g.fico || '');
        row('Email Address', g.email || '');
        row('Phone Number', g.phone || '');
        // Deploy 231.2 — Home Address now includes City, State, ZIP
        // assembled from the long-app fields (or parsed from the
        // single-line autocomplete value when the form didn't capture
        // them separately).
        row('Home Address', fmtFullAddress(g.address, g.city, g.state, g.zip));
        // Deploy 182: 2-year residency + previous address (conditional)
        row('At this address 2+ years?', YES_NO_LABEL(g.twoYearAddress));
        if (g.twoYearAddress === 'no' && g.prevAddress) {
          row('Previous Home Address', fmtFullAddress(g.prevAddress, g.prevCity, g.prevState, g.prevZip));
        }
        // Mailing address (if different)
        if (g.mailingSameAsHome === 'no') {
          row('Mailing Address (if different)', fmtFullAddress(g.mailingAddress, g.mailingCity, g.mailingState, g.mailingZip));
        } else if (g.mailingSameAsHome === 'yes') {
          row('Mailing Address (if different)', 'Same as home');
        }
        row('Marital Status', CAP1(g.marital));
        // Experience (form-specific; not in docx but useful)
        const expBits = [];
        if (g.flips != null && g.flips !== '')   expBits.push(`${g.flips} flips`);
        if (g.rentals != null && g.rentals !== '') expBits.push(`${g.rentals} rentals`);
        if (expBits.length) row('Investment Experience', expBits.join(' · '));
        doc.moveDown(0.5);
      }
      renderGuarantorBlock(g0, 'Guarantor 1');
      if (g1) renderGuarantorBlock(g1, 'Guarantor 2');
      // Deploy 236.148 — render Guarantor 3 and Guarantor 4 blocks
      // when their data is present in guarantors[2] / guarantors[3].
      if (g2) renderGuarantorBlock(g2, 'Guarantor 3');
      if (g3) renderGuarantorBlock(g3, 'Guarantor 4');

      // ── SECTION E: Entity Information ────────────────────────────
      const llcName    = data.llcName    || (co0 && co0.name)     || '';
      const llcEIN     = data.llcEIN     || (co0 && co0.ein)      || '';
      const llcState   = data.llcState   || (co0 && co0.state)    || '';
      const llcAddress = data.llcAddress || (co0 && co0.address)  || '';
      // Deploy 231.2 — entity address may also come through with
      // separate city/addrState/zip companions. The Companies array
      // entries store the address state under `addrState` (vs `state`
      // which is the jurisdiction); both are checked.
      const llcCity    = data.llcCity    || (co0 && co0.city)     || '';
      const llcAddrSt  = data.llcAddrState || (co0 && co0.addrState) || '';
      const llcZip     = data.llcZip     || (co0 && co0.zip)      || '';
      if (llcName || llcEIN || llcState || llcAddress) {
        section('Entity Information');
        row('Vesting Entity Name', llcName);
        // Deploy 236.148 — EIN formatter (was rendering as
        // phone-formatted "(393) 565-836" for raw 9-digit values).
        row('Vesting Entity EIN', fmtEIN(llcEIN));
        row('State Entity is Registered In', llcState);
        row('Vesting Entity Address', fmtFullAddress(llcAddress, llcCity, llcAddrSt, llcZip));
        // Deploy 182: ownership is now collected per-guarantor inside
        // their own block (g.ownership). Old code used g0Ownership/
        // g1Ownership at the top level — fall back to those for any
        // pre-Deploy-182 records.
        // Deploy 236.148 — extended to all 4 guarantors.
        //
        // Deploy 236.247 — LO-set LLC ownership on the Guarantors tab
        // is now the source of truth. Prior code read `g.ownership`
        // (the number each guarantor typed on their own long-app or
        // sub-form) and the four numbers routinely didn't add to
        // 100% or reflect the LO's negotiated split. The loan
        // record's `guarantorOwnership` map is keyed by client id
        // and edited via the Guarantors tab.
        //
        // Slots 2/3 already get this override at flatten time via
        // guarantor-synth.mjs, but slots 0/1 come from the
        // borrower_info snapshot and were never re-flattened. Overlay
        // for all four so nothing depends on the earlier stage.
        const _ownMap  = (loanRec && loanRec.guarantorOwnership) || {};
        const _addlIds = (loanRec && Array.isArray(loanRec.guarantorClientIds))
                          ? loanRec.guarantorClientIds : [];
        // Slot 0 always maps to the primary borrower's client id.
        const _g0Id = (client && client.id) || (record && record.clientId) || '';
        // Slots 1-3: prefer an id carried on the guarantor object
        // (guarantor-synth stamps this on the flattened record), fall
        // back to positional lookup in loan.guarantorClientIds.
        const _idFor = (g, addlIdx) =>
          (g && (g.id || g.clientId)) || _addlIds[addlIdx] || '';
        const g0Own = (_g0Id && _ownMap[_g0Id])
                     || (g0 && g0.ownership)
                     || data.g0Ownership || '';
        const g1Own = _ownMap[_idFor(g1, 0)]
                     || (g1 && g1.ownership)
                     || data.g1Ownership || '';
        const g2Own = _ownMap[_idFor(g2, 1)]
                     || (g2 && g2.ownership) || '';
        const g3Own = _ownMap[_idFor(g3, 2)]
                     || (g3 && g3.ownership) || '';
        row('Guarantor 1 % Ownership', g0Own ? `${g0Own}%` : '');
        if (g1) row('Guarantor 2 % Ownership', g1Own ? `${g1Own}%` : '');
        if (g2) row('Guarantor 3 % Ownership', g2Own ? `${g2Own}%` : '');
        if (g3) row('Guarantor 4 % Ownership', g3Own ? `${g3Own}%` : '');
        doc.moveDown(0.5);
      }

      // ── SECTION F: Declarations ──────────────────────────────────
      // Mirrors the docx Declarations table: rows are questions,
      // columns are Guarantor 1 and Guarantor 2 (if present).
      // Deploy 236.148 \u2014 generalized for 1-4 guarantors. Column
      // widths shrink as more guarantors are added so the table
      // stays within the 506pt printable width (Letter @ 54pt
      // side margins). Question column compresses; per-guarantor
      // columns stay fixed at 60-75pt.
      function declarationsTable() {
        if (doc.y > doc.page.height - 200) doc.addPage();
        section('Declarations');

        const activeGuarantors = [g0]
          .concat(g1 ? [g1] : [])
          .concat(g2 ? [g2] : [])
          .concat(g3 ? [g3] : []);
        const nGuarantors = activeGuarantors.length;
        const tableW = 506; // 612 page width - 2 * 54 margin
        const guarantorColW = nGuarantors >= 4 ? 60 :
                              nGuarantors === 3 ? 70 :
                              nGuarantors === 2 ? 75 : 75;
        const questionColW = tableW - (guarantorColW * nGuarantors);
        const colWidths = [questionColW].concat(
          activeGuarantors.map(() => guarantorColW)
        );
        const startX = 54;

        const declarations = [
          ['Are you a US Citizen?',                                                                                  'usCitizen'],
          ['Have you been declared bankrupt in the past 7 years?',                                                   'bankruptcy7yr'],
          ['Have you had a property foreclosed upon or given title or deed lieu thereof in the last 7 years?',       'foreclosure7yr'],
          ['Are you a party to a lawsuit?',                                                                          'partyToLawsuit'],
          ['Are you presently delinquent or in default on any Federal debt or any other loan or mortgage?',          'delinquentFederalDebt'],
          ['Have you directly or indirectly been obligated on any loan which resulted in foreclosure?',              'obligatedToForeclosed'],
          ['Are there any outstanding judgments against you?',                                                       'outstandingJudgments'],
          ['Do you intend to occupy the subject property?',                                                          'intendToOccupy'],
        ];

        // Header row
        const headerY = doc.y;
        doc.rect(startX, headerY, tableW, 18).fill(GOLD_LIGHT);
        doc.fillColor(TEXT).font('Helvetica-Bold').fontSize(8.5)
          .text('', startX + 6, headerY + 5, { width: colWidths[0] - 12 });
        let xCursor = startX + colWidths[0];
        for (let i = 0; i < nGuarantors; i++) {
          doc.text('Guarantor ' + (i + 1), xCursor + 6, headerY + 5,
                   { width: colWidths[i + 1] - 12, align: 'center' });
          xCursor += colWidths[i + 1];
        }
        doc.y = headerY + 18;

        declarations.forEach((d, i) => {
          // Deploy 236.149 — measure first, page-break second.
          // Previously the check was `doc.y > pageHeight - 60`
          // which let a row START on this page but then pdfkit's
          // text() auto-paginated mid-row, splitting the question
          // (page N) from the Yes/No cell values (page N+1, N+2).
          // Now we compute the row height up front and force a
          // page break if the WHOLE row won't fit.
          const questionH = doc.heightOfString(d[0], { width: colWidths[0] - 12, fontSize: 8 });
          const rowH = Math.max(20, questionH + 8);
          if (doc.y + rowH > doc.page.height - 54) {
            doc.addPage();
          }
          const rowY = doc.y;
          if (i % 2 === 0) {
            doc.rect(startX, rowY, tableW, rowH).fill('#FAF8F3');
          }
          doc.strokeColor(BORDER).lineWidth(0.4).rect(startX, rowY, colWidths[0], rowH).stroke();
          let cellX = startX + colWidths[0];
          for (let gi = 0; gi < nGuarantors; gi++) {
            doc.rect(cellX, rowY, colWidths[gi + 1], rowH).stroke();
            cellX += colWidths[gi + 1];
          }
          doc.fillColor(TEXT).font('Helvetica').fontSize(8)
            .text(d[0], startX + 6, rowY + 5, { width: colWidths[0] - 12 });
          doc.font('Helvetica-Bold').fontSize(9.5);
          cellX = startX + colWidths[0];
          for (let gi = 0; gi < nGuarantors; gi++) {
            doc.text(YES_NO_LABEL(activeGuarantors[gi][d[1]]) || '\u2014',
                     cellX, rowY + (rowH / 2) - 5,
                     { width: colWidths[gi + 1], align: 'center' });
            cellX += colWidths[gi + 1];
          }
          doc.y = rowY + rowH;
        });
        doc.moveDown(0.5);
      }
      declarationsTable();

      // ─────────────────────────────────────────────────────────
      // SIGNATURE BLOCK + AUDIT HELPERS (used per-signer below)
      // ─────────────────────────────────────────────────────────
      // Renders a boxed typed signature in script font, with the
      // typed-by caption underneath. If the signer hasn\u2019t signed yet
      // (audit is null), shows an empty box with a "[Signature pending
      // — Borrower 2]" placeholder so the document remains legible
      // when distributed as an interim copy.
      function sigBlock(signer, captionRole) {
        if (doc.y > doc.page.height - 130) doc.addPage();
        const sigY = doc.y + 4;
        doc.rect(54, sigY, doc.page.width - 108, 50)
          .strokeColor(BORDER).lineWidth(0.7).stroke();

        if (signer && signer.audit && signer.audit.signedAt) {
          doc.font('Times-Italic').fontSize(22).fillColor(PLUM)
            .text(signer.name || '', 64, sigY + 10, {
              width: doc.page.width - 128, height: 35,
            });
          doc.font('Helvetica').fontSize(8).fillColor(MUTED)
            .text(`Typed by ${signer.name || ''} on ` +
                  new Date(signer.audit.signedAt).toLocaleString('en-US', {
                    year: 'numeric', month: 'long', day: 'numeric',
                    hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
                  }) +
                  '   \u2014   ' + captionRole,
                  64, sigY + 56);
        } else if (unsigned) {
          // Deploy 231 — unsigned PDF: stamp instead of glyph. Caption
          // names the LO who entered the data so the file is traceable
          // even though it's not a signed legal record.
          doc.font('Helvetica-Bold').fontSize(11).fillColor('#9B5E1D')
            .text('[UNSIGNED — Filled by LO on behalf of borrower]',
                  64, sigY + 20, { width: doc.page.width - 128 });
          const eb = enteredBy.name || enteredBy.email || '';
          const ts = enteredBy.at
            ? new Date(enteredBy.at).toLocaleString('en-US', {
                year: 'numeric', month: 'long', day: 'numeric',
                hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
              })
            : '';
          const captionParts = [];
          if (eb) captionParts.push('Entered by ' + eb);
          if (ts) captionParts.push(ts);
          captionParts.push(captionRole);
          doc.font('Helvetica').fontSize(8).fillColor(MUTED)
            .text(captionParts.join('   —   '), 64, sigY + 56);
        } else {
          // Awaiting signature (interim copy waiting on Borrower 2)
          doc.font('Helvetica-Oblique').fontSize(11).fillColor('#9B5E1D')
            .text('[Signature pending — ' + captionRole + ']',
                  64, sigY + 20, { width: doc.page.width - 128 });
          doc.font('Helvetica').fontSize(8).fillColor(MUTED)
            .text(captionRole + ' has not yet signed this form.', 64, sigY + 56);
        }
        doc.y = sigY + 76;
      }

      // Helper to render a long body paragraph at full content width.
      // Same reason as section() — pdfkit text state is sticky; always
      // pass x explicitly so it doesn\u2019t inherit a narrow column from
      // an upstream caller.
      function paragraph(text, opts) {
        opts = opts || {};
        doc.font(opts.font || 'Helvetica').fontSize(opts.size || 8).fillColor(opts.color || TEXT)
          .text(text, 54, doc.y, Object.assign({
            width: doc.page.width - 108,
            lineGap: 1.5,
            align: 'justify',
          }, opts.textOpts || {}));
      }
      // Sub-section header inside a major section (e.g. "SIGNATURES")
      function subHeader(title) {
        doc.font('Helvetica-Bold').fontSize(9).fillColor(GOLD)
          .text(title.toUpperCase(), 54, doc.y, { width: doc.page.width - 108 });
        doc.moveTo(54, doc.y + 1).lineTo(doc.page.width - 54, doc.y + 1)
          .strokeColor(GOLD).lineWidth(0.5).stroke();
        doc.moveDown(0.4);
      }

      // Deploy 231.3 — Reordered narrative. New sequence:
      //   1. Disclaimer — Preliminary Terms (moved out of the Fees
      //      block, now anchors the end of the application-data
      //      sections).
      //   2. Electronic Signature Consent — with signatures. Borrowers
      //      first consent to e-sign, then the acknowledgements that
      //      follow are actually e-signed.
      //   3. Loan Application Acknowledgement & Agreement — with sigs.
      //   4. Authorization to Conduct Prequal Credit & Background
      //      Checks — one per signer.
      //   5. Authorization to Release Information — with sigs.
      //   6. Audit / Entry Record.

      // ── DISCLAIMER — PRELIMINARY TERMS ───────────────────────────
      // Deploy 231.4 — bottom-anchored to the Declarations page so it
      // reads as the final clarification at the foot of the data
      // sections. We measure the disclaimer's total height and position
      // doc.y so the block ends at the page bottom margin. If the
      // Declarations table ran long enough that there isn't room, we
      // fall back to rendering inline — pdfkit will auto-paginate.
      const _disPara1 = 'The proposed Loan Interest Rate and terms may be unilaterally withdrawn or adjusted by Originator in its sole discretion at any time in the event, during the underwriting process, certain loan parameters are determined to be materially and adversely different compared to those presented in this Application.';
      const _disPara2 = 'Please note this Application serves to outline the terms of the proposed financing of the referenced transaction. The terms set forth in this Application are merely a general proposal and are neither a binding offer nor a contract. Borrower understands and agrees that Originator is not obligated to enter into the transaction contemplated herein, on the terms set forth herein, or on any other terms, unless and until Originator obtains internal committee approval — predicated on multiple factors including but not limited to satisfactory appraisal, satisfactory credit review of the borrowing entity and Key Principals, satisfactory review of the property’s market, and Originator or its capital partner executes and delivers to Borrower final definitive loan documents, the terms of which shall supersede in their entirety the terms set forth herein.';
      const _disOpts  = { width: doc.page.width - 108, align: 'justify', lineGap: 1.5 };
      doc.font('Helvetica').fontSize(8.5);
      const _disH1 = doc.heightOfString(_disPara1, _disOpts);
      const _disH2 = doc.heightOfString(_disPara2, _disOpts);
      const _disBlockH = _disH1 + _disH2 + 38; // + section header + spacing
      const _bottomY = doc.page.height - doc.page.margins.bottom - _disBlockH;
      if (doc.y < _bottomY) doc.y = _bottomY;
      section('Disclaimer — Preliminary Terms');
      doc.font('Helvetica').fontSize(8.5).fillColor(TEXT)
        .text(_disPara1, 54, doc.y, _disOpts);
      doc.moveDown(0.4);
      doc.text(_disPara2, 54, doc.y, _disOpts);

      // ── SECTION 1: ESIGN/UETA CONSENT — with signatures ─────────
      // Deploy 231.4 — always starts on its own page so the consent
      // text + signature blocks are visually self-contained.
      doc.addPage();
      section('Electronic Signature Consent (ESIGN / UETA)');
      paragraph(ESIGN_CONSENT_TEXT);
      doc.moveDown(0.6);
      subHeader('Signatures');
      // Deploy 236.149 — signer.prequalOnly skips the ESIGN, Loan
      // Acknowledgement, and Info-Release signature loops. Used by
      // additional sub-form guarantors who signed their Credit
      // Authorization separately but did NOT sign the loan app
      // itself. They still get a full Prequal Credit & Background
      // Check page (the Prequal loop below does NOT skip them) so
      // their Credit Auth lands in the same long-app format as
      // the primary's.
      signers.forEach((signer) => {
        if (signer.prequalOnly) return;
        const role = roleLabelFor(signer.role);
        sigBlock(signer, role);
        doc.moveDown(0.3);
      });

      // ── SECTION 2: LOAN ACKNOWLEDGEMENT & AGREEMENT ─────────────
      if (doc.y > 400) doc.addPage();
      section('Loan Application Acknowledgement & Agreement');
      paragraph(LOAN_ACKNOWLEDGEMENT_TEXT);
      doc.moveDown(0.8);
      subHeader('Signatures');
      signers.forEach((signer) => {
        if (signer.prequalOnly) return;
        const role = roleLabelFor(signer.role);
        sigBlock(signer, role);
        doc.moveDown(0.3);
      });

      // ── SECTION 3: AUTHORIZATION TO CONDUCT PREQUAL CREDIT & BACKGROUND CHECKS ──
      // One copy per signer (each signer authorizes their OWN credit pull).
      // Deploy 231.4 — each signer's prequal auth gets its own page,
      // including the first one, so the consent text + signature block
      // are visually self-contained per borrower.
      signers.forEach((signer) => {
        doc.addPage();
        const role = roleLabelFor(signer.role);
        section(`Authorization to Conduct Prequal Credit & Background Checks — ${role}`);
        paragraph(PREQUAL_CREDIT_AUTH_TEXT);
        doc.moveDown(0.8);
        sigBlock(signer, role);
      });

      // ── SECTION 4: AUTHORIZATION TO RELEASE INFORMATION ─────────
      doc.addPage();
      section('Authorization to Release Information');
      paragraph(INFO_RELEASE_AUTH_TEXT);
      doc.moveDown(0.8);
      subHeader('Signatures');
      signers.forEach((signer) => {
        if (signer.prequalOnly) return;
        const role = roleLabelFor(signer.role);
        sigBlock(signer, role);
        doc.moveDown(0.3);
      });

      // ── AUDIT TRAIL ─────────────────────────────────────────────
      // One audit block per signer, since each signer is an
      // independent signature event with its own IP/UA/timestamp/seal.
      // Deploy 231 — unsigned PDFs swap this for an "Application Entry
      // Record" block (LO name + when, no crypto audit). See below.
      doc.addPage();
      if (unsigned) {
        section('Application Entry Record');
        const ebName  = enteredBy.name  || '';
        const ebEmail = enteredBy.email || '';
        const ebAt    = enteredBy.at    || '';
        doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
          .text('This is an internal-use copy of the loan application data collected on behalf of the borrower. It is not a signed legal document. The block below identifies the SLA Capital loan officer who entered the data and the time of entry.',
                54, doc.y, { width: doc.page.width - 108, lineGap: 1.5 });
        doc.moveDown(0.6);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(PLUM)
          .text('Entered By', 54, doc.y, { width: doc.page.width - 108 });
        doc.moveDown(0.3);
        if (ebName)  row('Loan Officer', ebName);
        if (ebEmail) row('Email', ebEmail);
        if (ebAt) {
          row('Entered at', new Date(ebAt).toLocaleString('en-US', {
            year: 'numeric', month: 'long', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
          }));
        }
        if (signers.length) {
          doc.moveDown(0.4);
          doc.font('Helvetica-Bold').fontSize(10).fillColor(PLUM)
            .text('Application Pertains To', 54, doc.y, { width: doc.page.width - 108 });
          doc.moveDown(0.3);
          signers.forEach((s) => {
            const r = roleLabelFor(s.role);
            row(r, (s.name || '') + (s.email ? '  —  ' + s.email : ''));
          });
        }
        doc.moveDown(0.6);
        doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED)
          .text(
            'No electronic-signature event has been recorded for this document. If a signed copy is required for closing, the borrower must complete the long-form loan application via the secure link sent to their email. This unsigned copy is provided for internal review only.',
            54, doc.y,
            { width: doc.page.width - 108, align: 'justify', lineGap: 1 }
          );
        doc.end();
        return;
      }
      section('Electronic Signature Audit');
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text('Each signer below represents an independent electronic-signature event recorded by the SLA Capital system.',
              54, doc.y, { width: doc.page.width - 108, lineGap: 1.5 });
      doc.moveDown(0.5);

      signers.forEach((signer, idx) => {
        if (idx > 0) doc.moveDown(0.6);
        const a = signer.audit;
        const role = roleLabelFor(signer.role);
        doc.font('Helvetica-Bold').fontSize(10).fillColor(PLUM)
          .text(role + ' \u2014 ' + (signer.name || ''), 54, doc.y, { width: doc.page.width - 108 });
        doc.moveDown(0.2);
        if (!a || !a.signedAt) {
          doc.font('Helvetica-Oblique').fontSize(9).fillColor('#9B5E1D')
            .text('[Signature pending — no audit event recorded yet.]',
                  54, doc.y, { width: doc.page.width - 108 });
          return;
        }
        row('Signer email', signer.email || '');
        row('Signed at (UTC)', a.signedAt || '');
        row('IP address', a.ipAddress || 'unavailable');
        row('User agent', (a.userAgent || '').slice(0, 100));
        if (a.geolocation) row('Geolocation', a.geolocation);
        row('Consent version', `v${a.consentVersion}`);
        row('Forms signed', (a.signedAuths || []).join(', '));
        row('Document content hash (SHA-256)', a.dataHash || '');
        row('Audit seal (HMAC-SHA256)', (a.seal || '').slice(0, 32) + '\u2026');
      });

      doc.moveDown(0.6);
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED)
        .text(
          'This document was electronically signed in accordance with the federal ESIGN Act (15 U.S.C. \u00A7 7001 et seq.) and applicable state UETA statutes. The audit trail above provides cryptographic evidence of each signing event. The content hash binds each signature to the specific data values reproduced in this document; any tampering with the borrower\u2019s stored record after signing would change this hash. The HMAC seal (computed with a server-side secret) provides tamper-evidence for the audit fields themselves.',
          54, doc.y,
          { width: doc.page.width - 108, align: 'justify', lineGap: 1 }
        );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
