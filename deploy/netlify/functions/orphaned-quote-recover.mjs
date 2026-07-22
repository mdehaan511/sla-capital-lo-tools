/**
 * orphaned-quote-recover.mjs — POST /api/orphaned-quote-recover
 *
 * Admin-only. Recovers a single orphaned quote (quote in QuoteStore with
 * no matching loan record on any client for that owner) by creating the
 * missing client + loan record from the quote's stored formData.
 *
 * Body: { quoteKey, owner } — both come from /api/orphaned-quotes-list.
 *
 * Behavior:
 *   1. Re-fetch the quote (don't trust the body's formData; pull fresh
 *      to avoid stale data and to verify the orphan still exists).
 *   2. Look up existing clients under that owner. If a client already
 *      has this borrower's email, append/merge the loan onto them. If
 *      no matching email but a matching name, merge by name. Else
 *      create a new client.
 *   3. Save the modified client back.
 *   4. Return the resulting clientId + loanId so the admin UI can
 *      deep-link to the recovered Loan Details page.
 *
 * Why server-side rather than frontend Clients.upsert: the frontend
 * helper queries+saves under the current user's owner. Recovery is
 * cross-LO by definition (admin acts on another LO's quote). Doing it
 * on the server lets us key directly off the orphan's owner with no
 * permission hoops.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write

function normAddr(s) {
  return String(s || '').toLowerCase().trim().replace(/\s+/g, ' ');
}
function streetPart(s) {
  return normAddr(s).split(',')[0].trim();
}

// Mirrors the frontend buildLoanFromSizer helper. Kept here so we don't
// depend on the sizer pages — recovery is a server-only operation.
function buildLoanFromOrphan(quote) {
  const fd = quote.formData || {};
  return {
    id:          'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    toolType:    quote.toolType || 'dscr',
    address:     quote.address || fd.address || '',
    savedAt:     new Date().toISOString(),
    updatedAt:   new Date().toISOString(),
    status:      quote.status === 'submitted' ? 'submitted' : 'active',
    loanAmt:     fd.loanAmt     || fd.purchasePrice || '',
    loanType:    fd.loanType    || '',
    fico:        fd.fico        || '',
    ficoLabel:   fd.ficoLabel   || '',
    propTypeLabel: fd.propTypeLabel || '',
    experienceLabel: fd.experienceLabel || '',
    rate:        fd._finalRate  || '',
    points:      fd._points     || '',
    propValue:   fd.propValue   || fd.arv || '',
    rent:        fd.rent        || fd.monthlyRent || '',
    taxes:       fd.taxes       || '',
    insurance:   fd.insurance   || '',
    hoa:         fd.hoa         || '',
    isIO:        fd.isIO        || '',
    prepay:      fd.prepay      || '',
    buydown:     fd.buydown     || '',
    dscr:        fd._dscr       || '',
    purchasePrice: fd.purchasePrice || '',
    rehabBudget:   fd.rehabBudget   || '',
    arv:           fd.arv           || '',
    experience:    fd.experience    || '',
    bedrooms:    fd.bedrooms    || '',
    bathrooms:   fd.bathrooms   || '',
    sqft:        fd.sqft        || '',
    propType:    fd.propType    || '',
    usCitizen:   fd.usCitizen   || '',
    loanPurpose: fd.loanPurpose || '',
    currentLoanAmt: fd.currentLoanAmt || '',
    rentalType:  fd.rentalType  || '',
    fundingDate: fd.fundingDate || '',
    notes:       fd.notes       || '',
    pricingSnapshot: fd._pricingSnapshot || null,
    // Audit trail
    _recoveredFromOrphan: true,
    _recoveredAt: new Date().toISOString(),
  };
}

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('orphaned-quote-recover top-level error:', e);
    return json(500, {
      error: 'Server error: ' + ((e && e.message) || 'unknown'),
    });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (!body.quoteKey) return json(400, { error: 'quoteKey required' });
  if (!body.owner)    return json(400, { error: 'owner required' });

  const quoteKey = String(body.quoteKey);
  const owner    = String(body.owner);

  const quotesStore  = getStore({ name: 'quotes',  consistency: 'strong' });
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // 1) Fetch the quote
  const quote = await quotesStore.get(quoteKey, { type: 'json' });
  if (!quote) return json(404, { error: 'Quote not found (may have been deleted): ' + quoteKey });

  const fd = quote.formData || {};
  const borrowerEmail = String(fd.borrowerEmail || quote.borrowerEmail || '').toLowerCase().trim();
  const borrowerName  = String(fd.borrower || fd.borrowerName || quote.borrower || '').trim();
  if (!borrowerEmail) {
    return json(400, { error: 'Quote has no borrower email — manual fix required.' });
  }
  if (!borrowerName) {
    return json(400, { error: 'Quote has no borrower name — manual fix required.' });
  }

  // Parse name into first/last
  const nameParts = borrowerName.split(/\s+/).filter(Boolean);
  const firstName = nameParts.length > 1 ? nameParts.slice(0, -1).join(' ') : (nameParts[0] || '');
  const lastName  = nameParts.length > 1 ? nameParts[nameParts.length - 1] : '';
  const phone     = String(fd.borrowerPhone || quote.borrowerPhone || '').trim();

  // 2) Look up clients under the orphan's owner. Match by email, then name.
  const { blobs } = await clientsStore.list({ prefix: owner + '/' });
  let existing = null;
  let existingKey = null;
  const allClients = [];
  for (const { key } of blobs) {
    const c = await clientsStore.get(key, { type: 'json' });
    if (!c) continue;
    allClients.push({ key, client: c });
    if ((c.email || '').toLowerCase().trim() === borrowerEmail) {
      existing = c;
      existingKey = key;
      break;
    }
  }
  if (!existing) {
    // No email match — fall back to name match (handles cases where the
    // client record was created with a different email but same person).
    const targetName = (firstName + ' ' + lastName).toLowerCase().trim();
    if (targetName) {
      for (const entry of allClients) {
        const cn = ((entry.client.firstName || '') + ' ' + (entry.client.lastName || '')).toLowerCase().trim();
        if (cn === targetName) {
          existing = entry.client;
          existingKey = entry.key;
          break;
        }
      }
    }
  }

  // 3) Build the loan record and merge / append
  const loanData = buildLoanFromOrphan(quote);
  const qAddrFull = normAddr(quote.address);
  const qAddrStreet = streetPart(quote.address);

  let clientToSave;
  let clientKey;
  let resultLoanId;

  if (existing) {
    // Append or merge. Check if a loan already exists at this address
    // (could happen if the orphan was partially-recovered earlier).
    existing.loans = existing.loans || [];
    let lIdx = -1;
    for (let k = 0; k < existing.loans.length; k++) {
      const lAddrFull = normAddr(existing.loans[k].address || '');
      const lAddrStreet = streetPart(existing.loans[k].address || '');
      if ((qAddrFull && lAddrFull === qAddrFull) ||
          (qAddrStreet && lAddrStreet && lAddrStreet === qAddrStreet)) {
        lIdx = k; break;
      }
    }
    if (lIdx >= 0) {
      // Already there — preserve the existing loan ID and merge fields.
      const prior = existing.loans[lIdx];
      existing.loans[lIdx] = Object.assign({}, loanData, {
        id: prior.id,
        status: prior.status || loanData.status,
        createdAt: prior.createdAt || loanData.savedAt,
      });
      resultLoanId = prior.id;
    } else {
      existing.loans.unshift(loanData);
      resultLoanId = loanData.id;
    }
    // Fill in missing top-level fields if blank
    if (firstName && !existing.firstName) existing.firstName = firstName;
    if (lastName  && !existing.lastName)  existing.lastName  = lastName;
    if (phone     && !existing.phone)     existing.phone     = phone;
    clientToSave = existing;
    clientKey = existingKey;
  } else {
    // Create a new client
    const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    clientToSave = {
      id: clientId,
      email: borrowerEmail,
      firstName,
      lastName,
      phone,
      createdAt: new Date().toISOString(),
      createdBy: owner,
      loans: [loanData],
    };
    // Match clients-save.mjs key format: keySafe(owner) + '/' + keySafe(id).
    // The owner from the orphan-list endpoint is already keySafe-d (it's
    // parsed from the existing client storage key), so don't re-apply.
    clientKey = owner + '/' + keySafe(clientId);
    resultLoanId = loanData.id;
  }

  // 4) Persist
  await clientsStore.setJSON(clientKey, clientToSave);
  await pgMirror.upsertClientWithLoansStrict(owner, clientToSave);

  return json(200, {
    success: true,
    clientId: clientToSave.id,
    loanId:   resultLoanId,
    ownerKey: owner,
    created:  !existing,
  });
}
