/**
 * loan-change-type.mjs — POST /api/loan-change-type
 *
 * Flips a loan's product type (dscr ↔ rtl). Wipes type-specific pricing
 * fields, preserves carry-over info (borrower, address, FICO), resets
 * status to active so the LO has to rebuild the loan in the other sizer.
 *
 * Body: { clientId, loanId, owner? }
 *   owner — admin cross-LO override; required when admin is acting on
 *           another LO's loan. When omitted, server uses the authed user's
 *           own owner key.
 *
 * Behavior:
 *   - Toggles loan.toolType
 *   - Clears: loanType, rate, points, dscr, _finalRate, _pricingSnapshot,
 *     rate-dependent fields (loanAmt is preserved as a hint, the LO can
 *     change it in the new sizer)
 *   - Clears RTL-specific (rehabBudget, arv, experience, ...) when going
 *     to DSCR; clears DSCR-specific (rent, taxes, insurance, hoa, ...)
 *     when going to RTL
 *   - status → 'active'
 *   - Clears submittedAt / submitNotes / submitNotesAt
 *   - Stamps audit fields: _typeChangedAt, _typeChangedFrom, _typeChangedBy
 *   - Appends a system note to loan.notes
 *
 * Returns: { success, newToolType, redirectUrl }
 *
 * Existing envelopes (rate sheet, term sheet, loan app PDFs) are NOT
 * deleted on the server — that's irreversible and the audit trail
 * matters. Instead, the Loan Details UI filters envelopes by
 * createdAt > _typeChangedAt, so superseded envelopes hide automatically.
 * If a borrower-info record was linked to this loan, the linkage is
 * cleared (the borrower-info itself stays — it's per-client, not per-loan).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-change-type top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  if (!body.clientId) return json(400, { error: 'clientId required' });
  if (!body.loanId)   return json(400, { error: 'loanId required' });

  // Resolve owner. Same pattern as clients-save.mjs etc — admin may pass
  // an explicit owner override to act on another LO's data; non-admins
  // only get their own owner key.
  const selfEmail = normalizeEmail(user.email);
  const selfKey = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientKey = ownerKey + '/' + keySafe(body.clientId);
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  const client = await clientsStore.get(clientKey, { type: 'json' });
  if (!client) return json(404, { error: 'Client not found' });

  const loanIdx = (client.loans || []).findIndex((l) => l && l.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on this client' });

  const loan = client.loans[loanIdx];
  const oldType = loan.toolType || 'dscr';
  const newType = oldType === 'rtl' ? 'dscr' : 'rtl';
  const now = new Date().toISOString();

  // Carry-over fields: borrower info, address, FICO. Everything else is
  // type-specific and gets cleared so the LO has to re-enter from the
  // other sizer. (FICO is universal enough across products to keep.)
  const carryOver = {
    id:           loan.id,
    address:      loan.address || '',
    toolType:     newType,
    status:       'active',
    fico:         loan.fico || '',
    ficoLabel:    loan.ficoLabel || '',
    propType:     loan.propType || '',
    propTypeLabel: loan.propTypeLabel || '',
    usCitizen:    loan.usCitizen || '',
    loanPurpose:  loan.loanPurpose || '',
    notes:        appendSystemNote(loan.notes || '', oldType, newType, selfEmail, now),
    createdAt:    loan.createdAt || loan.savedAt || now,
    savedAt:      loan.savedAt || now,
    updatedAt:    now,
    // Broker info is product-agnostic — the same broker is involved
    // regardless of whether this is a DSCR or RTL loan, so it carries
    // over on type change rather than getting wiped with pricing.
    brokerFee:     loan.brokerFee     || '',
    brokerName:    loan.brokerName    || '',
    brokerCompany: loan.brokerCompany || '',
    brokerEmail:   loan.brokerEmail   || '',
    brokerPhone:   loan.brokerPhone   || '',
    // Audit
    _typeChangedAt:   now,
    _typeChangedFrom: oldType,
    _typeChangedBy:   selfEmail,
  };
  // Preserve a couple of fields that might be useful as hints even though
  // they're type-specific. The LO can replace them in the new sizer.
  if (loan._originalAddress) carryOver._originalAddress = loan._originalAddress;
  if (loan._recoveredFromOrphan) {
    carryOver._recoveredFromOrphan = loan._recoveredFromOrphan;
    carryOver._recoveredAt = loan._recoveredAt;
  }
  // formData: keep only the borrower + address fields so the new sizer's
  // loadFromClientLoan path prefills the carry-overs and leaves everything
  // else blank for the LO to fill in.
  //
  // Borrower info source priority:
  //   1. The old loan's formData (sizer-created loans store it here)
  //   2. The parent client record (apply.html-sourced loans store name as
  //      client.firstName/lastName/email/phone, NOT in formData)
  // Without the client-record fallback, application-sourced loans lost
  // their borrower name on type change because the formData was empty.
  const oldFd = loan.formData || {};
  const clientFullName = ((client.firstName || '') + ' ' + (client.lastName || '')).trim();
  const carryName  = (oldFd.borrowerName || oldFd.borrower || clientFullName || '').trim();
  const carryEmail = (oldFd.borrowerEmail || client.email || '').trim();
  const carryPhone = (oldFd.borrowerPhone || client.phone || '').trim();
  carryOver.formData = {
    borrower:      carryName,
    borrowerName:  carryName,
    borrowerEmail: carryEmail,
    borrowerPhone: carryPhone,
    address:       oldFd.address || loan.address || '',
    // Address components (used by RTL sizer's separate street/city/state/zip inputs)
    propStreet:    oldFd.propStreet || extractStreet(oldFd.address || loan.address || ''),
    propCity:      oldFd.propCity   || '',
    propState:     oldFd.propState  || '',
    propZip:       oldFd.propZip    || '',
    // FICO carries
    fico:          oldFd.fico || '',
    ficoLabel:     oldFd.ficoLabel || '',
    // Property purpose (purchase / refi / cashout) carries — borrowers
    // tend to know what they want regardless of product
    loanPurpose:   oldFd.loanPurpose || '',
    // Broker info carries — same broker regardless of product
    brokerFee:     oldFd.brokerFee     || loan.brokerFee     || '',
    brokerName:    oldFd.brokerName    || loan.brokerName    || '',
    brokerCompany: oldFd.brokerCompany || loan.brokerCompany || '',
    brokerEmail:   oldFd.brokerEmail   || loan.brokerEmail   || '',
    brokerPhone:   oldFd.brokerPhone   || loan.brokerPhone   || '',
  };

  client.loans[loanIdx] = carryOver;
  client.updatedAt = now;

  // Persist
  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  await writeClient(ownerKey, client, { clientsStore });

  // Deploy 236.426 (D3): quote sweep retired — /api/quotes renders from
  // loans (D2), so store copies no longer need freshening.

  // Build the redirect URL — open the loan in the NEW sizer prefilled
  // from the (now-cleared) loan record. `typeChanged=1` tells the sizer
  // to skip the usual borrower-name lock so the LO can edit it during
  // the rebuild if needed (e.g. to correct a typo or use a legal name).
  const sizerPage = newType === 'rtl' ? 'rtl-sizer.html' : 'dscr-sizer.html';
  const params = new URLSearchParams({
    clientId: body.clientId,
    loanId:   body.loanId,
    typeChanged: '1',
  });
  if (loan.address) params.set('loadQuote', loan.address);
  // Cross-owner sizer load — admin acting on another LO's loan
  if (ownerKey !== selfKey) params.set('owner', body.owner || ownerKey);
  const redirectUrl = '/' + sizerPage + '?' + params.toString();

  return json(200, {
    success:     true,
    newToolType: newType,
    redirectUrl,
  });
}

function appendSystemNote(existing, oldType, newType, email, when) {
  const ts = new Date(when).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const header = '— Loan type changed ' + oldType.toUpperCase() + ' → ' + newType.toUpperCase() + ' (' + ts + ', by ' + email + ') —';
  const note = header + '\nLoan rebuilt in the ' + newType.toUpperCase() + ' sizer. Previous pricing and any sent envelopes from before this change are superseded.';
  return existing.trim() ? (existing.trim() + '\n\n' + note) : note;
}

function extractStreet(fullAddr) {
  // "123 Main St, Boise, ID 83702" → "123 Main St"
  return String(fullAddr || '').split(',')[0].trim();
}
