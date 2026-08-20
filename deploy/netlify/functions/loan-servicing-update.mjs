/**
 * loan-servicing-update.mjs — POST /api/loan-servicing-update
 *
 * Deploy 236.612 — servicing tracking. Sets the per-loan servicing scalar fields
 * that fill the Closed Loans columns. Whitelisted fields only; each write goes
 * through the PG-first strict writeClient (strict-write discipline).
 *
 * Body: { clientId, loanId, owner?, fields: { <whitelisted>: value, ... } }
 *
 * Auth: staff only (admin OR processor via canOverrideOwner).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

// Whitelist — only these loan fields may be set here.
// Field names align with the existing 236.339 Servicing Info section on Loan
// Details (servicerName / servicerUrl / maturityDate) so both surfaces + the
// borrower /my-loans card read/write the same loan fields.
const FIELDS = {
  maturityDate: 1, payoffAmount: 1, payoffDate: 1, paymentAmount: 1,
  servicerName: 1, servicerUrl: 1, servicerLoanNumber: 1, soldRate: 1, soldDate: 1,
  upb: 1, investorName: 1,
  // Deploy 236.622 — collateral tracking: 3 docs × date + location(custodian).
  signedOriginalsDate: 1, signedOriginalsLocation: 1, signedOriginalsTracking: 1,
  recordedDotDate: 1, recordedDotLocation: 1, recordedDotTracking: 1,
  titlePolicyDate: 1, titlePolicyLocation: 1, titlePolicyTracking: 1,
  // Deploy 236.624 — Close Out / Mark Sold / Pending Sale lifecycle:
  // tpoSpread (DSCR, points) + closingFees (DSCR rate-sheet snapshot) drive
  // Sold-DSCR profitability; activelyTrading ('yes'/'no') is the Pending-Sale
  // trade-ready flag.
  tpoSpread: 1, closingFees: 1, activelyTrading: 1,
  // Deploy 236.625 — Close Out lets staff set the loan type when it's missing
  // (Baseline imports arrive blank), since type routes RTL vs DSCR. projectLoan
  // maps loan.toolType -> the tool_type PG column, so this persists in the list.
  toolType: 1,
};

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-servicing-update error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const clientId = body.clientId, loanId = body.loanId;
  const fields = body.fields;
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (!fields || typeof fields !== 'object') return json(400, { error: 'fields object required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
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
    loan[k] = String(fields[k] == null ? '' : fields[k]).trim();
    applied[k] = loan[k];
  });
  if (!Object.keys(applied).length) return json(400, { error: 'No recognized servicing fields' });

  const now = new Date().toISOString();
  loan.servicingUpdatedAt = now;
  loan.servicingUpdatedBy = selfEmail;
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, fields: applied });
}
