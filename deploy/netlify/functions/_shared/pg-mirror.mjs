/**
 * _shared/pg-mirror.mjs — best-effort dual-write to Postgres.
 *
 * Phase 2 of the data migration. Every mutation endpoint calls one
 * of these AFTER its authoritative blob write. Behavior:
 *
 *   - Never throws. A PG write failure is logged and the primary
 *     request response is unaffected.
 *   - Never blocks. Returns a promise so callers can await, but a
 *     ".catch(() => {})" is enough — no meaningful info surfaces
 *     from the response anyway.
 *   - Idempotent on the receive end (upsert on conflict id).
 *
 * Whole-client mirror is preferred over per-loan when both are
 * available — a client save that touches the loans array flushes
 * ALL loans in one call, avoiding partial-state drift.
 *
 * Usage:
 *   import { mirror } from './_shared/pg-mirror.mjs';
 *   // ... after clientsStore.setJSON(key, record) ...
 *   mirror.upsertClient(ownerEmail, record).catch(() => {});
 */
import { db } from './supabase-db.mjs';
import { projectClient, projectLoan } from './pg-projections.mjs';

// Small helper: normalize an ownerKey (which in blob-land IS the
// email but is sometimes lowercased inconsistently) to a canonical
// email for owner_email storage. Same normalize the projections
// expect from the backfill.
function _ownerEmail(ownerKey) {
  return String(ownerKey || '').trim().toLowerCase();
}

// One JSON.stringify at import time so hot-path calls don't rebuild
// the "endpoint disabled" marker every invocation. When
// PG_MIRROR_DISABLED=true is set on Netlify, every mirror call is a
// no-op. Rollback lever for Phase 2 if something goes sideways.
function _isDisabled() {
  return String(process.env.PG_MIRROR_DISABLED || '').toLowerCase() === 'true';
}

async function _upsertClient(ownerEmail, client) {
  if (_isDisabled()) return;
  if (!client || !client.id || !ownerEmail) return;
  try {
    const row = projectClient(client, ownerEmail);
    if (!row) return;
    await db.upsert('clients', row, { onConflict: 'id' });
  } catch (e) {
    console.warn('[pg-mirror] upsertClient ' + (client.id || '?') + ' failed:',
      e && (e.message || e));
  }
}

async function _upsertClientWithLoans(ownerEmail, client) {
  if (_isDisabled()) return;
  if (!client || !client.id || !ownerEmail) return;
  await _upsertClient(ownerEmail, client);
  // Flush all loans currently on this client — they may have been
  // added / removed / edited in the same request that touched the
  // client scalars. A partial per-loan upsert would leave loans that
  // were REMOVED from client.loans[] still sitting in Postgres,
  // pointing at the same client_id.
  const currentLoanIds = new Set();
  if (Array.isArray(client.loans)) {
    const loanRows = [];
    for (const loan of client.loans) {
      if (!loan || !loan.id) continue;
      const row = projectLoan(loan, client.id, ownerEmail);
      if (row) {
        loanRows.push(row);
        currentLoanIds.add(loan.id);
      }
    }
    if (loanRows.length) {
      try {
        await db.upsert('loans', loanRows, { onConflict: 'id' });
      } catch (e) {
        console.warn('[pg-mirror] upsertLoans for client ' + client.id + ' failed:',
          e && (e.message || e));
      }
    }
  }
  // Delete any loans that USED to be on this client (in PG) but
  // aren't anymore (per the incoming record). Common cause: a
  // reassign moved a loan off, or a manual delete. Without this,
  // stale loans linger under their old client_id.
  try {
    const existing = await db.select('loans', {
      select: 'id',
      eq: { client_id: client.id },
    });
    for (const row of (existing || [])) {
      if (row && row.id && !currentLoanIds.has(row.id)) {
        // Fire-and-forget individual deletes so a stubborn row
        // doesn't stall the others.
        db.del('loans', { id: row.id }).catch((e) =>
          console.warn('[pg-mirror] stale loan delete ' + row.id + ' failed:',
            e && (e.message || e))
        );
      }
    }
  } catch (e) {
    console.warn('[pg-mirror] stale-loan reconcile for client ' + client.id + ' failed:',
      e && (e.message || e));
  }
}

async function _upsertLoan(ownerEmail, clientId, loan) {
  if (_isDisabled()) return;
  if (!loan || !loan.id || !clientId || !ownerEmail) return;
  try {
    const row = projectLoan(loan, clientId, ownerEmail);
    if (!row) return;
    await db.upsert('loans', row, { onConflict: 'id' });
  } catch (e) {
    console.warn('[pg-mirror] upsertLoan ' + (loan.id || '?') + ' failed:',
      e && (e.message || e));
  }
}

async function _deleteClient(clientId) {
  if (_isDisabled()) return;
  if (!clientId) return;
  try {
    await db.del('clients', { id: clientId });
  } catch (e) {
    console.warn('[pg-mirror] deleteClient ' + clientId + ' failed:',
      e && (e.message || e));
  }
}

async function _deleteLoan(loanId) {
  if (_isDisabled()) return;
  if (!loanId) return;
  try {
    await db.del('loans', { id: loanId });
  } catch (e) {
    console.warn('[pg-mirror] deleteLoan ' + loanId + ' failed:',
      e && (e.message || e));
  }
}

export const mirror = {
  upsertClient:          (ownerEmail, client)         => _upsertClient(_ownerEmail(ownerEmail), client),
  upsertClientWithLoans: (ownerEmail, client)         => _upsertClientWithLoans(_ownerEmail(ownerEmail), client),
  upsertLoan:            (ownerEmail, clientId, loan) => _upsertLoan(_ownerEmail(ownerEmail), clientId, loan),
  deleteClient:          (clientId)                    => _deleteClient(clientId),
  deleteLoan:            (loanId)                      => _deleteLoan(loanId),
};
