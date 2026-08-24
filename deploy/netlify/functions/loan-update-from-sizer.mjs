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
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
// Deploy 226 — append "reprice" entry to the loan's audit log when the
// sizer save changes rate / loanAmt / points / term vs. the prior record.
import { appendNoteEntry, describeReprice } from './_shared/notes-log.mjs';
// Deploy 236.5 (Brokers Phase 3b) — auto-link the loan to a broker
// entity when broker inline fields are set but brokerId isn't. Catches
// the case where the LO typed broker info directly without using the
// picker, OR where they're saving a loan that pre-dates the picker.
import { linkOrCreateBroker } from './_shared/broker-link.mjs';
// Deploy 236.249 — mirror this write into the quotes store so the
// Pipeline tile (which reads rate/points from the quote's formData,
// not the loan record) picks up the new pricing without depending on
// the browser-side QuoteStore.saveQuote landing correctly. Same
// pattern loan-financials-edit.mjs uses for inline edits.
// (quote-sync import removed — Deploy 236.426, D3.)
// Deploy 236.405 (C2 catch-up): store writes route through the shared
// PG-first writeClient helper (blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';

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

  const user = await requireAuth(context, req);
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
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
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

  // Deploy 236.252 \u2014 diagnostic log. Surfaces the exact values the
  // sizer is sending (incoming) vs. what's currently on the record
  // (prior), specifically for the pricing/status fields that Mike
  // reported as "not updating" for in-processing DSCR loans. If a
  // reprice ever silently loses rate/points, the function log will
  // now show WHY (incoming empty? backend preservation kicked in?
  // status branch taking prior?).
  console.log('[loan-update-from-sizer] incoming reprice for loan', body.loanId, {
    incoming_rate: incoming && incoming.rate,
    prior_rate: prior && prior.rate,
    incoming_points: incoming && incoming.points,
    prior_points: prior && prior.points,
    incoming_loanAmt: incoming && incoming.loanAmt,
    prior_loanAmt: prior && prior.loanAmt,
    prior_loanAmtLocked: prior && prior.loanAmtLocked,
    incoming_status: incoming && incoming.status,
    prior_status: prior && prior.status,
    incoming_loanType: incoming && incoming.loanType,
    prior_loanType: prior && prior.loanType,
    incoming_finalRate_fd: incoming && incoming._finalRate,
    incoming_rateOverride: incoming && incoming._rateOverride,
    incoming_pointsOverride: incoming && incoming._pointsOverride,
  });

  // Merge: spread incoming, then preserve specific server-side fields
  // that the sizer should never overwrite. Don\u2019t let the sizer
  // change the loan\u2019s id/createdAt/createdBy. Preserve LO-edited
  // app-section fields (so a re-size doesn\u2019t wipe them).
  const now = new Date().toISOString();
  const merged = Object.assign({}, incoming, {
    id: prior.id,
    createdAt: prior.createdAt || incoming.createdAt || now,
    updatedAt: now,
    // Deploy 236.254 — loanAmt now behaves like rate/points: whichever
    // side wrote most recently wins. Prior behavior preserved the LO's
    // manual override on Loan Details (loanAmtLocked=true) across
    // every sizer re-save, which meant the sizer's own loan-amount
    // edits silently no-op'd against the record whenever the LO had
    // previously touched Loan Details. Mike's ask: bidirectional
    // sync just like all other pricing fields. loanAmtLocked is
    // still stored so the Loan Details "LO override" badge continues
    // to reflect the last touch, but it's no longer a write gate.
    loanAmt:       incoming.loanAmt,
    loanAmtLocked: incoming.loanAmtLocked !== undefined ? !!incoming.loanAmtLocked : (prior.loanAmtLocked || false),
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
    // Deploy 236.141 — preserve guarantor / contacts / processing
    // / test-fixture fields that the sizer never sends. Without
    // these, every sizer save was wiping additional guarantors,
    // ownership %, vesting LLCs, the Processing Pipeline stage +
    // substatus, the auto-task-templates marker, etc. Same root
    // cause as the 236.38 notesLog preservation — Object.assign
    // copies `incoming` whole, so anything not in `incoming`
    // (which is just sizer-form output) gets dropped from the
    // merged record.
    guarantorClientIds:         (Array.isArray(incoming.guarantorClientIds)         ? incoming.guarantorClientIds         : prior.guarantorClientIds         || []),
    guarantorOwnership:         (incoming.guarantorOwnership && typeof incoming.guarantorOwnership === 'object' ? incoming.guarantorOwnership : prior.guarantorOwnership || {}),
    vestingLLCs:                (Array.isArray(incoming.vestingLLCs)                ? incoming.vestingLLCs                : prior.vestingLLCs                || []),
    _checkOwnership:            incoming._checkOwnership            || prior._checkOwnership            || null,
    _guarantorDocsUpdatedAt:    incoming._guarantorDocsUpdatedAt    || prior._guarantorDocsUpdatedAt    || '',
    _guarantorDocsUpdatedBy:    incoming._guarantorDocsUpdatedBy    || prior._guarantorDocsUpdatedBy    || '',
    processingStage:            incoming.processingStage            || prior.processingStage            || '',
    processingSubstatus:        incoming.processingSubstatus        || prior.processingSubstatus        || '',
    _templatesAppliedFor:       (incoming._templatesAppliedFor && typeof incoming._templatesAppliedFor === 'object' ? incoming._templatesAppliedFor : prior._templatesAppliedFor || {}),
    assignedProcessor:          incoming.assignedProcessor          || prior.assignedProcessor          || '',
    // Deploy 236.662 — preserve the multi-member processing team across sizer saves.
    assignedProcessors:         (Array.isArray(incoming.assignedProcessors) ? incoming.assignedProcessors : (Array.isArray(prior.assignedProcessors) ? prior.assignedProcessors : undefined)),
    _test:                      (incoming._test === true || prior._test === true) || undefined,
    slaDisplayId:               incoming.slaDisplayId               || prior.slaDisplayId               || '',
    appraisedValue:             incoming.appraisedValue             || prior.appraisedValue             || '',
    // Deploy 236.424 (D2) — formData was never on this preservation
    // list, so any PARTIAL update (API rate edit, programmatic field
    // tweak) silently wiped the loan's sizer snapshot. Invisible in
    // the quote era (pages read the QUOTE's formData copy); fatal now
    // that /api/quotes renders from the loan. Same bug class 236.141
    // fixed for guarantors/processing fields.
    formData: (incoming.formData && typeof incoming.formData === 'object' && Object.keys(incoming.formData).length
      ? incoming.formData
      : (prior.formData && typeof prior.formData === 'object' ? prior.formData : undefined)),
    // Deploy 236.691 — preserve the "reprice as portfolio" flag across sizer
    // saves (the sizer never sends it), EXCEPT when the loan is now priced as a
    // portfolio (propType 'portfolio'), which resolves the flag.
    needsRepricePortfolio: (String(incoming.propType || prior.propType || '').toLowerCase() === 'portfolio')
      ? false
      : (incoming.needsRepricePortfolio === true || prior.needsRepricePortfolio === true),
  });

  // Strip transient meta fields that shouldn't persist.
  delete merged._editingLoanId;
  delete merged._editingClientId;

  // Deploy 236.138 \u2014 a sizer save IS the new accepted pricing
  // baseline. Clear the Loan Details inline-editor's modification
  // tracking so the "N field(s) manually modified \u2014 Restore to
  // Original" banner disappears + Restore becomes a no-op until
  // the next inline edit. Same logic for the signed-docs stale
  // flag: re-pricing through the sizer naturally invalidates any
  // earlier "stale" stamp, since the sizer save is what would
  // need to be re-signed against anyway.
  delete merged._originalValues;
  delete merged._modifiedFields;
  delete merged._signedDocsStale;

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

  // Deploy 236.255 — append a snapshot to the loan's sizerHistory[]
  // so LOs can pull up past pricing rounds for the same deal during
  // negotiation. Every sizer save banks the current state; the
  // frontend history panel renders it as a scrollable table with
  // click-to-restore. Capped at 50 entries (~1KB each, 50 = 50KB
  // per loan record — comfortable within Netlify Blobs limits).
  // Note we snapshot from `merged` AFTER all preservation +
  // override logic so history reflects what was actually persisted.
  const PREPAY_LABEL = {
    '5y6m':  '5Yr/6Mo', '54321': '5-Year', '321': '3-Year',
    '320':   '2-Year',  '300':   '1-Year', 'none': 'None',
  };
  // Deploy 236.256 — read history from `prior` (the persisted record),
  // not `merged`. sizerHistory isn't in the preserved-fields block,
  // so merged.sizerHistory was always undefined and 236.255 was
  // silently overwriting on every save.
  const priorHistory = Array.isArray(prior.sizerHistory) ? prior.sizerHistory : [];
  // Deploy 236.257 — snapshot the RAW sizer formData that the
  // frontend attached to loanRecord._sizerFormData. buildLoanFromSizer
  // only emits a subset of loan-record fields; a full "restore"
  // needs every input the LO had on the sizer at save time (borrower
  // contact, address, all overrides, computed display values). If
  // the frontend didn't send _sizerFormData (older clients still
  // running 236.255-256), fall back to the previous subset built
  // from merged so history entries still stack.
  const rawFormData = (incoming && incoming._sizerFormData && typeof incoming._sizerFormData === 'object')
    ? incoming._sizerFormData
    : null;
  const snapshotFormData = rawFormData || {
    loanAmt:          merged.loanAmt          || '',
    propValue:        merged.propValue        || '',
    loanType:         merged.loanType         || '',
    fico:             merged.fico             || '',
    rent:             merged.rent             || '',
    taxes:            merged.taxes            || '',
    insurance:        merged.insurance        || '',
    hoa:              merged.hoa              || '',
    prepay:           merged.prepay           || '',
    buydown:          merged.buydown          || '',
    isIO:             merged.isIO             || '',
    loanPurpose:      merged.loanPurpose      || '',
    propType:         merged.propType         || '',
    currentLoanAmt:   merged.currentLoanAmt   || '',
    brokerFee:        merged.brokerFee        || '',
    _rateOverride:    merged._rateOverride    || '',
    _ltvOverride:     merged._ltvOverride     || '',
    _pointsOverride:  merged._pointsOverride  || '',
    _finalRate:       merged._finalRate       || '',
    _points:          merged._points          || '',
  };
  const snapshot = {
    savedAt:     now,
    savedBy:     user.email || '',
    loanAmt:     merged.loanAmt     || '',
    rate:        merged.rate        || '',
    points:      merged.points      || '',
    prepay:      merged.prepay      || '',
    prepayLabel: PREPAY_LABEL[String(merged.prepay || '').toLowerCase()] || '',
    formData:    snapshotFormData,
  };
  merged.sizerHistory = [snapshot].concat(priorHistory).slice(0, 50);
  // Deploy 236.257 — strip _sizerFormData off the persisted loan
  // record so it doesn't bloat every load (the sizer only cares
  // about the snapshot copies inside sizerHistory).
  if (merged._sizerFormData) delete merged._sizerFormData;

  client.loans[idx] = merged;
  client.updatedAt = now;

  try {
    // Deploy 236.405 (C2 catch-up): this endpoint was missed in the
    // 236.402 sweep — PG-first via shared writeClient like every
    // other user-facing writer. Quote sweep below stays non-strict
    // (its count feeds the quotesSynced response field).
    await writeClient(ownerKey, client, { clientsStore });
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  // Deploy 236.426 (D3): quote sweep retired — /api/quotes renders from
  // loans (D2), so store copies no longer need freshening. Pipeline
  // tiles now read rate/points from the LOAN's formData directly.
  return json(200, { ok: true, loan: merged, clientId: client.id, quotesSynced: 0 });
}
