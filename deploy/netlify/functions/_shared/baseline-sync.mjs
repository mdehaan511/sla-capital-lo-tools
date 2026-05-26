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
 * Phase status: PHASE 2 (manual button live). The hardcoded dry-run
 * lock has been removed — env var BASELINE_DRY_RUN now controls mode
 * (defaults to true / dry-run; explicit 'false' enables live calls).
 * The "Send to Baseline" button on Loan Details makes real HTTP
 * requests when env is configured for live. Phase 3 wires auto-fire
 * from advanceQuoteToInProcessing(). Phase 2.5 will expand the field
 * mapping once a real Baseline GET response reveals the configured
 * custom field names.
 */
import { getStore } from '@netlify/blobs';
import { decryptField } from './crypto.mjs';
import { keySafe } from './auth.mjs';
import { postSlack } from './slack.mjs';

const DEFAULT_BASE_URL = 'https://production.baselinesoftware.com/production/api';

function isEnabled() {
  if (process.env.BASELINE_ENABLED === '0') return false;
  return !!process.env.BASELINE_API_KEY;
}

/**
 * Defaults to dry-run unless BASELINE_DRY_RUN is *explicitly* set to
 * the string "false" (lowercase). Same fail-safe pattern as brevo.mjs
 * — typos or a deleted env var keep you in dry-run instead of silently
 * going live. To enable real Baseline calls, set BASELINE_DRY_RUN=false
 * in the Netlify environment.
 */
