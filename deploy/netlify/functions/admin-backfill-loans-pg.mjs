/**
 * admin-backfill-loans-pg.mjs — POST /api/admin-backfill-loans-pg
 *
 * Phase 1 of the Netlify Blobs → Supabase migration. Reads every
 * client blob in the `clients` store, projects into (clients, loans)
 * rows, upserts into Postgres. Idempotent — re-runnable safely; the
 * upsert conflict target is the primary key `id`.
 *
 * Body (all optional):
 *   { dryRun?: boolean (default true),
 *     limit?:  number  (safety cap, default no cap) }
 *
 * Response:
 *   { ok, dryRun, scannedClients, wroteClients, wroteLoans,
 *     skippedClients, errors: [...] }
 *
 * Auth: admin only. Uses SUPABASE_SERVICE_ROLE_KEY server-side to
 * bypass RLS.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { db, ping } from './_shared/supabase-db.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-backfill-loans-pg error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

// ── Projections: blob shape → Postgres row shape ─────────────
// Kept in one place so schema changes are obvious.

function _numOrNull(v) {
  if (v === '' || v == null) return null;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : null;
}
function _boolOrDefault(v, d = false) {
  if (v === true || v === false) return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return d;
}
function _tsOrNull(v) {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
function _dateOrNull(v) {
  if (!v) return null;
  // Accept ISO or 'YYYY-MM-DD'. Strip time if present.
  const s = String(v);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

const CLIENT_PROMOTED_KEYS = new Set([
  'id','firstName','lastName','email','phone','entityName','displayName',
  'companies','homeAddress','mailingAddress','ssn_enc','ssnLast4','fico',
  'dob','_isBroker','_isBrokerPlaceholder','notes','notesLog',
  'createdAt','updatedAt','createdBy','loans',
]);

const LOAN_PROMOTED_KEYS = new Set([
  'id','address','status','processingStage','toolType','loanType','loanAmt',
  'loanAmtLocked','rate','points','purchasePrice','propValue','rehabBudget',
  'arv','propType','fico','prepay','dscr','brokerId','_isBrokerLoan',
  'fromApplication','prospectId','fundingDate','maturityDate','servicerName',
  'servicerUrl','slaDisplayId','guarantorClientIds','guarantorOwnership',
  'vestingLLCs','formData','notes','notesLog','createdAt','updatedAt','savedAt',
]);

function projectClient(rec, ownerEmail) {
  const extra = {};
  for (const k of Object.keys(rec)) {
    if (!CLIENT_PROMOTED_KEYS.has(k)) extra[k] = rec[k];
  }
  return {
    id:                    String(rec.id),
    owner_email:           ownerEmail,
    first_name:            rec.firstName  || null,
    last_name:             rec.lastName   || null,
    email:                 rec.email      || null,
    phone:                 rec.phone      || null,
    entity_name:           rec.entityName || null,
    display_name:          rec.displayName || null,
    companies:             Array.isArray(rec.companies) ? rec.companies : [],
    home_address:          rec.homeAddress    || null,
    mailing_address:       rec.mailingAddress || null,
    ssn_enc:               rec.ssn_enc  || null,
    ssn_last4:             rec.ssnLast4 || null,
    fico:                  rec.fico     || null,
    dob:                   rec.dob      || null,
    is_broker:             _boolOrDefault(rec._isBroker),
    is_broker_placeholder: _boolOrDefault(rec._isBrokerPlaceholder),
    notes:                 rec.notes    || null,
    notes_log:             Array.isArray(rec.notesLog) ? rec.notesLog : [],
    created_at:            _tsOrNull(rec.createdAt) || new Date().toISOString(),
    updated_at:            _tsOrNull(rec.updatedAt) || new Date().toISOString(),
    created_by:            rec.createdBy || null,
    extra,
  };
}

function projectLoan(loan, clientId, ownerEmail) {
  const extra = {};
  for (const k of Object.keys(loan)) {
    if (!LOAN_PROMOTED_KEYS.has(k)) extra[k] = loan[k];
  }
  return {
    id:                   String(loan.id),
    client_id:            clientId,
    owner_email:          ownerEmail,
    address:              loan.address           || null,
    status:               loan.status            || null,
    processing_stage:     loan.processingStage   || null,
    tool_type:            loan.toolType          || null,
    loan_type:            loan.loanType          || null,
    loan_amt:             _numOrNull(loan.loanAmt),
    loan_amt_locked:      _boolOrDefault(loan.loanAmtLocked),
    rate:                 _numOrNull(loan.rate),
    points:               loan.points || null,
    purchase_price:       _numOrNull(loan.purchasePrice),
    prop_value:           _numOrNull(loan.propValue),
    rehab_budget:         _numOrNull(loan.rehabBudget),
    arv:                  _numOrNull(loan.arv),
    prop_type:            loan.propType || null,
    fico:                 loan.fico     || null,
    prepay:               loan.prepay   || null,
    dscr:                 _numOrNull(loan.dscr),
    broker_id:            loan.brokerId || null,
    is_broker_loan:       _boolOrDefault(loan._isBrokerLoan),
    from_application:     _boolOrDefault(loan.fromApplication),
    prospect_id:          loan.prospectId || null,
    funding_date:         _dateOrNull(loan.fundingDate),
    maturity_date:        _dateOrNull(loan.maturityDate),
    servicer_name:        loan.servicerName || null,
    servicer_url:         loan.servicerUrl  || null,
    sla_display_id:       loan.slaDisplayId || null,
    guarantor_client_ids: Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [],
    guarantor_ownership:  (loan.guarantorOwnership && typeof loan.guarantorOwnership === 'object')
                            ? loan.guarantorOwnership : {},
    vesting_llcs:         Array.isArray(loan.vestingLLCs) ? loan.vestingLLCs : [],
    form_data:            (loan.formData && typeof loan.formData === 'object') ? loan.formData : {},
    notes:                loan.notes || null,
    notes_log:            Array.isArray(loan.notesLog) ? loan.notesLog : [],
    extra,
    created_at:           _tsOrNull(loan.createdAt) || new Date().toISOString(),
    updated_at:           _tsOrNull(loan.updatedAt) || new Date().toISOString(),
    saved_at:             _tsOrNull(loan.savedAt),
  };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  // Fail fast if Supabase env vars are wrong before we start walking blobs.
  try {
    const p = await ping();
    if (!p.ok) return json(500, { error: 'Supabase ping returned HTTP ' + p.status });
  } catch (e) {
    return json(500, { error: 'Supabase env misconfigured: ' + (e && e.message) });
  }

  const body = (await req.json().catch(() => ({}))) || {};
  const dryRun = body.dryRun !== false; // default true — safer
  const limit  = Number.isFinite(body.limit) && body.limit > 0
    ? Math.min(body.limit, 5000)
    : Infinity;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const legacyBrokersStore = getStore({ name: 'brokers', consistency: 'strong' });

  let scannedClients = 0;
  let scannedLegacyBrokers = 0;
  let wroteClients   = 0;
  let wroteLoans     = 0;
  let skippedClients = 0;
  const errors = [];

  // ── Pass 1: collect ALL rows in memory ─────────────────────
  // Was: interleaved client + loan upserts per 25-client batch. That
  // failed the FK check on loans.broker_id whenever a loan's broker
  // lived in a client blob later in the scan (7 batches lost data
  // on the first backfill attempt). Fixed by separating the passes:
  // read everything, write clients FIRST (all of them), then loans.
  // At 2 800 clients × ~5 KB avg = ~14 MB in memory — well under
  // Netlify's 1 GB function ceiling.
  const allClientRows = [];
  const allLoanRows   = [];
  const knownClientIds = new Set();     // for the loan broker_id sanity check
  const READ_CHUNK = 25;
  const { blobs } = await clientsStore.list();
  for (let i = 0; i < blobs.length && scannedClients < limit; i += READ_CHUNK) {
    const slice = blobs.slice(i, Math.min(i + READ_CHUNK, blobs.length));
    await Promise.all(slice.map(async ({ key }) => {
      const slash = key.indexOf('/');
      if (slash < 0) return;
      const ownerKey = key.slice(0, slash);
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!rec || !rec.id) { skippedClients++; return; }
      scannedClients++;
      const cRow = projectClient(rec, ownerKey);
      allClientRows.push(cRow);
      knownClientIds.add(cRow.id);
      if (Array.isArray(rec.loans)) {
        for (const loan of rec.loans) {
          if (!loan || !loan.id) continue;
          allLoanRows.push(projectLoan(loan, cRow.id, ownerKey));
        }
      }
    }));
  }

  // ── Pass 2: legacy brokers store ───────────────────────────
  // The Phase A broker-migration (Deploy 236.224) folded broker
  // records into clients (_isBroker=true), but the legacy `brokers`
  // store is still queried as a fallback for un-migrated records.
  // Those legacy IDs are what loans.broker_id points at when the
  // FK violation fires. Upsert them as _isBroker=true clients so
  // the FK resolves.
  try {
    const { blobs: bBlobs } = await legacyBrokersStore.list();
    for (let i = 0; i < bBlobs.length; i += READ_CHUNK) {
      const slice = bBlobs.slice(i, Math.min(i + READ_CHUNK, bBlobs.length));
      await Promise.all(slice.map(async ({ key }) => {
        const slash = key.indexOf('/');
        if (slash < 0) return;
        const ownerKey = key.slice(0, slash);
        const rec = await legacyBrokersStore.get(key, { type: 'json' }).catch(() => null);
        if (!rec || !rec.id) return;
        if (knownClientIds.has(rec.id)) return; // Phase A already migrated this one
        scannedLegacyBrokers++;
        // Project as a client row; broker-specific fields ride in `extra`.
        const cRow = {
          id:          String(rec.id),
          owner_email: ownerKey,
          first_name:  rec.firstName  || (rec.name ? String(rec.name).split(' ')[0] : null),
          last_name:   rec.lastName   || (rec.name ? String(rec.name).split(' ').slice(1).join(' ') : null),
          email:       rec.email      || null,
          phone:       rec.phone      || null,
          entity_name: rec.company    || rec.entityName || null,
          display_name: rec.name      || null,
          companies:   [], home_address: null, mailing_address: null,
          ssn_enc: null, ssn_last4: null, fico: null, dob: null,
          is_broker: true,
          is_broker_placeholder: false,
          notes: null, notes_log: [],
          created_at: _tsOrNull(rec.createdAt) || new Date().toISOString(),
          updated_at: _tsOrNull(rec.updatedAt) || new Date().toISOString(),
          created_by: rec.createdBy || null,
          extra: { _fromLegacyBrokers: true, ...rec },
        };
        allClientRows.push(cRow);
        knownClientIds.add(cRow.id);
      }));
    }
  } catch (e) {
    errors.push('legacy brokers scan failed (non-fatal): ' + (e && e.message));
  }

  // ── Pass 3: null out orphan broker_id references ──────────
  // A loan can reference a broker_id that doesn't exist anywhere
  // (dead reference from a since-deleted broker). Leaving it would
  // FK-violate the batch — better to null it + track the original
  // in extra.orphanedBrokerId so it's not lost to history.
  let nulledBrokerIds = 0;
  for (const l of allLoanRows) {
    if (l.broker_id && !knownClientIds.has(l.broker_id)) {
      l.extra = l.extra || {};
      l.extra._orphanedBrokerId = l.broker_id;
      l.broker_id = null;
      nulledBrokerIds++;
    }
  }

  if (dryRun) {
    return json(200, {
      ok: true,
      dryRun: true,
      scannedClients,
      scannedLegacyBrokers,
      wouldWriteClients: allClientRows.length,
      wouldWriteLoans:   allLoanRows.length,
      nulledBrokerIds,
      skippedClients,
      errors: errors.slice(0, 50),
    });
  }

  // ── Pass 4: write ALL clients (FK targets) ────────────────
  // Chunked so a single upsert doesn't blow the request-body ceiling.
  const WRITE_CHUNK = 100;
  for (let i = 0; i < allClientRows.length; i += WRITE_CHUNK) {
    const chunk = allClientRows.slice(i, i + WRITE_CHUNK);
    try {
      await db.upsert('clients', chunk, { onConflict: 'id' });
      wroteClients += chunk.length;
    } catch (e) {
      errors.push('clients write batch @' + i + ' failed: ' + (e && e.message));
    }
  }

  // ── Pass 5: write ALL loans (FKs to clients now safe) ─────
  for (let i = 0; i < allLoanRows.length; i += WRITE_CHUNK) {
    const chunk = allLoanRows.slice(i, i + WRITE_CHUNK);
    try {
      await db.upsert('loans', chunk, { onConflict: 'id' });
      wroteLoans += chunk.length;
    } catch (e) {
      errors.push('loans write batch @' + i + ' failed: ' + (e && e.message));
    }
  }

  return json(200, {
    ok: true,
    dryRun: false,
    scannedClients,
    scannedLegacyBrokers,
    wroteClients,
    wroteLoans,
    nulledBrokerIds,
    skippedClients,
    errors: errors.slice(0, 50),
  });
}
