/**
 * baseline-enrich-migrate.mjs — POST /api/baseline-enrich-migrate
 *
 * Deploy 236.652 — bulk "manual migration" of the Baseline import loans. For each
 * `l_baseline_*` loan currently owned by the synthetic import account, this:
 *   1. reads the already-synced Baseline MIRROR record (baseline_loans_mirror),
 *   2. maps its Terms + Collateral onto the SLA loan (every field we can),
 *   3. reassigns the loan from baseline-migration@sla-import.local → Chance,
 *      the PG-first / drift-safe way (writeClient + delete old blob + native link,
 *      NOT the raw blob-move of users-reassign which drifts PG).
 *
 * The assigned PROCESSOR is intentionally NOT set here — Baseline's mirror payload
 * has no processor/officer field (Account_Owners are all "Subscriber" = capital
 * owners), so it can't be derived from the data. Handled separately.
 *
 * Body: { dryRun (default TRUE), offset (default 0), limit (default 25) }
 *   - dryRun: computes + returns per-loan `changes` without writing.
 *   - real  : writes + reassigns. Processed loans leave the import owner, so for a
 *             real run call repeatedly with offset:0 until `remaining` hits 0.
 * Auth: admin / super_admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { IMPORT_OWNER_KEY, setNativeLink } from './_shared/baseline-upsert.mjs';
import { loadMirroredLoan } from './_shared/baseline-mirror.mjs';
import { writeClient } from './_shared/client-write.mjs';

const DEST_EMAIL = 'chance@slacapital.com';
const DEST_KEY = keySafe(normalizeEmail(DEST_EMAIL));
const DEFAULT_LIMIT = 25;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-enrich-migrate error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

// ── mapping helpers ────────────────────────────────────────────────
function _num(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/[$,]/g, ''));
  return isFinite(n) ? n : null;
}
function _str(v) { return (v == null) ? '' : String(v).trim(); }
// Baseline dates arrive as "MM/DD/YYYY" or ISO → normalize to YYYY-MM-DD.
function _date(v) {
  const s = _str(v);
  if (!s) return '';
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + '-' + ('0' + m[1]).slice(-2) + '-' + ('0' + m[2]).slice(-2);
  return '';
}
// Annual $ → monthly, rounded to 2dp (Baseline stores taxes/insurance/HOA annually).
function _monthly(v) {
  const n = _num(v);
  if (n == null) return null;
  return String(Math.round((n / 12) * 100) / 100);
}
function _titleCase(v) {
  return _str(v).toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}
// "5,4,3,2,1" → "54321"; "3,2,1" → "321"; none → "none".
function _prepay(v) {
  const s = _str(v).toLowerCase();
  if (!s || /none|no /.test(s)) return 'none';
  const digits = s.replace(/[^0-9]/g, '');
  return digits || 'none';
}
function _toolType(product, rateDec) {
  const p = _str(product).toLowerCase();
  if (/construction|ground.?up|\bguc\b|new build/.test(p)) return 'guc';
  if (/dscr|rental/.test(p)) return 'dscr';
  if (/rtl|bridge|fix.?(and|&|-)?.?flip|flip|rehab|colchis|hard.?money|transactional/.test(p)) return 'rtl';
  // fallback: RTL prices higher than DSCR. rate is a decimal (0.07 = 7%).
  const r = _num(rateDec);
  if (r != null) return r >= 0.09 ? 'rtl' : 'dscr';
  return 'dscr';
}
function _isIO(amortType) {
  const s = _str(amortType).toLowerCase();
  if (/interest[-\s]?only/.test(s)) return true;
  if (/amortiz|principal|p ?& ?i/.test(s)) return false;
  return null; // unknown → leave loan.isIO untouched
}
function _propType(v) {
  const s = _str(v).toLowerCase();
  if (/single|sfr|1 unit/.test(s)) return 'sfr';
  if (/2.?4|two.?to.?four|duplex|triplex|fourplex/.test(s)) return '2-4';
  if (/non.?warrant/.test(s)) return 'nw_condo';
  if (/condo/.test(s)) return 'condo';
  if (/portfolio/.test(s)) return 'portfolio';
  if (/multi|5\+|apartment/.test(s)) return 'multi';
  return '';
}
function _rentalType(v) {
  const s = _str(v).toLowerCase();
  if (/short|airbnb|str/.test(s)) return 'str';
  if (/mid|mtr/.test(s)) return 'mtr';
  if (/long|ltr|6\+/.test(s)) return 'ltr';
  return '';
}

// Build the field-updates from a mirror record. Only returns keys we can
// confidently map + that have a value (so we never blank existing data).
function mapMirrorToFields(m) {
  const f = {};
  const set = (k, v) => { if (v !== '' && v != null) f[k] = v; };

  // Terms
  const loanAmt = _num(m.Loan_Amount);           if (loanAmt != null) f.loanAmt = loanAmt;
  const rate = _num(m.Rate);                      if (rate != null)    f.rate = rate; // Baseline decimal (0.07005)
  set('points', _str(m.Origination_Points));
  set('tpoPremium', _str(m.TPO_Premium));
  const term = _num(m.Amortization_Term);         if (term != null)    f.loanTerm = String(term);
  const io = _isIO(m.Amortization_Type);          if (io != null)      f.isIO = io;
  set('prepay', _prepay(m.Prepayment_Penalty));
  set('originationDate', _date(m.Origination));
  set('fundingDate', _date(m.Closing_Date || m.Origination));
  set('maturityDate', _date(m.Maturity));
  set('firstPaymentDate', _date(m.First_Payment));
  set('lienPosition', _str(m.Lien_Position).toLowerCase());
  set('toolType', _toolType(m.Product, m.Rate));

  // Valuation
  const asis = _num(m.Address_As_Is_Value);       if (asis != null) { f.propValue = String(asis); f.aivBpo = String(asis); }
  const arvB = _num(m.Address_ARV_Borrower);      if (arvB != null)    f.arv = String(arvB);
  const arvL = _num(m.Address_ARV_Lender);        if (arvL != null)    f.arvBpo = String(arvL);
  const debt = _num(m.Address_Existing_Debt);     if (debt != null)    f.currentLoanAmt = String(debt);
  const pp = _num(m.Address_Purchase_Price);      if (pp != null)      f.purchasePrice = String(pp);
  const rehab = _num(m.Address_Total_Rehab);      if (rehab != null)   f.rehabBudget = String(rehab);

  // Property
  const beds = _num(m.Address_Beds);              if (beds != null)    f.bedrooms = String(beds);
  const baths = _num(m.Address_Baths);            if (baths != null)   f.bathrooms = String(baths);
  const gla = _num(m.Address_Gross_Livable_Area_GLA); if (gla != null) f.sqft = String(gla);
  const lot = _num(m.Address_Lot_Size_Sqft);      if (lot != null)     f.lotSize = String(lot);
  const stories = _num(m.Address_Floors_Stories); if (stories != null) f.stories = String(stories);
  const yr = _num(m.Address_Year_Built);          if (yr != null)      f.yearBuilt = String(yr);
  set('propertyCounty', _titleCase(m.Address_County));
  set('propType', _propType(m.Address_Property_Type));
  set('rentalType', _rentalType(m.Address_Type_Of_Rental));
  set('purchaseDate', _date(m.Address_Purchase_Date));
  set('floodZone', _str(m.Address_Flood_Zone || m.Flood_Zone));

  // Carrying costs (Baseline annual → SLA monthly)
  set('monthlyTaxes', _monthly(m.Address_Property_Taxes));
  set('monthlyInsurance', _monthly(m.Address_Property_Insurance));
  set('monthlyHoa', _monthly(m.Address_HOA_Fees));
  const rent = _num(m.Address_Actual_Rent);       if (rent != null)    f.monthlyRent = String(rent); // Baseline actual rent is monthly

  return f;
}

// Apply the mapped fields to the loan, honoring LO pricing overrides so we never
// clobber a hand-set amount/rate/points.
function applyFields(loan, f) {
  const applied = {};
  Object.keys(f).forEach((k) => {
    if (k === 'loanAmt' && loan.loanAmtLocked) return;
    if (k === 'rate' && loan._rateOverride) return;
    if (k === 'points' && loan._pointsOverride) return;
    loan[k] = f[k];
    applied[k] = f[k];
  });
  return applied;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false && body.dryRun !== 'false' && body.dryRun !== 0;
  const offset = Math.max(0, parseInt(body.offset || 0, 10) || 0);
  const limit = Math.max(1, Math.min(50, parseInt(body.limit || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT));
  const selfEmail = normalizeEmail(user.email);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // List every client blob under the synthetic import owner.
  let keys = [];
  try {
    const listed = await clientsStore.list({ prefix: IMPORT_OWNER_KEY + '/' });
    keys = (listed && listed.blobs ? listed.blobs : []).map((b) => b.key);
  } catch (e) {
    return json(500, { error: 'Failed to list import-owner clients: ' + (e.message || 'unknown') });
  }
  const total = keys.length;
  const slice = keys.slice(offset, offset + limit);

  const counts = { enriched: 0, reassigned: 0, noMirror: 0, noLoan: 0, errors: 0 };
  const samples = [];

  for (const key of slice) {
    let client;
    try { client = await clientsStore.get(key, { type: 'json' }); }
    catch (e) { counts.errors++; continue; }
    if (!client || !Array.isArray(client.loans) || !client.loans.length) { counts.noLoan++; continue; }

    // These import clients wrap exactly one l_baseline_ loan.
    const loan = client.loans.find((l) => l && String(l.id || '').indexOf('l_baseline_') === 0) || client.loans[0];
    if (!loan) { counts.noLoan++; continue; }
    const extId = loan.slaDisplayId || String(client.id || '').replace(/^c_baseline_/, '') || String(loan.id || '').replace(/^l_baseline_/, '');

    let mirror = null;
    try { mirror = await loadMirroredLoan(extId); } catch (e) {}
    if (!mirror) { counts.noMirror++; samples.length < 40 && samples.push({ extId, addr: loan.address, action: 'skip', reason: 'no mirror record' }); continue; }

    const fields = mapMirrorToFields(mirror);
    const before = { toolType: loan.toolType, loanTerm: loan.loanTerm, propValue: loan.propValue, monthlyTaxes: loan.monthlyTaxes };

    if (dryRun) {
      if (samples.length < 40) samples.push({
        extId, addr: loan.address, clientId: client.id, loanId: loan.id,
        currentOwner: IMPORT_OWNER_KEY, willReassignTo: DEST_EMAIL,
        before, willSet: fields,
      });
      counts.enriched++; counts.reassigned++;
      continue;
    }

    // ── real write ──────────────────────────────────────────────────
    try {
      applyFields(loan, fields);
      loan.updatedAt = new Date().toISOString();
      loan._migratedFromBaseline = { at: loan.updatedAt, by: selfEmail, extId };

      // PG-first reassign to Chance (keep client id; owner flips in place).
      await writeClient(DEST_KEY, client, { clientsStore });
      // Drop the stale blob under the import owner (same PG id was just re-owned;
      // do NOT deleteClientStrict — that would erase the row we just wrote).
      try { await clientsStore.delete(key); } catch (e) {}
      // Repoint the Baseline native link so the 30-min migrate cron routes future
      // syncs to Chance instead of re-forking an import copy.
      try { await setNativeLink(extId, { ownerKey: DEST_KEY, clientId: client.id, loanId: loan.id, source: 'bulk-enrich-migrate' }); } catch (e) {}

      counts.enriched++; counts.reassigned++;
      if (samples.length < 40) samples.push({ extId, addr: loan.address, action: 'enriched+reassigned', setCount: Object.keys(fields).length });
    } catch (e) {
      counts.errors++;
      if (samples.length < 40) samples.push({ extId, addr: loan.address, action: 'error', error: (e && e.message) || 'unknown' });
    }
  }

  const nextOffset = dryRun ? (offset + slice.length) : 0;
  const remaining = dryRun ? Math.max(0, total - nextOffset) : Math.max(0, total - counts.enriched - counts.errors);
  const done = dryRun ? (nextOffset >= total) : (remaining <= 0 || slice.length === 0);

  return json(200, {
    ok: true, dryRun, total, processedThisCall: slice.length,
    offset, limit, nextOffset, remaining, done,
    dest: DEST_EMAIL, counts, samples,
  });
}
