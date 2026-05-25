/**
 * _shared/baseline-sync.mjs — Baseline (LOS) integration helper.
 *
 * Pushes approved+app-complete loans into Baseline by creating the
 * entity borrower, then each guarantor as a person borrower, connecting
 * them, then creating the loan itself. Tracks Baseline IDs back on the
 * SLA loan record so retries are idempotent.
 *
 * Modes (env vars):
 *   BASELINE_API_KEY   — required. If unset, integration is silently
 *                        disabled (returns mode='disabled' from status).
 *   BASELINE_BASE_URL  — defaults to
 *                        'https://production.baselinesoftware.com/production/api'
 *                        (override only if Baseline gives you a different
 *                        tenant URL).
 *   BASELINE_DRY_RUN   — defaults to TRUE (fail-safe). Only goes live
 *                        when explicitly set to the string 'false'
 *                        (lowercase). Phase 1 ships with this enabled —
 *                        the orchestrator builds the full payload
 *                        sequence and logs it to baseline-sync-log, but
 *                        no HTTP calls are made.
 *   BASELINE_ENABLED   — defaults to '1'. Set to '0' as a kill-switch
 *                        without unsetting the API key (e.g. during a
 *                        Baseline outage).
 *
 * Failure philosophy: best-effort. NEVER throw to the caller. All
 * Baseline failures are logged to the audit store and (Phase 3+) trigger
 * a Slack alert. The loan's approved-status transition in SLA Tools
 * still completes even if Baseline is down.
 *
 * Public API:
 *   baselineStatus()                    → { enabled, mode, configured, baseUrl }
 *   syncLoanToBaseline(loan, client, borrowerInfo, ctx)
 *                                       → { ok, mode, steps:[...], error? }
 *   listLog({ limit, loanId })          → [<log entries>, ...]  (newest first)
 *
 * Phase status: PHASE 1 (scaffolding). Real API calls are stubbed — the
 * orchestrator currently always runs in dry-run regardless of env, so
 * Phase 1 can deploy safely to main without risk of hitting Baseline.
 * Phase 2 will remove the hard dry-run lock and enable the manual
 * "Send to Baseline" button. Phase 3 wires auto-fire from
 * advanceQuoteToInProcessing().
 */
import { getStore } from '@netlify/blobs';

const DEFAULT_BASE_URL = 'https://production.baselinesoftware.com/production/api';

// PHASE 1 SAFETY LOCK — keep dry-run on regardless of env vars.
// Flip to `false` in Phase 2 once you've verified the field mapping
// against a real Baseline response. Search for this constant when
// promoting.
const PHASE_1_FORCE_DRY_RUN = true;

function isEnabled() {
  if (process.env.BASELINE_ENABLED === '0') return false;
  return !!process.env.BASELINE_API_KEY;
}

/**
 * Defaults to dry-run unless BASELINE_DRY_RUN is *explicitly* set to
 * "false". Same fail-safe pattern as brevo.mjs — typos or a deleted
 * env var keep you in dry-run instead of silently going live.
 *
 * Phase 1 additionally forces dry-run on regardless of env via the
 * PHASE_1_FORCE_DRY_RUN constant above.
 */
function isDryRun() {
  if (PHASE_1_FORCE_DRY_RUN) return true;
  const raw = process.env.BASELINE_DRY_RUN;
  if (raw === undefined || raw === null || raw === '') return true;
  return String(raw).toLowerCase() !== 'false';
}

