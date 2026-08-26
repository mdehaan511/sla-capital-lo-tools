/**
 * prospects-index.mjs — materialized index for the prospects store.
 * Deploy 236.343 (Tier 2 scaling — Option B).
 */
import { createStoreIndex } from './store-index.mjs';

// Pipeline's "New Application" column reads: id, firstName, lastName,
// email, phone, propAddress, loanProduct, loanPurpose, propType,
// purchasePrice, loEmail, assignmentSource, submitterType, savedAt.
// Everything the tile shows + everything the reassign/route logic
// needs. Drop long fields (project description, notes, raw form
// blobs) — the tile doesn't render them.
function projectProspect(p) {
  if (!p || typeof p !== 'object') return p;
  return {
    id:               p.id,
    firstName:        p.firstName        || '',
    lastName:         p.lastName         || '',
    email:            p.email            || '',
    phone:            p.phone            || '',
    propAddress:      p.propAddress      || '',
    loanProduct:      p.loanProduct      || '',
    loanPurpose:      p.loanPurpose      || '',
    propType:         p.propType         || '',
    purchasePrice:    p.purchasePrice    || '',
    propertyValue:    p.propertyValue    || '',
    currentLoanAmt:   p.currentLoanAmt   || '',
    estimatedARV:     p.estimatedARV     || '',
    rehabCost:        p.rehabCost        || '',
    monthlyRent:      p.monthlyRent      || '',
    // Deploy 236.757 — the pipeline card stashes THIS projected record as
    // the sizer's prefill payload (openInSizer → sla_prefill_prospect), so
    // every field a sizer prefill maps must survive the projection. The
    // slim v1 index silently dropped creditScore, taxes/insurance, the MF
    // operating-statement set and the GUC land/GC set — the sizer opened
    // half-empty even though the full prospect record had the data.
    creditScore:      p.creditScore      || '',
    monthlyTaxes:     p.monthlyTaxes     || '',
    monthlyInsurance: p.monthlyInsurance || '',
    monthlyHOA:       p.monthlyHOA       || '',
    fundingDate:      p.fundingDate      || '',
    rentalType:       p.rentalType       || '',
    // MF (5+) NCF fields — Deploy 236.750 set
    numUnits:         p.numUnits         || '',
    unitsOccupied:    p.unitsOccupied    || '',
    otherIncomeMo:    p.otherIncomeMo    || '',
    opexTaxes:        p.opexTaxes        || '',
    opexInsurance:    p.opexInsurance    || '',
    opexFlood:        p.opexFlood        || '',
    opexUtilities:    p.opexUtilities    || '',
    opexRepairs:      p.opexRepairs      || '',
    opexMgmt:         p.opexMgmt         || '',
    opexHOA:          p.opexHOA          || '',
    opexLandscaping:  p.opexLandscaping  || '',
    // GUC fields — Deploy 236.729 set
    ownLand:          p.ownLand          || '',
    landDebt:         p.landDebt         || '',
    gcName:           p.gcName           || '',
    gcPhone:          p.gcPhone          || '',
    gcEmail:          p.gcEmail          || '',
    loEmail:          p.loEmail          || '',
    assignmentSource: p.assignmentSource || '',
    submitterType:    p.submitterType    || '',
    brokerName:       p.brokerName       || '',
    brokerCompany:    p.brokerCompany    || '',
    brokerEmail:      p.brokerEmail      || '',
    brokerPhone:      p.brokerPhone      || '',
    // Client + loan links + status for the pipeline dedupe / tile
    // → loan-details routing.
    clientId:         p.clientId         || '',
    loanId:           p.loanId           || '',
    status:           p.status           || '',
    savedAt:          p.savedAt,
    updatedAt:        p.updatedAt,
    createdAt:        p.createdAt,
  };
}

export const prospectsIndex = createStoreIndex({
  indexStoreName:   'prospects-index',
  primaryStoreName: 'prospects',
  project:          projectProspect,
  // v2 — Deploy 236.757: prefill-complete projection (creditScore, monthly
  // T&I, MF NCF set, GUC land/GC set). Bump forces a rebuild from the
  // primary store on next read, so existing prospects pick the fields up.
  version:          2,
});
