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
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';

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

  const user = requireAuth(context, req);
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

  // Note-log entry on the loan for audit.
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(loan, {
      kind:  'status',
      text:  'Removed guarantor ' + body.guarantorClientId + ' from this loan',
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
    const { blobs } = await clientsStore.list();
    const wantSuffix = '/' + keySafe(body.guarantorClientId);
    for (const { key } of blobs) {
      if (!key.endsWith(wantSuffix)) continue;
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!rec || rec.id !== body.guarantorClientId) continue;
      const before = Array.isArray(rec._guarantorOnLoans) ? rec._guarantorOnLoans : [];
      const after = before.filter((b) =>
        !(b && b.primaryClientId === primary.id && b.loanId === body.loanId)
      );
      if (after.length !== before.length) {
        rec._guarantorOnLoans = after;
        rec.updatedAt = now;
        // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
        // (also refreshes the guarantor's owner index).
        const slash = key.indexOf('/');
        const gOwner = slash > 0 ? key.slice(0, slash) : ownerKey;
        await writeClient(gOwner, rec, { clientsStore });
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
        if (rec._guarantorSubformTokens.length !== beforeT) {
          const _slash2 = key.indexOf('/');
          const _gOwner2 = _slash2 > 0 ? key.slice(0, _slash2) : ownerKey;
          // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
          await writeClient(_gOwner2, rec, { clientsStore });
        }
      }
      break;
    }
  } catch (e) {
    console.warn('loan-remove-guarantor: backref cleanup failed (non-fatal):', e && e.message);
  }

  return json(200, {
    ok: true,
    loan,
    guarantorClientId: body.guarantorClientId,
    removedBackrefs,
  });
}
