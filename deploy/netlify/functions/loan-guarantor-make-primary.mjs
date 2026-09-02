/**
 * loan-guarantor-make-primary.mjs — POST /api/loan-guarantor-make-primary
 *
 * Deploy 236.705 — promote an additional guarantor (Guarantor 2/3/4) to be the
 * PRIMARY guarantor on a loan. Because "primary" is structural (the primary is
 * the client whose .loans[] owns the loan), this MOVES the loan to the target
 * guarantor's client record — mirroring loan-reassign's cross-store move — then
 * relabels the application so the new primary is Guarantor 1.
 *
 * Two modes:
 *   • mode 'switch' (default) — the OLD primary stays on the loan, demoted to a
 *     secondary guarantor. Both parties already signed, so we KEEP their
 *     signatures: reorder the signed_applications blocks (audit seals preserved)
 *     and regenerate the PDF with the new Guarantor-1/2 order. No re-sign.
 *   • mode 'delete_primary' — the OLD primary is removed from the loan entirely
 *     (used when the primary guarantor is deleted). The application is RESET to
 *     awaiting-signatures so the remaining parties re-sign the corrected doc.
 *
 * Body: { clientId (current primary), loanId, guarantorClientId (to promote),
 *         mode?, owner? }
 * Same-owner only (v1), matching loan-reassign. Auth: loan owner or admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { newRecordKey, legacyRecordKey } from './_shared/borrower-info-keys.mjs';
import { record as recordLoanRedirect } from './_shared/loan-redirects.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';
import { resetApplicationForResign } from './_shared/application-resign-reset.mjs';
import { revokeLoanAccess } from './_shared/loan-access-store.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-guarantor-make-primary error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function safeKey(s) { return String(s || '').replace(/[^a-zA-Z0-9_-]/g, '_'); }
function signedAppKey(ownerKey, clientId, loanId) {
  return `${ownerKey}/${safeKey(clientId)}/${safeKey(loanId || '_no_loan')}`;
}
function emailOf(x) { return normalizeEmail((x && x.email) || ''); }
function nameOf(x) {
  return String(((x && x.firstName) || '') + ' ' + ((x && x.lastName) || '')).replace(/\s+/g, ' ').trim().toLowerCase()
    || String((x && x.name) || '').replace(/\s+/g, ' ').trim().toLowerCase();
}
// Find the index in data.guarantors[] whose email (or name) matches the person.
function findGuarantorIdx(guarantors, email, name) {
  if (!Array.isArray(guarantors)) return -1;
  const em = String(email || '').toLowerCase();
  const nm = String(name || '').toLowerCase();
  for (let i = 0; i < guarantors.length; i++) {
    const g = guarantors[i] || {};
    const gEm = String(g.email || '').toLowerCase();
    const gNm = (((g.firstName || '') + ' ' + (g.lastName || '')).replace(/\s+/g, ' ').trim().toLowerCase())
      || String(g.name || '').replace(/\s+/g, ' ').trim().toLowerCase();
    if ((em && gEm && gEm === em) || (nm && gNm && gNm === nm)) return i;
  }
  return -1;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (!body.clientId)          return json(400, { error: 'clientId required' });
  if (!body.loanId)            return json(400, { error: 'loanId required' });
  if (!body.guarantorClientId) return json(400, { error: 'guarantorClientId required' });
  if (body.guarantorClientId === body.clientId) {
    return json(400, { error: 'That guarantor is already the primary' });
  }
  const mode = body.mode === 'delete_primary' ? 'delete_primary' : 'switch';
  const removeOldPrimary = (mode === 'delete_primary');

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey = selfKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // ── Load source (current primary) + the loan ──────────────────────
  const srcKey = ownerKey + '/' + keySafe(body.clientId);
  const src = await clientsStore.get(srcKey, { type: 'json' }).catch(() => null);
  if (!src) return json(404, { error: 'Current primary client not found' });
  if (!Array.isArray(src.loans)) return json(400, { error: 'Primary client has no loans' });
  const loanIdx = src.loans.findIndex((l) => l && l.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on primary client' });
  const loan = src.loans[loanIdx];

  const guIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
  if (!guIds.includes(body.guarantorClientId)) {
    return json(400, { error: 'That client is not an additional guarantor on this loan' });
  }

  // ── Load destination (guarantor to promote) ───────────────────────
  const destKey = ownerKey + '/' + keySafe(body.guarantorClientId);
  const dest = await clientsStore.get(destKey, { type: 'json' }).catch(() => null);
  if (!dest) return json(404, { error: 'Guarantor client not found (same-owner only)' });
  if (!Array.isArray(dest.loans)) dest.loans = [];

  const now = new Date().toISOString();
  const oldPrimaryEmail = emailOf(src);
  const oldPrimaryName  = nameOf(src);
  const newPrimaryEmail = emailOf(dest);
  const newPrimaryName  = nameOf(dest);

  // ── Rebuild the guarantor list on the loan ────────────────────────
  // New primary leaves the additional-guarantor list (they now OWN the loan).
  let ids = guIds.filter((id) => id !== body.guarantorClientId);
  const ownership = (loan.guarantorOwnership && typeof loan.guarantorOwnership === 'object')
    ? Object.assign({}, loan.guarantorOwnership) : {};
  if (removeOldPrimary) {
    // Old primary is deleted from the loan — drop their ownership too.
    delete ownership[body.clientId];
  } else {
    // Switch: old primary is demoted to a secondary guarantor.
    if (!ids.includes(body.clientId)) ids.push(body.clientId);
  }
  loan.guarantorClientIds = ids;
  loan.guarantorOwnership = ownership;

  // Audit + move stamps.
  loan._movedAt = now;
  loan._movedBy = selfEmail;
  loan._movedFromClientId = src.id;
  loan.updatedAt = now;
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    const srcNm = (oldPrimaryName || src.email || src.id);
    const destNm = (newPrimaryName || dest.email || dest.id);
    appendNoteEntry(loan, {
      kind: 'status',
      text: (removeOldPrimary
        ? 'Primary guarantor removed — promoted ' + destNm + ' to primary; application reset for re-sign'
        : 'Switched primary guarantor from ' + srcNm + ' to ' + destNm + ' (signatures preserved)'),
      author, authorEmail: user.email || '',
      meta: { via: 'loan_guarantor_make_primary', mode, fromClientId: src.id, toClientId: dest.id },
    });
  }

  // ── Move the loan record src → dest ───────────────────────────────
  src.loans.splice(loanIdx, 1);
  dest.loans.push(loan);
  src.updatedAt = now;
  dest.updatedAt = now;
  try {
    await writeClient(ownerKey, dest, { clientsStore }); // dest first so the loan always exists somewhere
    await writeClient(ownerKey, src, { clientsStore });
  } catch (e) {
    return json(500, { error: 'Failed to write client records: ' + (e.message || 'unknown') });
  }

  // If deleting the old primary as a guarantor, revoke their portal access to
  // this loan (their client record is kept — they may hold other loans).
  if (removeOldPrimary) {
    try {
      if (oldPrimaryEmail) await revokeLoanAccess({ email: oldPrimaryEmail, loanId: body.loanId, revokedBy: selfEmail });
    } catch (e) { console.warn('make-primary: old-primary portal revoke failed (non-fatal):', e && e.message); }
  }

  // ── Move borrower_info src → dest (keeps the answers) ──────────────
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  let movedBorrowerInfo = false;
  let biRec = null;
  try {
    const oldBiKey = newRecordKey(ownerKey, body.clientId, body.loanId);
    const legacyBiKey = legacyRecordKey(ownerKey, body.clientId);
    biRec = await biStore.get(oldBiKey, { type: 'json' }).catch(() => null);
    let foundAtNew = !!biRec;
    if (!biRec) biRec = await biStore.get(legacyBiKey, { type: 'json' }).catch(() => null);
    if (biRec) {
      biRec.clientId = dest.id;
      biRec.loanId = body.loanId;
      await biStore.setJSON(newRecordKey(ownerKey, dest.id, body.loanId), biRec);
      if (foundAtNew) await biStore.delete(oldBiKey); else await biStore.delete(legacyBiKey);
      movedBorrowerInfo = true;
    }
  } catch (e) { console.warn('make-primary: borrower_info move failed (non-fatal):', e && e.message); }

  // ── Move signed_applications src → dest ───────────────────────────
  const signedStore = getStore({ name: 'signed_applications', consistency: 'strong' });
  let signedRec = null;
  try {
    const oldAppKey = signedAppKey(ownerKey, body.clientId, body.loanId);
    signedRec = await signedStore.get(oldAppKey, { type: 'json' }).catch(() => null);
    if (signedRec) {
      signedRec.clientId = dest.id;
      await signedStore.setJSON(signedAppKey(ownerKey, dest.id, body.loanId), signedRec);
      await signedStore.delete(oldAppKey);
    }
  } catch (e) { console.warn('make-primary: signed_application move failed (non-fatal):', e && e.message); }

  // ── Move quotes + reviews + redirect (mirror loan-reassign) ───────
  let movedQuotes = 0, movedReviews = 0;
  try {
    const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
    const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const q = await quotesStore.get(key, { type: 'json' });
      if (!q) continue;
      if (q.loanId === body.loanId || (q.clientId === body.clientId && (!q.loanId || q.loanId === body.loanId))) {
        q.clientId = dest.id; if (!q.loanId) q.loanId = body.loanId;
        q.updatedAt = now; q._reassignedAt = now; q._reassignedBy = selfEmail;
        await quotesStore.setJSON(key, q); movedQuotes += 1;
      }
    }
  } catch (e) { console.warn('make-primary: quote move failed (non-fatal):', e && e.message); }
  try {
    const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r || !r.source) continue;
      if (r.source.loanId === body.loanId && r.source.clientId === body.clientId) {
        r.source.clientId = dest.id;
        const dn = (newPrimaryName ? (dest.firstName + ' ' + dest.lastName).trim() : '');
        if (dn) r.borrowerName = dn;
        r.updatedAt = now;
        await reviewsStore.setJSON(key, r); movedReviews += 1;
      }
    }
  } catch (e) { console.warn('make-primary: review move failed (non-fatal):', e && e.message); }
  try {
    await recordLoanRedirect({
      loanId: body.loanId, fromOwnerKey: ownerKey, fromClientId: body.clientId,
      toOwnerKey: ownerKey, toClientId: dest.id, via: 'make_primary:' + mode,
    });
  } catch (e) { console.warn('make-primary: redirect record failed (non-fatal):', e && e.message); }

  // ── Relabel the application so the new primary is Guarantor 1 ──────
  let applicationReset = false;
  let signaturesPreserved = false;
  if (removeOldPrimary) {
    // Delete-primary path: drop the old primary from data.guarantors[], move the
    // new primary to the front, and RESET the app to awaiting-signatures so the
    // remaining parties re-sign the corrected document.
    try {
      const r = await resetApplicationForResign({
        ownerKey, clientId: dest.id, loanId: body.loanId,
        force: true, // primary changed → always require re-sign
        transformData: (data) => {
          const arr = Array.isArray(data.guarantors) ? data.guarantors : null;
          if (!arr || !arr.length) return false;
          const oldIdx = findGuarantorIdx(arr, oldPrimaryEmail, oldPrimaryName);
          const newIdx = findGuarantorIdx(arr, newPrimaryEmail, newPrimaryName);
          const newEntry = newIdx >= 0 ? arr[newIdx] : null;
          // Drop the old primary; put the new primary first; keep the rest.
          const rest = arr.filter((_, i) => i !== oldIdx && i !== newIdx);
          data.guarantors = (newEntry ? [newEntry] : []).concat(rest);
          return true;
        },
      });
      applicationReset = !!(r && r.reset);
    } catch (e) { console.warn('make-primary: delete-primary reset failed (non-fatal):', e && e.message); }
  } else if (biRec) {
    // Switch path: reorder data.guarantors[] (swap positions 0 ↔ newIdx) so the
    // new primary is Guarantor 1, KEEPING everyone's answers + signatures.
    try {
      const data = biRec.data || (biRec.data = {});
      const arr = Array.isArray(data.guarantors) ? data.guarantors : [];
      const newIdx = findGuarantorIdx(arr, newPrimaryEmail, newPrimaryName);
      if (newIdx > 0) {
        const tmp = arr[0]; arr[0] = arr[newIdx]; arr[newIdx] = tmp;
      }
      biRec.updatedAt = now;
      await biStore.setJSON(newRecordKey(ownerKey, dest.id, body.loanId), biRec);
    } catch (e) { console.warn('make-primary: guarantor data reorder failed (non-fatal):', e && e.message); }

    // Reorder the signed blocks (borrower1 ↔ the new primary's block), preserve
    // audits, and regenerate the PDF. Best-effort — the move already succeeded.
    try {
      if (signedRec) {
        // Which borrowerN block is the new primary?
        let newPos = 0;
        for (const pos of [1, 2, 3, 4]) {
          const b = signedRec['borrower' + pos];
          if (b && emailOf(b) && emailOf(b) === newPrimaryEmail) { newPos = pos; break; }
        }
        if (newPos > 1) {
          const b1 = signedRec.borrower1;
          const bN = signedRec['borrower' + newPos];
          // Swap the people (audit seals travel with them); fix role labels to
          // match the new position.
          if (b1) b1.role = 'borrower' + newPos;
          if (bN) bN.role = 'borrower1';
          signedRec.borrower1 = bN;
          signedRec['borrower' + newPos] = b1;
        }
        // Rebuild signers in on-record order and regenerate.
        const signers = [];
        for (const pos of [1, 2, 3, 4]) {
          const b = signedRec['borrower' + pos];
          if (b) signers.push(b);
        }
        const destLoan = dest.loans.find((l) => l && l.id === body.loanId) || loan;
        const pdfBuffer = await renderSignedApplicationPDF({
          record: biRec, client: dest, loan: destLoan,
          status: signedRec.status || 'complete', signers,
        });
        signedRec.pdfBase64 = pdfBuffer.toString('base64');
        signedRec.pdfSize = pdfBuffer.length;
        signedRec.updatedAt = now;
        if (!Array.isArray(signedRec.corrections)) signedRec.corrections = [];
        signedRec.corrections.push({ at: now, by: selfEmail, reason: 'primary_guarantor_switch' });
        await signedStore.setJSON(signedAppKey(ownerKey, dest.id, body.loanId), signedRec);
        signaturesPreserved = true;
      }
    } catch (e) { console.warn('make-primary: signed PDF reorder/regen failed (non-fatal):', e && e.message); }
  }

  // Deploy 236.773 — audit log (best-effort; must never fail the save).
  try {
    const _alActor = normalizeEmail(user.email);
    await recordLoanChanges({
      ownerKey, clientId: dest.id, loanId: loan.id,
      actor: _alActor, actorName: user.name || _alActor,
      source: 'Guarantors', changes: [{ field: 'guarantors', label: 'Primary borrower changed', from: String((src && (src.firstName || src.lastName)) ? ((src.firstName||'') + ' ' + (src.lastName||'')).trim() : (src && src.id) || ''), to: String((dest && (dest.firstName || dest.lastName)) ? ((dest.firstName||'') + ' ' + (dest.lastName||'')).trim() : (dest && dest.id) || '') }],
    });
  } catch (e) { console.warn('loan-guarantor-make-primary: change log failed (non-fatal):', e && e.message); }

  // Deploy 236.818 — the primary changed (and the review's source.clientId just
  // moved to dest): refresh the Doc Review's point of truth + re-run reviewed
  // docs against the corrected borrower set (best-effort background).
  try {
    const { queueTruthRefresh } = await import('./_shared/review-truth.mjs');
    await queueTruthRefresh({
      ownerKey, clientId: dest.id, loanId: body.loanId,
      reason: removeOldPrimary
        ? 'primary guarantor removed — ' + (newPrimaryName || dest.email || dest.id) + ' promoted to primary'
        : 'primary switched to ' + (newPrimaryName || dest.email || dest.id),
      actorEmail: selfEmail,
    });
  } catch (e) { console.warn('make-primary: truth refresh queue failed (non-fatal):', e && e.message); }


  return json(200, {
    ok: true,
    mode,
    newPrimaryClientId: dest.id,
    oldPrimaryClientId: src.id,
    loanId: body.loanId,
    movedBorrowerInfo,
    movedQuotes,
    movedReviews,
    applicationReset,
    signaturesPreserved,
  });
}
