/**
 * loan-assign-lo.mjs — POST /api/loan-assign-lo
 *
 * Deploy 236.187 — reassign a loan from one Loan Officer's ownership
 * to another. Different from loan-reassign.mjs which moves between
 * two clients under the SAME owner. This moves ACROSS owners.
 *
 * The loan's client record can't just be moved (the source client
 * may have other loans that should stay). We create a new client
 * under the destination owner (copying borrower info) and put the
 * loan there. The source client keeps its other loans.
 *
 * Body:
 *   {
 *     ownerKey,          keySafe of current owner
 *     clientId,          loan's client id
 *     loanId,            the loan to move
 *     newOwnerEmail,     destination LO email
 *   }
 *
 * Behavior:
 *   - Loads source client + finds the loan.
 *   - Creates a new client at <newOwnerKey>/c_lo_<timestamp>_<rand>
 *     with copied borrower info + this loan.
 *   - Removes loan from source client. If source client is now empty
 *     AND was the IMPORT_OWNER_KEY, deletes it.
 *   - Moves supporting data: borrower_info, signed_applications,
 *     quotes, loan_reviews — same as loan-reassign for consistency.
 *   - Writes a native-link for future Baseline Migrates to route to
 *     the new owner if the loan has a Baseline external Id.
 *
 * Returns updated destination info + counts.
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { newRecordKey, legacyRecordKey } from './_shared/borrower-info-keys.mjs';
import { IMPORT_OWNER_KEY, setNativeLink } from './_shared/baseline-upsert.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-assign-lo error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  if (!body.ownerKey)      return json(400, { error: 'ownerKey required' });
  if (!body.clientId)      return json(400, { error: 'clientId required' });
  if (!body.loanId)        return json(400, { error: 'loanId required' });
  if (!body.newOwnerEmail) return json(400, { error: 'newOwnerEmail required' });

  const oldOwnerKey = String(body.ownerKey).trim();
  const newOwnerEmail = normalizeEmail(body.newOwnerEmail);
  const newOwnerKey = keySafe(newOwnerEmail);
  if (!newOwnerKey) return json(400, { error: 'newOwnerEmail is invalid' });
  if (oldOwnerKey === newOwnerKey) return json(400, { error: 'Loan is already owned by this LO' });

  const now = new Date().toISOString();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  const srcKey = oldOwnerKey + '/' + keySafe(body.clientId);
  const srcClient = await clientsStore.get(srcKey, { type: 'json' }).catch(() => null);
  if (!srcClient) return json(404, { error: 'Source client not found' });
  if (!Array.isArray(srcClient.loans)) return json(400, { error: 'Source client has no loans[]' });

  const loanIdx = srcClient.loans.findIndex((x) => x && x.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on source client' });
  const loan = srcClient.loans[loanIdx];

  // Build the destination client. Fresh id under new owner's namespace.
  const destClientId = 'c_lo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const destKey     = newOwnerKey + '/' + destClientId;
  const destClient  = {
    id: destClientId,
    firstName:  srcClient.firstName  || '',
    lastName:   srcClient.lastName   || '',
    email:      srcClient.email      || '',
    phone:      srcClient.phone      || '',
    entityName: srcClient.entityName || '',
    displayName: srcClient.displayName || '',
    address:    srcClient.address    || '',
    city:       srcClient.city       || '',
    state:      srcClient.state      || '',
    zip:        srcClient.zip        || '',
    createdAt:  now,
    updatedAt:  now,
    _assignedFromClientId: srcClient.id,
    _assignedFromOwnerKey: oldOwnerKey,
    _assignedAt:           now,
    _assignedBy:           user.email || '',
    loans: [],
  };

  // Stamp audit + note on the loan itself.
  loan._assignedAt          = now;
  loan._assignedBy          = user.email || '';
  loan._assignedFromOwnerKey = oldOwnerKey;
  loan._assignedFromClientId = srcClient.id;
  loan.updatedAt            = now;
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(loan, {
      kind:  'status',
      text:  'Assigned to LO ' + newOwnerEmail + ' (from owner ' + oldOwnerKey + ')',
      author,
      authorEmail: user.email || '',
      meta: { via: 'loan_assign_lo', fromOwnerKey: oldOwnerKey, toOwnerEmail: newOwnerEmail, toClientId: destClientId },
    });
  }

  destClient.loans.push(loan);
  srcClient.loans.splice(loanIdx, 1);
  srcClient.updatedAt = now;

  const deleteSrcClient = srcClient.loans.length === 0 && oldOwnerKey === IMPORT_OWNER_KEY;

  try {
    // Write dest FIRST — if src write fails, at least the loan lives somewhere.
    await clientsStore.setJSON(destKey, destClient);
    if (deleteSrcClient) await clientsStore.delete(srcKey);
    else                  await clientsStore.setJSON(srcKey, srcClient);
  } catch (e) {
    return json(500, { error: 'Failed to persist client records: ' + (e.message || 'unknown') });
  }

  // ── Move supporting cross-store data ─────────────────────────
  let movedBorrowerInfo = false;
  try {
    const biStore   = getStore({ name: 'borrower_info', consistency: 'strong' });
    const oldBiNew  = newRecordKey(oldOwnerKey, body.clientId, body.loanId);
    const oldBiLegacy = legacyRecordKey(oldOwnerKey, body.clientId);
    let biRec = await biStore.get(oldBiNew, { type: 'json' });
    let foundAtNew = !!biRec;
    if (!biRec) biRec = await biStore.get(oldBiLegacy, { type: 'json' });
    if (biRec) {
      const destBiKey = newRecordKey(newOwnerKey, destClientId, body.loanId);
      biRec.clientId = destClientId;
      biRec.loanId   = body.loanId;
      biRec.ownerKey = newOwnerKey;
      await biStore.setJSON(destBiKey, biRec);
      if (foundAtNew) await biStore.delete(oldBiNew);
      else            await biStore.delete(oldBiLegacy);
      movedBorrowerInfo = true;
    }
  } catch (e) {
    console.warn('loan-assign-lo: borrower_info move failed (non-fatal):', e && e.message);
  }

  let movedSignedApp = false;
  try {
    const appStore = getStore({ name: 'signed_applications', consistency: 'strong' });
    const oldAppKey = oldOwnerKey + '/' + keySafe(body.clientId) + '/' + keySafe(body.loanId);
    const newAppKey = newOwnerKey + '/' + destClientId + '/' + keySafe(body.loanId);
    const rec = await appStore.get(oldAppKey, { type: 'json' });
    if (rec) {
      rec.clientId = destClientId;
      rec.ownerKey = newOwnerKey;
      await appStore.setJSON(newAppKey, rec);
      await appStore.delete(oldAppKey);
      movedSignedApp = true;
    }
  } catch (e) {
    console.warn('loan-assign-lo: signed_application move failed (non-fatal):', e && e.message);
  }

  let movedQuotes = 0;
  try {
    const qStore = getStore({ name: 'quotes', consistency: 'strong' });
    const { blobs } = await qStore.list({ prefix: oldOwnerKey + '/' });
    for (const { key } of blobs) {
      const q = await qStore.get(key, { type: 'json' });
      if (!q) continue;
      if (q.loanId !== body.loanId) continue;
      // Delete old-owner-keyed entry, write under new owner's namespace.
      const newQuoteKey = newOwnerKey + '/' + key.slice(oldOwnerKey.length + 1);
      q.clientId  = destClientId;
      q.ownerKey  = newOwnerKey;
      q.updatedAt = now;
      q._reassignedAt = now;
      q._reassignedBy = user.email || '';
      await qStore.setJSON(newQuoteKey, q);
      if (newQuoteKey !== key) await qStore.delete(key);
      movedQuotes += 1;
    }
  } catch (e) {
    console.warn('loan-assign-lo: quote move failed (non-fatal):', e && e.message);
  }

  let movedReviews = 0;
  try {
    const rStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await rStore.list();
    for (const { key } of blobs) {
      const r = await rStore.get(key, { type: 'json' });
      if (!r || !r.source) continue;
      if (r.source.loanId === body.loanId && r.source.clientId === body.clientId && r.source.ownerKey === oldOwnerKey) {
        r.source.clientId = destClientId;
        r.source.ownerKey = newOwnerKey;
        r.updatedAt = now;
        await rStore.setJSON(key, r);
        movedReviews += 1;
      }
    }
  } catch (e) {
    console.warn('loan-assign-lo: review update failed (non-fatal):', e && e.message);
  }

  // Update the native link if this loan has a Baseline extId so
  // future Migrates keep landing on the NEW owner's record.
  const extId = (loan._baselineExternalId
    || (loan._baselineRaw && loan._baselineRaw.Id)
    || ''
  );
  let linkUpdated = false;
  if (extId) {
    try {
      await setNativeLink(String(extId).trim(), {
        ownerKey: newOwnerKey,
        clientId: destClientId,
        loanId:   loan.id,
        source:   'assign_lo',
      });
      linkUpdated = true;
    } catch (e) {
      console.warn('loan-assign-lo: setNativeLink failed (non-fatal):', e && e.message);
    }
  }

  return json(200, {
    ok: true,
    newOwnerKey,
    newOwnerEmail,
    newClientId:      destClientId,
    loanId:           loan.id,
    srcClientDeleted: deleteSrcClient,
    movedBorrowerInfo,
    movedSignedApp,
    movedQuotes,
    movedReviews,
    linkUpdated,
  });
}