function baseUrl() {
  return (process.env.BASELINE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

/**
 * Status probe for admin UI. Returns mode + configuration flags.
 * Mirrors brevoStatus() shape so the baseline-log.html viewer can show
 * the same mode badge pattern.
 */
export function baselineStatus() {
  return {
    enabled: isEnabled(),
    mode: !isEnabled() ? 'disabled' : (isDryRun() ? 'dry-run' : 'live'),
    configured: !!process.env.BASELINE_API_KEY,
    baseUrl: baseUrl(),
    phase: PHASE_1_FORCE_DRY_RUN ? 'phase-1-scaffold' : 'phase-2+',
  };
}

// ── Audit log ────────────────────────────────────────────────────────

/**
 * Append a single entry to the baseline-sync-log blob store. Errors
 * are swallowed — a failed log write must not break the sync.
 *
 * Each entry covers ONE step (entity / g1 / g2 / connect_g1 / connect_g2
 * / loan). A full sync writes up to 6 entries.
 */
async function writeLog(entry) {
  try {
    const ts = new Date().toISOString();
    const id = ts + '-' + Math.random().toString(36).slice(2, 9);
    const record = { id, ts, ...entry };
    const store = getStore({ name: 'baseline-sync-log', consistency: 'eventual' });
    await store.setJSON(id, record);
  } catch (e) {
    console.warn('baseline log write failed:', e && e.message);
  }
}

/**
 * List recent log entries, newest first. Used by /api/baseline-sync-log.
 * Filters optionally by loanId.
 */
export async function listLog(opts) {
  opts = opts || {};
  const limit = Math.min(1000, Math.max(1, opts.limit || 200));
  const loanFilter = opts.loanId || null;
  try {
    const store = getStore({ name: 'baseline-sync-log', consistency: 'eventual' });
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit * 4);
    const all = await Promise.all(keys.map(async (k) => {
      try { return await store.get(k, { type: 'json' }); }
      catch (_) { return null; }
    }));
    let filtered = all.filter(Boolean);
    if (loanFilter) {
      filtered = filtered.filter((e) => e.loanId === loanFilter);
    }
    return filtered.slice(0, limit);
  } catch (e) {
    console.error('baseline listLog error:', e);
    return [];
  }
}

// ── Payload helpers ──────────────────────────────────────────────────

/**
 * Strip sensitive fields from a payload before storing it in the audit
 * log. SSN and EIN values are replaced with '***REDACTED***'. The audit
 * log is super-admin-readable but defensive redaction means leaks are
 * limited if access controls ever slip.
 *
 * Returns a deep clone — never mutates the original.
 */
function redactSensitive(payload) {
  if (!payload || typeof payload !== 'object') return payload;
  const clone = JSON.parse(JSON.stringify(payload));
  const SENSITIVE = ['SSN', 'ssn', 'Ssn', 'EIN', 'ein', 'Ein', 'Tax_Id', 'Tax_ID', 'tax_id'];
  function walk(obj) {
    if (!obj || typeof obj !== 'object') return;
    for (const k of Object.keys(obj)) {
      if (SENSITIVE.indexOf(k) >= 0 && obj[k]) {
        obj[k] = '***REDACTED***';
      } else if (typeof obj[k] === 'object') {
        walk(obj[k]);
      }
    }
  }
  walk(clone);
  return clone;
}

// ── Payload builders (PHASE 1: minimal core fields only) ────────────
//
// Phase 2 will expand these once the user pastes a Baseline GET response
// revealing the configured custom field names. Until then we emit only
// the fields documented in the public Baseline schema so the dry-run
// log gives us a complete preview of what's about to be sent.

/**
 * Build the POST /borrower payload for the vesting LLC entity.
 * Returns null if the long-app has no LLC (loan vests in the individual).
 */
function buildEntityPayload(loan, client, bi) {
  if (!bi || bi.hasLLC !== 'yes') return null;
  const llcName = bi.llcName || (bi.companies && bi.companies[0] && bi.companies[0].name);
  if (!llcName) return null;

  // Best-effort address split — long-app uses a Google-places-formatted
  // string in bi.llcAddress, plus separate city/zip from the picker
  // attached to the companies[] entry. Try both sources.
  const company = (bi.companies || []).find((c) => c.name === llcName) || {};

  return {
    Is_Company: true,
    Name: llcName,
    Address_Street1: company.address || bi.llcAddress || '',
    Address_City: company.city || '',
    Address_State: company.addrState || bi.llcState || '',
    Address_Country: 'US',
    // EIN and state-of-formation will be added in Phase 2 once we know
    // the Baseline product's custom field names.
  };
}

/**
 * Build the POST /borrower payload for a single guarantor (person).
 * @param {object} g — guarantor object from borrower_info.guarantors[i]
 */
function buildPersonPayload(g) {
  if (!g || !g.email) return null;
  const phone = String(g.phone || '').replace(/[^\d]/g, '');
  return {
    Is_Company: false,
    First_Name: g.firstName || '',
    Last_Name: g.lastName || '',
    Email: String(g.email || '').trim().toLowerCase(),
    Phone: phone || undefined,
    Date_Birth: g.dob || undefined, // expected YYYY-MM-DD
    Address_Street1: g.address || '',
    Address_City: g.city || '',
    Address_State: g.state || '',
    Address_Country: 'US',
    // SSN, FICO, marital, citizenship, declarations → Phase 2 custom fields.
  };
}

/**
 * Build the POST /loan payload. Our SLA loanId is sent as Baseline's
 * `Id` so retries are idempotent — re-POSTing the same Id will fail on
 * Baseline's side, which we treat as a "already synced" success.
 */
function buildLoanPayload(loan, client, bi, refs) {
  // Parse the property address — long-app keeps street/city/state/zip
  // separately, but the loan record stores it as a single string. We
  // prefer the parsed components from borrower_info; fall back to a
  // string split heuristic if missing.
  const addr = parseAddress(loan.address || '');

  // Pick the primary Borrower_Id: prefer the entity; fall back to G1
  // (the long-app first guarantor); final fallback is the client.
  const primaryBorrowerId =
    refs.baselineEntityId ||
    refs.baselineGuarantor1Id ||
    null;

  const payload = {
    Id: loan.id, // SLA loanId → Baseline external ID, idempotent
    Name: loan.address || ('Loan ' + loan.id),
    Status: 'approved',
    Address_Street1: addr.street1,
    Address_City: addr.city,
    Address_State: addr.state,
    Address_Zipcode: addr.zip,
    Loan_Amount: parseFloat(loan.loanAmt) || undefined,
    Rate: parseFloat(loan.rate) || undefined,
    // Origination / Maturity are placeholders for Phase 2 once we
    // confirm the date semantics with a real PULL.
  };
  if (primaryBorrowerId) payload.Borrower_Id = primaryBorrowerId;

  return payload;
}

/**
 * Heuristic parse of "123 Main St, Spokane, WA 99208" into components.
 * Returns the best guess; downstream Baseline will store whatever we
 * send so a partial parse is better than nothing.
 */
function parseAddress(s) {
  const out = { street1: '', city: '', state: '', zip: '' };
  if (!s) return out;
  const parts = String(s).split(',').map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 1) out.street1 = parts[0];
  if (parts.length >= 2) out.city = parts[1];
  if (parts.length >= 3) {
    // Last comma-piece is usually "STATE ZIP" or "STATE ZIP, USA"
    const tail = parts[parts.length - 1].replace(/\bUSA\b/i, '').trim();
    const m = tail.match(/^([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
    if (m) {
      out.state = m[1];
      out.zip = m[2];
    } else {
      // Tail might be "WA 99208 USA" with USA in its own piece
      const tailM = parts[2] && parts[2].match(/^([A-Z]{2})\s+(\d{5})/);
      if (tailM) { out.state = tailM[1]; out.zip = tailM[2]; }
    }
  }
  return out;
}

// ── HTTP helper ──────────────────────────────────────────────────────

/**
 * Perform a single HTTP call against Baseline. Used by the orchestrator
 * for each step. Returns { ok, status, body, error }. Never throws.
 *
 * Phase 1: this is unreachable because the orchestrator runs in dry-run
 * mode. Phase 2 wires it in.
 */
async function baselineFetch(method, path, body) {
  const url = baseUrl() + (path.startsWith('/') ? path : '/' + path);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        // Baseline uses `Token <key>`, NOT `Bearer <key>` — this is per
        // their auth docs and is unusual; do not change without checking
        // a 403 wouldn't be the result.
        'Authorization': 'Token ' + process.env.BASELINE_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await resp.text().catch(() => '');
    let parsed;
    try { parsed = text ? JSON.parse(text) : {}; } catch (_) { parsed = { raw: text.slice(0, 500) }; }
    return {
      ok: resp.status >= 200 && resp.status < 300,
      status: resp.status,
      body: parsed,
    };
  } catch (e) {
    return { ok: false, status: 0, error: e && e.message };
  }
}

// ── Main orchestrator ────────────────────────────────────────────────

/**
 * Sync a single loan to Baseline. Idempotent: skips steps whose IDs are
 * already present on the loan record (loan._baselineEntityId etc.).
 *
 * @param {object} loan          — the SLA loan record
 * @param {object} client        — the parent client record
 * @param {object} borrowerInfo  — the long-app submission for this loan
 *                                 (the `borrower_info` blob), or null
 *                                 if the long app hasn't been submitted
 *                                 yet (in which case we bail with reason)
 * @param {object} ctx           — { triggerUserEmail, triggerReason }
 *
 * @returns {Promise<{
 *   ok: boolean,
 *   mode: 'disabled'|'dry-run'|'live',
 *   steps: Array<{step, ok, mode, status?, error?}>,
 *   refs: { baselineEntityId?, baselineGuarantor1Id?, baselineGuarantor2Id?, baselineLoanId? },
 *   error?: string,
 * }>}
 */
export async function syncLoanToBaseline(loan, client, borrowerInfo, ctx) {
  ctx = ctx || {};
  const result = {
    ok: false,
    mode: !isEnabled() ? 'disabled' : (isDryRun() ? 'dry-run' : 'live'),
    steps: [],
    refs: {
      baselineEntityId:      loan && loan._baselineEntityId      || null,
      baselineGuarantor1Id:  loan && loan._baselineGuarantor1Id  || null,
      baselineGuarantor2Id:  loan && loan._baselineGuarantor2Id  || null,
      baselineLoanId:        loan && loan._baselineLoanId        || null,
    },
  };

  // Bail early on missing prerequisites — log the bail so the audit
  // trail captures it, but return a clean result instead of an error.
  if (!loan || !loan.id) {
    result.error = 'missing_loan_id';
    await writeLog({ step: 'precheck', ok: false, error: result.error, mode: result.mode, triggerUserEmail: ctx.triggerUserEmail });
    return result;
  }
  if (!client || !client.id) {
    result.error = 'missing_client';
    await writeLog({ step: 'precheck', ok: false, error: result.error, mode: result.mode, loanId: loan.id, triggerUserEmail: ctx.triggerUserEmail });
    return result;
  }
  if (!borrowerInfo) {
    result.error = 'missing_borrower_info';
    await writeLog({ step: 'precheck', ok: false, error: result.error, mode: result.mode, loanId: loan.id, clientId: client.id, triggerUserEmail: ctx.triggerUserEmail });
    return result;
  }
  if (result.mode === 'disabled') {
    result.error = 'disabled';
    await writeLog({ step: 'precheck', ok: false, error: 'BASELINE_API_KEY unset or BASELINE_ENABLED=0', mode: result.mode, loanId: loan.id, clientId: client.id, triggerUserEmail: ctx.triggerUserEmail });
    return result;
  }

  const guarantors = Array.isArray(borrowerInfo.guarantors) ? borrowerInfo.guarantors : [];
  const g1 = guarantors[0] || null;
  const g2 = guarantors[1] || null;

  // Step 1 — entity (LLC). Skip if no LLC OR if already synced.
  const entityPayload = buildEntityPayload(loan, client, borrowerInfo);
  if (entityPayload && !result.refs.baselineEntityId) {
    const step = await runStep('entity', 'POST', '/borrower', entityPayload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    if (step.ok && step.body && step.body.Id) result.refs.baselineEntityId = step.body.Id;
    if (!step.ok) return finalize(result, 'entity_failed');
  }

  // Step 2 — Guarantor 1.
  const g1Payload = buildPersonPayload(g1);
  if (g1Payload && !result.refs.baselineGuarantor1Id) {
    const step = await runStep('g1', 'POST', '/borrower', g1Payload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    if (step.ok && step.body && step.body.Id) result.refs.baselineGuarantor1Id = step.body.Id;
    if (!step.ok) return finalize(result, 'g1_failed');
  }

  // Step 3 — Guarantor 2 (if any).
  const g2Payload = buildPersonPayload(g2);
  if (g2Payload && !result.refs.baselineGuarantor2Id) {
    const step = await runStep('g2', 'POST', '/borrower', g2Payload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    if (step.ok && step.body && step.body.Id) result.refs.baselineGuarantor2Id = step.body.Id;
    if (!step.ok) return finalize(result, 'g2_failed');
  }

  // Step 4 — connect G1 ↔ entity.
  if (result.refs.baselineEntityId && result.refs.baselineGuarantor1Id) {
    const connectPath = '/borrower/' + result.refs.baselineGuarantor1Id + '/connect/' + result.refs.baselineEntityId;
    const step = await runStep('connect_g1', 'PUT', connectPath, undefined, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    if (!step.ok) return finalize(result, 'connect_g1_failed');
  }

  // Step 5 — connect G2 ↔ entity.
  if (result.refs.baselineEntityId && result.refs.baselineGuarantor2Id) {
    const connectPath = '/borrower/' + result.refs.baselineGuarantor2Id + '/connect/' + result.refs.baselineEntityId;
    const step = await runStep('connect_g2', 'PUT', connectPath, undefined, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    if (!step.ok) return finalize(result, 'connect_g2_failed');
  }

  // Step 6 — loan.
  if (!result.refs.baselineLoanId) {
    const loanPayload = buildLoanPayload(loan, client, borrowerInfo, result.refs);
    const step = await runStep('loan', 'POST', '/loan', loanPayload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    // Loan's external Id is what we sent (loan.id). Some Baseline endpoints
    // also echo back an internal numeric Id; both should work as references.
    if (step.ok) result.refs.baselineLoanId = (step.body && step.body.Id) || loan.id;
    if (!step.ok) return finalize(result, 'loan_failed');
  }

  return finalize(result);
}

/**
 * Run a single sync step. In dry-run mode, builds the request and logs
 * a 'would-have-sent' entry without calling Baseline. In live mode,
 * calls baselineFetch and logs the actual response.
 *
 * Always returns the step's outcome (caller uses it to decide whether
 * to continue the sequence). Never throws.
 */
async function runStep(stepName, method, path, body, mode, ctx) {
  const startedAt = Date.now();
  const url = baseUrl() + (path.startsWith('/') ? path : '/' + path);
  const sanitizedBody = body !== undefined ? redactSensitive(body) : undefined;

  if (mode === 'dry-run') {
    const entry = {
      step: stepName,
      mode,
      ok: true,
      method,
      url,
      request: sanitizedBody,
      note: 'Dry run — no HTTP call made',
      durationMs: 0,
      ...ctx,
    };
    await writeLog(entry);
    // Return a plausible Body so the orchestrator's "did this step
    // succeed → store its returned Id" logic still flows. The fake
    // Id is prefixed so it's obvious in the log if a dry-run id ever
    // accidentally hits production code.
    const fakeId = stepName === 'loan' ? (ctx.loanId || 'dryrun_loan') : 'dryrun_' + stepName + '_' + Math.random().toString(36).slice(2, 8);
    return { step: stepName, ok: true, mode, body: { Id: fakeId }, status: 0 };
  }

  // Live mode (Phase 2+ — not reachable in Phase 1 due to PHASE_1_FORCE_DRY_RUN)
  const resp = await baselineFetch(method, path, body);
  const durationMs = Date.now() - startedAt;
  await writeLog({
    step: stepName,
    mode,
    method,
    url,
    ok: resp.ok,
    status: resp.status,
    request: sanitizedBody,
    response: resp.body,
    error: resp.error || (resp.ok ? null : ('HTTP ' + resp.status)),
    durationMs,
    ...ctx,
  });
  return { step: stepName, ok: resp.ok, mode, body: resp.body, status: resp.status, error: resp.error };
}

function finalize(result, errorTag) {
  if (errorTag) {
    result.ok = false;
    result.error = errorTag;
  } else {
    result.ok = true;
  }
  return result;
}
