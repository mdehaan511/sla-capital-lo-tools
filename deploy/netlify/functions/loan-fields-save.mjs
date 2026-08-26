/**
 * loan-fields-save.mjs — POST /api/loan-fields-save
 *
 * Deploy 236.639 — the save path for the Loan Details "Loan Terms" and
 * "Property / Collateral" sections (the Baseline-migration detail entry). Sets
 * whitelisted loan fields; strict PG-first writeClient. Deliberately does NOT
 * touch loanAmt / rate / points — those have their own override-aware editors
 * (FIN_EDITABLE + loanAmtLocked / _rateOverride / _pointsOverride); the Terms
 * section shows them read-through and links to the Financials editor.
 *
 * Field names REUSE what the sizer / long app already store — no duplicates:
 *   - Terms:    loanTerm, loanType, isIO, prepay, originationDate, maturityDate,
 *               firstPaymentDate, lienPosition, tpoPremium, holdback,
 *               initialAdvance, downPayment
 *   - Valuation: purchasePrice, propValue (as-is), aivBpo, arv (ARV borrower),
 *               arvBpo, currentLoanAmt (existing debt), rehabBudget
 *   - Property: propType, rentalType, bedrooms, bathrooms, sqft, numUnits,
 *               lotSize, yearBuilt, stories, propertyCounty, floodZone, purchaseDate
 *   - Carrying: monthlyTaxes, monthlyInsurance, monthlyHoa (SLA stores MONTHLY;
 *               the UI toggles monthly/annual and converts before POST)
 *
 * Body: { clientId, loanId, owner?, fields: { <whitelisted>: value } }
 * Auth: any authenticated user may edit their OWN loan; a cross-owner
 * override (body.owner ≠ self) requires processor/admin (Deploy 236.641).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

const FIELDS = {
  // Terms
  loanTerm: 1, loanType: 1, isIO: 1, prepay: 1, originationDate: 1, maturityDate: 1,
  firstPaymentDate: 1, lienPosition: 1, tpoPremium: 1, holdback: 1, initialAdvance: 1, downPayment: 1,
  // Deploy 236.651 — toolType (product) so the Baseline→SLA migration can stamp
  // RTL/DSCR/GUC onto imported l_baseline_* records that came in with it blank.
  // No Loan-Details UI sends this; it's set programmatically by the migration.
  toolType: 1,
  // Deploy 236.641 — Loan-tab reorg folded these into the Loan Terms box
  loanPurpose: 1, fundingDate: 1, projectDescription: 1,
  // Deploy 236.672 — Funding Plan box (was saving via the brittle Clients.upsert,
  // which dropped these — now saved deterministically here). tpo = the manual TPO
  // premium (points) the Funding Plan reads; buyRate = RTL yield.
  fundingSource: 1, fundingSourceOther: 1, investorId: 1, investorName: 1, tpo: 1, buyRate: 1,
  // Valuation
  purchasePrice: 1, propValue: 1, aivBpo: 1, arv: 1, arvBpo: 1, currentLoanAmt: 1, rehabBudget: 1,
  // Property
  propType: 1, rentalType: 1, bedrooms: 1, bathrooms: 1, sqft: 1, numUnits: 1, lotSize: 1,
  yearBuilt: 1, stories: 1, propertyCounty: 1, floodZone: 1, purchaseDate: 1,
  // Carrying costs (monthly canonical)
  monthlyTaxes: 1, monthlyInsurance: 1, monthlyHoa: 1,
  // Deploy 236.655 — Portfolio (multiple properties). These need special
  // handling in the apply loop (boolean / number / array, not a plain string).
  isPortfolio: 1, propertyCount: 1, properties: 1,
  // Deploy 236.691 — reprice-as-portfolio flag (boolean).
  needsRepricePortfolio: 1,
  // Deploy 236.713 — Dutch/Non-Dutch interest structure, editable in the Loan
  // Terms box (RTL/GUC). Drives the Closed Loans Draws tab's computed UPB.
  dutchInterest: 1,
  // Deploy 236.750 — MF (5+) operating-statement fields, edited in the Loan
  // Details MF Operating Statement box; feed the MF sizer's NCF DSCR.
  unitsOccupied: 1, otherIncomeMo: 1, vacancyPct: 1,
  opexTaxes: 1, opexInsurance: 1, opexFlood: 1, opexUtilities: 1, opexRepairs: 1,
  opexMgmt: 1, opexGA: 1, opexHOA: 1, opexTurnover: 1, opexLandscaping: 1, opexOther: 1,
};

function _truthy(v) {
  return v === true || v === 1 || v === 'true' || v === 'yes' || v === '1' || v === 'interest_only' || v === 'io';
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-fields-save error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId, loanId = body.loanId, fields = body.fields;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (!fields || typeof fields !== 'object') return json(400, { error: 'fields object required' });

  // Deploy 236.641 — these fields now include the everyday Loan-tab inputs
  // (Loan Purpose / Closing Date / Description), so an OWNER may edit their
  // OWN loan; only a cross-owner override requires processor/admin (the
  // standard CLAUDE.md owner-override pattern), no longer a blanket staff gate.
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && normalizeEmail(body.owner) !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires processor or admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  let client;
  try { client = await clientsStore.get(clientKey, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read client: ' + (e.message || 'unknown') }); }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client' });
  const loan = client.loans[idx];

  const applied = {};
  Object.keys(fields).forEach((k) => {
    if (!FIELDS[k]) return;
    if (k === 'isIO') { loan.isIO = _truthy(fields[k]); applied[k] = loan.isIO; return; }
    // Deploy 236.651 — toolType is the loan's product; only accept the three
    // valid values so a migration typo can't corrupt it into a bad product.
    if (k === 'toolType') {
      const tt = String(fields[k] == null ? '' : fields[k]).trim().toLowerCase();
      if (tt !== 'rtl' && tt !== 'dscr' && tt !== 'guc') return;
      loan.toolType = tt; applied[k] = tt; return;
    }
    // Deploy 236.713 — interest structure: only the two valid enum values.
    if (k === 'dutchInterest') {
      const di = String(fields[k] == null ? '' : fields[k]).trim().toLowerCase();
      if (di !== 'dutch' && di !== 'non_dutch') return;
      loan.dutchInterest = di; applied[k] = di; return;
    }
    // Deploy 236.655 — Portfolio: boolean flag, integer count, sanitized array.
    if (k === 'isPortfolio') { loan.isPortfolio = _truthy(fields[k]); applied[k] = loan.isPortfolio; return; }
    // Deploy 236.691 — reprice-as-portfolio flag (boolean; can be cleared to false).
    if (k === 'needsRepricePortfolio') { loan.needsRepricePortfolio = _truthy(fields[k]); applied[k] = loan.needsRepricePortfolio; return; }
    if (k === 'propertyCount') {
      let pc = parseInt(fields[k], 10);
      if (!isFinite(pc) || pc < 0) pc = 0;
      if (pc > 10) pc = 10;
      loan.propertyCount = pc; applied[k] = pc; return;
    }
    if (k === 'properties') {
      const arr = Array.isArray(fields[k]) ? fields[k] : [];
      loan.properties = arr.slice(0, 10).map((p) => {
        p = (p && typeof p === 'object') ? p : {};
        return {
          address:          String(p.address || '').slice(0, 300),
          propType:         String(p.propType || '').slice(0, 40),
          bedrooms:         String(p.bedrooms || '').slice(0, 10),
          bathrooms:        String(p.bathrooms || '').slice(0, 10),
          sqft:             String(p.sqft || '').slice(0, 12),
          // Deploy 236.657 — per-property valuation
          propValue:        String(p.propValue || '').slice(0, 15),
          appraisedValue:   String(p.appraisedValue || '').slice(0, 15),
          existingDebt:     String(p.existingDebt || '').slice(0, 15),
          monthlyRent:      String(p.monthlyRent || '').slice(0, 15),
          monthlyTaxes:     String(p.monthlyTaxes || '').slice(0, 15),
          monthlyInsurance: String(p.monthlyInsurance || '').slice(0, 15),
          monthlyHoa:       String(p.monthlyHoa || '').slice(0, 15),
        };
      });
      applied[k] = loan.properties.length; return;
    }
    loan[k] = String(fields[k] == null ? '' : fields[k]).trim();
    applied[k] = loan[k];
  });
  if (!Object.keys(applied).length) return json(400, { error: 'No recognized loan fields' });

  const now = new Date().toISOString();
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, fields: applied });
}
