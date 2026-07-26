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
import { getChecklist, getDefaultInvestor } from './_shared/loan-review-checklists.mjs';

const ALLOWED_LOAN_TYPES = ['dscr', 'rtl'];

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
  }

  await store.setJSON(keySafe(id), review);
  return json(200, { ok: true, review });
}