function isDryRun() {
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
  // Diagnostic info — the literal env var values (NOT the API key) so
  // a super-admin can self-diagnose why mode isn't what they expect.
  // Common case: BASELINE_DRY_RUN set to 'true' or unset → mode is
  // dry-run even though the user set up the key. The only value that
  // flips to live is the literal lowercase string 'false'.
  const rawDryRun = process.env.BASELINE_DRY_RUN;
  return {
    enabled: isEnabled(),
    mode: !isEnabled() ? 'disabled' : (isDryRun() ? 'dry-run' : 'live'),
    configured: !!process.env.BASELINE_API_KEY,
    baseUrl: baseUrl(),
    // Phase 2.6 diagnostics. Tells the user exactly what BASELINE_DRY_RUN
    // resolves to so they can debug a "I set live but it's still dry-run"
    // case without me asking them what the env var is set to.
    dryRunRaw: rawDryRun == null ? null : String(rawDryRun),
    enabledKillSwitch: process.env.BASELINE_ENABLED === '0',
    // Phase tag drives a small note in the admin viewer. 2.5 expanded
    // the field mapping; 2.6 added Tax_ID + Social_Security_Number
    // custom fields + diagnostics; 2.7 fixed the dry-run-refs-
    // poisoning bug; 2.7.2 added anomaly detection so the silent-no-op
    // failure mode never returns "synced" again. Phase 3 wires
    // auto-fire from approval. Deploy 225 — partial-address guard
    // (drop all Address_* unless we have full Street + City + State,
    // parse Google formatted_address strings on the way in).
    phase: 'deploy-229.2-hoist-extractid-fix-502',
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

// Deploy 208 — write a "step skipped" audit entry. Same store as
// writeLog, just with a `skipped: true` flag so the viewer can style
// it differently and we can filter for it. Helps diagnose "why didn't
// the entity step run?" cases without DevTools.
async function logSkipped(stepName, reason, mode, ctx) {
  await writeLog({
    step: stepName,
    mode,
    ok: true,
    skipped: true,
    note: 'Step skipped: ' + reason,
    skipReason: reason,
    ...ctx,
  });
}

/**
 * Deploy 222 (Phase 3) — auto-fire Baseline sync when a loan flips
 * to `approved`. Called from two places:
 *
 *   1. advanceQuoteToInProcessing() in _shared/borrower-info-sync.mjs
 *      — fires when the borrower's long-app submission auto-advances
 *      the loan from `awaiting_app` → `approved`. Covers all four
 *      borrower-info completion paths.
 *
 *   2. loan-advance-status.mjs — fires on the LO's manual safety-
 *      valve advance (when the auto-advance didn't pick up the
 *      borrower-info completion for some reason).
 *
 * Caller passes the already-loaded `client` and `targetLoan`; this
 * helper:
 *   - loads borrower_info from the per-loan blob key
 *   - runs the syncLoanToBaseline orchestrator
 *   - MUTATES targetLoan in place with the resulting refs + status
 *     fields (caller is responsible for the subsequent client.setJSON)
 *   - fires a Slack alert on live-mode failure
 *
 * NEVER throws. A Baseline failure (network error, 5xx, etc.) must not
 * block the approval flow — the loan still advances in SLA Tools. The
 * Slack alert lets the admin know to investigate.
 *
 * Returns { ok, mode, summaryStatus, error? }. Caller can log or check
 * the result if they want; usually fire-and-await.
 */
export async function syncOnApproval(client, targetLoan, ownerKey, triggerUserEmail) {
  if (!isEnabled()) {
    return { ok: false, mode: 'disabled', summaryStatus: 'not_synced', skipped: true, reason: 'baseline_disabled' };
  }
  if (!client || !targetLoan || !ownerKey) {
    return { ok: false, mode: 'unknown', summaryStatus: 'not_synced', error: 'missing_required_args' };
  }

  // Load borrower_info for this (client, loan). Per-loan key, since
  // Deploy 168. Tolerant of missing data — orchestrator's precheck
  // will short-circuit if bi is needed but missing.
  let borrowerInfo = null;
  try {
    const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
    const biKey = ownerKey + '/' + keySafe(client.id) + '/' + keySafe(targetLoan.id);
    borrowerInfo = await biStore.get(biKey, { type: 'json' });
  } catch (e) {
    console.warn('syncOnApproval: borrower_info read failed (continuing):', e && e.message);
  }

  const trigUser = triggerUserEmail || 'auto:approval';
  let result;
  try {
    result = await syncLoanToBaseline(targetLoan, client, borrowerInfo, {
      triggerUserEmail: trigUser,
      triggerReason: 'auto_on_approval',
      ownerKey,
    });
  } catch (e) {
    // Defensive — the orchestrator's own contract is "never throws"
    // but a runtime bug shouldn't break the approval flow.
    console.error('syncOnApproval: orchestrator threw unexpectedly:', e);
    return { ok: false, mode: 'unknown', summaryStatus: 'failed', error: 'orchestrator_threw:' + (e && e.message) };
  }

  // Compute summary status (mirror trigger.mjs's logic — dry-run is
  // never "synced" because no real Baseline records exist).
  let summaryStatus;
  if (result.mode === 'dry-run') {
    summaryStatus = 'not_synced';
  } else if (result.ok) {
    summaryStatus = 'synced';
  } else {
    summaryStatus = (result.refs.baselineEntityId || result.refs.baselineGuarantor1Id) ? 'partial' : 'failed';
  }

  const stepsSummary = (result.steps || []).map((s) => ({
    step: s.step, ok: !!s.ok, status: s.status || null, error: s.error || null,
  }));

  // Mutate targetLoan in place. Caller will save the client record in
  // the same transaction that's flipping the loan status — keeps the
  // Baseline-side refs and the SLA-side status change atomic.
  const now = new Date().toISOString();
  const persistRefs = (result.mode === 'live');

  if (persistRefs) {
    targetLoan._baselineEntityId     = result.refs.baselineEntityId     || null;
    targetLoan._baselineGuarantor1Id = result.refs.baselineGuarantor1Id || null;
    targetLoan._baselineGuarantor2Id = result.refs.baselineGuarantor2Id || null;
    targetLoan._baselineLoanId       = result.refs.baselineLoanId       || null;
  }
  targetLoan._baselineSyncStatus    = summaryStatus;
  targetLoan._baselineSyncMode      = result.mode;
  if (result.ok && persistRefs) targetLoan._baselineSyncedAt = now;
  targetLoan._baselineLastAttemptAt = now;
  targetLoan._baselineLastAttemptBy = trigUser;
  targetLoan._baselineLastError     = result.ok ? null : (result.error || 'unknown');
  targetLoan._baselineLastSteps     = stepsSummary;
  targetLoan._baselineLastDebug     = result._debug || null;

  // Slack alert on live-mode failure. Fire-and-forget — never block
  // the approval flow on Slack.
  if (!result.ok && result.mode === 'live') {
    const siteUrl = (process.env.URL || 'https://slaloantools.netlify.app').replace(/\/+$/, '');
    const loanLink = siteUrl +
      '/loan-details.html?clientId=' + encodeURIComponent(client.id) +
      '&loanId='   + encodeURIComponent(targetLoan.id);
    const failingStep = (stepsSummary.find((s) => !s.ok) || { step: result.error || 'unknown' });
    const message = {
      text: ':warning: Baseline auto-sync failed — ' + (targetLoan.address || targetLoan.id),
      blocks: [
        { type: 'section', text: { type: 'mrkdwn',
          text: '*Baseline auto-sync failed* (fired on loan approval)\n' +
                '*Loan:* ' + (targetLoan.address || targetLoan.id) + '\n' +
                '*Failing step:* `' + failingStep.step + '`' +
                (failingStep.error ? '\n*Error:* ' + failingStep.error : '') +
                (failingStep.status ? ' (HTTP ' + failingStep.status + ')' : '') + '\n' +
                '*Trigger:* ' + trigUser + '\n' +
                '<' + loanLink + '|Open loan details>',
        }},
      ],
    };
    postSlack(message).catch((e) => console.warn('Slack alert failed silently:', e && e.message));
  }

  return { ok: result.ok, mode: result.mode, summaryStatus, error: result.error || null };
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
  // Field names to redact in the audit log. Covers our own internal
  // names (ssn, ssn_enc, ein) and Baseline's confirmed field names
  // (Phase 2.6: Tax_ID, Social_Security_Number).
  const SENSITIVE = [
    'SSN', 'ssn', 'ssn_enc', 'Ssn',
    'EIN', 'ein', 'Ein',
    'Tax_Id', 'Tax_ID', 'tax_id',
    'Social_Security_Number', 'social_security_number',
  ];
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

// ── Data-source fallback helpers (Deploy 210 / Phase 2.8.2) ─────────
//
// Real production loans don't always have a fully-populated long-app
// (borrower_info) record. The user's first test loan had bi.status =
// 'complete' but guarantorsCount=0 and hasLLC=null — yet the client
// record itself had borrower name + email + phone from when the loan
// was originally created. Without these fallbacks, the orchestrator
// would skip entity + g1 steps and the loan would sync to Baseline
// orphaned (no Primary_Borrower).
//
// Each helper tries sources in priority order:
//   Guarantor: bi.guarantors[idx] → flat bi.g{idx}_* → client record (idx=0 only)
//   Entity:    bi.hasLLC='yes' + llcName → client.companies[0]

function getGuarantor(bi, client, idx) {
  let g = null;

  // Priority 1: packed guarantors array from the long-app save flow
  if (bi && Array.isArray(bi.guarantors) && bi.guarantors[idx]) {
    g = { ...bi.guarantors[idx], _source: 'long_app_packed' };
  }
  // Priority 2: flat g{idx}_* keys (unpacked form data)
  if (!g) {
    const prefix = 'g' + idx + '_';
    if (bi && (bi[prefix + 'email'] || bi[prefix + 'firstName'])) {
      g = {
        firstName: bi[prefix + 'firstName'] || '',
        lastName:  bi[prefix + 'lastName']  || '',
        email:     bi[prefix + 'email']     || '',
        phone:     bi[prefix + 'phone']     || '',
        dob:       bi[prefix + 'dob']       || '',
        fico:      bi[prefix + 'fico']      || '',
        ssn:       bi[prefix + 'ssn']       || '',
        ssn_enc:   bi[prefix + 'ssn_enc']   || '',
        address:   bi[prefix + 'address']   || '',
        city:      bi[prefix + 'city']      || '',
        state:     bi[prefix + 'state']     || '',
        marital:   bi[prefix + 'marital']   || '',
        usCitizen: bi[prefix + 'usCitizen'] || '',
        flips:     bi[prefix + 'flips']     || '',
        _source:   'long_app_flat',
      };
    }
  }
  // Priority 3 (primary guarantor only): client record contact info.
  // The client always has at minimum email+name+phone since those are
  // captured when the loan is first created. Less rich than the long-
  // app but enough to attach a borrower to the Baseline loan.
  if (!g && idx === 0 && client && client.email) {
    g = {
      firstName: client.firstName || '',
      lastName:  client.lastName  || '',
      email:     client.email     || '',
      phone:     client.phone     || '',
      dob:       client.dob       || '',
      fico:      client.fico      || '',
      ssn_enc:   client.ssn_enc   || '',
      address:   (client.homeAddress && client.homeAddress.street) || '',
      city:      (client.homeAddress && client.homeAddress.city)   || '',
      state:     (client.homeAddress && client.homeAddress.state)  || '',
      marital:   client.maritalStatus || '',
      usCitizen: client.usCitizen || '',
      flips:     client.flips || '',
      _source:   'client_record',
    };
  }

  // Deploy 211 — primary-guarantor address backfill. Long-app
  // sometimes saves Street1 without City/State (Google Places
  // didn't autocomplete a full match, or the borrower typed manually
  // and the form let them through). For g0, fill missing city/state
  // from client.homeAddress when available.
  if (g && idx === 0 && client && client.homeAddress) {
    if (!g.city)  g.city  = client.homeAddress.city  || '';
    if (!g.state) g.state = client.homeAddress.state || '';
  }

  return g;
}

function getEntityInfo(bi, client) {
  // Priority 1: long-app says hasLLC='yes' with a name
  if (bi && bi.hasLLC === 'yes') {
    const llcName = bi.llcName || (bi.companies && bi.companies[0] && bi.companies[0].name);
    if (llcName) {
      const company = (bi.companies || []).find((c) => c.name === llcName) || {};
      return {
        name:    llcName,
        street1: company.address || bi.llcAddress || '',
        city:    company.city || '',
        state:   company.addrState || bi.llcState || '',
        ein:     company.ein || bi.llcEIN || '',
        _source: 'long_app',
      };
    }
  }
  // Priority 2: client.companies[] (synced from a prior loan's LLC info)
  if (client && Array.isArray(client.companies) && client.companies[0]) {
    const c = client.companies[0];
    if (c && c.name) {
      return {
        name:    c.name,
        street1: c.address || '',
        city:    c.city || '',
        state:   c.addrState || c.state || '',
        ein:     c.ein || '',
        _source: 'client_companies',
      };
    }
  }
  return null;
}

// ── Payload builders (PHASE 2.5 — expanded from real PULL dump) ─────
//
// Mapping derived from a confirmed GET /borrower + GET /loan response
// on the customer's Baseline account. State strings use full names
// ("Idaho", not "ID") — confirmed by the example. Phone is country-
// code-prefixed digits-only ("12087716115"). Rate is a decimal (0.12).
// Dates are YYYY-MM-DD. Loan terms include the RTL-friendly Holdback
// and Initial_Advance fields that map cleanly to our rehab budget +
// initial draw concept.
//
// Custom-field fields known to exist in Baseline but NOT returned by
// the GET endpoint (and therefore not in my dump) — SSN, EIN, the
// long-app declarations (bankruptcy/foreclosure/lawsuits/etc.). These
// are settable on POST/PATCH but their exact field names need to come
// from the customer's Baseline product configuration. Marked TODO
// throughout; Phase 2.6 wires them.

// 2-letter → full state name. Baseline expects the full name based on
// the dump ("Idaho" in both Address_State and Borrower_Jurisdiction).
// Pass-through if the input is already the full name.
const US_STATES = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', DC: 'District of Columbia',
  FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois',
  IN: 'Indiana', IA: 'Iowa', KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana',
  ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan',
  MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri', MT: 'Montana',
  NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota',
  OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania',
  RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota',
  TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont', VA: 'Virginia',
  WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
};
function expandState(s) {
  if (!s) return '';
  const trimmed = String(s).trim();
  // Already a full name (more than 2 chars and not all upper)
  if (trimmed.length > 2) return trimmed;
  const upper = trimmed.toUpperCase();
  return US_STATES[upper] || trimmed;
}

// SLA property-type slug → Baseline enum value. Our example loan had
// Address_Property_Type=null so the exact enum strings aren't 100%
// confirmed — these are educated guesses based on common LOS
// conventions. Baseline silently drops unknown enum values, so the
// failure mode is "field stays empty" not "request rejected".
const PROPERTY_TYPE_MAP = {
  sfr:          'Single Family',
  single:       'Single Family',
  '2-4':        '2-4 Unit',
  '5+':         '5+ Unit',
  mfr:          'Multi-Family',
  multi:        'Multi-Family',
  condo_w:      'Condominium',
  condo_nw:     'Condominium',
  condo:        'Condominium',
  townhome:     'Townhouse',
  townhouse:    'Townhouse',
  manufactured: 'Manufactured',
  rural:        'Rural',
  portfolio:    'Portfolio',
};
function mapPropertyType(s) {
  if (!s) return undefined;
  const key = String(s).trim().toLowerCase();
  return PROPERTY_TYPE_MAP[key]; // undefined if unknown — let Baseline default
}

// Enum guesses for citizenship + marital. Same caveat — exact strings
// not visible in the GET dump (both nullable). Adjust if Baseline
// drops the value.
function mapCitizenship(yesNo) {
  if (yesNo == null || yesNo === '') return undefined;
  const v = String(yesNo).trim().toLowerCase();
  if (v === 'yes' || v === 'us' || v === 'us_citizen' || v === 'us citizen') return 'US Citizen';
  if (v === 'no' || v === 'non_us' || v === 'foreign') return 'Non-US Citizen';
  return undefined;
}
function mapMaritalStatus(s) {
  if (s == null || s === '') return undefined;
  const v = String(s).trim().toLowerCase();
  if (v === 'married')   return 'Married';
  if (v === 'single')    return 'Single';
  if (v === 'divorced')  return 'Divorced';
  if (v === 'widowed')   return 'Widowed';
  if (v === 'separated') return 'Separated';
  return undefined;
}

// Date helpers — Baseline expects YYYY-MM-DD throughout.
function todayISO() {
  return new Date().toISOString().slice(0, 10);
}
function todayCompact() {
  return todayISO().replace(/-/g, ''); // 20260525
}
function addMonthsISO(iso, months) {
  if (!iso) return undefined;
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d.getTime())) return undefined;
  d.setUTCMonth(d.getUTCMonth() + (Number(months) || 0));
  return d.toISOString().slice(0, 10);
}

