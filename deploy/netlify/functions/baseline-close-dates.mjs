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

// Street-suffix abbreviations. Baseline tends to spell these out
// ("Main Street"); SLA-side via Google Places usually abbreviates
// ("Main St"). Without folding them to a canonical form the address
// lookup misses on otherwise-identical loans. Keys are the long form,
// values the abbreviation we fold TO.
const SUFFIX_MAP = {
  'street': 'st', 'st.': 'st',
  'avenue': 'ave', 'ave.': 'ave', 'av': 'ave',
  'road': 'rd', 'rd.': 'rd',
  'drive': 'dr', 'dr.': 'dr',
  'boulevard': 'blvd', 'blvd.': 'blvd',
  'lane': 'ln', 'ln.': 'ln',
  'court': 'ct', 'ct.': 'ct',
  'circle': 'cir', 'cir.': 'cir',
  'place': 'pl', 'pl.': 'pl',
  'terrace': 'ter', 'ter.': 'ter',
  'parkway': 'pkwy', 'pkwy.': 'pkwy',
  'highway': 'hwy', 'hwy.': 'hwy',
  'square': 'sq', 'sq.': 'sq',
  'trail': 'trl', 'trl.': 'trl',
  'way': 'way',
  'north': 'n', 'south': 's', 'east': 'e', 'west': 'w',
  'northeast': 'ne', 'northwest': 'nw',
  'southeast': 'se', 'southwest': 'sw',
};

// Normalize an address string for use as a lookup key.
// Lowercase, comma->space, whitespace-collapse, trim, then fold each
// token through SUFFIX_MAP so "Main Street" and "Main St" land at the
// same key. Also strips a trailing ", USA" because Google Places
// returns those sometimes.
function normAddr(s) {
  let v = String(s || '')
    .toLowerCase()
    .replace(/,?\s*usa\s*$/i, '')
    .replace(/[,.#]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const toks = v.split(' ').map((t) => SUFFIX_MAP[t] || t);
  return toks.join(' ');
}

// Extract just street number + first three "house" words. Strips
// directionals and suffixes so "1234 N Main St" and "1234 Main St" and
// "1234 Main Street #4B" all collide.
function streetKey(s) {
  const norm = normAddr(s);
  const m = norm.match(/^(\d+)\s+(.+)$/);
  if (!m) return '';
  let num = m[1];
  let rest = m[2]
    // Drop leading directional
    .replace(/^(n|s|e|w|ne|nw|se|sw)\b\s*/i, '')
    // Drop trailing apt/unit/suite markers
    .replace(/\b(apt|unit|suite|ste|fl|floor|bldg|#)\b.*/i, '')
    .trim();
  // Keep at most 3 words for the street name body
  const tail = rest.split(/\s+/).slice(0, 3).join(' ');
  return num + ' ' + tail;
}

// Build the full Baseline address string — Street1, City, State, Zip.
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

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  let all = [];
  try {
    all = await listMirroredLoans();
  } catch (e) {
    console.warn('baseline-close-dates: mirror read failed:', e && e.message);
    return json(200, { ok: true, count: 0, byAddress: {}, lastMirroredAt: '' });
  }

  const url = new URL(req.url);
  const debugAddr = url.searchParams.get('debug') || '';

  const byAddress = {};
  let lastMirroredAt = '';
  const debugMatches = [];
  for (const loan of all) {
    if (!loan) continue;
    if (loan._mirroredAt && loan._mirroredAt > lastMirroredAt) lastMirroredAt = loan._mirroredAt;
    const fullAddr = buildBaselineAddress(loan);
    const closeDate = pickCloseDate(loan);
    const status = String(loan.Status || '').toLowerCase().trim();
    const baselineId = String(loan.Id || '').trim();

    // Write THREE keys per loan so the frontend can match on whichever
    // normalization actually agrees with the SLA-side address. Tried in
    // priority order on the frontend (most-specific first):
    //   1. Full normalized address (street + city + state + zip)
    //   2. Street number + first 3 words of street name (drops dir + unit)
    //   3. Just the street1 portion normalized
    // If a duplicate address exists, prefer the entry with status !=
    // closed/cancelled so the active loan's close date wins.
    const keys = [
      normAddr(fullAddr),
      streetKey(loan.Address_Street1 || fullAddr),
      normAddr(loan.Address_Street1 || ''),
    ].filter((k, i, arr) => k && arr.indexOf(k) === i);

    // Debug mode — collect candidate loans whose address matches the
    // probe string (substring, case-insensitive) so Mike can verify
    // what's actually in the mirror without exposing the full payload.
    if (debugAddr) {
      const probe = String(debugAddr).toLowerCase();
      const fullLower = String(fullAddr).toLowerCase();
      const street1Lower = String(loan.Address_Street1 || '').toLowerCase();
      if (fullLower.includes(probe) || street1Lower.includes(probe)) {
        debugMatches.push({
          Id: baselineId,
          fullAddr,
          normalizedKeys: keys,
          status,
          dateFields: {
            Estimated_Close_Date:   loan.Estimated_Close_Date   || null,
            Expected_Close_Date:    loan.Expected_Close_Date    || null,
            Projected_Close_Date:   loan.Projected_Close_Date   || null,
            Anticipated_Close_Date: loan.Anticipated_Close_Date || null,
            Close_Date:             loan.Close_Date             || null,
            Origination:            loan.Origination            || null,
            Maturity:               loan.Maturity               || null,
            Created_Date:           loan.Created_Date           || null,
          },
          pickedCloseDate: closeDate,
        });
      }
    }

    if (!closeDate) continue;
    for (const key of keys) {
      const existing = byAddress[key];
      if (existing) {
        const existingActive = existing.status && existing.status !== 'closed' && existing.status !== 'cancelled';
        const incomingActive = status && status !== 'closed' && status !== 'cancelled';
        if (existingActive && !incomingActive) continue;
      }
      byAddress[key] = { closeDate, baselineId, status };
    }
  }

  const payload = {
    ok: true,
    count: Object.keys(byAddress).length,
    byAddress,
    lastMirroredAt,
  };
  if (debugAddr) payload.debug = { probe: debugAddr, matches: debugMatches };
  return json(200, payload);
}
