/**
 * loan-reviews-get.mjs — GET /api/loan-reviews-get?id=<reviewId>
 *
 * Returns the full loan-review record (including per-doc state and
 * upload history). Used by loan-review-detail.html.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, keySafe,
} from './_shared/auth.mjs';

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

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const url = new URL(req.url);
  const id = url.searchParams.get('id');
  if (!id) return json(400, { error: 'id required' });

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const r = await store.get(keySafe(id), { type: 'json' });
  if (!r) return json(404, { error: 'Review not found' });
  return json(200, { review: r });
}
