/**
 * admin-blob-pg-sync.mjs — POST /api/admin-blob-pg-sync
 *
 * Bulk repair tool. Scans every client blob across every owner
 * namespace (or a specified subset), compares each to what Postgres
 * has, and fills in whatever PG is missing.
 *
 * Why this exists: pg-mirror was fire-and-forget from Phase 2 landing
 * until today. If a PG write silently failed for ANY reason (FK
 * violation, transient network, schema hiccup), the blob write still
 * succeeded and the user saw success — but PG never got the record.
 * Phase 4 made reads PG-first, so those "invisible" blob records now
 * appear to have vanished from Pipeline / Clients / Loans / Details.
 *
 * This endpoint sweeps the whole blob store, upserts every client
 * (and its nested loans) into PG, and reports the diff. Deletions
 * in PG that no longer exist in blob are also reconciled (optional).
 *
 * Body: {
 *   dryRun?: true,          // default true — report only, don't write
 *   owner?: string,         // optional — scope to one owner
 *   deleteOrphansInPg?: true, // default false — delete PG rows not in blob
 * }
 *
 * Response: {
 *   ok, dryRun,
 *   scanned: { owners, clients, loans },
 *   pgMissing: {
 *     clients: [{id, ownerKey, ...}],
 *     loans:   [{id, clientId, ownerKey, ...}],
 *   },
 *   pgOrphans: {   // PG rows with no blob equivalent
 *     clients: [id, ...],
 *     loans:   [id, ...],
 *   },
 *   wrote: { clients, loans },     // when dryRun=false
 *   deleted: { clients, loans },   // when deleteOrphansInPg=true
 *   errors: [{...}],
 *   durationMs,
 * }
 *
 * Admin only. Timeout 26s (set in netlify.toml).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { projectClient, projectLoan } from './_shared/pg-projections.mjs';
// Deploy 236.432 (C5): the scan+diff moved to _shared/blob-pg-drift.mjs
// so the daily bake-off cron (drift-report-cron) and this repair tool
// share one diff implementation.
import { computeDrift } from './_shared/blob-pg-drift.mjs';

// Chunk sizes tuned for the free-tier Netlify function limits + Supabase's
// default request timeout. Small enough that a slow query doesn't stall
// the whole run.
const CLIENT_CHUNK = 50;
const LOAN_CHUNK   = 100;

// ── Deploy 236.482 — PG→blob reverse projection for the backfill step.
// Faithful to client-get-pg.mjs's _clientRowToBlobShape (that's the read
// shape used everywhere), with two write-specific additions: carry ssn_enc
// so a backfilled blob is COMPLETE (the blob is still the SSN source of
// truth per 236.459), and preserve loanAmtLocked etc. via the loan shape.
// Keep in sync with client-get-pg if that projection changes.
function _pgLoanToBlob(l) {
  if (!l) return null;
  const out = {
    id:                 l.id,
    address:            l.address           || '',
    status:             l.status            || 'active',
    processingStage:    l.processing_stage  || '',
    toolType:           l.tool_type         || '',
    loanType:           l.loan_type         || '',
    loanAmt:            l.loan_amt          || '',
    loanAmtLocked:      !!l.loan_amt_locked,
    rate:               l.rate              || '',
    points:             l.points            || '',
    purchasePrice:      l.purchase_price    || '',
    propValue:          l.prop_value        || '',
    rehabBudget:        l.rehab_budget      || '',
    arv:                l.arv               || '',
    propType:           l.prop_type         || '',
    fico:               l.fico              || '',
    prepay:             l.prepay            || '',
    dscr:               l.dscr              || '',
    brokerId:           l.broker_id         || '',
    _isBrokerLoan:      !!l.is_broker_loan,
    fromApplication:    !!l.from_application,
    prospectId:         l.prospect_id       || '',
    fundingDate:        l.funding_date      || '',
    maturityDate:       l.maturity_date     || '',
    servicerName:       l.servicer_name     || '',
    servicerUrl:        l.servicer_url      || '',
    slaDisplayId:       l.sla_display_id    || '',
    guarantorClientIds: l.guarantor_client_ids || [],
    guarantorOwnership: l.guarantor_ownership || {},
    vestingLLCs:        l.vesting_llcs || [],
    formData:           l.form_data || {},
    notes:              l.notes || '',
    notesLog:           l.notes_log || [],
    createdAt:          l.created_at,
    updatedAt:          l.updated_at,
    savedAt:            l.saved_at || l.updated_at,
  };
  Object.assign(out, l.extra || {});
  return out;
}
function _pgClientToBlob(c) {
  if (!c) return null;
  const loans = Array.isArray(c.loans) ? c.loans.map(_pgLoanToBlob).filter(Boolean) : [];
  const out = {
    id:                   c.id,
    firstName:            c.first_name  || '',
    lastName:             c.last_name   || '',
    email:                c.email       || '',
    phone:                c.phone       || '',
    entityName:           c.entity_name || '',
    displayName:          c.display_name || '',
    companies:            c.companies || [],
    homeAddress:          c.home_address || null,
    mailingAddress:       c.mailing_address || null,
    ssnLast4:             c.ssn_last4 || '',
    fico:                 c.fico || '',
    dob:                  c.dob || '',
    _isBroker:            !!c.is_broker,
    _isBrokerPlaceholder: !!c.is_broker_placeholder,
    notes:                c.notes || '',
    notesLog:             c.notes_log || [],
    createdAt:            c.created_at,
    updatedAt:            c.updated_at,
    createdBy:            c.created_by || '',
    loans,
  };
  Object.assign(out, c.extra || {});
  out.loans = loans;
  // Authoritative promoted fields win over any stale key that rode in
  // via extra (same discipline as the 236.461 SSN clobber fix).
  out.ssnLast4 = c.ssn_last4 || '';
  if (c.ssn_enc) out.ssn_enc = c.ssn_enc; else delete out.ssn_enc;
  return out;
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-blob-pg-sync error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false; // default true
  const ownerFilter = body.owner ? keySafe(normalizeEmail(body.owner)) : null;
  const deleteOrphans = body.deleteOrphansInPg === true;

  const startedAt = Date.now();

  // ── 1-3. Scan + diff (shared with drift-report-cron since C5) ──
  let drift;
  try {
    drift = await computeDrift({ ownerFilter });
  } catch (e) {
    return json(500, { error: 'Drift scan failed: ' + (e && e.message) });
  }
  const { scanned, missingClients, missingLoans, orphanClientIds, orphanLoanIds } = drift;

  const result = {
    ok: true,
    dryRun,
    scanned,
    pgMissing: {
      clients: missingClients.map((c) => ({ id: c.id, ownerKey: c.ownerKey })),
      loans:   missingLoans.map((l) => ({ id: l.id, clientId: l.clientId, ownerKey: l.ownerKey })),
    },
    pgOrphans: {
      clients: orphanClientIds,
      loans:   orphanLoanIds,
    },
    wrote: { clients: 0, loans: 0 },
    deleted: { clients: 0, loans: 0 },
    errors: [],
    durationMs: 0,
  };

  // ── Deploy 236.479 — enrich the orphan-client report so a dryRun is
  // actually actionable. An opaque id list can't tell a junk shell from
  // a real client, which is why the "35 orphan clients" nag went
  // undiagnosed for days. Pull a few identifying columns for each orphan
  // (bounded) so they can be classified at a glance — most importantly
  // whether they're broker placeholder rows (is_broker_placeholder),
  // which are loanless by nature and the likeliest source of a stable
  // "N orphan clients / 0 orphan loans" drift.
  if (orphanClientIds.length) {
    const idsToFetch = orphanClientIds.slice(0, 200);
    try {
      const rows = await db.select('clients', {
        select: 'id,owner_email,first_name,last_name,email,is_broker,is_broker_placeholder,created_at,updated_at',
        in: { id: idsToFetch },
      });
      result.pgOrphans.clientDetails = rows || [];
      // Deploy 236.482 — break the flags out PROPERLY. The old summary
      // lumped is_broker with is_broker_placeholder under one label,
      // which mis-classified real broker records as placeholders. Report
      // each flag separately plus owner + created-date grouping so the
      // orphans' origin (a migration? a purged LO?) is obvious in one run.
      let isBroker = 0, isPlaceholder = 0, neither = 0, withNameOrEmail = 0;
      const byOwner = {};
      let minCreated = null, maxCreated = null;
      for (const r of (rows || [])) {
        if (r.is_broker_placeholder) isPlaceholder++;
        else if (r.is_broker) isBroker++;
        else neither++;
        if (r.first_name || r.last_name || r.email) withNameOrEmail++;
        const o = r.owner_email || '(none)';
        byOwner[o] = (byOwner[o] || 0) + 1;
        if (r.created_at) {
          if (!minCreated || r.created_at < minCreated) minCreated = r.created_at;
          if (!maxCreated || r.created_at > maxCreated) maxCreated = r.created_at;
        }
      }
      result.pgOrphans.summary = {
        total: orphanClientIds.length,
        detailed: (rows || []).length,
        isBroker,
        isBrokerPlaceholder: isPlaceholder,
        neither,
        withNameOrEmail,
        byOwner,
        createdRange: { min: minCreated, max: maxCreated },
      };
    } catch (e) {
      result.errors.push({ phase: 'orphan detail fetch', message: (e && e.message) });
    }
  }

  if (dryRun) {
    result.durationMs = Date.now() - startedAt;
    return json(200, result);
  }

  // ── 4. Write missing clients + loans to PG (chunked) ───────────
  if (missingClients.length) {
    const rows = missingClients
      .map((m) => projectClient(m.record, m.ownerKey))
      .filter(Boolean);
    for (let i = 0; i < rows.length; i += CLIENT_CHUNK) {
      const chunk = rows.slice(i, i + CLIENT_CHUNK);
      try {
        await db.upsert('clients', chunk, { onConflict: 'id' });
        result.wrote.clients += chunk.length;
      } catch (e) {
        result.errors.push({ phase: 'clients upsert', chunkStart: i, message: (e && e.message) });
      }
    }
  }

  if (missingLoans.length) {
    const rows = missingLoans
      .map((m) => projectLoan(m.loan, m.clientId, m.ownerKey))
      .filter(Boolean);
    for (let i = 0; i < rows.length; i += LOAN_CHUNK) {
      const chunk = rows.slice(i, i + LOAN_CHUNK);
      try {
        await db.upsert('loans', chunk, { onConflict: 'id' });
        result.wrote.loans += chunk.length;
      } catch (e) {
        result.errors.push({ phase: 'loans upsert', chunkStart: i, message: (e && e.message) });
      }
    }
  }

  // ── 5. Optional: delete PG rows that no longer exist in blob ───
  if (deleteOrphans) {
    // Deploy 236.481 — safety filter. When onlyBrokerPlaceholders is set,
    // restrict client deletion to orphans confirmed as broker placeholder
    // husks (is_broker_placeholder), using the details fetched above. This
    // protects a REAL client that is transiently PG-only (in the sub-second
    // window between writeClient's PG write and its blob mirror) from being
    // swept — such a client is never a broker placeholder. Use this when
    // clearing the known broker-placeholder backlog.
    let clientIdsToDelete = orphanClientIds;
    if (body.onlyBrokerPlaceholders === true) {
      const details = result.pgOrphans.clientDetails || [];
      const phSet = new Set(
        details.filter((r) => r && r.is_broker_placeholder).map((r) => r.id)
      );
      clientIdsToDelete = orphanClientIds.filter((id) => phSet.has(id));
      result.deleteFilter = {
        onlyBrokerPlaceholders: true,
        eligible: clientIdsToDelete.length,
        skippedNonPlaceholder: orphanClientIds.length - clientIdsToDelete.length,
      };
    }
    // Delete loans first (FK constraint — loans reference clients).
    for (const id of orphanLoanIds) {
      try {
        await db.del('loans', { id });
        result.deleted.loans++;
      } catch (e) {
        result.errors.push({ phase: 'loan delete', id, message: (e && e.message) });
      }
    }
    for (const id of clientIdsToDelete) {
      try {
        await db.del('clients', { id });
        result.deleted.clients++;
      } catch (e) {
        result.errors.push({ phase: 'client delete', id, message: (e && e.message) });
      }
    }
  }

  // ── 6. Optional: backfill orphan PG clients INTO blob (PG→blob) ──
  // Deploy 236.482 — the inverse of step 4. Use when PG holds authoritative
  // client records the blob mirror is missing (e.g. is_broker records
  // created before the broker write paths moved onto writeClient). Purely
  // ADDITIVE: writes a blob copy of a row that already exists in PG, so
  // there's no destructive edge. onlyBrokerOrphans restricts it to real
  // broker records (is_broker && !placeholder) — the confirmed backlog.
  if (body.backfillOrphansToBlob === true && orphanClientIds.length) {
    const details = result.pgOrphans.clientDetails || [];
    let ids = orphanClientIds.slice(0, 500);
    if (body.onlyBrokerOrphans === true) {
      const brokerSet = new Set(
        details.filter((r) => r && r.is_broker && !r.is_broker_placeholder).map((r) => r.id)
      );
      ids = ids.filter((id) => brokerSet.has(id));
    }
    result.backfill = {
      onlyBrokerOrphans: body.onlyBrokerOrphans === true,
      attempted: ids.length,
      wroteToBlob: 0,
    };
    const store = getStore({ name: 'clients', consistency: 'strong' });
    for (const id of ids) {
      try {
        const row = await db.first('clients', { eq: { id }, select: '*,loans!client_id(*)' });
        if (!row) { result.errors.push({ phase: 'backfill fetch', id, message: 'row not found' }); continue; }
        const blobShape = _pgClientToBlob(row);
        await store.setJSON(keySafe(row.owner_email) + '/' + keySafe(row.id), blobShape);
        result.backfill.wroteToBlob++;
      } catch (e) {
        result.errors.push({ phase: 'backfill write', id, message: (e && e.message) });
      }
    }
  }

  result.durationMs = Date.now() - startedAt;
  return json(200, result);
}
