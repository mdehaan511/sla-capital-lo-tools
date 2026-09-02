/**
 * loan-reviews-save.mjs — POST /api/loan-reviews-save
 *
 * Create or update a loan review record. Both flows go through this
 * endpoint to keep the merge logic in one place.
 *
 * Create-new body shape:
 *   {
 *     loanType: 'dscr' | 'rtl',
 *     source: { kind: 'existing', clientId, loanId, ownerKey } | { kind: 'stub' },
 *     address, borrowerName, loanAmount, loEmail, expectedCloseDate,
 *     // optionally a pre-built docs map if the caller already initialized it
 *   }
 *
 * Update-existing body shape:
 *   {
 *     id: 'r_...',
 *     patch: { ...partial-update-shape... }
 *   }
 * The patch is shallow-merged into the existing record EXCEPT for
 * `docs`, which is merged per-slug (so a patch to a single doc tray
 * doesn't blow away the other 30+ trays).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { getChecklist, getDefaultInvestor, findCategory, portfolioCollateralEntries } from './_shared/loan-review-checklists.mjs';
// Deploy 236.564 — denormalize the open-conditions count onto the loan (for the
// pipeline badge). PG-first strict writer.
import { writeClient } from './_shared/client-write.mjs';
// Deploy 236.746 — flagged issues land in the loan's Notes & Activity stream.
import { appendNoteEntry } from './_shared/notes-log.mjs';

// Deploy 236.746 — when a processor flags an issue on a doc tray (verdict
// 'issues' + flagReason), append it to the LOAN's note stream so the whole
// team sees it in Notes & Activity, tied to the document by name.
async function _logFlaggedIssuesToLoan(review, patchedDocs, actorEmail) {
  const src = review && review.source;
  if (!src || src.kind !== 'existing' || !src.clientId || !src.loanId || !src.ownerKey) return;
  const flagged = Object.keys(patchedDocs || {}).filter((slug) =>
    patchedDocs[slug] && patchedDocs[slug].verdict === 'issues' && patchedDocs[slug].flagReason);
  if (!flagged.length) return;
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(src.ownerKey);
  const client = await clientsStore.get(ownerKey + '/' + keySafe(src.clientId), { type: 'json' });
  if (!client || !Array.isArray(client.loans)) return;
  const loan = client.loans.find((l) => l && l.id === src.loanId);
  if (!loan) return;
  let wrote = false;
  for (const slug of flagged) {
    const cat = findCategory(slug);
    const label = (cat && cat.label) || (review.docs && review.docs[slug] && review.docs[slug].label) || slug;
    const text = 'Document issue flagged — ' + label + ': ' + patchedDocs[slug].flagReason;
    // Deploy 236.762 — idempotent: a re-confirmed modal or a client retry
    // re-sends the same patch; don't stack identical notes. An EDITED
    // reason produces different text and still logs.
    const dup = Array.isArray(loan.notesLog) &&
      loan.notesLog.some((e) => e && e.kind === 'doc_issue_flagged' && e.text === text);
    if (dup) continue;
    appendNoteEntry(loan, {
      kind: 'doc_issue_flagged',
      text,
      author: actorEmail || 'Processor',
      authorEmail: actorEmail || '',
      meta: { slug, reviewId: review.id },
    });
    wrote = true;
  }
  if (!wrote) return;
  loan.updatedAt = new Date().toISOString();
  await writeClient(ownerKey, client, { clientsStore });
}

// Sum non-cleared conditions across all doc trays and mirror the count onto the
// LOAN record (loan.openConditions / totalConditions) so the Processing Pipeline
// — which loads loans, not reviews — can show a badge. Only writes on a change.
async function _syncConditionsCountToLoan(review) {
  const src = review && review.source;
  if (!src || src.kind !== 'existing' || !src.clientId || !src.loanId || !src.ownerKey) return;
  let open = 0, total = 0;
  const docs = review.docs || {};
  for (const slug of Object.keys(docs)) {
    const cs = (docs[slug] && Array.isArray(docs[slug].conditions)) ? docs[slug].conditions : [];
    for (const c of cs) { total += 1; if (c && c.status !== 'cleared') open += 1; }
  }
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const ownerKey = keySafe(src.ownerKey);
  const client = await clientsStore.get(ownerKey + '/' + keySafe(src.clientId), { type: 'json' });
  if (!client || !Array.isArray(client.loans)) return;
  const loan = client.loans.find((l) => l && l.id === src.loanId);
  if (!loan) return;
  if ((loan.openConditions || 0) === open && (loan.totalConditions || 0) === total) return; // unchanged
  loan.openConditions = open;
  loan.totalConditions = total;
  loan.updatedAt = new Date().toISOString();
  await writeClient(ownerKey, client, { clientsStore });
}

const ALLOWED_LOAN_TYPES = ['dscr', 'rtl', 'guc'];

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-reviews-save error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const selfEmail = normalizeEmail(user.email);
  const now = new Date().toISOString();

  // ── Update existing ───────────────────────────────────────────
  if (body.id) {
    const existing = await store.get(keySafe(body.id), { type: 'json' });
    if (!existing) return json(404, { error: 'Review not found' });
    const patch = body.patch || {};

    // Shallow merge for top-level fields
    const updated = { ...existing, ...patch };

    // Per-doc merge so a patch like { docs: { sow: { verdict: 'approved' } } }
    // doesn't erase the other 30+ trays.
    if (patch.docs) {
      updated.docs = { ...(existing.docs || {}) };
      for (const slug of Object.keys(patch.docs)) {
        updated.docs[slug] = { ...(existing.docs[slug] || {}), ...patch.docs[slug] };
      }
    }

    // Frozen fields — caller can't change these.
    updated.id = existing.id;
    updated.createdAt = existing.createdAt;
    updated.updatedAt = now;

    // Track last-editor for audit.
    updated.lastEditedBy = selfEmail;
    updated.lastEditedAt = now;

    await store.setJSON(keySafe(updated.id), updated);
    // Deploy 236.564 — keep the loan's open-conditions count fresh for the
    // pipeline badge. Only when a docs patch landed (conditions live under docs).
    if (patch.docs) { try { await _syncConditionsCountToLoan(updated); } catch (e) { console.warn('conditions count sync failed:', e && e.message); } }
    // Deploy 236.746 — flagged issues → loan Notes & Activity (best-effort).
    if (patch.docs) { try { await _logFlaggedIssuesToLoan(updated, patch.docs, selfEmail); } catch (e) { console.warn('flag note append failed:', e && e.message); } }
    return json(200, { ok: true, review: updated });
  }

  // ── Create new ─────────────────────────────────────────────────
  const loanType = String(body.loanType || '').toLowerCase();
  if (!ALLOWED_LOAN_TYPES.includes(loanType)) {
    return json(400, { error: 'loanType must be one of: ' + ALLOWED_LOAN_TYPES.join(', ') });
  }

  const id = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

  // Initialize doc map from checklist.
  const checklist = getChecklist(loanType);
  const docs = {};
  for (const item of checklist) {
    docs[item.slug] = {
      slug: item.slug,
      verdict: 'pending',
      required: !(item.optional || item.investor),
      processorNotes: '',
      naReason: '',
      currentDocId: '',
      currentFilename: '',
      currentSize: 0,
      currentUploadedAt: '',
      currentMimeType: '',
      // Phase 2 fields — initialized for forward-compat.
      aiVerdict: '',
      aiNotes: '',
      aiFindings: [],
      aiExtractedEntities: {},
      aiReviewedAt: '',
      aiError: '',
      aiCostCents: 0,
      processorOverrideReason: '',
      approvedAt: '',
      approvedBy: '',
      history: [],
    };
  }

  const review = {
    id,
    createdAt: now,
    updatedAt: now,
    status: 'in_progress',
    loanType,
    investor: body.investor || getDefaultInvestor(loanType),
    source: body.source || { kind: 'stub' },
    address: String(body.address || '').trim(),
    borrowerName: String(body.borrowerName || '').trim(),
    loanAmount: Number(body.loanAmount || 0),
    loEmail: normalizeEmail(body.loEmail || ''),
    expectedCloseDate: String(body.expectedCloseDate || '').trim(),
    processorEmail: selfEmail,
    docs,
    consistencyCheck: { verdict: 'pending', notes: '', lastRunAt: '' },
    aiCostCents: 0,
    createdBy: selfEmail,
    lastEditedBy: selfEmail,
    lastEditedAt: now,
    // Deploy 236.73 — snapshot of the full client + loan record at
    // review-create time. The review uses this as its source of
    // truth (per Mike's spec: "data on the back end that is used
    // to generate the Rate Sheet and Loan Application become the
    // source of truth"). Subsequent LO edits to the underlying
    // loan record DON'T change what's being reviewed.
    sourceLoanSnapshot: null,
    sourceClientSnapshot: null,
  };

  // For existing-loan sources, fetch + snapshot now. Best-effort —
  // failure here doesn't block review creation (the processor can
  // still mark docs against the basic header fields).
  if (review.source && review.source.kind === 'existing' && review.source.clientId && review.source.loanId && review.source.ownerKey) {
    try {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const ownerKey = keySafe(review.source.ownerKey);
      const clientKey = ownerKey + '/' + keySafe(review.source.clientId);
      const client = await clientsStore.get(clientKey, { type: 'json' });
      if (client) {
        const loan = (client.loans || []).find((l) => l.id === review.source.loanId);
        if (loan) {
          review.sourceLoanSnapshot = loan;
          // Strip the heavy fields from the client snapshot — we only
          // need contact / identity. Trim out the full loans array
          // since the targeted loan is already on sourceLoanSnapshot.
          review.sourceClientSnapshot = {
            id: client.id,
            firstName: client.firstName || '',
            lastName: client.lastName || '',
            email: client.email || '',
            phone: client.phone || '',
            entityName: client.entityName || '',
            createdAt: client.createdAt || '',
          };
          // Backfill missing display fields from the loan record so
          // the review header isn't blank if the caller didn't pass
          // them in.
          if (!review.address && loan.address) review.address = loan.address;
          if (!review.loanAmount && loan.loanAmt) review.loanAmount = Number(loan.loanAmt || 0);
          if (!review.expectedCloseDate && loan.fundingDate) review.expectedCloseDate = loan.fundingDate;
        }
      }
    } catch (e) {
      console.warn('loan-reviews-save: snapshot fetch failed (non-fatal):', e && e.message);
    }
    // Deploy 236.744 — attach the signed Loan Application + latest Rate Sheet
    // at CREATE time. The sign-time auto-attach (236.160) only fires when a
    // review already exists at signing; a review created afterwards (the
    // common processor flow) got neither doc. save:false — the review is
    // written for the first time just below.
    let _createAttachedSlugs = [];
    try {
      const { attachSourceDocs } = await import('./_shared/loan-review-auto-attach.mjs');
      const _ar = await attachSourceDocs({
        ownerKey: keySafe(review.source.ownerKey),
        clientId: review.source.clientId,
        loanId:   review.source.loanId,
        address:  (review.sourceLoanSnapshot && review.sourceLoanSnapshot.address) || review.address,
        review,
        actorEmail: selfEmail,
        save: false,
      });
      _createAttachedSlugs = (_ar && _ar.attachedSlugs) || [];
    } catch (e) {
      console.warn('loan-reviews-save: create-time source-doc attach failed (non-fatal):', e && e.message);
    }
    // Deploy 236.849 — queue the AI review for the docs just attached, AFTER
    // the review is written below (the background reviewer re-reads it).
    review._queueAiAfterSave = _createAttachedSlugs;
    // Deploy 236.838 — also pull in any Xactus credit reports / flood certs
    // ordered BEFORE this review existed (they only reached the verifications
    // store; the live-order attach needs a review to attach to). Newest
    // becomes the tray's current doc, with the 120-day credit staleness date.
    try {
      const { attachExistingVerifications } = await import('./_shared/loan-review-auto-attach.mjs');
      await attachExistingVerifications({
        ownerKey: keySafe(review.source.ownerKey),
        loanId:   review.source.loanId,
        review,
        actorEmail: selfEmail,
      });
    } catch (e) {
      console.warn('loan-reviews-save: verification backfill failed (non-fatal):', e && e.message);
    }
  }

  // Deploy 236.690 — Portfolio: give the Collateral section per-property trays.
  // Each single collateral tray is replaced by one per property ("<slug>__p<i>"),
  // tagged with the property so the doc-review can tab collateral by property.
  // The rubric (conditions) travels on each tray so upload/retry verify against
  // it (via the docState.conditions fallback). Non-collateral sections stay single.
  const _pfLoan = review.sourceLoanSnapshot;
  if (_pfLoan && _pfLoan.isPortfolio && Array.isArray(_pfLoan.properties) && _pfLoan.properties.length > 1) {
    const props = _pfLoan.properties;
    review.properties = props.map((p, i) => ({ index: i, label: 'Property ' + (i + 1), address: (p && p.address) || '' }));
    // Deploy 236.782 — portfolioCollateralEntries adds the five docs Mike
    // wants on EVERY property of a portfolio loan even when the tool type's
    // own checklist lacks them (SOW on DSCR, Lease Agreements on RTL).
    const collateralEntries = portfolioCollateralEntries(review.loanType || '');
    for (const it of collateralEntries) {
      delete review.docs[it.slug];
      props.forEach((p, i) => {
        const pslug = it.slug + '__p' + i;
        review.docs[pslug] = {
          slug: pslug,
          section: 'collateral',
          label: it.label,
          conditions: it.conditions || '',
          propertyIndex: i,
          propertyLabel: 'Property ' + (i + 1),
          propertyAddress: (p && p.address) || '',
          verdict: 'pending',
          required: !(it.optional || it.investor),
          processorNotes: '',
          naReason: '',
          currentDocId: '', currentFilename: '', currentSize: 0, currentUploadedAt: '', currentMimeType: '',
          aiVerdict: '', aiNotes: '', aiFindings: [], aiExtractedEntities: {}, aiReviewedAt: '', aiError: '', aiCostCents: 0,
          processorOverrideReason: '', approvedAt: '', approvedBy: '', history: [], documents: [],
        };
      });
    }
  }

  // Deploy 236.849 — fire queued AI reviews only after the review is stored
  // (each background reviewer re-reads it fresh). The stash key never persists.
  const _aiSlugs = Array.isArray(review._queueAiAfterSave) ? review._queueAiAfterSave : [];
  delete review._queueAiAfterSave;
  await store.setJSON(keySafe(id), review);
  if (_aiSlugs.length) {
    try {
      const { queueAiReviews } = await import('./_shared/loan-review-auto-attach.mjs');
      await queueAiReviews(review.id, _aiSlugs);
    } catch (e) { console.warn('loan-reviews-save: AI queue failed (non-fatal):', e && e.message); }
  }
  return json(200, { ok: true, review });
}
