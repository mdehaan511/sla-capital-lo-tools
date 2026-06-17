/**
 * loan-reassign.mjs — POST /api/loan-reassign
 *
 * Move a loan from one client to another. The common LO scenario is
 * "the person who filled out the apply-link wasn't the actual
 * guarantor" — the loan gets created under client A but should live
 * under client B (the real guarantor).
 *
 * Moves more than just the loan record. Cross-store records keyed by
 * (ownerKey, clientId, loanId) — borrower_info, signed_applications,
 * borrower_info_token_idx, etc. — would silently break if left under
 * the old client. Same for quotes (Pipeline reads quote.clientId for
 * tile links) and loan_reviews (review pages link by source.clientId).
 *
 * Body:
 *   {
 *     srcClientId,                                  required
 *     loanId,                                       required
 *     destClientId,                                 EITHER this
 *     newClient: { firstName, lastName, email,      OR this
 *                  phone?, entityName? },
 *     owner?                                        admin cross-LO
 *   }
 *
 * Same-owner only for v1. Both clients must live under the same
 * ownerKey. Cross-LO admin moves can be added later if needed.
 *
 * Stamps audit fields on the loan record:
 *   _movedAt, _movedBy, _movedFromClientId
 * Appends a notesLog entry kind:'status' describing the move.
 *
 * Returns: { ok: true, destClientId, loanId, movedQuotes, movedReviews,
 *            movedBorrowerInfo, movedSignedApp }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { newRecordKey, legacyRecordKey } from './_shared/borrower-info-keys.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-reassign top-level error:', e);
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
  if (!body.srcClientId) return json(400, { error: 'srcClientId required' });
  if (!body.loanId)      return json(400, { error: 'loanId required' });
  if (!body.destClientId && !body.newClient) {
    return json(400, { error: 'destClientId or newClient required' });
  }
  if (body.destClientId && body.newClient) {
    return json(400, { error: 'Provide either destClientId or newClient, not both' });
  }
  if (body.newClient && !body.newClient.firstName && !body.newClient.lastName && !body.newClient.email) {
    return json(400, { error: 'newClient needs at least firstName, lastName, or email' });
  }

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
  const srcKey = ownerKey + '/' + keySafe(body.srcClientId);

  let srcClient;
  try {
    srcClient = await clientsStore.get(srcKey, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to read source client: ' + (e.message || 'unknown') });
  }
  if (!srcClient) return json(404, { error: 'Source client not found' });
  if (!Array.isArray(srcClient.loans)) return json(400, { error: 'Source client has no loans array' });

  const loanIdx = srcClient.loans.findIndex((l) => l && l.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on source client' });
  const loan = srcClient.loans[loanIdx];

  // Resolve / create destination client
  let destClient;
  let destClientCreated = false;
  if (body.destClientId) {
    if (body.destClientId === body.srcClientId) {
      return json(400, { error: 'Destination is the same as source — nothing to do' });
    }
    const destKey = ownerKey + '/' + keySafe(body.destClientId);
    try { destClient = await clientsStore.get(destKey, { type: 'json' }); }
    catch (e) { return json(500, { error: 'Failed to read dest client: ' + (e.message || 'unknown') }); }
    if (!destClient) return json(404, { error: 'Destination client not found' });
  } else {
    const nc = body.newClient || {};
    const now = new Date().toISOString();
    destClient = {
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      firstName: String(nc.firstName || '').trim(),
      lastName:  String(nc.lastName  || '').trim(),
      email:     normalizeEmail(nc.email || ''),
      phone:     String(nc.phone || '').trim(),
      entityName: String(nc.entityName || '').trim(),
      createdAt: now,
      updatedAt: now,
      loans: [],
      _createdViaReassign: true,
      _createdBy: selfEmail,
    };
    destClientCreated = true;
  }
  if (!Array.isArray(destClient.loans)) destClient.loans = [];

  // ── Move the loan record ─────────────────────────────────────
  const now = new Date().toISOString();
  loan._movedAt = now;
  loan._movedBy = selfEmail;
  loan._movedFromClientId = srcClient.id;
  loan.updatedAt = now;

  // Audit note on the loan
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    const srcName = ((srcClient.firstName || '') + ' ' + (srcClient.lastName || '')).trim() || srcClient.email || srcClient.id;
    const destName = ((destClient.firstName || '') + ' ' + (destClient.lastName || '')).trim() || destClient.email || destClient.id;
    appendNoteEntry(loan, {
      kind:        'status',
      text:        'Reassigned loan from ' + srcName + ' to ' + destName + (destClientCreated ? ' (new client)' : ''),
      author,
      authorEmail: user.email || '',
      meta: {
        via: 'loan_reassign',
        fromClientId: srcClient.id,
        toClientId:   destClient.id,
        destClientCreated,
      },
    });
  }

  // Splice out of source, push onto destination
  srcClient.loans.splice(loanIdx, 1);
  destClient.loans.push(loan);

  // Write both clients atomically-as-possible. Write dest FIRST so
  // that if the src write fails, the loan still exists somewhere.
  // The audit fields on the loan make it clear it was moved.
  try {
    const destKey = ownerKey + '/' + keySafe(destClient.id);
    await clientsStore.setJSON(destKey, destClient);
    await clientsStore.setJSON(srcKey, srcClient);
  } catch (e) {
    return json(500, { error: 'Failed to write client records: ' + (e.message || 'unknown') });
  }

  // ── Move borrower_info ───────────────────────────────────────
  // The long-app data the original applicant submitted. Probably
  // partly wrong for the new guarantor (they'll re-send the long-app
  // link to the actual guarantor), but the property + loan details
  // are still useful. Move the record to the new key so it's not
  // orphaned.
  let movedBorrowerInfo = false;
  try {
    const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
    const newBiKey = newRecordKey(ownerKey, body.srcClientId, body.loanId);
    const legacyBiKey = legacyRecordKey(ownerKey, body.srcClientId);
    let biRec = await biStore.get(newBiKey, { type: 'json' });
    let foundAtNewKey = !!biRec;
    if (!biRec) biRec = await biStore.get(legacyBiKey, { type: 'json' });
    if (biRec) {
      const destBiKey = newRecordKey(ownerKey, destClient.id, body.loanId);
      // Update embedded refs so the moved record stays self-consistent.
      biRec.clientId = destClient.id;
      biRec.loanId   = body.loanId;
      await biStore.setJSON(destBiKey, biRec);
      // Delete the old key so we don't leave a stale duplicate that
      // could be picked up later via the legacy lookup path.
      if (foundAtNewKey) await biStore.delete(newBiKey);
      else                await biStore.delete(legacyBiKey);
      movedBorrowerInfo = true;
    }
  } catch (e) {
    console.warn('loan-reassign: borrower_info move failed (non-fatal):', e && e.message);
  }

  // ── Move signed_application ──────────────────────────────────
  let movedSignedApp = false;
  try {
    const appStore = getStore({ name: 'signed_applications', consistency: 'strong' });
    const oldAppKey = ownerKey + '/' + keySafe(body.srcClientId) + '/' + keySafe(body.loanId);
    const newAppKey = ownerKey + '/' + keySafe(destClient.id) + '/' + keySafe(body.loanId);
    const appRec = await appStore.get(oldAppKey, { type: 'json' });
    if (appRec) {
      appRec.clientId = destClient.id;
      await appStore.setJSON(newAppKey, appRec);
      await appStore.delete(oldAppKey);
      movedSignedApp = true;
    }
  } catch (e) {
    console.warn('loan-reassign: signed_application move failed (non-fatal):', e && e.message);
  }

  // ── Update quotes ────────────────────────────────────────────
  // Pipeline tile clicks navigate via quote.clientId — orphaned
  // quote records would point at the empty source client.
  let movedQuotes = 0;
  try {
    const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q) continue;
      if (q.loanId === body.loanId || (q.clientId === body.srcClientId && (!q.loanId || q.loanId === body.loanId))) {
        q.clientId = destClient.id;
        if (!q.loanId) q.loanId = body.loanId;
        q.updatedAt = now;
        q._reassignedAt = now;
        q._reassignedBy = selfEmail;
        await quotesStore.setJSON(key, q);
        movedQuotes += 1;
      }
    }
  } catch (e) {
    console.warn('loan-reassign: quote update failed (non-fatal):', e && e.message);
  }

  // ── Update loan_reviews ──────────────────────────────────────
  // The new Doc Review tool. Review records reference source.clientId
  // and source.loanId. If a review exists for this loan, point it at
  // the new client so the "Open Loan Doc Review →" link from Loan
  // Details (which matches by clientId+loanId) keeps working.
  let movedReviews = 0;
  try {
    const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r || !r.source) continue;
      if (r.source.loanId === body.loanId && r.source.clientId === body.srcClientId) {
        r.source.clientId = destClient.id;
        // Refresh display fields snapshotted from the (now-different)
        // client record so the review header isn't stale.
        const destName = ((destClient.firstName || '') + ' ' + (destClient.lastName || '')).trim();
        if (destName) r.borrowerName = destName;
        r.updatedAt = now;
        await reviewsStore.setJSON(key, r);
        movedReviews += 1;
      }
    }
  } catch (e) {
    console.warn('loan-reassign: review update failed (non-fatal):', e && e.message);
  }

  return json(200, {
    ok: true,
    destClientId: destClient.id,
    loanId: body.loanId,
    destClientCreated,
    movedQuotes,
    movedReviews,
    movedBorrowerInfo,
    movedSignedApp,
  });
}
