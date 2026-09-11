/**
 * _shared/extension-agreement-pdf.mjs — Deploy 236.843
 *
 * Renders the LOAN EXTENSION AGREEMENT as a PDF, mirroring Mike's Word
 * template ("Loan Extension Agreement (1).docx") verbatim with the
 * bracketed fields filled from the loan record:
 *
 *   [TODAYS DATE] [BORROWER NAME] [ORIGINATION DATE] [LOAN AMOUNT]
 *   [PROPERTY ADDRESS] [CURRENT UPB] [NEXT MATURITY DATE] [1 ORIGINATION POINT]
 *   + the paid-at-signing vs added-to-principal checkbox pair.
 *
 * The signature blocks render as labeled lines. Deploy 236.897 (Mike: "It came
 * back with a signing confirmation page but the document does not show as
 * signed") — we now also hand back the COORDINATES of those two lines so
 * envelope-sign can stamp each party's signature onto the agreement itself.
 * The certificate page alone left a fully executed agreement whose signature
 * lines were visibly blank, which is not something you can send a servicer.
 *
 * Returns { buffer, sigFields } — sigFields is one entry per signer role,
 * shaped for native-esign's stamper.
 */
import PDFDocument from 'pdfkit';

function fmtMoney(v) {
  const n = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, ''));
  if (!isFinite(n)) return String(v || '');
  return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fmtDate(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? String(v) : d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

/**
 * @param {object} v — filled values:
 *   todaysDate, borrowerName, originationDate, loanAmount, propertyAddress,
 *   currentUpb, newMaturityDate, extensionFee,
 *   feeHandling: 'at_signing' | 'add_to_principal',
 *   lenderName (signer, e.g. 'Mike DeHaan')
 */
export function buildExtensionAgreementPdf(v) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'LETTER', margins: { top: 64, bottom: 64, left: 64, right: 64 } });
    const chunks = [];
    const sigFields = [];
    // pdfkit lays out top-down and this agreement is one page today, but count
    // pages anyway so the coordinates stay right if the text ever grows.
    let pageNumber = 1;
    doc.on('pageAdded', () => { pageNumber += 1; });
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), sigFields }));
    doc.on('error', reject);

    const SIG_RULE = '____________________________';
    const DATE_RULE = '______________';

    /**
     * Record where a "Signature: ____  Date: ____" line was drawn, so the
     * signature can later be stamped onto the rule instead of beside it.
     *
     * pdfkit measures y from the page TOP and draws a line's glyphs on a
     * baseline below that; pdf-lib measures from the BOTTOM and draws AT the
     * baseline. We hand over a top-based baseline and let the stamper flip it,
     * so neither side has to know about the other's origin.
     */
    function markSignatureLine(role, prefix) {
      const left = doc.page.margins.left;
      const lineTop = doc.y;
      // widthOfString uses the font currently set, which is why every caller
      // sets B() immediately before.
      const ascent = doc.currentLineHeight() * 0.78;
      sigFields.push({
        role,
        pageNumber,
        pageHeight: doc.page.height,
        sigX: left + doc.widthOfString(prefix),
        dateX: left + doc.widthOfString(prefix + SIG_RULE + '    Date: '),
        // Sit the text ON the rule rather than on top of the underscores.
        sigYFromTop: lineTop + ascent,
        dateYFromTop: lineTop + ascent,
      });
    }

    // Deploy 236.845 — the extension term reads "three (3) months" (Mike),
    // matching the new-maturity default of the 1st of the month three months
    // out (an exact day count would drift once the date snaps to the 1st).
    const atSigning = v.feeHandling !== 'add_to_principal';

    const H = () => doc.font('Times-Bold').fontSize(11);
    const B = () => doc.font('Times-Roman').fontSize(11);

    doc.font('Times-Bold').fontSize(14).text('LOAN EXTENSION AGREEMENT', { align: 'center' });
    doc.moveDown(1.5);

    B().text(
      'This Loan Extension Agreement (the "Agreement") is made effective as of ' + fmtDate(v.todaysDate) +
      ', by and between Sir Lends A Lot, LLC (the "Lender") and ' + String(v.borrowerName || '') +
      ' (the "Borrower").', { lineGap: 3 });
    doc.moveDown(1);

    H().text('1. RECITALS', { continued: true });
    B().text('  The Borrower and Lender are parties to a certain Promissory Note and Deed of Trust dated ' +
      fmtDate(v.originationDate) + ', originally in the principal amount of ' + fmtMoney(v.loanAmount) +
      ' (the "Loan"), secured by the property located at:', { lineGap: 3 });
    doc.moveDown(0.5);
    doc.font('Times-Bold').text(String(v.propertyAddress || ''), { indent: 24 });
    B().text('(the "Property").', { indent: 24 });
    doc.moveDown(1);

    H().text('2. LOAN BALANCE', { continued: true });
    B().text('  The parties agree that the current unpaid principal balance of the Loan as of the date of this Agreement is: ' +
      fmtMoney(v.currentUpb), { lineGap: 3 });
    doc.moveDown(1);

    H().text('3. EXTENSION OF MATURITY DATE', { continued: true });
    B().text('  The Lender agrees to extend the current maturity date of the Loan for a period of three (3) months. The new maturity date for the Loan shall be ' + fmtDate(v.newMaturityDate) + '.', { lineGap: 3 });
    doc.moveDown(1);

    H().text('4. EXTENSION FEE', { continued: true });
    B().text('  In consideration for this extension, the Borrower agrees to pay an extension fee equal to one percentage point (1.00%) of the original loan balance, totaling ' +
      fmtMoney(v.extensionFee) + '.', { lineGap: 3 });
    doc.moveDown(0.5);
    B().text('[' + (atSigning ? 'X' : ' ') + ']  This fee shall be paid at the time of signing.', { indent: 24 });
    doc.moveDown(0.25);
    B().text('[' + (atSigning ? ' ' : 'X') + ']  This fee shall be added to the principal balance of the Loan.', { indent: 24 });
    doc.moveDown(1);

    H().text('5. NO OTHER MODIFICATIONS', { continued: true });
    B().text('  Except as expressly modified by this Agreement, all other terms, conditions, and covenants of the original Promissory Note and Deed of Trust remain in full force and effect.', { lineGap: 3 });
    doc.moveDown(2);

    // Deploy 236.974 (Mike: "extensions can be sent to both of the guarantors") —
    // v.guarantors = [{ name, role }] adds a consent clause and one signature
    // block per guarantor after the borrower's. Each block's rule is measured
    // under its own role so the stamper can find it.
    const guarantors = Array.isArray(v.guarantors) ? v.guarantors.filter((g) => g && g.role) : [];
    if (guarantors.length) {
      H().text('6. GUARANTOR CONSENT', { continued: true });
      B().text('  Each undersigned Guarantor consents to this Agreement and confirms that their guaranty of the Loan remains in full force and effect with respect to the Loan as extended by this Agreement.', { lineGap: 3 });
      doc.moveDown(1);
    }

    B().text('The parties execute this Agreement by electronic signature; the attached signature certificate forms part of this Agreement.', { lineGap: 3 });
    doc.moveDown(2);

    // Signature blocks. The rules are measured as they're drawn (236.897) so
    // envelope-sign can stamp each party's name and date onto its own line —
    // the lender's on the lender rule, the borrower's on the borrower rule.
    H().text('LENDER:');
    B().text('Sir Lends A Lot, LLC');
    const lenderPrefix = 'By: ' + String(v.lenderName || '') + '    Signature: ';
    B(); markSignatureLine('lender', lenderPrefix);
    B().text(lenderPrefix + SIG_RULE + '    Date: ' + DATE_RULE);
    doc.moveDown(1.5);
    H().text('BORROWER:');
    B().text(String(v.borrowerName || ''));
    const borrowerPrefix = 'Signature: ';
    B(); markSignatureLine('borrower', borrowerPrefix);
    B().text(borrowerPrefix + SIG_RULE + '    Date: ' + DATE_RULE);
    guarantors.forEach((g) => {
      doc.moveDown(1.5);
      H().text('GUARANTOR:');
      B().text(String(g.name || ''));
      const gPrefix = 'Signature: ';
      B(); markSignatureLine(String(g.role), gPrefix);
      B().text(gPrefix + SIG_RULE + '    Date: ' + DATE_RULE);
    });

    doc.end();
  });
}
