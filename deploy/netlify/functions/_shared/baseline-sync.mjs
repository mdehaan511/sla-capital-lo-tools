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
    // auto-fire from approval.
    phase: 'phase-2.8.9-graphql-diagnostics',
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

  const payload = {
    Is_Company:      true,
    Name:            ent.name,
    Address_Street1: ent.street1,
    Address_City:    ent.city,
    Address_State:   expandState(ent.state),
    Address_Country: 'United States',
  };

  // Phase 2.6 — Tax_ID (EIN) custom field. XX-XXXXXXX format from the
  // long-app or client.companies entry.
  if (ent.ein) payload.Tax_ID = String(ent.ein).trim();

  // Strip blanks (defensive — same pattern as buildPersonPayload).
  Object.keys(payload).forEach((k) => {
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

  const payload = {
    Is_Company:      false,
    First_Name:      g.firstName || '',
    Last_Name:       g.lastName || '',
    Name:            (g.firstName || '') + (g.lastName ? ' ' + g.lastName : ''),
    Email:           String(g.email || '').trim().toLowerCase(),
    Other_Email:     String(g.email || '').trim().toLowerCase(), // matched dump
    Phone:           fmtPhone(g.phone),
    Date_Birth:      g.dob || undefined, // expected YYYY-MM-DD
    Address_Street1: g.address || '',
    Address_City:    g.city || '',
    Address_State:   expandState(g.state || ''),
    Address_Country: 'United States',
    Credit_Score:    g.fico ? parseInt(g.fico, 10) : undefined,
    // Deploy 211 — moved from loan-level Guarantor_* fields to the
    // person-borrower record. Baseline denormalizes onto the loan
    // automatically when the borrower is linked. Field names are best
    // guesses based on Baseline's naming convention (the dump showed
    // Borrower_/Guarantor_ prefixes on the loan-level versions; the
    // borrower-record fields most likely drop the prefix).
    Citizenship:     mapCitizenship(g.usCitizen),
    Marital_Status:  mapMaritalStatus(g.marital),
    Num_Flipped:     g.flips != null && g.flips !== '' ? parseInt(g.flips, 10) : undefined,
  };

  // Social_Security_Number is the customer's custom field name (per
  // user, confirmed Phase 2.6). Only attached if we successfully
  // decrypted; we never send "" since that would overwrite a real
  // value in Baseline with empty.
  if (ssn) payload.Social_Security_Number = ssn;

  // Strip undefined/empty so we don't overwrite existing Baseline data
  // with blanks on PATCH-like upserts.
  Object.keys(payload).forEach((k) => {
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

  // Try a wider range of patterns. GraphQL conventions vary:
  //   - Type name: borrowers (plural — Hasura-style) or borrower (singular)
  //   - Field name: Email (PascalCase, matching REST) or email (lowercase)
  //   - Filter: where: { field: { _eq: X } } (Hasura/PostgREST style) or
  //             direct args: (Email: "X")
  // Stop at the first query that returns a non-empty result.
  const queries = [
    // Hasura-style where with PascalCase field
    { label: 'plural+where+Email',  query: '{ borrowers(where: { Email: { _eq: "' + cleanEmail + '" } }) { Id Email } }' },
    // Hasura-style where with lowercase field
    { label: 'plural+where+email',  query: '{ borrowers(where: { email: { _eq: "' + cleanEmail + '" } }) { Id email } }' },
    // Singular type
    { label: 'singular+where+Email', query: '{ borrower(where: { Email: { _eq: "' + cleanEmail + '" } }) { Id Email } }' },
    { label: 'singular+where+email', query: '{ borrower(where: { email: { _eq: "' + cleanEmail + '" } }) { Id email } }' },
    // Direct args (no `where`)
    { label: 'plural+args+Email',   query: '{ borrowers(Email: "' + cleanEmail + '") { Id } }' },
    { label: 'plural+args+email',   query: '{ borrowers(email: "' + cleanEmail + '") { Id } }' },
    // Schema introspection — last resort. Reveals the actual type names
    // so we can fix the helper. Doesn't return borrower data, just
    // discovery info.
    { label: 'introspect',          query: '{ __schema { queryType { fields { name args { name type { name kind } } } } } }' },
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
      // For the introspection query, just record the result and stop
      // searching — we won't get borrower data from it.
      if (q.label === 'introspect') {
        out.attempts.push(attempt);
        continue;
      }
      // GraphQL errors → try next query
      if (attempt.body.errors && attempt.body.errors.length) {
        out.attempts.push(attempt);
        continue;
      }
      // Look for borrower data in the response
      const data = attempt.body.data || {};
      const candidates = data.borrowers || data.borrower;
      const list = Array.isArray(candidates) ? candidates : (candidates ? [candidates] : []);
      if (list.length > 0) {
        out.id = list[0].Id || list[0].id || null;
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

  // Deploy 211 — Baseline POST responses are wrapped:
  //   { "borrower": { "Id": "15633071", ... } }
  //   { "loan":     { "Id": "SLA-...",   ... } }
  // Pre-Deploy-211 we read step.body.Id (always undefined) so refs
  // never populated and the loan was created with no Borrower_Id /
  // Guarantor_Id — orphaned borrowers + orphaned loan. Helper unwraps
  // either shape, falling back to the unwrapped form for forward
  // compatibility if Baseline ever drops the wrapper.
  function extractId(stepBody, key) {
    if (!stepBody) return undefined;
    if (stepBody[key] && stepBody[key].Id) return stepBody[key].Id;
    if (stepBody.Id) return stepBody.Id;
    return undefined;
  }

  // Deploy 212 — Baseline returns 409 + "That email address is already
  // in use" (plain text, captured as response.raw) when POST /borrower
  // hits an existing email. Normal in production for repeat borrowers;
  // also happens during testing. Treated as soft-success — the loan
  // POST will attach via Borrower_Email/Guarantor_Email instead.
  function isDuplicateEmailError(step) {
    if (!step || step.ok) return false;
    if (step.status === 409) return true;
    // Some platforms return 400 with a body indicating the conflict.
    const text = step.body && (step.body.raw || step.body.error || step.body.message) || '';
    return /already in use|already exists|duplicate/i.test(String(text));
  }

  // Step 1 — entity (LLC). Skip if no LLC OR if already synced.
  const entityPayload = buildEntityPayload(loan, client, borrowerInfo);
  if (entityPayload && !result.refs.baselineEntityId) {
    const step = await runStep('entity', 'POST', '/borrower', entityPayload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
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
    const step = await runStep('g1', 'POST', '/borrower', g1Payload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
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
    const step = await runStep('g2', 'POST', '/borrower', g2Payload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
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
    // Deploy 216 (Phase 2.8.7) — loan already exists in Baseline, but
    // we may have borrower refs that weren't available the first time
    // (e.g. g1 was a 409 originally and we just resolved their Id via
    // GraphQL on this retry). PATCH the existing loan to set the
    // Borrower_Id / Guarantor_Id so the loan finally has its borrowers
    // attached.
    //
    // Idempotent — if Baseline already has these set on the loan, PATCH
    // with the same values is a no-op. If the entity Id matches but
    // Guarantor_Id was empty, this fills it in.
    const patchPayload = {};
    if (result.refs.baselineEntityId)     patchPayload.Borrower_Id  = result.refs.baselineEntityId;
    if (result.refs.baselineGuarantor1Id) patchPayload.Guarantor_Id = result.refs.baselineGuarantor1Id;
    if (Object.keys(patchPayload).length > 0) {
      const patchPath = '/loan/' + encodeURIComponent(result.refs.baselineLoanId);
      const step = await runStep('loan_patch', 'PATCH', patchPath, patchPayload, result.mode, { loanId: loan.id, clientId: client.id, ownerKey: ctx.ownerKey, triggerUserEmail: ctx.triggerUserEmail });
      result.steps.push(step);
      if (!step.ok) return finalize(result, 'loan_patch_failed');
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
