/**
 * loan-update-from-sizer.mjs — POST /api/loan-update-from-sizer
 *
 * Deploy 192: bypass the brittle email-then-address matching in
 * Clients.upsert when the sizer has a known (clientId, loanId). Direct
 * ID-based update: read the client record, find the loan by ID,
 * Object.assign the incoming loanData, save.
 *
 * Used by both DSCR and RTL sizers when window._editingLoanId AND
 * window._editingClientId are set (i.e. the LO opened an existing
 * loan to edit, not a brand-new quote). New quotes still go through
 * the legacy upsert path so the client + loan get auto-created.
 *
 * Body:
 *   {
 *     clientId: 'c_...',
 *     loanId: 'l_...',
 *     loanData: { ... merged loan record from buildLoanFromSizer ... },
 *     owner?: 'other@lo.com'  (admin cross-LO override)
 *   }
 *
 * Response: { ok: true, loan: <updated loan record> }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 226 — append "reprice" entry to the loan's audit log when the
// sizer save changes rate / loanAmt / points / term vs. the prior record.
import { appendNoteEntry, describeReprice } from './_shared/notes-log.mjs';
// Deploy 236.5 (Brokers Phase 3b) — auto-link the loan to a broker
// entity when broker inline fields are set but brokerId isn't. Catches
// the case where the LO typed broker info directly without using the
// picker, OR where they're saving a loan that pre-dates the picker.
import { linkOrCreateBroker } from './_shared/broker-link.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-update-from-sizer top-level error:', e);
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
  if (!body.loanData || typeof body.loanData !== 'object') {
    return json(400, { error: 'loanData required' });
  }

  // Resolve owner key. Admin cross-LO override allowed.
  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(body.clientId);

  let client;
  try {
    client = await clientsStore.get(clientKey, { type: 'json' });
  } catch (e) {
    return json(500, { error: 'Failed to read client record: ' + (e.message || 'unknown') });
  }
  if (!client) return json(404, { error: 'Client not found at ' + clientKey });
  if (!Array.isArray(client.loans)) client.loans = [];

  const idx = client.loans.findIndex((l) => l && l.id === body.loanId);
  if (idx < 0) return json(404, { error: 'Loan not found on client. clientId=' + body.clientId + ' loanId=' + body.loanId });

  const prior = client.loans[idx];
  const incoming = body.loanData;

  // Merge: spread incoming, then preserve specific server-side fields
  // that the sizer should never overwrite. Don\u2019t let the sizer
  // change the loan\u2019s id/createdAt/createdBy. Preserve LO-edited
  // app-section fields (so a re-size doesn\u2019t wipe them).
  const now = new Date().toISOString();
  const merged = Object.assign({}, incoming, {
    id: prior.id,
    createdAt: prior.createdAt || incoming.createdAt || now,
    updatedAt: now,
    // Preserve loan amount when LO has locked it (manual override on
    // Loan Details). If not locked, take the incoming value.
    loanAmt:       prior.loanAmtLocked ? prior.loanAmt : incoming.loanAmt,
    loanAmtLocked: prior.loanAmtLocked || false,
    // Preserve LO-edited app-section fields if the sizer didn\u2019t
    // explicitly set them this round.
    bedrooms:    incoming.bedrooms    || prior.bedrooms,
    bathrooms:   incoming.bathrooms   || prior.bathrooms,
    sqft:        incoming.sqft        || prior.sqft,
    projectDescription: incoming.projectDescription || prior.projectDescription || '',
    notes:       incoming.notes       || prior.notes || '',
    // Deploy 228 \u2014 preserve Desired Close Date. The sizer has no
    // input for it; without preservation, every sizer save clobbers
    // the value supplied by the prospect short app or set on Loan
    // Details. Same preservation pattern as the other app-section
    // fields above.
    fundingDate: incoming.fundingDate || prior.fundingDate || '',
    // Preserve status: a save shouldn\u2019t demote a Submitted loan back
    // to Active. If the sizer doesn\u2019t explicitly send a status, keep
    // the prior status. If it does, only accept if prior was active.
    status: (prior.status && prior.status !== 'active' && prior.status !== 'on_hold')
      ? prior.status
      : (incoming.status || prior.status || 'active'),
    // Deploy 236.38 \u2014 PRESERVE notesLog. The sizer's incoming payload
    // never includes notesLog (it's built fresh from form data), so
    // every sizer save was overwriting it with `undefined` and wiping
    // the entire audit history. The reprice entry that this endpoint
    // appends below then became the only surviving entry.
    // Same pattern as the app-section preservation above: take the
    // prior value when incoming doesn't carry one.
    notesLog: (Array.isArray(prior.notesLog) ? prior.notesLog : []).slice(),
    // Deploy 236.38 \u2014 audit-log metadata fields also live on the
    // loan record (prospectId, baselineId, borrowerInfoCompletedAt,
    // _manualAdvanceAt/By/From). All would be wiped by the same
    // overwrite-from-incoming bug. Preserve from prior unless the
    // sizer explicitly sends one.
    prospectId:                 incoming.prospectId                 || prior.prospectId                 || '',
    baselineId:                 incoming.baselineId                 || prior.baselineId                 || '',
    borrowerInfoCompletedAt:    incoming.borrowerInfoCompletedAt    || prior.borrowerInfoCompletedAt    || '',
    _manualAdvanceAt:           incoming._manualAdvanceAt           || prior._manualAdvanceAt           || '',
    _manualAdvanceBy:           incoming._manualAdvanceBy           || prior._manualAdvanceBy           || '',
    _manualAdvanceFrom:         incoming._manualAdvanceFrom         || prior._manualAdvanceFrom         || '',
  });

  // Strip transient meta fields that shouldn\u2019t persist.
  delete merged._editingLoanId;
  delete merged._editingClientId;

  // Deploy 236.5 \u2014 broker entity auto-link. Runs only if there's some
  // broker data on the merged record AND brokerId isn't already a
  // valid pointer to a record in this LO's book. Best-effort: failure
  // never blocks the save, broker-link.mjs swallows internally.
  try {
    if (merged && (merged.brokerName || merged.brokerEmail || merged.brokerId)) {
      const linked = await linkOrCreateBroker(ownerKey, merged);
      if (linked && linked.id) {
        merged.brokerId = linked.id;
        // Backfill the inline fields from the canonical broker record
        // so the loan display stays consistent if the broker record was
        // edited recently (the broker book is the source of truth now).
        const b = linked.broker || {};
        if (b.name)    merged.brokerName    = b.name;
        if (b.company) merged.brokerCompany = b.company;
        if (b.email)   merged.brokerEmail   = b.email;
        if (b.phone)   merged.brokerPhone   = b.phone;
      }
    }
  } catch (e) {
    console.warn('loan-update-from-sizer: broker auto-link failed (non-fatal):', e && e.message);
  }

  // Deploy 226 \u2014 auto-append a "reprice" audit-log entry when the sizer
  // save changed rate / loanAmt / points / term vs. the prior record.
  // Skipped silently when this is a brand-new loan (prior had no rate)
  // or when nothing meaningful changed.
  const repriceDelta = describeReprice(prior, merged);
  if (repriceDelta && prior.rate != null && prior.rate !== '') {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(merged, {
      kind:        'reprice',
      text:        repriceDelta.text,
      author,
      authorEmail: user.email || '',
      meta:        repriceDelta.meta,
    });
  }

  client.loans[idx] = merged;
  client.updatedAt = now;

  try {
    await clientsStore.setJSON(clientKey, client);
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  return json(200, { ok: true, loan: merged, clientId: client.id });
}
