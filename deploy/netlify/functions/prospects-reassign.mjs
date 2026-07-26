/**
 * prospects-reassign.mjs — POST /api/prospects-reassign
 *
 * Admin-only endpoint to reassign a prospect from one owner key (typically
 * 'unassigned') to a target LO email. Re-stores the prospect under the
 * target LO's key, removes the old blob, AND runs the auto-create-client
 * flow that prospects-save uses on first arrival — so the LO sees the
 * client + initial loan in their Clients/Pipeline.
 *
 * Body:
 *   {
 *     fromOwner: 'unassigned' | <oldOwnerKey>,
 *     prospectId: 'p_...',
 *     toLoEmail: 'sara.s@slacapital.com'
 *   }
 *
 * Response: { ok: true, newOwnerKey, clientCreated: boolean }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe, normalizeEmail,
  readJsonBody,
} from './_shared/auth.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const fromOwner = String(body.fromOwner || '').trim();
  const prospectId = String(body.prospectId || '').trim();
  const toLoEmail = normalizeEmail(body.toLoEmail || '');
  if (!fromOwner || !prospectId) return json(400, { error: 'fromOwner and prospectId required' });
  if (!toLoEmail || !toLoEmail.includes('@')) return json(400, { error: 'Valid toLoEmail required' });

  const store = getStore({ name: 'prospects', consistency: 'strong' });
  const oldKey = `${fromOwner}/${keySafe(prospectId)}`;

  // Load the existing prospect
  let prospect;
  try {
    prospect = await store.get(oldKey, { type: 'json' });
  } catch (e) {
    console.error('prospects-reassign: read error', e);
    return json(500, { error: 'Failed to read prospect' });
  }
  if (!prospect) return json(404, { error: 'Prospect not found at ' + oldKey });

  // Mutate ownership fields
  prospect.loSlug = toLoEmail;
  prospect.loEmail = toLoEmail;
  prospect.loDisplay = prospect.loDisplay || '';

  const newOwnerKey = keySafe(toLoEmail);
  const newKey = `${newOwnerKey}/${keySafe(prospectId)}`;

  try {
    // Write the new entry first, then delete the old. If the delete fails
    // we end up with a duplicate (not great) but the prospect is still
    // visible to the LO. Worst case is admin re-runs and the duplicate
    // gets overwritten on second pass.
    await store.setJSON(newKey, prospect);
    if (oldKey !== newKey) {
      try { await store.delete(oldKey); }
      catch (e) { console.warn('prospects-reassign: delete old key failed:', e); }
    }
  } catch (e) {
    console.error('prospects-reassign: write error', e);
    return json(500, { error: 'Failed to reassign prospect' });
  }

  // Now run the same client-from-prospect upsert that prospects-save does
  // on first arrival, so the LO gets a Client + initial Loan they can work.
  let clientCreated = false;
  try {
    clientCreated = await upsertClientFromProspect(prospect, toLoEmail);
  } catch (e) {
    console.warn('prospects-reassign: client upsert failed:', e);
  }

  return json(200, { ok: true, newOwnerKey, clientCreated });
};

// Mirror of the helper in prospects-save.mjs. Kept inline (vs. shared
// import) so this endpoint stays self-contained and a future schema
// change in one file doesn't silently break the other.
async function upsertClientFromProspect(prospect, loEmail) {
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(normalizeEmail(loEmail));
  const borrowerEmailNorm = normalizeEmail(prospect.email);
  if (!borrowerEmailNorm) return false;

  // Search this LO's clients for an existing match by borrower email
  let existing = null;
  let existingKey = null;
  try {
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' });
      if (c && (c.email || '').toLowerCase() === borrowerEmailNorm) {
        existing = c;
        existingKey = key;
        break;
      }
    }
  } catch (e) {
    console.warn('prospects-reassign: client list failed:', e);
  }

  // Map application's loanProduct → sizer toolType
  const lp = String(prospect.loanProduct || '').toLowerCase();
  const toolType = lp === 'dscr' ? 'dscr' : 'rtl';
  const loanTypeForRecord = lp === 'fix_flip' ? 'light'
    : lp === 'bridge'        ? 'bridge'
    : lp === 'transactional' ? 'transactional'
    : '';

  const now = new Date().toISOString();
  const loan = {
    id: 'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    toolType,
    address: prospect.propAddress || '',
    savedAt: now,
    updatedAt: now,
    status: 'active',
    loanType: loanTypeForRecord,
    loanAmt: prospect.purchasePrice || prospect.propertyValue || '',
    propValue: prospect.propertyValue || prospect.estimatedARV || '',
    rent: prospect.monthlyRent || '',
    taxes: prospect.monthlyTaxes || '',
    insurance: prospect.monthlyInsurance || '',
    hoa: prospect.monthlyHOA || '',
    bedrooms: prospect.bedrooms || '',
    bathrooms: prospect.bathrooms || '',
    sqft: prospect.sqft || '',
    propType: prospect.propType || '',
    usCitizen: prospect.usCitizen || '',
    loanPurpose: prospect.loanPurpose || '',
    rentalType: prospect.rentalType || '',
    fundingDate: prospect.fundingDate || '',
    purchasePrice: prospect.purchasePrice || '',
    rehabBudget: prospect.rehabCost || '',
    arv: prospect.estimatedARV || '',
    experience: prospect.flipsCompleted || '',
    currentLoanAmt: prospect.currentLoanAmt || '',
    projectDescription: prospect.projectDescription || '',
    creditScore: prospect.creditScore || '',
    fromApplication: true,
  };

  if (existing) {
    // Merge a new loan into the existing client record. Don't duplicate
    // if a loan at the same address already exists.
    const addrNorm = normAddr(loan.address);
    const dupIdx = (existing.loans || []).findIndex(
      (l) => normAddr(l.address || '') === addrNorm,
    );
    if (dupIdx < 0) {
      existing.loans = existing.loans || [];
      existing.loans.unshift(loan);
    }
    existing.updatedAt = now;
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
    await writeClient(ownerKey, existing, { clientsStore });
    return true;
  }

  // Create a fresh client record
  const clientId = 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  const record = {
    id: clientId,
    createdAt: now,
    updatedAt: now,
    createdBy: normalizeEmail(loEmail),
    firstName: prospect.firstName || '',
    lastName: prospect.lastName || '',
    email: borrowerEmailNorm,
    phone: prospect.phone || '',
    loans: [loan],
    fromApplication: true,
  };
  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  await writeClient(ownerKey, record, { clientsStore });
  return true;
}

function normAddr(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}
