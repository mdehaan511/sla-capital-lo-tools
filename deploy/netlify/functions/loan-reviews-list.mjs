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
  handleOptions, json, requireAuth, isProcessor,
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

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const url = new URL(req.url);
  const statusFilter = (url.searchParams.get('status') || 'in_progress').toLowerCase();

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const { blobs } = await store.list();

  const reviews = [];
  for (const { key } of blobs) {
    const r = await store.get(key, { type: 'json' });
    if (!r) continue;
    if (statusFilter !== 'all' && (r.status || 'in_progress') !== statusFilter) continue;
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
