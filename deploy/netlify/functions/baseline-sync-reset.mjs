/**
 * baseline-sync-reset.mjs — POST /api/baseline-sync-reset
 *
 * Clear the persisted Baseline refs (_baselineEntityId / _baselineGuarantor1Id
 * / _baselineGuarantor2Id / _baselineLoanId) on a loan record so a
 * subsequent "Send to Baseline" creates fresh records.
 *
 * Used when a Baseline loan is in a half-broken state (e.g. loan record
 * exists but Guarantor isn't attached because the person↔entity
 * connection happened after the loan was created — Baseline only
 * derives Guarantor_Id at loan-create time from the entity's Team).
 *
 * IMPORTANT — this does NOT delete the existing Baseline records.
 * The LO must manually delete the orphan loan in Baseline UI before
 * clicking Retry, otherwise a new Baseline loan will be created
 * alongside the old one.
 *
 * Auth: loan owner OR admin (admin may pass `owner` to act on another
 * LO's loan, same pattern as the rest of the endpoints).
 *
 * Body: { clientId, loanId, owner? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail, keySafe, readJsonBody,
} from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.clientId || !body.loanId) {
    return json(400, { error: 'clientId and loanId required' });
  }

  // Owner resolution. Admins may target another LO's loan via body.owner.
  const selfEmail = normalizeEmail(user.email);
  let ownerEmail = selfEmail;
  if (body.owner && body.owner !== selfEmail) {
    if (!isAdmin(user)) {
      return json(403, { error: 'Owner override requires admin' });
    }
    ownerEmail = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(ownerEmail);

  // Load the client and locate the loan ───────────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(body.clientId);

  let client;
  try {
    client = await clientsStore.get(clientKey, { type: 'json' });
  } catch (e) {
    console.error('baseline-sync-reset: client read failed', e);
    return json(500, { error: 'Failed to load client' });
  }
  if (!client) return json(404, { error: 'Client not found' });

  const loans = Array.isArray(client.loans) ? client.loans : [];
  const loanIdx = loans.findIndex((l) => l && l.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = loans[loanIdx];

  // Capture the pre-reset refs so we can return them in the response —
  // the LO needs to know which Baseline records to manually delete /
  // clean up.
  const priorRefs = {
    baselineEntityId:     loan._baselineEntityId     || null,
    baselineGuarantor1Id: loan._baselineGuarantor1Id || null,
    baselineGuarantor2Id: loan._baselineGuarantor2Id || null,
    baselineLoanId:       loan._baselineLoanId       || null,
  };

  const now = new Date().toISOString();
  const updatedLoan = {
    ...loan,
    _baselineEntityId:     null,
    _baselineGuarantor1Id: null,
    _baselineGuarantor2Id: null,
    _baselineLoanId:       null,
    _baselineSyncStatus:   'not_synced',
    _baselineLastError:    null,
    _baselineLastSteps:    [],
    _baselineLastDebug:    null,
    _baselineLastResetAt:  now,
    _baselineLastResetBy:  selfEmail,
    _baselinePriorRefs:    priorRefs,
  };

  const updatedClient = {
    ...client,
    loans: loans.map((l, i) => (i === loanIdx ? updatedLoan : l)),
    updatedAt: now,
  };

  try {
    await clientsStore.setJSON(clientKey, updatedClient);
  } catch (e) {
    console.error('baseline-sync-reset: client write failed', e);
    return json(500, { error: 'Failed to clear refs' });
  }

  return json(200, {
    ok: true,
    priorRefs,
    note: 'Baseline refs cleared. Manually delete the orphaned Baseline records (loan + any borrowers that shouldn\'t persist) before clicking Retry, otherwise a duplicate loan will be created.',
  });
};
