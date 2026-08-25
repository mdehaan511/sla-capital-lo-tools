/**
 * _shared/borrower-prefill.mjs — Deploy 236.741
 *
 * The loan/property half of the long-app prefill. Extracted from
 * borrower-info-request.mjs so borrower-info-load can RE-DERIVE it from the
 * live loan on every borrower load: the prefill used to be snapshotted at
 * invite time, which meant prefill improvements (e.g. the GUC ownLand field,
 * Deploy 236.740) never reached already-sent links, and later LO edits to the
 * loan didn't flow either. The borrower/LO/companies halves stay snapshotted
 * (they don't drift the same way).
 *
 * Mutates pf in place; pf.property / pf.loan are created if absent.
 */
export function applyLoanPrefill(pf, loan) {
  if (!pf || !loan) return pf;
  // Mirrors borrower-info-request's original annualize: number out, '' when
  // the monthly value doesn't parse.
  const annualize = (m) => {
    const n = parseFloat(String(m == null ? '' : m).replace(/[^0-9.\-]/g, ''));
    return isFinite(n) ? Math.round(n * 12) : '';
  };
  pf.property = pf.property || {};
  pf.loan = pf.loan || {};

  pf.property.address   = loan.address || '';
  pf.property.propType  = loan.propType || '';
  pf.property.bedrooms  = loan.bedrooms || '';
  pf.property.bathrooms = loan.bathrooms || '';
  pf.property.sqft      = loan.sqft || '';

  pf.loan.toolType        = loan.toolType || '';
  pf.loan.loanType        = loan.loanType || '';
  pf.loan.loanPurpose     = loan.loanPurpose || '';
  pf.loan.loanAmt         = loan.loanAmt || loan.purchasePrice || '';
  pf.loan.loanAmtLocked   = !!loan.loanAmtLocked;
  pf.loan.maxLoan         = loan.maxLoan || '';
  pf.loan.purchasePrice   = loan.purchasePrice || '';
  pf.loan.propValue       = loan.propValue || loan.arv || '';
  pf.loan.arv             = loan.arv || loan.estimatedARV || '';
  pf.loan.rehabBudget     = loan.rehabBudget || '';
  pf.loan.currentLoanAmt  = loan.currentLoanAmt || loan.existingLoanAmt || '';
  pf.loan.rent            = loan.rent || '';
  pf.loan.rentalType      = loan.rentalType || '';
  pf.loan.fundingDate     = loan.fundingDate || '';
  pf.loan.experience      = loan.experience || '';
  // Deploy 236.740 — GUC / ground-up fields for the New Construction prefill.
  // Application-created loans carry them top-level; sizer-saved quotes keep
  // them in formData.
  pf.loan.ownLand  = loan.ownLand  || (loan.formData && loan.formData.ownLand)  || '';
  pf.loan.landDebt = loan.landDebt || (loan.formData && loan.formData.landDebt) || '';
  pf.loan.projectDescription = loan.projectDescription || '';
  pf.loan.fico            = loan.fico || (pf.borrower && pf.borrower.fico) || '';
  pf.loan.annualTaxes     = annualize(loan.taxes);
  pf.loan.annualInsurance = annualize(loan.insurance);
  pf.loan.annualHOA       = annualize(loan.hoa);
  return pf;
}
