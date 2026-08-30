/**
 * loan-servicing-update.mjs — POST /api/loan-servicing-update
 *
 * Deploy 236.612 — servicing tracking. Sets the per-loan servicing scalar fields
 * that fill the Closed Loans columns. Whitelisted fields only; each write goes
 * through the PG-first strict writeClient (strict-write discipline).
 *
 * Body: { clientId, loanId, owner?, fields: { <whitelisted>: value, ... },
 *         disposition?: 'post_close'|'servicing'|'pending_sale'|'sold'|'paid_off',
 *         drawMeta?: { '<sitewireDrawId>': { wireSentDate?, reimbursementRequested? } } }
 *
 * Deploy 236.784 — optional `disposition` rides in the SAME write. The Closed
 * Loans lifecycle modals used to fire loan-set-disposition + this endpoint in
 * PARALLEL; both read-modify-write the whole client, so whichever read first
 * and wrote last silently clobbered the other's field — the "moved to Pending
 * Sale but reverted on refresh" bug. One call, one write, no race.
 *
 * Deploy 236.706 — drawMeta: per-draw annotations for the Closed Loans → Draws
 * tab (wire sent date + reimbursement-requested flag). Sitewire has no such
 * fields, so they live on the SLA loan keyed by the Sitewire draw id. Merged
 * per draw id AND per field, so edits to different draws/fields don't clobber.
 *
 * Auth: staff only (admin OR processor via canOverrideOwner).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { diffLoan, recordLoanChanges } from './_shared/loan-change-log.mjs';

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
  // Deploy 236.798 — LO commission inputs (lo-commissions.html):
  // commissionSource 'lo'|'company' (company-sourced first loan halves the
  // tier bps) and commissionReferral 'yes'|'' ($250 borrower-referral bonus).
  commissionSource: 1, commissionReferral: 1,
};

// Deploy 236.784 — same set loan-set-disposition accepts.
const VALID_DISPOSITION = { post_close: 1, servicing: 1, pending_sale: 1, sold: 1, paid_off: 1 };

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
  const fields = (body.fields && typeof body.fields === 'object') ? body.fields : {};
  const drawMeta = (body.drawMeta && typeof body.drawMeta === 'object') ? body.drawMeta : null;
  const disposition = body.disposition != null ? String(body.disposition).toLowerCase().trim() : '';
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });
  if (disposition && !VALID_DISPOSITION[disposition]) return json(400, { error: 'Invalid disposition' });
  if (!Object.keys(fields).length && !drawMeta && !disposition) return json(400, { error: 'fields, drawMeta, or disposition required' });

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
  const _alBefore = Object.assign({}, loan);  // Deploy 236.773 — audit-log snapshot

  const applied = {};
  Object.keys(fields).forEach((k) => {
    if (!FIELDS[k]) return;
    loan[k] = String(fields[k] == null ? '' : fields[k]).trim();
    applied[k] = loan[k];
  });

  // Deploy 236.706 — merge per-draw annotations. Only the two known fields
  // are accepted, dates must be YYYY-MM-DD (or '' to clear), and draw ids
  // must be numeric (Sitewire ids) so junk keys can't grow the record.
  let drawMetaApplied = 0;
  if (drawMeta) {
    if (!loan.drawMeta || typeof loan.drawMeta !== 'object') loan.drawMeta = {};
    Object.keys(drawMeta).forEach((id) => {
      if (!/^\d+$/.test(id)) return;
      const patch = drawMeta[id];
      if (!patch || typeof patch !== 'object') return;
      const cur = loan.drawMeta[id] || {};
      if ('wireSentDate' in patch) {
        const v = String(patch.wireSentDate == null ? '' : patch.wireSentDate).trim();
        // Deploy 236.762 — a malformed date only skips THIS field; the old
        // `return` bailed out of the whole per-id patch, silently dropping
        // a valid reimbursementRequested sent in the same call.
        if (v === '' || /^\d{4}-\d{2}-\d{2}$/.test(v)) {
          cur.wireSentDate = v;
          drawMetaApplied++;
        }
      }
      if ('reimbursementRequested' in patch) {
        cur.reimbursementRequested = !!patch.reimbursementRequested;
        drawMetaApplied++;
      }
      loan.drawMeta[id] = cur;
    });
  }

  if (!Object.keys(applied).length && !drawMetaApplied && !disposition) return json(400, { error: 'No recognized servicing fields' });

  const now = new Date().toISOString();
  // Deploy 236.784 — disposition change in the same atomic write (audit stamps
  // match loan-set-disposition's).
  if (disposition) {
    loan.disposition   = disposition;
    loan.dispositionAt = now;
    loan.dispositionBy = selfEmail;
  }
  loan.servicingUpdatedAt = now;
  loan.servicingUpdatedBy = selfEmail;
  loan.updatedAt = now;

  try { await writeClient(ownerKey, client, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e.message || 'unknown') }); }

  // Deploy 236.773 — audit log (best-effort; must never fail the save).
  try {
    const _alActor = normalizeEmail(user.email);
    await recordLoanChanges({
      ownerKey, clientId: clientId, loanId: loanId,
      actor: _alActor, actorName: user.name || _alActor,
      source: 'Servicing', changes: diffLoan(_alBefore, loan),
    });
  } catch (e) { console.warn('loan-servicing-update: change log failed (non-fatal):', e && e.message); }

  return json(200, { ok: true, fields: applied, disposition: disposition || undefined, drawMeta: drawMetaApplied ? loan.drawMeta : undefined });
}
