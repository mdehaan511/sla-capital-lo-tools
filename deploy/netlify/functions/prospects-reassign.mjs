/**
 * prospects-reassign.mjs — POST /api/prospects-reassign
 *
 * Admin-only endpoint to reassign a prospect from one owner key (typically
 * 'unassigned') to a target LO email. Re-stores the prospect under the
 * target LO's key and removes the old blob.
 *
 * Deploy 236.783 — reassigning now MOVES the client + loan that
 * prospects-save auto-created under the ORIGINAL owner, instead of
 * minting a second copy under the new LO (the old behavior — it left
 * the original untouched, which is exactly how the Aaron Madison /
 * Hawthorne Ave loan ended up on two LOs' pipelines: auto-created
 * under chance@ at submit, re-created under sara.s@ on reassign).
 * Mike's rule: reassigning must never create duplicates.
 *
 * Resolution order:
 *   1. Source copy under the OLD owner is found by loan.prospectId
 *      (stamped since 236.22), falling back to borrower-email +
 *      normalized-address match on fromApplication loans.
 *   2. If the target LO already has this prospect's loan (matched by
 *      prospectId), nothing new is created (dedup).
 *   3. Source found → the loan MOVES: the whole client record is
 *      re-homed when it only held this loan, else just the loan is
 *      spliced across. Cross-store records that key by owner
 *      (borrower_info, signed_applications, quotes, loan_reviews'
 *      source) move with it, and a loan redirect is recorded so old
 *      URLs keep working.
 *   4. No source copy (e.g. fromOwner 'unassigned' never had one) →
 *      the historical auto-create runs under the new owner, now
 *      stamping prospectId (the old inline mirror had drifted and
 *      didn't).
 *
 * Body:
 *   {
 *     fromOwner: 'unassigned' | <oldOwnerKey>,
 *     prospectId: 'p_...',
 *     toLoEmail: 'sara.s@slacapital.com'
 *   }
 *
 * Response: { ok, newOwnerKey, clientCreated, clientMoved, loanMoved,
 *             dedupSkipped }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe, normalizeEmail,
  readJsonBody,
} from './_shared/auth.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { newRecordKey, legacyRecordKey } from './_shared/borrower-info-keys.mjs';
import { record as recordLoanRedirect } from './_shared/loan-redirects.mjs';
import { prospectsIndex } from './_shared/prospects-index.mjs';

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

  // Deploy 236.783 — move the already-created client/loan (or create one
  // only if none exists anywhere). Never leave two copies behind.
  const result = { clientCreated: false, clientMoved: false, loanMoved: false, dedupSkipped: false };
  try {
    await moveOrCreateClient(prospect, prospectId, fromOwner, toLoEmail, user, result);
  } catch (e) {
    console.warn('prospects-reassign: client move/upsert failed:', e);
  }

  // Deploy 236.783 — keep the prospect's client/loan links + the
  // prospects-index in step with the move (the index previously kept the
  // stale old-owner entry after a reassign). Best-effort.
  try {
    if (result.destClientId) prospect.clientId = result.destClientId;
    if (result.loanId)       prospect.loanId   = result.loanId;
    await store.setJSON(newKey, prospect);
    await prospectsIndex.upsertRecord(newOwnerKey, prospect);
    if (fromOwner !== newOwnerKey) await prospectsIndex.removeRecord(fromOwner, prospectId);
  } catch (e) {
    console.warn('prospects-reassign: index sync failed (non-fatal):', e && e.message);
  }

  return json(200, { ok: true, newOwnerKey, ...result });
};

function normAddr(s) {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function loanMatchesProspect(l, prospectId, prospect) {
  if (!l) return false;
  if (prospectId && l.prospectId === prospectId) return true;
  return !!(l.fromApplication && prospect.propAddress && normAddr(l.address) === normAddr(prospect.propAddress));
}

async function moveOrCreateClient(prospect, prospectId, fromOwnerKey, toLoEmail, user, result) {
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const newOwnerKey = keySafe(normalizeEmail(toLoEmail));
  const borrowerEmailNorm = normalizeEmail(prospect.email);
  const selfEmail = normalizeEmail(user.email);
  const now = new Date().toISOString();

  // ── 1. Does the TARGET owner already have this prospect's loan? ──
  // Also remember their client for this borrower email (merge target).
  let destClient = null;
  try {
    const { blobs } = await clientsStore.list({ prefix: newOwnerKey + '/' });
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' });
      if (!c) continue;
      if (Array.isArray(c.loans) && c.loans.some((l) => l && l.prospectId === prospectId)) {
        // Already converted under the target LO — nothing to create or move.
        // (If a stale copy also exists under the old owner, we leave it for a
        // human: silently deleting another LO's records on a dedup hit is how
        // real data gets lost.)
        result.dedupSkipped = true;
        return;
      }
      if (!destClient && borrowerEmailNorm && normalizeEmail(c.email || '') === borrowerEmailNorm) {
        destClient = c;
      }
    }
  } catch (e) {
    console.warn('prospects-reassign: target scan failed:', e);
  }

  // ── 2. Find the auto-created copy under the OLD owner ──
  let srcClient = null;
  let srcLoanIdx = -1;
  if (fromOwnerKey && fromOwnerKey !== newOwnerKey) {
    try {
      const { blobs } = await clientsStore.list({ prefix: fromOwnerKey + '/' });
      for (const { key } of blobs) {
        const c = await clientsStore.get(key, { type: 'json' });
        if (!c || !Array.isArray(c.loans)) continue;
        let idx = c.loans.findIndex((l) => l && l.prospectId === prospectId);
        if (idx < 0 && borrowerEmailNorm && normalizeEmail(c.email || '') === borrowerEmailNorm) {
          idx = c.loans.findIndex((l) => loanMatchesProspect(l, prospectId, prospect));
        }
        if (idx >= 0) { srcClient = c; srcLoanIdx = idx; break; }
      }
    } catch (e) {
      console.warn('prospects-reassign: source scan failed:', e);
    }
  }

  // ── 3. No source copy anywhere → historical auto-create (now with
  //       prospectId stamped so future dedup/moves are deterministic). ──
  if (!srcClient) {
    result.clientCreated = await upsertClientFromProspect(prospect, toLoEmail, destClient, result);
    return;
  }

  // ── 4. MOVE the loan to the new owner ──
  const loan = srcClient.loans[srcLoanIdx];
  if (!loan.prospectId) loan.prospectId = prospectId;
  loan.updatedAt = now;
  appendNoteEntry(loan, {
    kind:        'status',
    text:        'Loan reassigned from ' + fromOwnerKey + ' to ' + toLoEmail + ' (prospect reassignment — moved, not copied)',
    author:      selfEmail,
    authorEmail: selfEmail,
    meta: { via: 'prospects_reassign', fromOwnerKey, toOwnerKey: newOwnerKey, prospectId },
  });

  const srcKey = fromOwnerKey + '/' + keySafe(srcClient.id);
  const soleLoan = srcClient.loans.length === 1;
  let destClientId;

  if (soleLoan && !destClient) {
    // Re-home the WHOLE client record (same ids — every stored reference
    // to clientId/loanId stays valid; only the owner prefix changes).
    srcClient.updatedAt = now;
    await writeClient(newOwnerKey, srcClient, { clientsStore });
    try { await clientsStore.delete(srcKey); }
    catch (e) { console.warn('prospects-reassign: old client blob delete failed:', e); }
    destClientId = srcClient.id;
    result.clientMoved = true;
  } else {
    // Splice the loan across; the source client keeps its other loans
    // (or is deleted below if this emptied an auto-created shell).
    srcClient.loans.splice(srcLoanIdx, 1);
    if (!destClient) {
      destClient = {
        id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        createdAt: now,
        updatedAt: now,
        createdBy: normalizeEmail(toLoEmail),
        firstName: prospect.firstName || srcClient.firstName || '',
        lastName:  prospect.lastName  || srcClient.lastName  || '',
        email:     borrowerEmailNorm,
        phone:     prospect.phone || srcClient.phone || '',
        loans: [],
        fromApplication: true,
      };
      result.clientCreated = true;
    }
    if (!Array.isArray(destClient.loans)) destClient.loans = [];
    destClient.loans.unshift(loan);
    destClient.updatedAt = now;
    // Dest first: if the source write then fails the loan still exists.
    await writeClient(newOwnerKey, destClient, { clientsStore });
    if (srcClient.loans.length === 0 && srcClient.fromApplication) {
      try {
        await clientsStore.delete(srcKey);
        await pgMirror.deleteClientStrict(srcClient.id);
      } catch (e) { console.warn('prospects-reassign: emptied shell delete failed:', e); }
    } else {
      srcClient.updatedAt = now;
      await writeClient(fromOwnerKey, srcClient, { clientsStore });
    }
    destClientId = destClient.id;
    result.loanMoved = true;
  }
  result.destClientId = destClientId;
  result.loanId = loan.id;

  // ── 5. Carry owner-keyed side records with the loan (all best-effort;
  //       usually no-ops — reassignment normally happens at intake,
  //       before any of these exist). ──
  const srcClientId = srcClient.id;
  try { // borrower_info (long app)
    const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
    const oldNew = newRecordKey(fromOwnerKey, srcClientId, loan.id);
    const oldLegacy = legacyRecordKey(fromOwnerKey, srcClientId);
    let rec = await biStore.get(oldNew, { type: 'json' });
    let foundAtNew = !!rec;
    if (!rec) rec = await biStore.get(oldLegacy, { type: 'json' });
    if (rec) {
      rec.clientId = destClientId;
      await biStore.setJSON(newRecordKey(newOwnerKey, destClientId, loan.id), rec);
      await biStore.delete(foundAtNew ? oldNew : oldLegacy);
    }
  } catch (e) { console.warn('prospects-reassign: borrower_info move failed (non-fatal):', e && e.message); }

  try { // signed application PDF record
    const appStore = getStore({ name: 'signed_applications', consistency: 'strong' });
    const oldAppKey = fromOwnerKey + '/' + keySafe(srcClientId) + '/' + keySafe(loan.id);
    const rec = await appStore.get(oldAppKey, { type: 'json' });
    if (rec) {
      rec.clientId = destClientId;
      await appStore.setJSON(newOwnerKey + '/' + keySafe(destClientId) + '/' + keySafe(loan.id), rec);
      await appStore.delete(oldAppKey);
    }
  } catch (e) { console.warn('prospects-reassign: signed_application move failed (non-fatal):', e && e.message); }

  try { // sizer quote records under the old owner
    const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
    const { blobs } = await quotesStore.list({ prefix: fromOwnerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q || q.loanId !== loan.id) continue;
      q.clientId = destClientId;
      q.updatedAt = now;
      await quotesStore.setJSON(newOwnerKey + '/' + key.split('/').slice(1).join('/'), q);
      await quotesStore.delete(key);
    }
  } catch (e) { console.warn('prospects-reassign: quote move failed (non-fatal):', e && e.message); }

  try { // doc review source pointer (reviews are keyed flat by review id)
    const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r || !r.source || r.source.loanId !== loan.id) continue;
      r.source.clientId = destClientId;
      r.source.ownerKey = toLoEmail;
      r.loEmail = toLoEmail;
      r.updatedAt = now;
      await reviewsStore.setJSON(key, r);
    }
  } catch (e) { console.warn('prospects-reassign: review move failed (non-fatal):', e && e.message); }

  // Old bookmarked URLs (owner, client, loan) keep resolving.
  try {
    await recordLoanRedirect({
      loanId:       loan.id,
      fromOwnerKey: fromOwnerKey,
      fromClientId: srcClientId,
      toOwnerKey:   newOwnerKey,
      toClientId:   destClientId,
      via:          'prospects_reassign',
    });
  } catch (e) { console.warn('prospects-reassign: redirect record failed (non-fatal):', e && e.message); }
}

// Mirror of the helper in prospects-save.mjs — runs ONLY when no client
// copy exists anywhere yet (e.g. the prospect sat under 'unassigned',
// which never auto-creates a client). Deploy 236.783: now stamps
// prospectId on the loan (drift fix) and merges into the target LO's
// existing client for this borrower when one was found.
async function upsertClientFromProspect(prospect, loEmail, existing, result) {
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(normalizeEmail(loEmail));
  const borrowerEmailNorm = normalizeEmail(prospect.email);
  if (!borrowerEmailNorm) return false;

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
    prospectId: prospect.id || '',
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
    // if a loan for this prospect (or its address) already exists.
    const dupIdx = (existing.loans || []).findIndex(
      (l) => loanMatchesProspect(l, prospect.id || '', prospect),
    );
    if (dupIdx < 0) {
      existing.loans = existing.loans || [];
      existing.loans.unshift(loan);
      if (result) result.loanId = loan.id;
    } else if (result) {
      result.loanId = existing.loans[dupIdx].id;
    }
    if (result) result.destClientId = existing.id;
    existing.updatedAt = now;
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
  await writeClient(ownerKey, record, { clientsStore });
  if (result) { result.destClientId = clientId; result.loanId = loan.id; }
  return true;
}