// Strip non-digits + ensure US "1" country-code prefix. Baseline phones
// in the dump look like "12087716115" — country code + 10 digits.
function fmtPhone(s) {
  if (!s) return undefined;
  const digits = String(s).replace(/[^\d]/g, '');
  if (!digits) return undefined;
  if (digits.length === 10) return '1' + digits;
  return digits;
}

// Deploy 208 — normalize rate to decimal. Our loan records store rate
// as a percent number (e.g. 10.5 for 10.5%), but Baseline expects the
// decimal form (0.105). Heuristic: values < 1 are already decimal,
// values >= 1 are percent and need /100. Catches both formats so
// historical data still works.
function normalizeRate(r) {
  const n = parseFloat(r);
  if (!n || isNaN(n)) return undefined;
  return n < 1 ? n : (n / 100);
}

// Deploy 208 — normalize Origination_Points. Our loan record stores
// "1.50 pts" (with text), but Baseline wants just the number. Strip
// any non-numeric characters, parse, return as numeric (Baseline's
// dump shows the field as a string but their docs accept numeric too).
function normalizePoints(p) {
  if (p == null || p === '') return undefined;
  const s = String(p).replace(/[^\d.]/g, '');
  if (!s) return undefined;
  const n = parseFloat(s);
  if (isNaN(n)) return undefined;
  return n;
}

// Deploy 208/210 — derive a Baseline-style external ID from our SLA
// loanId. Existing customer IDs use SLA-YYYYMMDD-NNNN format with a
// 4-digit numeric suffix. Deploy 210 swapped the alphanumeric suffix
// from the SLA loanId for a deterministic 4-digit numeric hash so the
// format actually matches (e.g. SLA-20260525-4732, not SLA-..._890j).
// Same SLA loanId always hashes to the same Baseline Id → retries
// safely deduplicate. Collision risk at ~20 loans/day is < 2%/year.
function deriveBaselineLoanId(loan) {
  const date = (loan && loan.fundingDate)
    ? String(loan.fundingDate).replace(/-/g, '')
    : todayCompact();
  // djb2-style 32-bit hash, mod 10000 → 0-9999, zero-padded.
  let hash = 0;
  const s = String(loan && loan.id || '');
  for (let i = 0; i < s.length; i++) {
    hash = ((hash << 5) - hash + s.charCodeAt(i)) | 0;
  }
  const num = Math.abs(hash) % 10000;
  const suffix = String(num).padStart(4, '0');
  return 'SLA-' + date + '-' + suffix;
}

// Deploy 208 — robust address parser. Old version only handled
// "Street, City, STATE ZIP" (state+zip combined). Production data
// also comes through as "Street, City, STATE, ZIP" (separate pieces)
// from Google Places autocomplete, which was leaving Address_State
// and Address_Zipcode null on the Baseline-side. Rewrite handles both
// forms plus optional trailing USA / United States.
function parseAddress(s) {
  const out = { street1: '', city: '', state: '', zip: '' };
  if (!s) return out;
  const parts = String(s).split(',').map((p) => p.trim()).filter(Boolean);
  // Strip trailing country marker if present.
  if (parts.length && /^(USA|US|United States)$/i.test(parts[parts.length - 1])) {
    parts.pop();
  }
  if (parts.length === 0) return out;
  out.street1 = parts[0];
  if (parts.length === 1) return out;

  const last = parts[parts.length - 1];
  const stateZip   = last.match(/^([A-Z]{2})\s+(\d{5})(?:-\d{4})?$/);
  const zipOnly    = last.match(/^(\d{5})(?:-\d{4})?$/);
  const stateOnly  = last.match(/^([A-Z]{2})$/);

  if (stateZip) {
    // "Street, City, STATE ZIP"
    out.state = stateZip[1];
    out.zip   = stateZip[2];
    if (parts.length >= 3) out.city = parts.slice(1, parts.length - 1).join(', ');
  } else if (zipOnly && parts.length >= 3) {
    // "Street, City, STATE, ZIP"  ← Google Places typical
    out.zip = zipOnly[1];
    const secondLast = parts[parts.length - 2];
    if (/^[A-Z]{2}$/.test(secondLast)) {
      out.state = secondLast;
      if (parts.length >= 4) out.city = parts.slice(1, parts.length - 2).join(', ');
    } else {
      out.city = parts.slice(1, parts.length - 1).join(', ');
    }
  } else if (stateOnly && parts.length >= 2) {
    // "Street, City, STATE"  (no zip)
    out.state = stateOnly[1];
    if (parts.length >= 3) out.city = parts.slice(1, parts.length - 1).join(', ');
  } else {
    // Couldn't detect zip/state — everything after street is city.
    out.city = parts.slice(1).join(', ');
  }
  return out;
}

/**
 * Build the POST /borrower payload for the vesting LLC entity.
 * Returns null if the long-app has no LLC (loan vests in the individual).
 *
 * The Baseline borrower record for an entity is fairly thin: Name,
 * Is_Company, address parts. Entity-specific lending metadata
 * (Borrower_Entity_Type, Borrower_Jurisdiction) is set at the LOAN
 * level instead — see buildLoanPayload below.
 *
 * TODO Phase 2.6: add EIN once we have the custom field name from the
 * customer's Baseline product config.
 */
function buildEntityPayload(loan, client, bi) {
  // Deploy 210 — uses getEntityInfo() fallback chain: long-app's
  // hasLLC='yes' + llcName takes priority; otherwise falls back to
  // client.companies[0] (if any LLC was ever synced for this client).
  // Returns null only if neither source has any entity data, meaning
  // the loan genuinely vests in the individual.
  const ent = getEntityInfo(bi, client);
  if (!ent) return null;

  // Deploy 225 — same partial-address guard as buildPersonPayload. The
  // entity's street1 commonly comes through as a Google formatted_address
  // ("Street, City, ST ZIP, USA") when the long-app's LLC address field
  // is used in single-line autocomplete mode. Parse to recover city/
  // state/zip, then fall back to separate fields if present. If we
  // still don't have city + state, drop ALL Address_* fields rather
  // than send a partial address (Baseline 500s on Street1-only payloads).
  const entParsed = parseAddress(ent.street1 || '');
  const entStreet = (entParsed.street1 || ent.street1 || '').trim();
  const entCity   = (entParsed.city  || ent.city  || '').trim();
  const entStRaw  = (entParsed.state || ent.state || '').trim();
  const entZip    = (entParsed.zip   || '').trim();
  const entHaveFullAddress = !!(entStreet && entCity && entStRaw);

  const payload = {
    Is_Company:      true,
    Name:            ent.name,
    Address_Street1: entHaveFullAddress ? entStreet : undefined,
    Address_City:    entHaveFullAddress ? entCity   : undefined,
    Address_State:   entHaveFullAddress ? expandState(entStRaw) : undefined,
    Address_Zipcode: entHaveFullAddress ? (entZip || undefined) : undefined,
    Address_Country: entHaveFullAddress ? 'United States' : undefined,
  };

  // Deploy 229 — Tax_ID (EIN) moved to _followUpFields. Same risk
  // profile as the person-borrower custom fields: if Baseline rejects
  // it on POST we don't lose the create. Will be PATCHed individually
  // after the entity record exists.
  payload._followUpFields = {};
  if (ent.ein) payload._followUpFields.Tax_ID = String(ent.ein).trim();

  // Strip blanks (defensive — same pattern as buildPersonPayload).
  // _followUpFields stays even if empty so the orchestrator knows
  // there's nothing to PATCH.
  Object.keys(payload).forEach((k) => {
    if (k === '_followUpFields') return;
    if (payload[k] === undefined || payload[k] === '' || payload[k] === null) delete payload[k];
  });

  return payload;
}

/**
 * Build the POST /borrower payload for a single guarantor (person).
 *
 * The Team-list view in the GET dump showed: Id, Name, First_Name,
 * Last_Name, Email, Other_Email, Date_Birth, Phone, Phone_Secondary,
 * Is_Company, Created_At, Updated_At, Credit_Score. Address fields
 * weren't on the Team-list view but standalone person borrowers
 * almost certainly accept them — sending; if Baseline ignores, no harm.
 *
 * @param {object} g — guarantor object from borrower_info.guarantors[i]
 *
 * TODO Phase 2.6: SSN (custom field), declarations (bankruptcy7yr /
 * foreclosure7yr / partyToLawsuit / delinquentFederalDebt / obligated
 * ToForeclosed / outstandingJudgments / intendToOccupy) — all live in
 * borrower_info but their Baseline custom field names need confirming.
 */
