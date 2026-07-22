/**
 * loan-create-on-client.mjs — POST /api/loan-create-on-client
 *
 * Companion to loan-update-from-sizer.mjs. That endpoint UPDATES an
 * existing loan by (clientId, loanId). This one CREATES a new loan
 * on an existing client — same direct-ID discipline, no email or
 * address matching guesswork.
 *
 * Use case: the "+ Create New Loan" button on Client Details lands
 * the LO in the sizer with clientId in the URL but no loanId (no
 * loan exists yet). When they Save Quote, the sizer previously fell
 * through to Clients.upsert, which matches by borrowerEmail — and
 * on broker-owned deals (where the "client" is the broker and the
 * borrower email is a totally different person / not set) that
 * created a duplicate client instead of appending the loan to the
 * broker record. Symptom: Pipeline shows "⚠ Loan record missing"
 * on the new card, Broker/Contact isn't clickable, an unrelated
 * prospect at the same address surfaces in New Application.
 *
 * Body: { clientId, owner?, loanData }
 * Response: { ok: true, loan: <new loan with fresh id + createdAt> }
 *
 * The backend mints the loanId so ownership is unambiguous. The
 * caller then hydrates window._editingLoanId from the response, so
 * subsequent saves go through the deterministic update path
 * (loan-update-from-sizer) rather than repeatedly falling through
 * upsert.
 *
 * Fires the same three write-throughs as loan-update-from-sizer:
 *   - Postgres mirror (Phase 2 dual-write)
 *   - clients-index materialized cache (Deploy 236.341)
 *   - quote-store sync (Deploy 236.249)
 * All fire-and-forget — the primary blob write is what mattered.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { linkOrCreateBroker } from './_shared/broker-link.mjs';
import { syncLoanToQuoteStoreStrict } from './_shared/quote-sync.mjs';
import { upsertClientStrict as indexUpsertClientStrict } from './_shared/clients-index.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs';

// Same shape as loan-details.js's loan ID minter.
function _newLoanId() {
  return 'l_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Fields the caller shouldn't be allowed to force on a create — the
// backend owns id + createdAt so the loanId is canonical.
const CALLER_CANNOT_SET = ['id', 'createdAt'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-create-on-client error:', e);
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
  if (!body.clientId) return json(400, { error: 'clientId required' });
  if (!body.loanData || typeof body.loanData !== 'object') {
    return json(400, { error: 'loanData required' });
  }

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(body.clientId);

  let client;
  try {
    client = await clientsStore.get(clientKey, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to read client record: ' + (e.message || 'unknown') });
  }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const now = new Date().toISOString();
  const loanId = _newLoanId();

  // Strip caller-set id/createdAt so backend is authoritative on those.
  // Strip _editingClientId / _editingLoanId (they're transient sizer
  // state, per CLAUDE.md — should never persist).
  const incoming = Object.assign({}, body.loanData);
  for (const k of CALLER_CANNOT_SET) delete incoming[k];
  delete incoming._editingClientId;
  delete incoming._editingLoanId;

  const newLoan = Object.assign({}, incoming, {
    id:        loanId,
    createdAt: now,
    updatedAt: now,
    savedAt:   now,
    status:    incoming.status || 'active',
  });

  // Append + write.
  client.loans.push(newLoan);
  client.updatedAt = now;

  // Note-log entry so the audit trail shows where this loan came from.
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(newLoan, {
      kind:  'status',
      text:  'Loan created from sizer (client: ' + client.id + ')',
      author,
      authorEmail: user.email || '',
      meta: { via: 'loan_create_on_client', clientId: client.id },
    });
  }

  // Auto-link broker if inline fields present without a brokerId —
  // same helper loan-update-from-sizer uses.
  try {
    await linkOrCreateBroker(ownerKey, newLoan);
  } catch (e) {
    console.warn('loan-create-on-client: broker-link non-fatal:', e && e.message);
  }

  try {
    await clientsStore.setJSON(clientKey, client);
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  // Strict triple-write — blob is already saved above; if PG, index,
  // or quote store fails, throw a 500 so the LO retries instead of
  // silent inconsistency.
  await pgMirror.upsertClientWithLoansStrict(ownerKey, client);
  await indexUpsertClientStrict(ownerKey, client);
  await syncLoanToQuoteStoreStrict(ownerKey, newLoan);

  return json(200, {
    ok:   true,
    loan: newLoan,
  });
}
