/**
 * _shared/address.mjs — Shared address-string parser.
 *
 * Deploy 228 — extracted from baseline-sync.mjs (Deploy 208) so other
 * endpoints can reuse it. The Long Loan App uses single-line Google
 * Places autocomplete for borrower home + LLC addresses, which leaves
 * the input value populated with the full formatted_address ("Street,
 * City, ST ZIP, USA") and no separate city/state/zip extraction. Any
 * code that later wants structured address components has to parse
 * the combined string — that's what this helper is for.
 *
 * Handles all the forms we've actually seen in production:
 *   "Street, City, STATE ZIP"        — state+zip combined
 *   "Street, City, STATE, ZIP"       — Google Places typical
 *   "Street, City, STATE"            — no zip
 *   "Street, City"                   — no state/zip
 *   "Street"                         — single component
 * Any of the above may be followed by a trailing "USA" / "US" /
 * "United States" which we strip before parsing.
 *
 * Returns { street1, city, state, zip } — string fields, missing
 * pieces are empty strings (never undefined).
 */

export function parseAddress(s) {
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
    out.state = stateZip[1];
    out.zip   = stateZip[2];
    if (parts.length >= 3) out.city = parts.slice(1, parts.length - 1).join(', ');
  } else if (zipOnly && parts.length >= 3) {
    out.zip = zipOnly[1];
    const secondLast = parts[parts.length - 2];
    if (/^[A-Z]{2}$/.test(secondLast)) {
      out.state = secondLast;
      if (parts.length >= 4) out.city = parts.slice(1, parts.length - 2).join(', ');
    } else {
      out.city = parts.slice(1, parts.length - 1).join(', ');
    }
  } else if (stateOnly && parts.length >= 2) {
    out.state = stateOnly[1];
    if (parts.length >= 3) out.city = parts.slice(1, parts.length - 1).join(', ');
  } else {
    out.city = parts.slice(1).join(', ');
  }
  return out;
}

/**
 * Given an object that has SOME of { address, city, state, zip } from
 * a long-app guarantor or company record, fill in any blanks from
 * parsing the `address` field. Mutates and returns the input.
 *
 * No-ops when separate fields are already populated.
 */
export function fillAddressBlanks(obj) {
  if (!obj) return obj;
  const haveCity  = !!String(obj.city  || '').trim();
  const haveState = !!String(obj.state || obj.addrState || '').trim();
  const haveZip   = !!String(obj.zip   || '').trim();
  if (haveCity && haveState && haveZip) return obj;
  const parsed = parseAddress(obj.address || '');
  // Only fill blanks — never overwrite an explicit value the borrower
  // (or the form) provided separately.
  if (!haveCity  && parsed.city)  obj.city  = parsed.city;
  if (!haveState && parsed.state) {
    // Some company records use addrState instead of state — both are
    // valid; we update the same field that already exists if present,
    // else default to state.
    if ('addrState' in obj || (obj.state === undefined && obj.addrState !== undefined)) {
      obj.addrState = parsed.state;
    } else {
      obj.state = parsed.state;
    }
  }
  if (!haveZip   && parsed.zip)   obj.zip   = parsed.zip;
  return obj;
}