function buildPersonPayload(g) {
  if (!g || !g.email) return null;

  // Phase 2.6 — SSN decrypted from at-rest storage. Long-app encrypts
  // the SSN with SSN_ENCRYPTION_KEY and stores it as g.ssn_enc; some
  // legacy records may still have plain g.ssn. Try both; fall through
  // silently on decrypt failure (Baseline gets the record without
  // SSN rather than failing the whole sync).
  let ssn = '';
  if (g.ssn_enc) {
    try {
      ssn = decryptField(g.ssn_enc) || '';
    } catch (e) {
      console.warn('baseline buildPersonPayload: SSN decrypt failed (continuing without):', e && e.message);
    }
  } else if (g.ssn) {
    ssn = String(g.ssn);
  }
  ssn = ssn.trim();

  // Deploy 225 — defensive address resolution. The long app stores the
  // home address as a single combined string in g.address with optional
  // separate g.city / g.state / g.zip. In single-line autocomplete mode
  // we get the Google formatted_address ("Street, City, ST ZIP, USA")
  // in g.address and the separate fields stay blank. In structured
  // mode the reverse — separate fields are filled and g.address holds
  // just the street.
  //
  // Phase-2 prod test (Herbert Loper, 5/26) returned a 500 from Baseline
  // POST /borrower because we sent Address_Street1 + Address_Country
  // with no City/State (those got stripped by the blank-removal loop
  // below). Baseline appears to crash server-side on a partial address.
  //
  // Strategy: parse g.address first to recover embedded city/state/zip,
  // then fall back to the separate fields. If we STILL don't have both
  // city AND state, drop ALL Address_* fields so we send no address at
  // all rather than a half-address.
  const parsed = parseAddress(g.address || '');
  const street = (parsed.street1 || g.address || '').trim();
  const city   = (parsed.city  || g.city  || '').trim();
  const stRaw  = (parsed.state || g.state || '').trim();
  const zip    = (parsed.zip   || g.zip   || '').trim();
  const haveFullAddress = !!(street && city && stRaw);

  // Deploy 229 — payload split into two buckets.
  //
  // The Herbert Loper diagnostic (5/26) ran the strip-and-retry chain
  // and proved: tier 4 (no Credit_Score / Citizenship / Marital_Status)
  // succeeds, tier 3 (with them) returns 500. So at least one of those
  // three fields trips Baseline's POST /borrower validator. The
  // successful response also revealed the real field name for flip
  // count: "Projects_Completed_In_Last_36_Months" (our Num_Flipped was
  // silently being ignored).
  //
  // Without Baseline API docs we don't know whether those fields are
  // read-only on POST, require a Custom_Fields wrapper, need a
  // different enum string, or something else. To unblock the everyday
  // sync flow we:
  //   (1) build the POST payload with only known-safe fields, and
  //   (2) attach a _followUpFields bag for the orchestrator to PATCH
  //       onto the borrower record after creation. Each PATCH is fired
  //       individually so a 500 on one field doesn't block the others;
  //       successes + failures land in the audit log so we learn over
  //       time which fields actually work on Mike's Baseline config.
  const payload = {
    Is_Company:      false,
    First_Name:      g.firstName || '',
    Last_Name:       g.lastName || '',
    Name:            (g.firstName || '') + (g.lastName ? ' ' + g.lastName : ''),
    Email:           String(g.email || '').trim().toLowerCase(),
    Other_Email:     String(g.email || '').trim().toLowerCase(), // matched dump
    Phone:           fmtPhone(g.phone),
    Date_Birth:      g.dob || undefined, // expected YYYY-MM-DD
    Address_Street1: haveFullAddress ? street : undefined,
    Address_City:    haveFullAddress ? city   : undefined,
    Address_State:   haveFullAddress ? expandState(stRaw) : undefined,
    Address_Zipcode: haveFullAddress ? (zip || undefined) : undefined,
    Address_Country: haveFullAddress ? 'United States' : undefined,
  };

  // Follow-up PATCH fields. Each is attempted as a SEPARATE PATCH
  // /borrower/{Id} call after the create succeeds. Per-field PATCH
  // means a 500 on one doesn't block the others. The orchestrator
  // strips this property off before sending the POST so it doesn't
  // get into the network call.
  payload._followUpFields = {};
  const fico = g.fico ? parseInt(g.fico, 10) : null;
  if (fico)                                        payload._followUpFields.Credit_Score                            = fico;
  if (g.flips != null && g.flips !== '')           payload._followUpFields.Projects_Completed_In_Last_36_Months    = parseInt(g.flips, 10);
  const citizenshipVal = mapCitizenship(g.usCitizen);
  if (citizenshipVal)                              payload._followUpFields.Citizenship                              = citizenshipVal;
  const maritalVal = mapMaritalStatus(g.marital);
  if (maritalVal)                                  payload._followUpFields.Marital_Status                          = maritalVal;
  if (ssn)                                         payload._followUpFields.Social_Security_Number                  = ssn;

  // Strip undefined/empty from the main payload.
  Object.keys(payload).forEach((k) => {
    if (k === '_followUpFields') return;
    if (payload[k] === undefined || payload[k] === '' || payload[k] === null) delete payload[k];
  });

  return payload;
}

/**
 * Build the POST /loan payload. Our SLA loanId is sent as Baseline's
 * `Id` so retries are idempotent — re-POSTing the same Id will be
 * rejected on Baseline's side and we treat that as "already synced".
 *
 * Loan-level fields cover four categories:
 *   1. Identity     — Id, Name, Status, Borrower_Id, Guarantor_Id
 *   2. Property     — Address_* (parsed) + property detail fields
 *   3. Loan terms   — Loan_Amount, Rate, Term, Holdback, Initial_Advance,
 *                     Origination, Maturity, Origination_Points,
 *                     Amortization_Type, Frequency
 *   4. Borrower/Guarantor denormalized — entity type, jurisdiction,
 *                     citizenship, marital status, credit score, flips
 *                     (these are auto-populated by Baseline from the
 *                     linked records when the GET returns, but setting
 *                     them explicitly on create ensures the new loan
 *                     has rich metadata even before the borrower
 *                     records are fully fleshed out)
 */
