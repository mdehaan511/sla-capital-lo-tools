/**
 * guarantor-synth.mjs — Deploy 236.147
 *
 * Build a synthetic `record` object suitable for
 * renderSignedApplicationPDF() when the data didn't originate
 * from a borrower-info long-app submission. Used by:
 *   - guarantor-application-download.mjs (per-guarantor PDF that
 *     looks like the full loan application but with just one
 *     guarantor in slot 0)
 *   - loan-bundle-download.mjs (one per-guarantor PDF section
 *     per additional guarantor, same format as long app)
 *
 * The renderer reads from data.guarantors[0/1], data.companies[0],
 * and flat top-level data fields. This helper flattens the
 * guarantor's nested homeAddress / prevAddress / mailingAddress
 * into the flat shape the renderer expects, copies declarations
 * onto the guarantor object, and pulls vestingLLCs[0] into the
 * companies array.
 *
 * Inputs:
 *   guarantor    — the client record being highlighted
 *   loan         — the loan record (for property + pricing fields)
 *   primary      — the primary borrower's client record (used for
 *                  ownerKey + contextual labels)
 *   ownerKey     — owner namespace, passed through to record
 *   asGuarantorIndex — 0 (default — guarantor is positioned as
 *                  Guarantor 1) or 1 (positioned as Guarantor 2).
 *                  The renderer only handles indexes 0 and 1.
 */
