/**
 * baseline-close-dates.mjs — GET /api/baseline-close-dates
 *
 * Deploy 236.61. Authed (any LO) lookup that returns a map of normalized
 * property address -> {closeDate, baselineId, status} drawn from the
 * Baseline mirror. The Pipeline and Loan Details pages use this to
 * surface Baseline's Estimated_Close_Date on tiles and headers instead
 * of (or as a refresher for) the locally-saved fundingDate.
 *
 * Why a new endpoint vs. relaxing baseline-mirror-list:
 *   - baseline-mirror-list returns Loan_Amount, Status, all custom fields,
 *     etc. It's admin-only by design. Opening it up to all authed users
 *     would leak the full Baseline record for every loan SLA has on file.
 *   - LOs only need address -> closeDate for the pipeline display. This
 *     endpoint returns exactly that minimum.
 *
 * Returns: {
 *   ok: true,
 *   count: <number of address entries>,
 *   byAddress: {
 *     "<normalized address>": {
 *       closeDate: "YYYY-MM-DD" | string,
 *       baselineId: "SLA-..." | "",
 *       status: "lead" | "in processing" | etc. (lowercase)
 *     }
 *   },
 *   lastMirroredAt: "ISO timestamp" | ""
 * }
 *
 * Address normalization: lowercased, whitespace-collapsed, no commas.
 * Matches the same normalizer used in Pipeline + Loan Details so the
 * frontend lookup is straight-equality.
 */
import {
  handleOptions, json, requireAuth,
} from './_shared/auth.mjs';
import { listMirroredLoans } from './_shared/baseline-mirror.mjs';

// Normalize an address string for use as a lookup key. Mirrors the
// normalizer used on Pipeline + Loan Details: lowercase, collapse all
// whitespace runs to single spaces, strip commas, trim.
function normAddr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/,/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Build the full address string Baseline-side as Street1, City, State,
// Zip — same shape the loan record's `address` field uses on the SLA
// side. Either part can be missing; we only need the combined string
// to normalize reliably.
function buildBaselineAddress(loan) {
  if (!loan) return '';
  var parts = [];
  if (loan.Address_Street1) parts.push(loan.Address_Street1);
  if (loan.Address_City)    parts.push(loan.Address_City);
  if (loan.Address_State)   parts.push(loan.Address_State);
  if (loan.Address_Zipcode) parts.push(loan.Address_Zipcode);
  return parts.join(', ');
}

// Pick the most useful close-date value from a Baseline loan record.
// Estimated_Close_Date is the field LOs maintain manually in Baseline
// for "when do we think this funds"; Origination is set when it
// actually funds. Prefer the estimate while the loan's still active;
// fall back to Origination for already-closed loans where the
// estimate may have been cleared.
function pickCloseDate(loan) {
  if (!loan) return '';
  return String(
    loan.Estimated_Close_Date
    || loan.Expected_Close_Date
    || loan.Projected_Close_Date
    || loan.Anticipated_Close_Date
    || loan.Close_Date
    || loan.Origination
    || ''
  ).trim();
}

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('baseline-close-dates error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  let all = [];
  try {
    all = await listMirroredLoans();
  } catch (e) {
    console.warn('baseline-close-dates: mirror read failed:', e && e.message);
    return json(200, { ok: true, count: 0, byAddress: {}, lastMirroredAt: '' });
  }

  const byAddress = {};
  let lastMirroredAt = '';
  for (const loan of all) {
    if (!loan) continue;
    if (loan._mirroredAt && loan._mirroredAt > lastMirroredAt) lastMirroredAt = loan._mirroredAt;
    const addr = buildBaselineAddress(loan);
    const key = normAddr(addr);
    if (!key) continue;
    const closeDate = pickCloseDate(loan);
    if (!closeDate) continue;
    const status = String(loan.Status || '').toLowerCase().trim();
    const baselineId = String(loan.Id || '').trim();
    // If a duplicate address exists (rare — same property funded twice),
    // prefer the entry with a status other than already-closed so the
    // active loan's close date wins. Otherwise the later iteration wins.
    const existing = byAddress[key];
    if (existing) {
      const existingActive = existing.status && existing.status !== 'closed' && existing.status !== 'cancelled';
      const incomingActive = status && status !== 'closed' && status !== 'cancelled';
      if (existingActive && !incomingActive) continue;
    }
    byAddress[key] = { closeDate, baselineId, status };
  }

  return json(200, {
    ok: true,
    count: Object.keys(byAddress).length,
    byAddress,
    lastMirroredAt,
  });
}