function buildLoanPayload(loan, client, bi, refs, g1Resolved, g2Resolved) {
  const addr = parseAddress(loan.address || '');
  const isRTL = (loan.toolType || '') === 'rtl';
  const isDutch = (loan.dutchInterest || (bi && bi.dutchInterest) || 'dutch') === 'dutch';

  // Deploy 212 — accept the resolved guarantor objects from the
  // orchestrator's getGuarantor() fallback chain (long-app → flat →
  // client record). Previously we re-read bi.guarantors[0] which
  // missed the client-record fallback case entirely.
  const g1 = g1Resolved || (bi && bi.guarantors && bi.guarantors[0]) || {};

  // Identity ----------------------------------------------------------
  // Primary borrower: prefer the entity (LLC); fall back to G1 person
  // when the loan vests in the individual (no entity created).
  // Guarantor_Id: G1's person id, but ONLY when there's a distinct
  // entity. When the loan vests in G1 directly there's no separate
  // guarantor — Borrower_Id alone covers it.
  const primaryBorrowerId = refs.baselineEntityId || refs.baselineGuarantor1Id || null;
  const guarantorId = refs.baselineEntityId ? (refs.baselineGuarantor1Id || null) : null;

  // Loan amounts ------------------------------------------------------
  const loanAmt   = parseFloat(loan.loanAmt) || undefined;
  const rehab     = isRTL ? (parseFloat(loan.rehabBudget) || 0) : 0;
  // Initial advance = loan amount minus rehab holdback (RTL only).
  // For DSCR / no-rehab loans, leave undefined so Baseline uses its
  // own default (typically = loan amount).
  const initialAdv = isRTL && rehab > 0 && loanAmt ? (loanAmt - rehab) : undefined;

  // Dates -------------------------------------------------------------
  // Origination defaults to today if no funding date on file; Maturity
  // is Origination + Term months. Baseline computes Per_Diem etc. from
  // these — important to get them right.
  const origination = loan.fundingDate || todayISO();
  // Deploy 208 — term fallback. RTL loans default to 12 months when
  // not set on the record (private-lending standard); DSCR loans leave
  // it unset so Baseline's product default applies.
  let termMonths = parseInt(loan.loanTerm, 10);
  if (!termMonths || isNaN(termMonths)) termMonths = isRTL ? 12 : undefined;
  const maturity = termMonths ? addMonthsISO(origination, termMonths) : undefined;

  // Amortization type. Dutch ONLY for now — user opted to leave Non-
  // Dutch unset (Baseline product default applies) until we confirm
  // the exact enum string for that mode.
  const amortizationType = isDutch ? 'Interest-Only (Loan Amount)' : undefined;

  // Deploy 208 — configurable Status + Substatus per user direction.
  // All new loans push into 'lead' status. Substatus tracks product
  // family (DSCR vs RTL) for the team's pipeline filtering. Both
  // settable per Baseline's docs.
  const baselineStatus    = 'lead';
  const baselineSubstatus = isRTL ? 'RTL' : 'DSCR';

  // Deploy 210 (Phase 2.8.2) — Loan_Type removed. User configured
  // Baseline so that the Substatus value (RTL / DSCR) auto-selects
  // the correct product. We just set Substatus; Baseline handles the
  // product selection on its side.

  const payload = {
    // ─ Identity ───────────────────────────────────────────────────
    // Deploy 208 — switched to SLA-YYYYMMDD-<suffix> format matching
    // the customer's existing Baseline ID convention. Derived
    // deterministically from our SLA loanId so retries dedupe.
    Id:        deriveBaselineLoanId(loan),
    Name:      loan.address || ('Loan ' + loan.id),
    Status:    baselineStatus,
    Substatus: baselineSubstatus,

    // ─ Property address (parsed) ─────────────────────────────────
    Address_Street1: addr.street1,
    Address_City:    addr.city,
    Address_State:   expandState(addr.state),
    Address_Zipcode: addr.zip,
    Address_Country: 'United States',

    // ─ Property details ──────────────────────────────────────────
    Address_Property_Type:          mapPropertyType(loan.propType || (bi && bi.propertyType)),
    Address_Beds:                   parseInt(loan.bedrooms, 10) || undefined,
    Address_Baths:                  parseFloat(loan.bathrooms) || undefined,
    Address_Gross_Livable_Area_GLA: parseInt(loan.sqft, 10) || undefined,
    Address_Project_Summary:        loan.projectDescription || (bi && bi.planDescription) || undefined,

    // RTL fields (purchase price, rehab, ARV)
    Address_Purchase_Price:         isRTL ? (parseFloat(loan.purchasePrice) || undefined) : undefined,
    Address_ARV_Borrower:           isRTL ? (parseFloat(loan.arv) || undefined)           : undefined,
    Address_Total_Rehab:            isRTL ? (rehab || undefined)                          : undefined,

    // DSCR fields (as-is value, rent)
    Address_As_Is_Value:            !isRTL ? (parseFloat(loan.propValue) || undefined) : undefined,
    Address_Actual_Rent:            !isRTL ? (parseFloat(loan.rent)      || undefined) : undefined,
    Address_Market_Rent:            !isRTL ? (parseFloat(loan.rent)      || undefined) : undefined,

    // Carrying costs (both products)
    Address_Property_Taxes:         parseFloat(loan.taxes)     || undefined,
    Address_HOA_Fees:               parseFloat(loan.hoa)       || undefined,

    // ─ Loan terms ─────────────────────────────────────────────────
    Loan_Amount:        loanAmt,
    // Deploy 208 — convert percent (10.5) to decimal (0.105). Our loan
    // records store rate as percent (display value); Baseline's dump
    // showed rate as decimal (0.12). normalizeRate detects which format
    // came in and converts; >= 1 means percent (divide), < 1 means
    // already decimal. Pre-208 we sent 10.5 verbatim → Baseline read it
    // as 1050%, making Per_Diem and Principal_Interest grotesque.
    Rate:               normalizeRate(loan.rate),
    Term:               termMonths,
    Holdback:           rehab > 0 ? rehab : undefined,                // RTL only
    Initial_Advance:    initialAdv,                                   // RTL only
    Origination:        origination,
    Maturity:           maturity,
    // Deploy 208 — strip text like " pts" off the points value; send
    // as a number. Pre-208 we were sending "1.50 pts" verbatim.
    Origination_Points: normalizePoints(loan.points),
    Amortization_Type:  amortizationType,
    Frequency:          'Monthly',

    // ─ Borrower/Guarantor denormalized metadata ──────────────────
    Borrower_Entity_Type: refs.baselineEntityId ? 'Limited Liability Company' : undefined,
    Borrower_Jurisdiction: refs.baselineEntityId ? expandState(bi && (bi.llcState || (bi.companies && bi.companies[0] && bi.companies[0].addrState)) || '') : undefined,
    Guarantor_Citizenship:    mapCitizenship(g1.usCitizen),
    Guarantor_Marital_Status: mapMaritalStatus(g1.marital),
    Guarantor_Credit_Score:   g1.fico ? parseInt(g1.fico, 10) : undefined,
    Guarantor_Num_Flipped:    g1.flips != null && g1.flips !== '' ? parseInt(g1.flips, 10) : undefined,
  };

  // Link entity + guarantor.
  // Preferred: explicit Baseline IDs (when we successfully created /
  // had the IDs from a prior sync). Fallback: email-based auto-attach,
  // which Baseline resolves to an existing borrower if one matches
  // the email, otherwise creates a new one.
  //
  // Deploy 212 — email fallback added to handle the common case of an
  // investor with multiple loans (the borrower already exists in
  // Baseline → our POST /borrower returned 409 → we don't have an Id
  // → loan POST needs Borrower_Email / Guarantor_Email to link).
  if (primaryBorrowerId) {
    payload.Borrower_Id = primaryBorrowerId;
  } else if (g1 && g1.email) {
    // No entity (vests in individual) AND we couldn't create g1 person
    // directly. Auto-attach by email — Baseline will link the existing
    // borrower or create one with this email.
    payload.Borrower_Email = String(g1.email).trim().toLowerCase();
  }
  if (guarantorId) {
    payload.Guarantor_Id = guarantorId;
  } else if (refs.baselineEntityId && g1 && g1.email) {
    // Entity is the Borrower; G1 is the Guarantor. No g1 Id (409
    // duplicate-email on borrower POST), so attach G1 by email.
    payload.Guarantor_Email = String(g1.email).trim().toLowerCase();
  }

  // Strip blanks so we don't overwrite Baseline-side data on retries.
  Object.keys(payload).forEach((k) => {
    if (payload[k] === undefined || payload[k] === '' || payload[k] === null) delete payload[k];
  });

  return payload;
}

// Note: parseAddress was hoisted up to live with the other field-
// normalization helpers (and rewritten in Deploy 208 to handle
// "Street, City, State, Zip" addresses that Google Places returns).
// See the top of the file.

// ── HTTP helper ──────────────────────────────────────────────────────

/**
 * Perform a single HTTP call against Baseline. Used by the orchestrator
 * for each step. Returns { ok, status, body, error }. Never throws.
 *
 * Phase 1: this is unreachable because the orchestrator runs in dry-run
 * mode. Phase 2 wires it in.
 */
// Deploy 215/218 (Phase 2.8.6 / 2.8.9) — find an existing borrower by
// email via Baseline's GraphQL endpoint. Used when POST /borrower
// returns 409 "email already in use" so we can recover the existing
// borrower's Id and attach it to the loan as Guarantor_Id.
//
// GraphQL schema is not documented for this customer — type and field
// names need probing. Deploy 218 makes this diagnostic: returns
// { id, attempts } where attempts is the array of every query tried
// and what Baseline returned. The caller writes attempts to the audit
// log so we can see WHY a lookup failed.
async function findBorrowerByEmail(email) {
  const out = { id: null, attempts: [] };
  if (!email) return out;
  const cleanEmail = String(email).trim().toLowerCase();
  if (!cleanEmail) return out;

  // Deploy 219 — schema introspection revealed the GraphQL type for
  // borrowers is `people` (Hasura convention; the REST /borrower
  // endpoint is a view over this table). All fields are snake_case
  // lowercase (id, email). The single canonical query below is what
  // the schema actually accepts; the alternates are kept as
  // diagnostics in case the schema evolves.
  const queries = [
    // Canonical (confirmed by introspection in Deploy 218):
    { label: 'people+where+email', query: '{ people(where: { email: { _eq: "' + cleanEmail + '" } }) { id email } }' },
    // Diagnostic fallbacks if schema changes:
    { label: 'people+where+Email', query: '{ people(where: { Email: { _eq: "' + cleanEmail + '" } }) { id Email } }' },
  ];

  for (const q of queries) {
    const attempt = { label: q.label, query: q.query, httpStatus: null, body: null };
    try {
      const url = baseUrl() + '/graph';
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': 'Token ' + process.env.BASELINE_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify({ query: q.query }),
      });
      attempt.httpStatus = resp.status;
      const text = await resp.text().catch(() => '');
      try { attempt.body = text ? JSON.parse(text) : null; }
      catch (_) { attempt.body = { raw: String(text).slice(0, 500) }; }

      if (!attempt.body) { out.attempts.push(attempt); continue; }
      // GraphQL errors → try next query
      if (attempt.body.errors && attempt.body.errors.length) {
        out.attempts.push(attempt);
        continue;
      }
      // Look for borrower data in the response. Deploy 219 — the
      // schema's actual table is `people`. Keep `borrowers` /
      // `borrower` as fallback keys in case the schema evolves or a
      // different tenant uses different naming.
      const data = attempt.body.data || {};
      const candidates = data.people || data.borrowers || data.borrower;
      const list = Array.isArray(candidates) ? candidates : (candidates ? [candidates] : []);
      if (list.length > 0) {
        out.id = list[0].id || list[0].Id || null;
        out.attempts.push(attempt);
        if (out.id) return out;
      }
      out.attempts.push(attempt);
    } catch (e) {
      attempt.error = e && e.message;
      out.attempts.push(attempt);
    }
  }
  return out;
}

// Deploy 220 — one-time diagnostic. Asks Baseline GraphQL for the list
// of available mutation fields. Writes them into the audit log so we
// can see whether insert_guarantees_one (or similar) is available for
// directly inserting the guarantor↔loan linkage when PATCH doesn't
// honor it. Never throws.
async function probeMutationSchema(ctx) {
  const query = '{ __schema { mutationType { name fields { name args { name type { name kind ofType { name kind } } } } } } }';
  try {
    const url = baseUrl() + '/graph';
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Token ' + process.env.BASELINE_API_KEY,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify({ query }),
    });
    const text = await resp.text().catch(() => '');
    let parsed;
    try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = { raw: text.slice(0, 500) }; }
    // Look specifically for guarantees-related mutation fields, since
    // those are what we need.
    const mutationType = parsed && parsed.data && parsed.data.__schema && parsed.data.__schema.mutationType;
    const allFields = (mutationType && mutationType.fields) || [];
    const guaranteeFields = allFields.filter((f) => /guarantee|guaranty|borrow|people|insert|update/i.test(f.name)).map((f) => f.name);
    await writeLog({
      step: 'mutation_probe',
      mode: 'live',
      ok: !!mutationType,
      note: mutationType
        ? ('GraphQL mutationType available. ' + allFields.length + ' total mutation fields. ' + guaranteeFields.length + ' look guarantee/borrow/insert/update related.')
        : 'GraphQL returned no mutationType (queries-only schema?). See full response.',
      mutationTypeName: mutationType && mutationType.name,
      mutationFieldCount: allFields.length,
      guaranteeRelatedMutationFields: guaranteeFields.slice(0, 40),
      response: parsed,
      ...ctx,
    });
  } catch (e) {
    await writeLog({
      step: 'mutation_probe',
      mode: 'live',
      ok: false,
      note: 'Mutation probe threw: ' + (e && e.message),
      ...ctx,
    });
  }
}

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

