/**
 * loan-add-guarantor.mjs — POST /api/loan-add-guarantor
 *
 * Deploy 236.130 — manual add-guarantor flow from Loan Details.
 * Lets the LO add an additional guarantor to a loan without
 * re-routing through the long application. Dedupes by email
 * against existing clients under the same owner. Creates / links
 * the client, appends to loan.guarantorClientIds, stamps the
 * ownership %, generates a sub-form invite token, and writes the
 * reverse index so the public guarantor-subform.html page can
 * resolve the new guarantor.
 *
 * Body: {
 *   clientId, loanId, owner?,
 *   guarantor: { email, firstName, lastName, phone, ownershipPct? }
 * }
 *
 * Response: {
 *   ok: true,
 *   loan,
 *   guarantor,             // full client record
 *   tokenEntry,            // { token, status, createdAt, ... }
 *   matchedExistingClient  // boolean — true if we deduped, false if newly created
 * }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { loadRecord } from './_shared/borrower-info-keys.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-add-guarantor top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = String(body.clientId || '').trim();
  const loanId   = String(body.loanId   || '').trim();
  const g        = body.guarantor || {};
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  const firstName = String(g.firstName || '').trim();
  const lastName  = String(g.lastName  || '').trim();
  const email     = String(g.email     || '').toLowerCase().trim();
  const phone     = String(g.phone     || '').trim();
  if (!email)     return json(400, { error: 'Guarantor email is required (used to dedupe + send the sub-form link).' });
  if (!firstName) return json(400, { error: 'Guarantor first name is required.' });
  if (!lastName)  return json(400, { error: 'Guarantor last name is required.' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const primaryKey = ownerKey + '/' + keySafe(clientId);

  let primary;
  try { primary = await clientsStore.get(primaryKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read primary client: ' + (e.message || 'unknown') }); }
  if (!primary) return json(404, { error: 'Primary client not found' });
  if (!Array.isArray(primary.loans)) return json(404, { error: 'Primary client has no loans array' });
  const loanIdx = primary.loans.findIndex((l) => l && l.id === loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on primary client' });
  const loan = primary.loans[loanIdx];

  // ── Dedupe by email against existing clients under this owner.
  // Scan the owner's clients for an email match. If found, reuse
  // (and fill in any blanks); otherwise create a brand-new record.
  let matchedExistingClient = false;
  let guarantor = null;
  let guarantorKey = null;
  try {
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' });
      if (c && String(c.email || '').toLowerCase().trim() === email) {
        guarantor = c;
        guarantorKey = key;
        matchedExistingClient = true;
        break;
      }
    }
  } catch (e) {
    console.warn('loan-add-guarantor: client scan failed (non-fatal, will create new):', e && e.message);
  }

  const now = new Date().toISOString();
  const backref = { primaryClientId: clientId, loanId };

  if (guarantor) {
    // Fill in any blank contact fields the LO supplied; don't
    // overwrite values the existing client already carries.
    if (!guarantor.firstName && firstName) guarantor.firstName = firstName;
    if (!guarantor.lastName  && lastName)  guarantor.lastName  = lastName;
    if (!guarantor.phone     && phone)     guarantor.phone     = phone;
    guarantor._guarantorOnLoans = Array.isArray(guarantor._guarantorOnLoans) ? guarantor._guarantorOnLoans : [];
    const alreadyLinked = guarantor._guarantorOnLoans.some((b) =>
      b && b.primaryClientId === backref.primaryClientId && b.loanId === backref.loanId);
    if (!alreadyLinked) guarantor._guarantorOnLoans.push(backref);
  } else {
    guarantor = {
      id:         'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      firstName,
      lastName,
      email,
      phone,
      entityName: '',
      createdAt:  now,
      updatedAt:  now,
      loans:      [],
      companies:  [],
      _createdViaManualGuarantorAdd: true,
      _guarantorOnLoans: [backref],
    };
    guarantorKey = ownerKey + '/' + keySafe(guarantor.id);
  }

  // Deploy 236.150 — vesting-entity mapping. When a guarantor is
  // added to a loan, the loan's vesting LLC (from the long-app
  // borrower_info record if available, falling back to whatever
  // the LO captured on the Loan Details Vesting LLC UI) should
  // appear in their Client Details Companies section. Without
  // this, manually-added guarantors had no entity on their
  // client page even though they're a key principal of the LLC
  // borrowing the loan.
  try {
    const vestingEntity = await _resolveLoanVestingEntity({
      ownerKey, primaryClientId: clientId, loanId, loan, primary,
    });
    if (vestingEntity && vestingEntity.name) {
      guarantor.companies = Array.isArray(guarantor.companies) ? guarantor.companies : [];
      const lcName = vestingEntity.name.toLowerCase();
      const exists = guarantor.companies.some((c) => c && String(c.name || '').toLowerCase() === lcName);
      if (!exists) {
        guarantor.companies.unshift({
          id:        'co_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name:      vestingEntity.name,
          ein:       vestingEntity.ein       || '',
          state:     vestingEntity.state     || '',
          address:   vestingEntity.address   || '',
          city:      vestingEntity.city      || '',
          addrState: vestingEntity.addrState || '',
          zip:       vestingEntity.zip       || '',
        });
      }
    }
  } catch (e) {
    console.warn('loan-add-guarantor: vesting-entity mapping failed (non-fatal):', e && e.message);
  }

  // ── Sub-form invite token (one per loan per guarantor).
  guarantor._subFormTokensByLoan = guarantor._subFormTokensByLoan || {};
  let tokenEntry = guarantor._subFormTokensByLoan[loanId];
  if (!tokenEntry) {
    const token = 'gsf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 14);
    tokenEntry = {
      token,
      createdAt:       now,
      status:          'pending',
      ownerKey,
      primaryClientId: clientId,
      loanId,
    };
    guarantor._subFormTokensByLoan[loanId] = tokenEntry;
    try {
      const idxStore = getStore({ name: 'guarantor-subform-token-idx', consistency: 'strong' });
      await idxStore.setJSON(token, {
        token, ownerKey,
        clientId:        guarantor.id,
        primaryClientId: clientId,
        loanId,
      });
    } catch (e) {
      console.warn('loan-add-guarantor: subform token index write failed (non-fatal):', e && e.message);
    }
  }

  guarantor.updatedAt = now;
  try { await clientsStore.setJSON(guarantorKey, guarantor); }
  catch (e) { return json(500, { error: 'Failed to write guarantor client: ' + (e.message || 'unknown') }); }

  // ── Wire into the loan: guarantorClientIds + ownership map.
  loan.guarantorClientIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
  if (loan.guarantorClientIds.indexOf(guarantor.id) < 0) {
    loan.guarantorClientIds.push(guarantor.id);
  }
  const pct = parseFloat(g.ownershipPct);
  if (isFinite(pct)) {
    loan.guarantorOwnership = Object.assign({}, loan.guarantorOwnership || {});
    loan.guarantorOwnership[guarantor.id] = pct;
  }
  loan.updatedAt = now;

  // Audit entry on the loan's notesLog.
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  appendNoteEntry(loan, {
    kind:        'guarantor_added',
    text:        'Manually added guarantor: ' + firstName + ' ' + lastName + ' (' + email + ')' +
                 (isFinite(pct) ? ' · ' + pct + '% ownership' : '') +
                 (matchedExistingClient ? ' · linked to existing client' : ' · new client record created'),
    author:      authorName,
    authorEmail: user.email || '',
    meta: {
      guarantorClientId: guarantor.id,
      matchedExistingClient,
      ownership: isFinite(pct) ? pct : null,
    },
  });

  primary.loans[loanIdx] = loan;
  primary.updatedAt = now;
  try { await clientsStore.setJSON(primaryKey, primary); }
  catch (e) { return json(500, { error: 'Failed to write primary client: ' + (e.message || 'unknown') }); }

  return json(200, {
    ok: true,
    loan,
    guarantor,
    tokenEntry,
    matchedExistingClient,
  });
}

// Deploy 236.150 — locate the loan's vesting entity, in this
// priority order:
//   1. The borrower_info long-app record's companies[0] / flat
//      llcX fields (most complete — has EIN, address, state).
//   2. The loan's vestingLLCs[0] from the Loan Details UI (name
//      only — the UI doesn't capture EIN/address).
//   3. The primary client's companies[0] (catch-all for older
//      records that pre-date borrower_info per-loan keys).
// Returns null if nothing matches.
async function _resolveLoanVestingEntity({ ownerKey, primaryClientId, loanId, loan, primary }) {
  // Source 1 — borrower_info long-app.
  try {
    const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
    const biRec = await loadRecord(biStore, ownerKey, primaryClientId, loanId, primary);
    if (biRec && biRec.data) {
      const co0 = Array.isArray(biRec.data.companies) ? biRec.data.companies[0] : null;
      if (co0 && co0.name) {
        return {
          name:      co0.name,
          ein:       co0.ein       || '',
          state:     co0.state     || '',
          address:   co0.address   || '',
          city:      co0.city      || '',
          addrState: co0.addrState || '',
          zip:       co0.zip       || '',
        };
      }
      if (biRec.data.llcName) {
        return {
          name:      biRec.data.llcName,
          ein:       biRec.data.llcEIN     || '',
          state:     biRec.data.llcState   || '',
          address:   biRec.data.llcAddress || '',
          city:      biRec.data.llcCity    || '',
          addrState: biRec.data.llcAddrState || '',
          zip:       biRec.data.llcZip     || '',
        };
      }
    }
  } catch (_) {}

  // Source 2 — Loan Details Vesting LLC UI.
  if (loan && Array.isArray(loan.vestingLLCs) && loan.vestingLLCs.length && loan.vestingLLCs[0].name) {
    return {
      name: loan.vestingLLCs[0].name,
      ein:  loan.vestingLLCs[0].ein || '',
    };
  }

  // Source 3 — primary client's companies (catch-all).
  if (primary && Array.isArray(primary.companies) && primary.companies.length) {
    const c = primary.companies[0];
    if (c && c.name) {
      return {
        name:      c.name,
        ein:       c.ein       || '',
        state:     c.state     || '',
        address:   c.address   || '',
        city:      c.city      || '',
        addrState: c.addrState || '',
        zip:       c.zip       || '',
      };
    }
  }

  return null;
}
