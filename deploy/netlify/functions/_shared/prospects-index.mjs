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
  version:          1,
});
