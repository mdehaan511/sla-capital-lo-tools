/**
 * loan-reviews-list.mjs — GET /api/loan-reviews
 *
 * Returns every loan review in the system. Phase 1 keeps reviews un-
 * scoped (processors and admins both see all in-progress reviews) per
 * spec point #6 of the build conversation.
 *
 * Response: { reviews: [...] }
 *
 * Query params:
 *   ?status=in_progress (default) | finalized | all
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-reviews-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  // Deploy 236.881 — LOs list the reviews for their OWN loans (the
  // Documents tab was processor-only until now). Staff see everything.
  const staff = isProcessor(user);
  const mine = keySafe(normalizeEmail(user.email || ''));
  if (!staff && !mine) return json(403, { error: 'Not authorized' });

  const url = new URL(req.url);
  const statusFilter = (url.searchParams.get('status') || 'in_progress').toLowerCase();

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const { blobs } = await store.list();

  // Deploy 236.881 — read in PARALLEL. This walked every review blob one
  // await at a time; at 56 reviews that was slow enough to hang the tab, and
  // LOs are about to start hitting it too. Same lesson as the profiles-store
  // scan: a serial loop over a store is a timeout waiting to happen.
  const recs = await Promise.all(
    blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null))
  );

  const reviews = [];
  for (const r of recs) {
    if (!r) continue;
    if (statusFilter !== 'all' && (r.status || 'in_progress') !== statusFilter) continue;
    // An LO's list is their own loans only. Scoped by the review's own
    // source.ownerKey, never by anything the caller sent.
    if (!staff && ((r.source && r.source.ownerKey) || '') !== mine) continue;
    // Trim heavy fields (doc history) before returning the index list.
    // Detail page calls loan-reviews-get for the full record.
    reviews.push(summarize(r));
  }

  // Most-recently-updated first.
  reviews.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));

  return json(200, { reviews });
}

function summarize(r) {
  const docs = r.docs || {};
  let totalRequired = 0;
  let totalReviewed = 0;
  for (const slug of Object.keys(docs)) {
    const d = docs[slug];
    if (d && d.required === false) continue;
    totalRequired += 1;
    if (d && (d.verdict === 'approved' || d.verdict === 'na')) totalReviewed += 1;
  }
  return {
    id:                  r.id,
    status:              r.status || 'in_progress',
    loanType:            r.loanType || '',
    address:             r.address || '',
    borrowerName:        r.borrowerName || '',
    loanAmount:          r.loanAmount || 0,
    loEmail:             r.loEmail || '',
    processorEmail:      r.processorEmail || '',
    expectedCloseDate:   r.expectedCloseDate || '',
    createdAt:           r.createdAt || '',
    updatedAt:           r.updatedAt || '',
    docsReviewed:        totalReviewed,
    docsTotal:           totalRequired,
    source:              r.source || null,
    aiCostCents:         r.aiCostCents || 0,
  };
}