// Deploy 204 (Phase 2.7 hotfix): dry-run runs persist FAKE Baseline IDs
// onto the loan record (e.g. _baselineEntityId = 'dryrun_entity_abc').
// On a subsequent LIVE retry, the orchestrator saw those refs and
// thought "already synced, skip" — making zero real API calls but
// marking the loan as synced. This helper recognises both legacy
// dry-run prefixes ('dryrun_') and the new clearly-marked prefix
// ('__DRYRUN__') so existing affected loans self-heal on their next
// retry, and new dry-runs can never poison the record.
function isRealBaselineId(id) {
  if (!id || typeof id !== 'string') return false;
  if (id.indexOf('dryrun_')   === 0) return false;
  if (id.indexOf('__DRYRUN__') === 0) return false;
  return true;
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
  // Deploy 206 (Phase 2.7.2): capture the raw loan refs BEFORE
  // filtering so we can surface them in the response as a debug aid.
  const rawRefsFromLoan = {
    baselineEntityId:      (loan && loan._baselineEntityId)     || null,
    baselineGuarantor1Id:  (loan && loan._baselineGuarantor1Id) || null,
    baselineGuarantor2Id:  (loan && loan._baselineGuarantor2Id) || null,
    baselineLoanId:        (loan && loan._baselineLoanId)       || null,
  };
  const result = {
    ok: false,
    mode: !isEnabled() ? 'disabled' : (isDryRun() ? 'dry-run' : 'live'),
    steps: [],
    // Deploy 204 + 205 (Phase 2.7 hotfix): filter dry-run-tainted refs.
    // If a previous dry-run persisted a fake ID, treat it as missing
    // so a live retry actually runs all the steps. isRealBaselineId()
    // recognizes both 'dryrun_' (legacy) and '__DRYRUN__' (current).
    //
    // CAVEAT — the LOAN step's pre-Deploy-204 dry-run fake ID was the
    // real loanId itself (unprefixed), so it slips through the filter
    // looking legitimate. If we kept it, a live retry would create
    // entity + guarantors but SKIP the loan-create step — partial
    // sync, no loan in Baseline. Deploy 205 adds the second guard
    // below: if any of the borrower refs were filtered out, the whole
    // prior attempt is suspect — clear the loan ref too. The user's
    // affected loan recovers on the next retry.
    refs: {
      baselineEntityId:      isRealBaselineId(loan && loan._baselineEntityId)      ? loan._baselineEntityId      : null,
      baselineGuarantor1Id:  isRealBaselineId(loan && loan._baselineGuarantor1Id)  ? loan._baselineGuarantor1Id  : null,
      baselineGuarantor2Id:  isRealBaselineId(loan && loan._baselineGuarantor2Id)  ? loan._baselineGuarantor2Id  : null,
      baselineLoanId:        isRealBaselineId(loan && loan._baselineLoanId)        ? loan._baselineLoanId        : null,
    },
  };
  // Deploy 205 guard — if any borrower ref came in dry-run-tainted,
  // discard the loan ref too. They're a unit; the previous attempt
  // was a dry-run and produced no real Baseline records.
  const hadBorrowerRefs = !!(
    (loan && loan._baselineEntityId)     ||
    (loan && loan._baselineGuarantor1Id) ||
    (loan && loan._baselineGuarantor2Id)
  );
  const keptBorrowerRefs = !!(
    result.refs.baselineEntityId      ||
    result.refs.baselineGuarantor1Id  ||
    result.refs.baselineGuarantor2Id
  );
  if (hadBorrowerRefs && !keptBorrowerRefs) {
    // Borrower refs existed but were ALL dry-run-tainted → loan ref
    // (even if unprefixed) is from the same poisoned attempt.
    result.refs.baselineLoanId = null;
  }

  // Deploy 214 (Phase 2.8.5) — auto-clear stale-format loan refs. Pre-
  // Deploy-210 we used our SLA loanId (l_<timestamp>_<6chars>) as the
  // Baseline Id directly. Deploy 210 switched to the customer's
  // SLA-YYYYMMDD-NNNN format. Loans that synced before the format
  // change have refs in the old format; the Baseline records at
  // those IDs are typically broken (Rate as percent, no Primary_
  // Borrower, etc. — bug accumulation from the early phases). Clearing
  // forces the next retry to POST a fresh Baseline record with the
  // current format and the current correct field mapping.
  if (result.refs.baselineLoanId && !String(result.refs.baselineLoanId).startsWith('SLA-')) {
    result.refs.baselineLoanId = null;
  }

  // Deploy 206 (Phase 2.7.2): EDGE CASE we missed in 205. If the loan
  // record had ONLY a _baselineLoanId set (no entity/g1/g2 — say the
  // user cleared them manually, or a previous failed attempt left
  // a partial state, or the SLA loanId was stamped some other way),
  // hadBorrowerRefs is false and the guard doesn't fire. The
  // orchestrator then keeps the loan ref, skips the loan-create step,
  // and ALL other steps' connect targets are missing → 0 steps run
  // total. End result: misleading "synced" with empty audit log.
  //
  // Fix: if all three borrower refs are null but loan ref is set,
  // the loan record is in a half-broken state. There's no way to
  // verify the existing loanId points to a real Baseline record
  // without doing a Baseline GET first (and even then a 404 would
  // require us to re-create). Simpler & safer: clear the loan ref
  // so we always re-create cleanly. The duplicate-Id rejection from
  // Baseline then becomes our idempotency signal (we treat it as
  // "already synced" if Baseline says the Id exists).
  if (!result.refs.baselineEntityId &&
      !result.refs.baselineGuarantor1Id &&
      !result.refs.baselineGuarantor2Id &&
      result.refs.baselineLoanId) {
    result.refs.baselineLoanId = null;
  }

  // Deploy 208/210 — long-app + fallback snapshot. Sanitized snapshot
  // of what drives the entity / guarantor steps. Deploy 210 added the
  // _source tag on each resolved object so we can see whether the data
  // came from the long-app, flat keys, or the client fallback.
  function snapshotBi(b, c) {
    const ent = getEntityInfo(b, c);
    const g1 = getGuarantor(b, c, 0);
    const g2 = getGuarantor(b, c, 1);
    return {
      bi_present:  !!b,
      bi_status:   b ? (b.status || null) : null,
      bi_hasLLC:   b ? (b.hasLLC || null) : null,
      bi_llcName:  b && b.llcName ? 'set' : 'unset',
      bi_companiesCount: b && Array.isArray(b.companies) ? b.companies.length : 0,
      bi_guarantorsCount: b && Array.isArray(b.guarantors) ? b.guarantors.length : 0,
      client_email_present: !!(c && c.email),
      client_companies_count: c && Array.isArray(c.companies) ? c.companies.length : 0,
      resolved_entity: ent
        ? { source: ent._source, hasName: !!ent.name, hasState: !!ent.state, hasEin: !!ent.ein }
        : null,
      resolved_g1: g1
        ? { source: g1._source, emailDomain: ((g1.email||'').split('@')[1] || null), hasFirstName: !!g1.firstName, hasLastName: !!g1.lastName, hasPhone: !!g1.phone, hasDob: !!g1.dob, hasFico: !!g1.fico, hasSsnEnc: !!g1.ssn_enc }
        : null,
      resolved_g2: g2
        ? { source: g2._source, emailDomain: ((g2.email||'').split('@')[1] || null), hasFirstName: !!g2.firstName, hasLastName: !!g2.lastName }
        : null,
    };
  }

  // Attach a debug bundle that the trigger endpoint can pass through
  // in its response and persist onto the loan for panel display.
  result._debug = {
    rawRefsFromLoan,
    refsAfterFilter: { ...result.refs },
    biSnapshot: snapshotBi(borrowerInfo, client),
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

  // Deploy 210 — use the fallback chain instead of reading guarantors[]
  // directly. getGuarantor tries: long-app packed → flat g{idx}_* keys
  // → client record (g0 only). Means we can sync even loans whose long-
  // app didn't fully populate page 4.
  const g1 = getGuarantor(borrowerInfo, client, 0);
  const g2 = getGuarantor(borrowerInfo, client, 1);

  // Deploy 229.2 — extractId and isDuplicateEmailError moved to module
  // scope (see top of file) so postBorrowerWithAddressFallback and
  // firePersonFollowUpPatches can use them. They were nested inside
  // this orchestrator function as closures; calling them from the
  // outside-scoped wrapper functions threw ReferenceError → 502 fast.

  // Step 1 — entity (LLC). Skip if no LLC OR if already synced.
  const entityPayload = buildEntityPayload(loan, client, borrowerInfo);
  if (entityPayload && !result.refs.baselineEntityId) {
    // Deploy 228.2 — same address-strip fallback as the guarantor
    // steps. The entity address goes through the same Baseline
    // address validator, so a missing ZIP / geocoding fail / etc.
    // would 500 the same way.
    const step = await postBorrowerWithAddressFallback('entity', entityPayload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    const entId = extractId(step.body, 'borrower');
    if (step.ok && entId) {
      result.refs.baselineEntityId = entId;
    } else if (!step.ok && isDuplicateEmailError(step)) {
      // Deploy 212a — entity 409 (LLC name + state already exists in
      // Baseline from a prior sync). Soft-success; we can't attach
      // an entity by email at loan-create time (no Borrower_Email-
      // equivalent for entities), so the loan will fall back to
      // attaching G1 as the Borrower instead. Less ideal but the
      // loan still syncs with a borrower attached.
      step.ok = true;
      step.skipped = true;
      step.reason = 'existing_entity_no_id_recoverable_via_loan';
    } else if (!step.ok) {
      return finalize(result, 'entity_failed');
    }
  } else if (!result.refs.baselineEntityId) {
    // Deploy 208/210 — log "skipped" entry with reason. With the new
    // fallback chain (long-app → client.companies), the only way
    // entityPayload comes back null is if NEITHER source has any LLC
    // data — meaning the loan vests in the individual.
    const reason = !entityPayload
      ? 'no_LLC_data_in_long_app_or_client_record'
      : 'already_synced';
    await logSkipped('entity', reason, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push({ step: 'entity', ok: true, skipped: true, mode: result.mode, reason });
  }

  // Step 2 — Guarantor 1.
  const g1Payload = buildPersonPayload(g1);
  if (g1Payload && !result.refs.baselineGuarantor1Id) {
    // Deploy 228.2 — wrap POST /borrower so a 500 from the address
    // validator (missing ZIP, geocoding fail, generic "Something went
    // wrong") falls back to a retry with Address_* stripped. The
    // borrower record gets created without an address; recovery audit
    // entry tells the LO to add it manually or fix and re-sync.
    const step = await postBorrowerWithAddressFallback('g1', g1Payload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    const g1Id = extractId(step.body, 'borrower');
    if (step.ok && g1Id) {
      result.refs.baselineGuarantor1Id = g1Id;
    } else if (!step.ok && isDuplicateEmailError(step)) {
      // Deploy 215/218 — 409 means existing borrower; GraphQL lookup
      // to recover their Id for Guarantor_Id attachment.
      const lookup = await findBorrowerByEmail(g1Payload.Email);
      if (lookup.id) {
        result.refs.baselineGuarantor1Id = lookup.id;
        step.ok = true;
        step.skipped = true;
        step.reason = 'existing_borrower_found_via_graphql:' + lookup.id;
        await writeLog({
          step: 'g1_recovery',
          mode: result.mode,
          ok: true,
          note: 'GraphQL found existing borrower by email: ' + lookup.id,
          baselineId: lookup.id,
          attempts: lookup.attempts,
          loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail,
        });
      } else {
        step.ok = true;
        step.skipped = true;
        step.reason = 'existing_borrower_by_email_graphql_lookup_failed';
        // Deploy 218 — include the per-attempt details so we can
        // diagnose. Each attempt has label / query / httpStatus / body
        // showing what Baseline returned. Click to expand the entry
        // in /baseline-log.html to see them.
        await writeLog({
          step: 'g1_recovery',
          mode: result.mode,
          ok: false,
          note: 'GraphQL lookup failed across all field-name and type-name variants. Per-attempt responses captured in `attempts` for diagnosis.',
          attempts: lookup.attempts,
          loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail,
        });
      }
    } else if (!step.ok) {
      return finalize(result, 'g1_failed');
    }
  } else if (!result.refs.baselineGuarantor1Id) {
    // Deploy 210 — with the client-record fallback, g1 should almost
    // never be null. If it is, the client record itself has no email,
    // which means something upstream is broken.
    const reason = !g1Payload
      ? (g1 && !g1.email ? 'g1_resolved_but_no_email' : 'no_borrower_data_anywhere_check_client_record')
      : 'already_synced';
    await logSkipped('g1', reason, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push({ step: 'g1', ok: true, skipped: true, mode: result.mode, reason });
  }

  // Step 3 — Guarantor 2 (if any).
  const g2Payload = buildPersonPayload(g2);
  if (g2Payload && !result.refs.baselineGuarantor2Id) {
    // Deploy 228.2 — same address-strip fallback as g1.
    const step = await postBorrowerWithAddressFallback('g2', g2Payload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    const g2Id = extractId(step.body, 'borrower');
    if (step.ok && g2Id) {
      result.refs.baselineGuarantor2Id = g2Id;
    } else if (!step.ok && isDuplicateEmailError(step)) {
      // Same GraphQL lookup pattern as g1 (Deploy 215/218).
      const lookup = await findBorrowerByEmail(g2Payload.Email);
      if (lookup.id) {
        result.refs.baselineGuarantor2Id = lookup.id;
        step.ok = true;
        step.skipped = true;
        step.reason = 'existing_borrower_found_via_graphql:' + lookup.id;
        await writeLog({
          step: 'g2_recovery',
          mode: result.mode,
          ok: true,
          note: 'GraphQL found existing borrower by email: ' + lookup.id,
          baselineId: lookup.id,
          attempts: lookup.attempts,
          loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail,
        });
      } else {
        step.ok = true;
        step.skipped = true;
        step.reason = 'existing_borrower_by_email_graphql_lookup_failed';
        await writeLog({
          step: 'g2_recovery',
          mode: result.mode,
          ok: false,
          note: 'GraphQL lookup failed across all field-name and type-name variants.',
          attempts: lookup.attempts,
          loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail,
        });
      }
    } else if (!step.ok) {
      return finalize(result, 'g2_failed');
    }
  }
  // Note: g2 is genuinely optional (single-borrower loans). No "skipped"
  // log when there's no g2 on the long-app — that's expected, not an
  // anomaly. Only log if g2 was present but unsendable (edge case).

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
    // Deploy 212 — pass the resolved g1/g2 (with fallbacks) into the
    // payload builder so it can use g1.email for auto-attach when an
    // explicit Guarantor_Id isn't available.
    const loanPayload = buildLoanPayload(loan, client, borrowerInfo, result.refs, g1, g2);
    const step = await runStep('loan', 'POST', '/loan', loanPayload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
    result.steps.push(step);
    // Deploy 211 — Baseline returns { loan: { Id: "SLA-..." } } wrapped.
    // extractId handles either shape. Fallback to the deterministic Id
    // we sent in case the response shape is unexpected.
    if (step.ok) {
      result.refs.baselineLoanId = extractId(step.body, 'loan') || deriveBaselineLoanId(loan);
    }
    if (!step.ok) return finalize(result, 'loan_failed');
  } else if (result.refs.baselineEntityId || result.refs.baselineGuarantor1Id) {
    // Deploy 216/220 — loan already exists in Baseline, but we may
    // have borrower refs that weren't available the first time. PATCH
    // the existing loan to set Borrower_Id / Guarantor_Id.
    //
    // Deploy 220 — modify-loan docs don't list Guarantor_* as settable,
    // and our last test showed PATCH with Guarantor_Id alone didn't
    // create the guarantees linkage. Also include Guarantor_Email so
    // Baseline can use email-based auto-attach (same documented
    // behavior as Borrower_Email; Guarantor_Email isn't documented
    // but the docs note "any field available in the loan can be set").
    const patchPayload = {};
    if (result.refs.baselineEntityId)     patchPayload.Borrower_Id  = result.refs.baselineEntityId;
    if (result.refs.baselineGuarantor1Id) patchPayload.Guarantor_Id = result.refs.baselineGuarantor1Id;
    if (g1 && g1.email) patchPayload.Guarantor_Email = String(g1.email).trim().toLowerCase();
    if (Object.keys(patchPayload).length > 0) {
      const patchPath = '/loan/' + encodeURIComponent(result.refs.baselineLoanId);
      const step = await runStep('loan_patch', 'PATCH', patchPath, patchPayload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
      result.steps.push(step);
      if (!step.ok) return finalize(result, 'loan_patch_failed');
    }

    // Deploy 220 — additionally probe GraphQL for mutation support so
    // we can fall back to insert_guarantees_one if PATCH doesn't wire
    // the guarantor. Logs the available mutation field names into the
    // audit so we can craft the right write call in Deploy 221.
    if (result.refs.baselineLoanId && result.refs.baselineGuarantor1Id) {
      await probeMutationSchema({ loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail, baselineLoanId: result.refs.baselineLoanId, baselineGuarantor1Id: result.refs.baselineGuarantor1Id });
    }
  }

  // Deploy 206 (Phase 2.7.2) — anomaly guard. If we reach here with zero
  // steps having run, something silently no-op'd: either every
  // build*Payload returned null (rare — would need no LLC AND no g1
  // email AND a pre-existing loan ref) OR the orchestrator was tricked
  // by stale refs into skipping everything (the original bug class
  // we've been chasing). Surface it loudly instead of returning a
  // misleading "synced" state.
  if (result.steps.length === 0) {
    return finalize(result, 'no_steps_ran');
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
// Deploy 229.2 — module-scope versions of helpers previously nested
// inside the orchestrator. They're used by postBorrowerWithAddressFallback
// + firePersonFollowUpPatches below, which live at module scope and
// therefore can't reach into the orchestrator's closure scope.

// Baseline POST responses are wrapped: { "borrower": { "Id": "...", ... } }
// or { "loan": { "Id": "SLA-...", ... } }. Unwraps either shape, with a
// forward-compat fallback to the unwrapped form.
function extractId(stepBody, key) {
  if (!stepBody) return undefined;
  if (stepBody[key] && stepBody[key].Id) return stepBody[key].Id;
  if (stepBody.Id) return stepBody.Id;
  return undefined;
}

// Baseline returns 409 + "That email address is already in use" (plain
// text in response.raw) when POST /borrower hits an existing email.
// Some platforms return 400 with the conflict in the body. Treated as
// soft-success by the orchestrator.
function isDuplicateEmailError(step) {
  if (!step || step.ok) return false;
  if (step.status === 409) return true;
  const text = step.body && (step.body.raw || step.body.error || step.body.message) || '';
  return /already in use|already exists|duplicate/i.test(String(text));
}

// Deploy 228.2 / 228.3 — Borrower-create with progressive-strip retry chain.
//
// Baseline's POST /borrower endpoint returns a generic HTTP 500
// "Something went wrong. Please contact support." when ANY field
// trips its validator — the body never says which. Without API docs,
// we walk down a chain of progressively-stripped payloads on 500.
// Each retry is logged as its own step so the audit log makes it
// obvious which payload finally got through (and therefore which
// stripped field was the culprit).
//
// Tiers (each only fires on the previous one's 500):
//   tier 1 — full payload (as-built)
//   tier 2 — no Address_* (Deploy 228.2)
//   tier 3 — no Address_* + no SSN, Other_Email, Num_Flipped
//            (custom/optional fields most likely to be format-rejected)
//   tier 4 — minimal: First_Name, Last_Name, Name, Email, Is_Company,
//            Phone, Date_Birth only. Everything else dropped.
//
// Whichever tier succeeds wins. If even tier 4 fails, the original
// (tier 1) step is returned so the LO sees the real error message.
async function postBorrowerWithAddressFallback(stepName, payload, mode, ctx) {
  // Deploy 229 — strip the _followUpFields bag (PATCH-eligible custom
  // fields attached by buildPersonPayload) before sending. We fire
  // them via per-field PATCH after the create succeeds.
  const followUps = payload && payload._followUpFields;
  if (followUps) {
    payload = Object.assign({}, payload);
    delete payload._followUpFields;
  }

  const t1 = await runStep(stepName, 'POST', '/borrower', payload, mode, ctx);
  if (t1.ok) {
    await firePersonFollowUpPatches(stepName, t1, followUps, mode, ctx);
    return t1;
  }
  if (t1.skipped) return t1;
  if (t1.status !== 500) return t1;

  // Tier 2 — strip address.
  const t2Payload = stripFields(payload, ['Address_Street1','Address_City','Address_State','Address_Zipcode','Address_Country']);
  const stripped2 = changedKeys(payload, t2Payload);
  const t2 = await runStep(stepName + '_no_address', 'POST', '/borrower', t2Payload, mode, ctx);
  if (t2.ok) {
    await recordRecovery(stepName, t2, t1, mode, ctx, 'address', stripped2);
    await firePersonFollowUpPatches(stepName, t2, followUps, mode, ctx);
    return t2;
  }
  if (t2.status !== 500) return t1;

  // Tier 3 — also drop Other_Email (the only remaining standard-schema
  // optional field beyond address). Custom fields aren't in the main
  // payload anymore (Deploy 229 — they're _followUpFields).
  const t3Payload = stripFields(t2Payload, ['Other_Email']);
  const stripped3 = changedKeys(payload, t3Payload);
  const t3 = await runStep(stepName + '_no_other_email', 'POST', '/borrower', t3Payload, mode, ctx);
  if (t3.ok) {
    await recordRecovery(stepName, t3, t1, mode, ctx, 'address + Other_Email', stripped3);
    await firePersonFollowUpPatches(stepName, t3, followUps, mode, ctx);
    return t3;
  }
  if (t3.status !== 500) return t1;

  // Tier 4 — bare minimum payload. First_Name, Last_Name, Name, Email,
  // Is_Company, Phone, Date_Birth only. If even this fails, the issue
  // is in Baseline (or in one of the truly-required fields).
  const KEEP = new Set(['First_Name','Last_Name','Name','Email','Is_Company','Phone','Date_Birth']);
  const t4Payload = {};
  Object.keys(payload).forEach((k) => { if (KEEP.has(k)) t4Payload[k] = payload[k]; });
  const stripped4 = changedKeys(payload, t4Payload);
  const t4 = await runStep(stepName + '_minimal', 'POST', '/borrower', t4Payload, mode, ctx);
  if (t4.ok) {
    await recordRecovery(stepName, t4, t1, mode, ctx, 'all optional fields', stripped4);
    await firePersonFollowUpPatches(stepName, t4, followUps, mode, ctx);
    return t4;
  }

  // Nothing worked — return the original failure so the LO sees the
  // real error context (not the noise from the retries).
  return t1;
}

// Deploy 229 — after a successful POST /borrower, fire a separate
// PATCH /borrower/{Id} call for each follow-up field individually.
// Per-field PATCH means a 500 on one field doesn't block the others,
// AND the audit log makes it obvious which custom fields Baseline
// accepts on Mike's per-customer config (no docs to go by).
//
// Deploy 229.1 — PATCH calls fire in PARALLEL via Promise.all and
// each is individually try/caught. Sequential firing pushed the
// orchestrator past Netlify's 10s function timeout when 4+ follow-up
// fields were present (5 PATCHes × ~600ms = 3s extra per borrower,
// and there are 2 borrowers + 1 entity worst-case). Concurrent
// firing brings total PATCH time down to the slowest single PATCH.
//
// Best-effort: per-PATCH failures are logged (each as its own audit
// entry) but never propagate up — the parent create step's success
// is what matters. The borrower record exists either way; the LO
// can fill missing values manually in Baseline UI.
async function firePersonFollowUpPatches(parentStep, createStep, followUps, mode, ctx) {
  if (!followUps || typeof followUps !== 'object') return;
  const borrowerId = extractId(createStep.body, 'borrower');
  if (!borrowerId) return;
  const keys = Object.keys(followUps).filter((k) => followUps[k] !== undefined && followUps[k] !== null && followUps[k] !== '');
  if (!keys.length) return;
  // Each PATCH wrapped in its own try/catch so one throwing doesn't
  // poison the Promise.all (which would crash the whole orchestrator
  // with no audit trail of which field misbehaved).
  await Promise.all(keys.map(async (fieldName) => {
    const patchBody = {};
    patchBody[fieldName] = followUps[fieldName];
    try {
      await runStep(
        parentStep + '_patch_' + fieldName,
        'PATCH',
        '/borrower/' + borrowerId,
        patchBody,
        mode,
        ctx,
      );
    } catch (e) {
      // runStep already catches inside baselineFetch, but defense in depth
      // in case writeLog or some other helper throws unexpectedly. Logged
      // so the LO sees what happened.
      try {
        await writeLog({
          step:   parentStep + '_patch_' + fieldName,
          mode,
          ok:     false,
          error:  'patch threw uncaught: ' + (e && e.message),
          ...ctx,
        });
      } catch (_) { /* swallow log failure */ }
    }
  }));
}

function stripFields(payload, keys) {
  const out = Object.assign({}, payload);
  keys.forEach((k) => { delete out[k]; });
  return out;
}

function changedKeys(before, after) {
  const out = [];
  Object.keys(before).forEach((k) => { if (!(k in after)) out.push(k); });
  return out;
}

async function recordRecovery(stepName, retryStep, originalStep, mode, ctx, label, strippedFields) {
  retryStep.recoveryNote = 'Initial POST /borrower returned 500. Retried with ' + label + ' stripped and succeeded. ' +
    'The Baseline borrower record was created WITHOUT these fields: ' + strippedFields.join(', ') + '. ' +
    'Edit the borrower in the Baseline UI to fill them in, or fix the upstream format issue and re-sync.';
  await writeLog({
    step: stepName + '_recovery',
    mode,
    ok: true,
    note: retryStep.recoveryNote,
    baselineId: extractId(retryStep.body, 'borrower') || null,
    strippedFields,
    originalStatus: originalStep.status,
    originalError: (originalStep.body && originalStep.body.error) || originalStep.raw || null,
    ...ctx,
  });
}

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
    // Deploy 204 (Phase 2.7 hotfix): use a clearly-marked __DRYRUN__
    // prefix for ALL dry-run fake IDs (including the loan step, which
    // previously used the real loanId — making dry-run-vs-real refs
    // indistinguishable). The orchestrator's isRealBaselineId() guard
    // filters these out so a future live retry actually runs the
    // step. The trigger endpoint additionally skips ref persistence
    // in dry-run mode so this branch should never write back to the
    // loan record anyway — defense in depth.
    const fakeId = '__DRYRUN__' + stepName + '_' + Math.random().toString(36).slice(2, 8);
    return { step: stepName, ok: true, mode, body: { Id: fakeId }, status: 0 };
  }

  // Live mode (Phase 2+) — actually call Baseline. The orchestrator
  // halts the sequence on the first failure (caller checks step.ok).
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
