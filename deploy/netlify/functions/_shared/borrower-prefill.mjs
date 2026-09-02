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
  // Deploy 236.756 — Multifamily (5+) operating-statement fields for the long
  // app's MF income/expense block.
  pf.loan.numUnits      = loan.numUnits || '';
  pf.loan.unitsOccupied = loan.unitsOccupied || '';
  pf.loan.otherIncomeMo = loan.otherIncomeMo || '';
  ['opexTaxes','opexInsurance','opexFlood','opexUtilities','opexRepairs','opexMgmt','opexHOA','opexLandscaping'].forEach((k) => {
    pf.loan[k] = loan[k] || '';
  });
  pf.loan.projectDescription = loan.projectDescription || '';
  pf.loan.fico            = loan.fico || (pf.borrower && pf.borrower.fico) || '';
  pf.loan.annualTaxes     = annualize(loan.taxes);
  pf.loan.annualInsurance = annualize(loan.insurance);
  pf.loan.annualHOA       = annualize(loan.hoa);
  return pf;
}

// ── Deploy 236.851 — is the loan-holding CLIENT record the broker? ─────────
// The long-app prefill must not mirror a BROKER's contact info into the
// borrower / Guarantor #1 fields (Deploy ~229 bug class). The old test was
// "the loan is broker-originated" — but loan.brokerId lives forever, while
// the loan can MOVE onto the real borrower's client record (guarantor swap /
// make-primary: the Locust Ave loan). Then the stale flag blanked Guarantor
// #1 on a re-sent application even though the client IS the borrower.
// Decision order (first hit wins):
//   1. not broker-originated                          → NOT broker
//   2. client tagged _isBroker                        → broker
//   3. client's email IS the loan's brokerEmail       → broker (broker shell)
//   4. client has no email at all                     → broker (can't verify — legacy caution)
//   5. the form's recipient IS the client             → NOT broker (they fill their own form)
//   6. otherwise: distinct person with their own email → NOT broker
export function clientActsAsBroker(client, loan, recipientEmail) {
  const norm = (s) => String(s || '').trim().toLowerCase();
  const brokerOriginated = !!(loan && (loan._isBrokerLoan || loan.brokerId));
  if (!brokerOriginated) return false;
  if (client && client._isBroker === true) return true;
  const cEmail = norm(client && client.email);
  if (!cEmail) return true;
  if (norm(loan && loan.brokerEmail) && norm(loan.brokerEmail) === cEmail) return true;
  if (norm(recipientEmail) && norm(recipientEmail) === cEmail) return false;
  return false;
}

// ── Deploy 236.853 (Mike) — seed guarantor SSNs from client profiles ───────
// The long app forced retyping SSNs the platform already stores encrypted on
// client records (client.ssn_enc — accumulated from prior signed applications
// and guarantor sub-forms). This copies the ENCRYPTED value into the
// application record SERVER-SIDE; the browser only ever sees the ***-**-1234
// mask (borrower-info-load masks ssn_enc → ssn_masked, the form's 236.411
// mask round-trip preserves the stored value on save, and the signed PDF
// decrypts server-side). Never overwrites an SSN already on the application.
// G1 seeds from the primary client — skipped when that record is the broker
// (their SSN must never land on a borrower's application). G2+ seed from the
// loan's linked guarantor client records, matched into existing entries by
// email. Mutates data in place; returns true when anything was added.
// CALLERS: only run against an UNSIGNED record — adding fields to signed
// data would break the signature's dataHash attestation.
export async function seedGuarantorSSNsFromProfiles({ data, client, loan, ownerKey, clientsStore, recipientEmail }) {
  let changed = false;
  if (!data || !client || !ownerKey) return false;
  const norm = (s) => String(s || '').trim().toLowerCase();

  if (client.ssn_enc && !clientActsAsBroker(client, loan, recipientEmail)) {
    if (!Array.isArray(data.guarantors)) data.guarantors = [];
    if (!data.guarantors[0]) data.guarantors[0] = {};
    if (!data.guarantors[0].ssn_enc) {
      data.guarantors[0].ssn_enc = client.ssn_enc;
      changed = true;
    }
  }

  const gids = (loan && Array.isArray(loan.guarantorClientIds)) ? loan.guarantorClientIds : [];
  if (gids.length && clientsStore && Array.isArray(data.guarantors) && data.guarantors.length > 1) {
    for (const gid of gids) {
      try {
        const gKey = ownerKey + '/' + String(gid == null ? '' : gid).replace(/[^a-zA-Z0-9_-]/g, '_');
        const gc = await clientsStore.get(gKey, { type: 'json' });
        if (!gc || !gc.ssn_enc || !norm(gc.email)) continue;
        for (let i = 1; i < data.guarantors.length; i++) {
          const g = data.guarantors[i];
          if (g && !g.ssn_enc && norm(g.email) === norm(gc.email)) {
            g.ssn_enc = gc.ssn_enc;
            changed = true;
          }
        }
      } catch (_) { /* per-guarantor best-effort */ }
    }
  }
  return changed;
}

// The borrower half of the prefill, from a client record that IS the borrower.
// Shared so borrower-info-load can rebuild it live when a stale broker flag is
// detected on an already-sent link (same shape as borrower-info-request's).
export function buildBorrowerPrefill(client) {
  client = client || {};
  return {
    firstName: client.firstName || '',
    lastName:  client.lastName || '',
    email:     client.email || '',
    phone:     client.phone || '',
    usCitizen: client.usCitizen || '',
    dob:       client.dob || '',
    maritalStatus: client.maritalStatus || '',
    homeAddress: client.homeAddress || null,
    fico:      client.fico || '',
    flips:     client.flips || '',
    rentals:   client.rentals || '',
  };
}
