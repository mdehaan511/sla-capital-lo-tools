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

// ── STRICT VARIANTS ─────────────────────────────────────────────
// These throw on error. Use them from mutation endpoints so PG
// write failures surface as 500s to the caller (and, in turn, as
// clear error toasts to the LO) rather than silent success + a
// missing tile on Pipeline.
//
// Phase 4 flipped reads to PG-first with blob fallback. When PG is
// out of sync with blob, EVERY page that reads PG shows stale data.
// The old fire-and-forget mirror was fine when PG was purely a
// mirror; it's dangerous now that PG is authoritative for reads.
//
// Rollback lever: PG_MIRROR_DISABLED=true still skips ALL mirror
// writes (strict + non-strict) so if PG has an outage or a bad
// schema deploy we can restore write-path availability instantly.
//
// Naming: <method>Strict. Callers should await + let the outer
// try/catch surface the error.
async function _upsertClientStrict(ownerEmail, client) {
  if (_isDisabled()) return;
  if (!client || !client.id || !ownerEmail) return;
  const row = projectClient(client, ownerEmail);
  if (!row) return;
  await db.upsert('clients', row, { onConflict: 'id' });
}

// Hardening Phase C1 (Deploy 236.393) — the strict client-save path
// prefers the upsert_client_with_loans RPC (db/migrations/002_tx_rpcs.sql):
// client upsert + loans upsert + stale-loan reconcile in ONE Postgres
// transaction instead of four separate REST calls a crash could split.
// Until the migration has been run, PostgREST answers 404/PGRST202 —
// we note it once per warm instance and fall back to the legacy
// multi-call sequence, so deploy order doesn't matter.
let _txRpcMissing = false;

function _isRpcMissing(e) {
  return !!(e && (e.status === 404 ||
    (e.data && e.data.code === 'PGRST202') ||
    /PGRST202|Could not find the function/i.test(String(e.message || ''))));
}

// opts.allowDemotion (Phase C4, Deploy 236.394): the DB trigger
// trg_loans_no_demotion blocks terminal→non-terminal status moves
// unless this is passed. Only endpoints where a demotion is an
// EXPLICIT user action set it: loan-cancel restore, admin moves in
// loan-advance-status, curated merges. Everything else (sizer saves,
// prospect flows, quote sync) defaults to false — that's the
// stale-snapshot bug class the trigger exists to kill.
// Deploy 236.449 — broker-FK self-heal. A loan can carry a brokerId
// that isn't a live PG client: brokers live in the 'brokers' store and
// aren't always mirrored into `clients`, or the broker was deleted/
// merged. The loans.broker_id → clients(id) FK then rejects the whole
// save with `loans_broker_id_fkey` (HTTP 409), 500ing the LO's save.
// Recurring (Chance's C5 loan, then a live sizer save). We null the
// dangling pointer(s) and retry: inline brokerName/email are kept, and
// the FK re-links on the next broker save once the broker is a client.
function _isBrokerFkError(e) {
  const m = String((e && (e.message || e.msg)) || e || '');
  return /loans_broker_id_fkey/i.test(m) ||
         (/broker_id/i.test(m) && /foreign key/i.test(m));
}

// Validate each distinct broker_id against `clients`; null the ones that
// don't resolve — on BOTH the projected rows (for the PG retry) and the
// original loan objects (so the blob mirror + the endpoint's response
// stay consistent with PG). Returns the count of dangling ids nulled.
async function _nullDanglingBrokerIds(loanRows, client) {
  const ids = [...new Set((loanRows || []).map((r) => r && r.broker_id).filter(Boolean))];
  if (!ids.length) return 0;
  const live = new Set();
  for (const id of ids) {
    const hit = await db.first('clients', { select: 'id', eq: { id } }).catch(() => null);
    if (hit && hit.id) live.add(id);
  }
  const dangling = new Set(ids.filter((id) => !live.has(id)));
  if (!dangling.size) return 0;
  for (const r of loanRows) {
    if (r && r.broker_id && dangling.has(r.broker_id)) r.broker_id = null;
  }
  if (client && Array.isArray(client.loans)) {
    for (const l of client.loans) {
      if (l && dangling.has(String(l.brokerId || ''))) l.brokerId = null;
    }
  }
  return dangling.size;
}