export function synthRecordForGuarantor({ guarantor, loan, primary, ownerKey, asGuarantorIndex }) {
  const g = guarantor || {};
  const ha = g.homeAddress    || {};
  const pa = g.prevAddress    || {};
  const ma = g.mailingAddress || {};
  const decl = g.declarations || {};

  const ownership =
    (loan && loan.guarantorOwnership && loan.guarantorOwnership[g.id]) ||
    g.ownership || '';

  // Long-app guarantor shape — flat fields the renderer reads,
  // declarations spread onto the object so g.bankruptcy7yr etc.
  // resolve like they do from the form's nested g[idx]_X mirrors.
  const longAppGuarantor = {
    firstName:        g.firstName || '',
    lastName:         g.lastName  || '',
    email:            g.email     || '',
    phone:            g.phone     || '',
    dob:              g.dob       || '',
    fico:             g.fico      || '',
    ssn_enc:          g.ssn_enc   || '',  // renderer decrypts
    ssn:              g.ssn       || '',  // legacy fallback
    marital:          g.maritalStatus || g.marital || '',
    usCitizen:        g.usCitizen || '',
    flips:            g.flips     || '',
    rentals:          g.rentals   || '',
    ownership,
    // Flattened home address.
    address:          ha.street || '',
    city:             ha.city   || '',
    state:            ha.state  || '',
    zip:              ha.zip    || '',
    // 2-year residency + previous address.
    twoYearAddress:   g.twoYearAddress || '',
    prevAddress:      pa.street || '',
    prevCity:         pa.city   || '',
    prevState:        pa.state  || '',
    prevZip:          pa.zip    || '',
    // Mailing address.
    mailingSameAsHome: g.mailingSameAsHome || '',
    mailingAddress:   ma.street || '',
    mailingCity:      ma.city   || '',
    mailingState:     ma.state  || '',
    mailingZip:       ma.zip    || '',
    // Declarations (renderer reads each as a yes/no field on g).
    bankruptcy7yr:         decl.bankruptcy7yr         || '',
    foreclosure7yr:        decl.foreclosure7yr        || '',
    partyToLawsuit:        decl.partyToLawsuit        || '',
    delinquentFederalDebt: decl.delinquentFederalDebt || '',
    obligatedToForeclosed: decl.obligatedToForeclosed || '',
    outstandingJudgments:  decl.outstandingJudgments  || '',
    intendToOccupy:        decl.intendToOccupy        || '',
  };

  // Slot the guarantor into position 0 or 1. Position 1 leaves
  // slot 0 empty (renderer guards against this with `if (g0)`).
  const guarantors = (asGuarantorIndex === 1)
    ? [{}, longAppGuarantor]
    : [longAppGuarantor];

  // Vesting LLC → companies[0]. Prefer the loan's curated
  // vestingLLCs list (LO-editable on Loan Details Contacts);
  // fall back to the primary client's first company or
  // entityName.
  let company = null;
  if (loan && Array.isArray(loan.vestingLLCs) && loan.vestingLLCs.length && loan.vestingLLCs[0].name) {
    company = {
      name:    loan.vestingLLCs[0].name || '',
      ein:     loan.vestingLLCs[0].ein  || '',
      state:   '',
      address: '',
      city:    '',
      addrState: '',
      zip:     '',
    };
  } else if (primary && Array.isArray(primary.companies) && primary.companies.length) {
    const c = primary.companies[0];
    company = {
      name:      c.name      || '',
      ein:       c.ein       || '',
      state:     c.state     || '',
      address:   c.address   || '',
      city:      c.city      || '',
      addrState: c.addrState || '',
      zip:       c.zip       || '',
    };
  } else if (primary && primary.entityName) {
    company = { name: primary.entityName, ein: '', state: '', address: '', city: '', addrState: '', zip: '' };
  }

  // Loan + property scalars from the loan record. These mirror
  // the long-app form's flat field names so the renderer's
  // `data.X` reads work without remapping.
  const monthlyTaxes     = parseFloat(loan && (loan.monthlyTaxes     || loan.taxes)     || 0) || 0;
  const monthlyInsurance = parseFloat(loan && (loan.monthlyInsurance || loan.insurance) || 0) || 0;
  const monthlyHoa       = parseFloat(loan && (loan.monthlyHoa       || loan.hoa)       || 0) || 0;

  const data = {
    propertyAddress:    loan && loan.address  || '',
    currentValue:       loan && (loan.appraisedValue || loan.propValue) || '',
    requestedLoanAmt:   loan && loan.loanAmt  || '',
    loanAmt:            loan && loan.loanAmt  || '',
    loanPurpose:        loan && loan.loanPurpose || '',
    dscrPurchaseRefi:   loan && (loan.purchaseOrRefi || loan.loanPurpose) || '',
    purchaseOrRefi:     loan && (loan.purchaseOrRefi || loan.loanPurpose) || '',
    propertyType:       loan && loan.propType || 'sfr',
    bedrooms:           loan && loan.bedrooms || '',
    bathrooms:          loan && loan.bathrooms || '',
    sqft:               loan && loan.sqft     || '',
    purchasePrice:      loan && loan.purchasePrice || '',
    arv:                loan && loan.arv      || '',
    renoCost:           loan && (loan.rehabBudget || loan.rehabCost) || '',
    currentRent:        loan && (loan.monthlyRent || loan.rent) || '',
    annualTaxes:        monthlyTaxes     * 12 || '',
    annualInsurance:    monthlyInsurance * 12 || '',
    annualHOA:          monthlyHoa       * 12 || '',
    estimatedDSCR:      loan && loan.dscr     || '',
    ffCloseDate:        loan && loan.fundingDate || '',
    dscrCloseDate:      loan && loan.fundingDate || '',
    guarantors,
    companies: company ? [company] : [],
    // Legacy flat LLC fields — some long-app submissions used
    // these directly; the renderer falls back to them if
    // companies[] is empty. Mirroring them removes the risk.
    llcName:    (company && company.name)    || '',
    llcEIN:     (company && company.ein)     || '',
    llcState:   (company && company.state)   || '',
    llcAddress: (company && company.address) || '',
    llcCity:    (company && company.city)    || '',
    llcAddrState: (company && company.addrState) || '',
    llcZip:     (company && company.zip)     || '',
  };

  return {
    clientId: primary && primary.id || '',
    loanId:   loan    && loan.id    || '',
    ownerKey: ownerKey || '',
    prefill:  { propertyAddress: data.propertyAddress },
    data,
  };
}
