/**
 * loan-remove-guarantor.mjs — POST /api/loan-remove-guarantor
 *
 * Deploy 236.366 — inverse of loan-add-guarantor. Unlinks a
 * guarantor client from a loan.
 *
 * Mike's use case: broker loans get accidentally tagged with a
 * guarantor before the deal's actually ready (broker deals often
 * skip the guarantor step until later in the flow). The Add
 * Guarantor button previously had no matching Clear/Remove path —
 * once linked, the guarantor stuck.
 *
 * Body: {
 *   clientId,               required — primary client's id
 *   loanId,                 required
 *   guarantorClientId,      required — the client to unlink
 *   owner?                  admin cross-LO
 * }
 *
 * Behavior:
 *   1. Removes guarantorClientId from loan.guarantorClientIds.
 *   2. Deletes loan.guarantorOwnership[guarantorClientId].
 *   3. On the guarantor client itself, removes any entry in
 *      _guarantorOnLoans that references this loan.
 *   4. Appends a note-log entry to the loan documenting who did it.
 *   5. Does NOT delete the guarantor client — they may still be
 *      linked to other loans, or the LO may want to re-add them
 *      later. Just removes the link.
 *
 * Response: { ok, loan, guarantorClientId, removedBackrefs }
 * Auth: loan owner or admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { revokeLoanAccess } from './_shared/loan-access-store.mjs'; // Deploy 236.591
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';
import { findClientById } from './_shared/client-lookup.mjs'; // Deploy 236.418
// Deploy 236.703 — removing a guarantor modifies the application and requires a
// re-sign (Mike). This resets the app to awaiting-signatures.
import { resetApplicationForResign } from './_shared/application-resign-reset.mjs';
// Deploy 236.818 — the Doc Review's point of truth must follow the change.
import { queueTruthRefresh } from './_shared/review-truth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-remove-guarantor error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

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

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey = selfKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin/processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const primaryKey = ownerKey + '/' + keySafe(body.clientId);
  const primary = await clientsStore.get(primaryKey, { type: 'json' }).catch(() => null);
  if (!primary) return json(404, { error: 'Primary client not found' });

  const loanIdx = (primary.loans || []).findIndex((l) => l && l.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on primary client' });
  const loan = primary.loans[loanIdx];

  const ids = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
  if (!ids.includes(body.guarantorClientId)) {
    // Not linked — nothing to remove. Treat as idempotent success so
    // an accidental double-click from the UI doesn't error.
    return json(200, {
      ok: true,
      loan,
      guarantorClientId: body.guarantorClientId,
      removedBackrefs: 0,
      alreadyUnlinked: true,
    });
  }

  const now = new Date().toISOString();
  loan.guarantorClientIds = ids.filter((id) => id !== body.guarantorClientId);
  if (loan.guarantorOwnership && typeof loan.guarantorOwnership === 'object') {
    delete loan.guarantorOwnership[body.guarantorClientId];
  }
  loan.updatedAt = now;
  primary.updatedAt = now;

  // Deploy 236.818 — resolve the guarantor's identity BEFORE the audit note so
  // the note says WHO was removed, not their record id ("Removed guarantor
  // c_17866..." meant nothing to a processor reading the feed). The same lookup
  // result feeds the backref cleanup below — one PG hit, not two.
  let guarantorHit = null;
  let guarantorEmail = '';
  let guarantorName = '';
  try {
    // Deploy 236.418 — was a full-store walk (sequential blob gets
    // across every namespace) to find the guarantor's client record;
    // now one indexed PG lookup by id.
    guarantorHit = await findClientById(body.guarantorClientId, clientsStore);
    if (guarantorHit) {
      guarantorEmail = normalizeEmail(guarantorHit.client.email || '');
      guarantorName = ((guarantorHit.client.firstName || '') + ' ' + (guarantorHit.client.lastName || '')).replace(/\s+/g, ' ').trim();
    }
  } catch (e) {
    console.warn('loan-remove-guarantor: identity lookup failed (non-fatal):', e && e.message);
  }
  const guarantorLabel = guarantorName || guarantorEmail || body.guarantorClientId;

  // Note-log entry on the loan for audit.
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(loan, {
      kind:  'status',
      text:  'Removed guarantor ' + guarantorLabel + ' from this loan',
      author,
      authorEmail: user.email || '',
      meta: { via: 'loan_remove_guarantor', guarantorClientId: body.guarantorClientId },
    });
  }

  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  await writeClient(ownerKey, primary, { clientsStore });

  // Clean up the backref on the guarantor client. The guarantor may
  // live under a different owner (linked cross-LO); walk all
  // namespaces to find it. Non-fatal if we can't — the backref will
  // eventually be reconciled by other flows.
  let removedBackrefs = 0;
  try {
    const hit = guarantorHit;
    if (hit) {
      const rec = hit.client;
      const gOwner = hit.ownerKey;
      // Deploy 236.591 — revoke this guarantor's borrower-portal access to the
      // loan they were just removed from, so it disappears from their portal.
      // borrower-portal-loans also self-heals via its guarantor tie-check, but
      // revoking the grant keeps the loan_access list honest and auditable.
      try {
        const gEmail = normalizeEmail(rec.email || '');
        if (gEmail) await revokeLoanAccess({ email: gEmail, loanId: body.loanId, revokedBy: selfEmail });
      } catch (e) {
        console.warn('loan-remove-guarantor: portal-access revoke failed (non-fatal):', e && e.message);
      }
      const before = Array.isArray(rec._guarantorOnLoans) ? rec._guarantorOnLoans : [];
      const after = before.filter((b) =>
        !(b && b.primaryClientId === primary.id && b.loanId === body.loanId)
      );
      let dirty = false;
      if (after.length !== before.length) {
        rec._guarantorOnLoans = after;
        rec.updatedAt = now;
        dirty = true;
        removedBackrefs += (before.length - after.length);
      }
      // Also nuke any pending subform token entries for this loan
      // so a stale email can't still land on a form for a
      // now-unlinked guarantor.
      if (Array.isArray(rec._guarantorSubformTokens)) {
        const beforeT = rec._guarantorSubformTokens.length;
        rec._guarantorSubformTokens = rec._guarantorSubformTokens.filter((t) =>
          !(t && t.primaryClientId === primary.id && t.loanId === body.loanId)
        );
        if (rec._guarantorSubformTokens.length !== beforeT) dirty = true;
      }
      if (dirty) {
        // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient.
        // One write instead of the old up-to-two.
        await writeClient(gOwner, rec, { clientsStore });
      }
    }
  } catch (e) {
    console.warn('loan-remove-guarantor: backref cleanup failed (non-fatal):', e && e.message);
  }

  // Deploy 236.703 — removing a guarantor modifies the loan application, so the
  // remaining parties must re-sign the corrected document. Splice this guarantor
  // out of data.guarantors[] and, if the app was already signed/in-flight, reset
  // it to awaiting-signatures (delete the signed PDF + re-mint the Borrower-1
  // link). A fresh Borrower-1 sign rebuilds the PDF + secondary tokens from the
  // reduced guarantor set. Best-effort — never fail the removal on this.
  let applicationReset = false;
  try {
    const em = String(guarantorEmail || '').toLowerCase();
    const nm = String(guarantorName || '').toLowerCase();
    const dropGuarantor = (data) => {
      const arr = Array.isArray(data.guarantors) ? data.guarantors : null;
      if (!arr) return false;
      let idx = -1;
      for (let i = 0; i < arr.length; i++) {
        const g = arr[i] || {};
        const gEm = String(g.email || '').toLowerCase();
        const gNm = (((g.firstName || '') + ' ' + (g.lastName || '')).toLowerCase().replace(/\s+/g, ' ').trim())
          || String(g.name || '').toLowerCase().replace(/\s+/g, ' ').trim();
        if ((em && gEm && gEm === em) || (nm && gNm && gNm === nm)) { idx = i; break; }
      }
      // Never touch index 0 (the primary borrower) from the secondary-remove path.
      if (idx <= 0) return false;
      arr.splice(idx, 1);
      return true;
    };
    const r = await resetApplicationForResign({
      ownerKey, clientId: body.clientId, loanId: body.loanId, transformData: dropGuarantor,
    });
    applicationReset = !!(r && r.reset);
  } catch (e) {
    console.warn('loan-remove-guarantor: application re-sign reset failed (non-fatal):', e && e.message);
  }

  // Deploy 236.773 — audit log (best-effort; must never fail the save).
  try {
    const _alActor = normalizeEmail(user.email);
    await recordLoanChanges({
      ownerKey, clientId: primary.id, loanId: loan.id,
      actor: _alActor, actorName: user.name || _alActor,
      source: 'Guarantors', changes: [{ field: 'guarantors', label: 'Guarantor removed', from: String(guarantorName || guarantorEmail || body.guarantorClientId), to: '' }],
    });
  } catch (e) { console.warn('loan-remove-guarantor: change log failed (non-fatal):', e && e.message); }

  // Deploy 236.818 — refresh the Doc Review's point of truth + re-run its
  // reviewed docs so the AI stops grading against the removed guarantor.
  // Fire-and-forget background work; never blocks the removal.
  await queueTruthRefresh({
    ownerKey, clientId: primary.id, loanId: loan.id,
    reason: 'guarantor ' + guarantorLabel + ' removed',
    actorEmail: selfEmail,
  });


  return json(200, {
    ok: true,
    loan,
    guarantorClientId: body.guarantorClientId,
    removedBackrefs,
    applicationReset,
  });
}
