/**
 * loan-reviews-delete.mjs — POST /api/loan-reviews-delete
 *
 * Deletes a review record AND every doc blob associated with it
 * (purges everything under loan-review-docs/<reviewId>/). Per spec
 * point #7 ("Documents do not need to be stored long term in the
 * platform but can be deleted after review"), this is the finalize/
 * purge step.
 *
 * Body: { id }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, keySafe,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('loan-reviews-delete error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body || !body.id) return json(400, { error: 'id required' });
  const id = keySafe(body.id);

  // Purge all docs first so partial-delete leaves no orphan blob bytes.
  const docsStore = getStore({ name: 'loan-review-docs', consistency: 'strong' });
  const { blobs } = await docsStore.list({ prefix: id + '/' });
  let docsPurged = 0;
  for (const { key } of blobs) {
    try { await docsStore.delete(key); docsPurged += 1; } catch (e) {
      console.warn('loan-reviews-delete: doc purge failed for', key, e && e.message);
    }
  }

  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  await reviewStore.delete(id);

  return json(200, { ok: true, docsPurged });
}