async function _upsertClientWithLoansStrict(ownerEmail, client, opts) {
  if (_isDisabled()) return;
  if (!client || !client.id || !ownerEmail) return;

  if (!_txRpcMissing) {
    const clientRow = projectClient(client, ownerEmail);
    if (!clientRow) return;
    const loanRows = [];
    if (Array.isArray(client.loans)) {
      for (const loan of client.loans) {
        if (!loan || !loan.id) continue;
        const row = projectLoan(loan, client.id, ownerEmail);
        if (row) loanRows.push(row);
      }
    }
    try {
      const rpcArgs = { p_client: clientRow, p_loans: loanRows };
      // Only send the third param when true: a 002-only database
      // (003 not yet run) has the two-param function, and a 3-named-
      // arg call against it reads as "function missing" (PGRST202) —
      // which would silently latch the non-atomic fallback. The
      // two-arg call matches both versions; on a 002-only DB the
      // trigger doesn't exist yet, so demotions pass regardless.
      if (opts && opts.allowDemotion) rpcArgs.p_allow_demotion = true;
      await db.rpc('upsert_client_with_loans', rpcArgs);
      return;
    } catch (e) {
      // Deploy 236.449 — self-heal a dangling broker_id rather than
      // failing the whole save, then retry the atomic write ONCE.
      if (_isBrokerFkError(e)) {
        const nulled = await _nullDanglingBrokerIds(loanRows, client).catch(() => 0);
        if (nulled > 0) {
          const retryArgs = { p_client: clientRow, p_loans: loanRows };
          if (opts && opts.allowDemotion) retryArgs.p_allow_demotion = true;
          await db.rpc('upsert_client_with_loans', retryArgs);
          console.warn('[pg-mirror] nulled ' + nulled + ' dangling broker_id(s) on ' + client.id + ' and retried the save.');
          return;
        }
        throw e; // FK error but no dangling broker identified — surface it
      }
      if (!_isRpcMissing(e)) throw e; // real failure — strict path surfaces it
      _txRpcMissing = true;
      console.warn('[pg-mirror] upsert_client_with_loans RPC missing — run db/migrations/002_tx_rpcs.sql. Falling back to multi-call writes.');
    }
  }

  // Legacy multi-call fallback (non-atomic).
  await _upsertClientStrict(ownerEmail, client);
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
      await db.upsert('loans', loanRows, { onConflict: 'id' });
    }
  }
  // Reconcile stale loans — same logic as the non-strict path but
  // deletes are awaited too so a broken reconcile surfaces.
  const existing = await db.select('loans', {
    select: 'id',
    eq: { client_id: client.id },
  });
  for (const row of (existing || [])) {
    if (row && row.id && !currentLoanIds.has(row.id)) {
      await db.del('loans', { id: row.id });
    }
  }
}

async function _upsertLoanStrict(ownerEmail, clientId, loan) {
  if (_isDisabled()) return;
  if (!loan || !loan.id || !clientId || !ownerEmail) return;
  const row = projectLoan(loan, clientId, ownerEmail);
  if (!row) return;
  await db.upsert('loans', row, { onConflict: 'id' });
}

async function _deleteClientStrict(clientId) {
  if (_isDisabled()) return;
  if (!clientId) return;
  // Phase C1: delete_client_tx removes loans + client in one
  // transaction. Also fixes a latent FK bug — loans.client_id is ON
  // DELETE RESTRICT, so the bare client delete below FAILS whenever
  // the client still has loan rows in PG.
  if (!_txRpcMissing) {
    try {
      await db.rpc('delete_client_tx', { p_client_id: clientId });
      return;
    } catch (e) {
      if (!_isRpcMissing(e)) throw e;
      _txRpcMissing = true;
      console.warn('[pg-mirror] delete_client_tx RPC missing — run db/migrations/002_tx_rpcs.sql. Falling back to bare delete.');
    }
  }
  await db.del('clients', { id: clientId });
}

async function _deleteLoanStrict(loanId) {
  if (_isDisabled()) return;
  if (!loanId) return;
  await db.del('loans', { id: loanId });
}

export const mirror = {
  // Legacy fire-and-forget variants. Never throw; log on failure.
  // Kept for callsites where a PG write is genuinely optional
  // (e.g. best-effort backref cleanup where the caller has already
  // reported success to the user).
  upsertClient:          (ownerEmail, client)         => _upsertClient(_ownerEmail(ownerEmail), client),
  upsertClientWithLoans: (ownerEmail, client)         => _upsertClientWithLoans(_ownerEmail(ownerEmail), client),
  upsertLoan:            (ownerEmail, clientId, loan) => _upsertLoan(_ownerEmail(ownerEmail), clientId, loan),
  deleteClient:          (clientId)                    => _deleteClient(clientId),
  deleteLoan:            (loanId)                      => _deleteLoan(loanId),
  // Strict variants — throw on error. Use these for the AUTHORITATIVE
  // dual-write in every mutation endpoint. Await + let outer try/catch
  // surface the failure as a 500.
  upsertClientStrict:          (ownerEmail, client)         => _upsertClientStrict(_ownerEmail(ownerEmail), client),
  upsertClientWithLoansStrict: (ownerEmail, client, opts)   => _upsertClientWithLoansStrict(_ownerEmail(ownerEmail), client, opts),
  upsertLoanStrict:            (ownerEmail, clientId, loan) => _upsertLoanStrict(_ownerEmail(ownerEmail), clientId, loan),
  deleteClientStrict:          (clientId)                    => _deleteClientStrict(clientId),
  deleteLoanStrict:            (loanId)                      => _deleteLoanStrict(loanId),
};
