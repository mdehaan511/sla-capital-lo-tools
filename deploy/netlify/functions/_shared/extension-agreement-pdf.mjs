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
 * The signature blocks render as labeled lines; the actual signatures are
 * applied by the native eSign flow (envelope-sign appends the signature
 * certificate page with each signer's typed signature + audit trail).
 *
 * Returns a Buffer of PDF bytes.
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
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

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

    B().text('The parties execute this Agreement by electronic signature; the attached signature certificate forms part of this Agreement.', { lineGap: 3 });
    doc.moveDown(2);

    // Signature blocks — signed via the appended eSign certificate page.
    H().text('LENDER:');
    B().text('Sir Lends A Lot, LLC');
    B().text('By: ' + String(v.lenderName || '') + '    Signature: ____________________________    Date: ______________');
    doc.moveDown(1.5);
    H().text('BORROWER:');
    B().text(String(v.borrowerName || ''));
    B().text('Signature: ____________________________    Date: ______________');

    doc.end();
  });
}
