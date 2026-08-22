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
  // Valuation
  purchasePrice: 1, propValue: 1, aivBpo: 1, arv: 1, arvBpo: 1, currentLoanAmt: 1, rehabBudget: 1,
  // Property
  propType: 1, rentalType: 1, bedrooms: 1, bathrooms: 1, sqft: 1, numUnits: 1, lotSize: 1,
  yearBuilt: 1, stories: 1, propertyCounty: 1, floodZone: 1, purchaseDate: 1,
  // Carrying costs (monthly canonical)
  monthlyTaxes: 1, monthlyInsurance: 1, monthlyHoa: 1,
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
