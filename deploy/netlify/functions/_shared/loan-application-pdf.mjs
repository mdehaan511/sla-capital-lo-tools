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
import { ESIGN_CONSENT_TEXT } from './esign.mjs';

// SLA brand colors (RGB to match the rest of the app)
const PLUM       = '#261A36';
const GOLD       = '#C8813A';
const GOLD_LIGHT = '#F5E9D8';
const TEXT       = '#1A1520';
const MUTED      = '#7A7488';
const BORDER     = '#E4DFD4';

export function renderSignedApplicationPDF({ record, client, signature, audit, loProfile }) {
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
      const guarantors = Array.isArray(data.guarantors) ? data.guarantors : [];
      const g0 = guarantors[0] || {};
      const g1 = guarantors[1] || null;
      const companies = Array.isArray(data.companies) ? data.companies : [];
      const co0 = companies[0] || {};

      const fmtAddr = (a) => {
        if (!a) return '';
        const parts = [a.street || a.address, a.city, [a.state, a.zip].filter(Boolean).join(' ')]
          .filter(Boolean);
        return parts.join(', ');
      };
      const fmtSSN = (ssn) => {
        if (!ssn) return '';
        const digits = String(ssn).replace(/\D/g, '');
        if (digits.length !== 9) return ssn;
        return digits.slice(0, 3) + '-' + digits.slice(3, 5) + '-' + digits.slice(5);
      };
      const fmtMoney = (n) => {
        const num = parseFloat(String(n || '').replace(/[$,]/g, ''));
        if (!isFinite(num) || num === 0) return '';
        return '$' + Math.round(num).toLocaleString('en-US');
      };

      // ── HEADER ──────────────────────────────────────────────────
      const startY = doc.y;
      doc.rect(0, 0, doc.page.width, 70).fill(PLUM);
      doc.fillColor(GOLD).font('Times-Bold').fontSize(20)
        .text('Sir Lends A Lot LLC', 54, 22);
      doc.fillColor(GOLD_LIGHT).font('Helvetica').fontSize(8)
        .text('SLA CAPITAL  ·  LOAN APPLICATION', 54, 46);
      // Doc date on the right
      doc.fillColor(GOLD_LIGHT).fontSize(8)
        .text('Executed: ' + new Date(audit.signedAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
              doc.page.width - 250, 30, { width: 200, align: 'right' });
      // Gold rule under the header
      doc.rect(0, 70, doc.page.width, 2).fill(GOLD);

      doc.fillColor(TEXT).y = 90;

      // ── DOCUMENT TITLE ──────────────────────────────────────────
      doc.font('Times-Bold').fontSize(16).fillColor(PLUM)
        .text('SIGNED LOAN APPLICATION', { align: 'center' });
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(8.5).fillColor(MUTED)
        .text('Sir Lends A Lot LLC dba SLA Capital  ·  For business-purpose, investment property loans only.',
              { align: 'center' });
      doc.moveDown(1.5);

      // ── Section helper ──────────────────────────────────────────
      function section(title) {
        if (doc.y > doc.page.height - 120) doc.addPage();
        doc.font('Helvetica-Bold').fontSize(9).fillColor(GOLD)
          .text(title.toUpperCase());
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

      // ── BORROWER / GUARANTOR ─────────────────────────────────────
      section('Primary Borrower / Guarantor');
      row('Full name', `${g0.firstName || data.borrowerFirstName || ''} ${g0.lastName || data.borrowerLastName || ''}`.trim());
      row('Email', g0.email || data.borrowerEmail || client && client.email || '');
      row('Phone', g0.phone || data.borrowerPhone || client && client.phone || '');
      row('Date of birth', g0.dob || '');
      row('Estimated FICO', g0.fico || '');
      row('Marital status', g0.marital || '');
      row('US citizen', g0.usCitizen || '');
      row('SSN', fmtSSN(g0.ssn));
      row('Home address', fmtAddr({
        street: g0.address, city: g0.city, state: g0.state, zip: g0.zip,
      }));
      row('Investment experience', `${g0.flips || 0} flips · ${g0.rentals || 0} rentals`);
      doc.moveDown(0.5);

      if (g1) {
        section('Co-Borrower / Guarantor');
        row('Full name', `${g1.firstName || ''} ${g1.lastName || ''}`.trim());
        row('Email', g1.email || '');
        row('Phone', g1.phone || '');
        row('Date of birth', g1.dob || '');
        row('Estimated FICO', g1.fico || '');
        row('Marital status', g1.marital || '');
        row('US citizen', g1.usCitizen || '');
        row('SSN', fmtSSN(g1.ssn));
        row('Home address', fmtAddr({
          street: g1.address, city: g1.city, state: g1.state, zip: g1.zip,
        }));
        row('Investment experience', `${g1.flips || 0} flips · ${g1.rentals || 0} rentals`);
        doc.moveDown(0.5);
      }

      // ── PROPERTY & LOAN ─────────────────────────────────────────
      section('Property & Loan');
      row('Property address', data.propertyAddress || (record.prefill && record.prefill.propertyAddress) || '');
      row('Property type', data.propertyType || '');
      row('Number of units', data.numUnits || '');
      row('Flood zone', data.floodZone || '');
      row('Bedrooms', data.bedrooms || '');
      row('Bathrooms', data.bathrooms || '');
      row('Square footage', data.sqft || '');
      const purpose = data.dscrPurchaseRefi || data.purchaseOrRefi || data.loanPurpose || '';
      row('Purchase or refinance', purpose);
      row('Loan type', record.toolType || (record.prefill && record.prefill.toolType) || '');
      row('Requested loan amount', fmtMoney(data.requestedLoanAmt || data.loanAmt || (record.prefill && record.prefill.loanAmt)));
      row('Required close date', data.dscrCloseDate || data.ffCloseDate || '');
      if (data.purchasePrice)        row('Purchase price',     fmtMoney(data.purchasePrice));
      if (data.arv)                  row('After-repair value', fmtMoney(data.arv));
      if (data.renoCost)             row('Rehab budget',       fmtMoney(data.renoCost));
      if (data.currentLoanAmount || data.currentLoanAmt) {
        row('Current loan balance', fmtMoney(data.currentLoanAmount || data.currentLoanAmt));
      }
      if (data.currentValue)         row('Current market value', fmtMoney(data.currentValue));
      if (data.currentRent)          row('Current monthly rent', fmtMoney(data.currentRent));
      if (data.annualTaxes)          row('Annual property taxes', fmtMoney(data.annualTaxes));
      if (data.annualInsurance)      row('Annual insurance',     fmtMoney(data.annualInsurance));
      if (data.annualHOA)            row('Annual HOA',           fmtMoney(data.annualHOA));
      if (data.planDescription)      row('Project / plan',       data.planDescription);
      if (data.exitStrategy)         row('Exit strategy',        data.exitStrategy);
      if (data.originalPurchaseDate) row('Original purchase date', data.originalPurchaseDate);
      doc.moveDown(0.5);

      // ── ENTITY / VESTING ────────────────────────────────────────
      if (co0 && (co0.name || co0.ein)) {
        section('Vesting Entity');
        row('Entity name', co0.name || '');
        row('State of formation', co0.state || '');
        row('EIN', co0.ein || '');
        row('Registered address', fmtAddr({
          street: co0.address, city: co0.city, state: co0.addrState, zip: co0.zip,
        }));
        doc.moveDown(0.5);
      }

      // ── BORROWER CERTIFICATIONS (ESIGN CONSENT) ─────────────────
      // Force a page break here if the consent + signature block won't
      // fit; the consent text is long.
      if (doc.y > 400) doc.addPage();
      section('Borrower Certifications & Electronic Signature Consent');
      doc.font('Helvetica').fontSize(8).fillColor(TEXT)
        .text(ESIGN_CONSENT_TEXT, { lineGap: 1.5, align: 'justify' });
      doc.moveDown(1);

      // ── SIGNATURE BLOCK ─────────────────────────────────────────
      if (doc.y > doc.page.height - 200) doc.addPage();
      section('Signature');

      // Boxed signature in a "script" font so it visually reads like a signature
      const sigY = doc.y + 4;
      doc.rect(54, sigY, doc.page.width - 108, 50).strokeColor(BORDER).lineWidth(0.7).stroke();
      // pdfkit doesn't include script fonts by default; "Times-Italic" is a
      // reasonable cross-platform stand-in that reads as a signature.
      doc.font('Times-Italic').fontSize(22).fillColor(PLUM)
        .text(signature.signerName || '', 64, sigY + 10, {
          width: doc.page.width - 128, height: 35,
        });
      // Below-line caption with timestamp
      doc.font('Helvetica').fontSize(8).fillColor(MUTED)
        .text(`Typed by ${signature.signerName || ''} on ${new Date(audit.signedAt).toLocaleString('en-US', { dateStyle: 'long', timeStyle: 'short', timeZoneName: 'short' })}`,
              64, sigY + 56);
      doc.y = sigY + 78;

      // ── AUDIT TRAIL ─────────────────────────────────────────────
      // Always visible at the end. Provides the auditability without
      // hiding it from the borrower — they can see what we recorded.
      section('Electronic Signature Audit');
      row('Signer', signature.signerName || '');
      row('Signer email', signature.signerEmail || g0.email || data.borrowerEmail || '');
      row('Signed at (UTC)', audit.signedAt || '');
      row('IP address', audit.ipAddress || 'unavailable');
      row('User agent', (audit.userAgent || '').slice(0, 100));
      if (audit.geolocation) {
        row('Geolocation', audit.geolocation);
      }
      row('Consent version', `v${audit.consentVersion}`);
      row('Document content hash (SHA-256)', audit.dataHash || '');
      row('Audit seal (HMAC-SHA256)', (audit.seal || '').slice(0, 32) + '…');

      doc.moveDown(0.6);
      doc.font('Helvetica-Oblique').fontSize(7.5).fillColor(MUTED)
        .text(
          'This document was electronically signed by the borrower in accordance with the federal ESIGN Act (15 U.S.C. § 7001 et seq.) and applicable state UETA statutes. The audit trail above provides cryptographic evidence of the signing event. The content hash binds the signature to the specific data values reproduced in this document; any tampering with the borrower\'s stored record after signing would change this hash. The HMAC seal (computed with a server-side secret) provides tamper-evidence for the audit fields themselves.',
          { align: 'justify', lineGap: 1 }
        );

      doc.end();
    } catch (e) {
      reject(e);
    }
  });
}
