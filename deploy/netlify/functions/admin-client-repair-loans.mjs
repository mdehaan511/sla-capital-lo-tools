/**
 * admin-client-repair-loans.mjs — POST /api/admin-client-repair-loans
 *
 * Inverse of admin-pg-resync. That tool pushes blob → PG (blob is
 * truth). This tool pushes PG → blob for the loans[] array on ONE
 * client (PG is truth for the individual loan records via the
 * loans table's client_id FK).
 *
 * Use case: the client blob's `loans[]` array has drifted out of
 * sync with what's actually in PG. Symptom: loans-merge-manual
 * (or any endpoint that reads client.loans[]) returns
 * "loan not found on client" even though loan-get-pg finds the loan
 * under that same client_id. Root cause is usually a mutation that
 * wrote the loan into PG (via a pg-mirror hook) without also
 * updating the source client blob's loans[] — typically a
 * loan-move / reassign where the target-side write happened but the
 * source-side removal missed.
 *
 * What it does:
 *   1. Read the client blob at <ownerKey>/<clientId>.
 *   2. Read all PG loan rows where client_id = clientId.
 *   3. For each PG loan, project back to the frontend/blob shape.
 *   4. Rewrite client.loans[] to be exactly the PG set (order by
 *      updated_at desc, matching PG's own ordering).
 *   5. Write the client blob and refresh the materialized
 *      clients-index so Pipeline/Loans/Search all see it.
 *
 * Does NOT touch PG. PG is treated as read-only truth.
 *
 * Body: { clientId, owner? }
 * Response: {
 *   ok, ownerKey, clientId,
 *   before: { loanCount, loanIds },
 *   after:  { loanCount, loanIds },
 *   added:  [ loanId, ... ],
 *   removed:[ loanId, ... ],
 * }
 * Admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { upsertClient as indexUpsertClient } from './_shared/clients-index.mjs';

// Project a PG loan row back to the shape the blob expects. Same
// mapping as loan-get-pg.mjs's _loanRowToBlobShape (kept local to
// avoid coupling this repair tool to that endpoint's internals).
function _pgLoanToBlobShape(l) {
  if (!l) return null;
  const out = {
    id:                   l.id,
    address:              l.address           || '',
    status:               l.status            || 'active',
    processingStage:      l.processing_stage  || '',
    toolType:             l.tool_type         || '',
    loanType:             l.loan_type         || '',
    loanAmt:              l.loan_amt          || '',
    loanAmtLocked:        !!l.loan_amt_locked,
    rate:                 l.rate              || '',
    points:               l.points            || '',
    purchasePrice:        l.purchase_price    || '',
    propValue:            l.prop_value        || '',
    rehabBudget:          l.rehab_budget      || '',
    arv:                  l.arv               || '',
    propType:             l.prop_type         || '',
    fico:                 l.fico              || '',
    prepay:               l.prepay            || '',
    dscr:                 l.dscr              || '',
    brokerId:             l.broker_id         || '',
    _isBrokerLoan:        !!l.is_broker_loan,
    fromApplication:      !!l.from_application,
    prospectId:           l.prospect_id       || '',
    fundingDate:          l.funding_date      || '',
    maturityDate:         l.maturity_date     || '',
    servicerName:         l.servicer_name     || '',
    servicerUrl:          l.servicer_url      || '',
    slaDisplayId:         l.sla_display_id    || '',
    guarantorClientIds:   l.guarantor_client_ids || [],
    guarantorOwnership:   l.guarantor_ownership || {},
    vestingLLCs:          l.vesting_llcs || [],
    formData:             l.form_data || {},
    notes:                l.notes || '',
    notesLog:             l.notes_log || [],
    createdAt:            l.created_at,
    updatedAt:            l.updated_at,
    savedAt:              l.saved_at || l.updated_at,
  };
  Object.assign(out, l.extra || {});
  return out;
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-client-repair-loans error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const clientId = String(body.clientId || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });

  const selfEmail = normalizeEmail(user.email);
  const ownerParam = String(body.owner || '').trim();
  const ownerKey = ownerParam ? keySafe(normalizeEmail(ownerParam)) : keySafe(selfEmail);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const blobKey = ownerKey + '/' + keySafe(clientId);
  const rec = await clientsStore.get(blobKey, { type: 'json' }).catch(() => null);
  if (!rec) return json(404, { error: 'Client not found in blob store at ' + blobKey });

  // Read the truth: all PG loans with this client_id, ordered by
  // updated_at desc to mirror what most consumers expect.
  let pgLoans;
  try {
    pgLoans = await db.select('loans', {
      select: '*',
      eq: { client_id: clientId },
      order: { updated_at: 'desc' },
    });
  } catch (e) {
    return json(500, { error: 'PG read failed: ' + (e && e.message) });
  }

  const beforeIds = (rec.loans || []).map((l) => l && l.id).filter(Boolean);
  const beforeSet = new Set(beforeIds);
  const newLoans = (pgLoans || []).map(_pgLoanToBlobShape).filter(Boolean);
  const afterIds = newLoans.map((l) => l.id);
  const afterSet = new Set(afterIds);

  const added   = afterIds.filter((id) => !beforeSet.has(id));
  const removed = beforeIds.filter((id) => !afterSet.has(id));

  // Rewrite the loans[] array and stamp updatedAt.
  rec.loans = newLoans;
  rec.updatedAt = new Date().toISOString();

  try {
    await clientsStore.setJSON(blobKey, rec);
  } catch (e) {
    return json(500, { error: 'Blob write failed: ' + (e && e.message) });
  }

  // Sync the materialized index so downstream reads (Pipeline etc.)
  // reflect the repair immediately. Fire-and-forget on failure —
  // the primary write already landed.
  indexUpsertClient(ownerKey, rec).catch(() => {});

  return json(200, {
    ok: true,
    ownerKey,
    clientId,
    before: { loanCount: beforeIds.length, loanIds: beforeIds },
    after:  { loanCount: afterIds.length,  loanIds: afterIds },
    added,
    removed,
  });
}
