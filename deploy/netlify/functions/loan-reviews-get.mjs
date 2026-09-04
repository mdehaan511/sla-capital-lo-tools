/**
 * loan-reviews-get.mjs — GET /api/loan-reviews-get?id=<reviewId>
 *
 * Returns the full loan-review record (including per-doc state and
 * upload history). Used by loan-review-detail.html.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
// Deploy 236.881 — LOs may now read the review for their OWN loans, narrowed
// to the tray set in LO_VISIBLE_SLUGS. Filtering happens here, before the
// record leaves the server.
import { filterReviewForUser } from './_shared/loan-review-visibility.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-reviews-get error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json(400, { error: 'id required' });

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const r = await store.get(keySafe(id), { type: 'json' });
  if (!r) return json(404, { error: 'Review not found' });

  // Staff see the whole file.
  if (isProcessor(user)) return json(200, { review: r });

  // Deploy 236.881 — a Loan Officer reads the review for a loan THEY OWN,
  // narrowed to the trays in LO_VISIBLE_SLUGS. Ownership is the review's
  // own source.ownerKey, which is the loan's owner key — not anything the
  // caller supplied.
  const mine = keySafe(normalizeEmail(user.email || ''));
  const owner = (r.source && r.source.ownerKey) || '';
  if (!mine || owner !== mine) {
    return json(403, { error: 'This document review belongs to another loan officer.' });
  }
  return json(200, { review: filterReviewForUser(r, user) });
}
