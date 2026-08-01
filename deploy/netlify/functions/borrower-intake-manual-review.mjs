/**
 * borrower-intake-manual-review.mjs — POST /api/borrower-intake-manual-review
 *
 * Deploy 236.518 — the borrower asks a human to review a document the AI
 * flagged (instead of re-uploading). Sets a manualReviewRequested flag on the
 * review's docState so the processor sees a "Manual review requested" notice on
 * that tray in the internal Document Review.
 *
 * Body: { loanId, primaryClientId, ownerKey, slug, note? }
 * Auth: canReadLoan (borrower grant).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { canReadLoan } from './_shared/access.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-intake-manual-review error:', e);
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
  const { loanId, primaryClientId, ownerKey } = body;
  const slug = String(body.slug || '').trim();
  const note = String(body.note || '').slice(0, 1000);
  if (!loanId || !slug) return json(400, { error: 'loanId and slug required' });

  let loan = null;
  try {
    if (primaryClientId && ownerKey) {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) || null : null;
    }
  } catch (_) {}
  const perm = await canReadLoan(user, loan || { id: loanId, ownerKey }, { ownerKey, loanId });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  let review = null, reviewKey = null;
  try {
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' });
      if (!r) continue;
      if (r.source && r.source.loanId === loanId) { review = r; reviewKey = key; break; }
      if (r.address && loan && loan.address &&
          String(r.address).toLowerCase().trim() === String(loan.address).toLowerCase().trim()) { review = r; reviewKey = key; break; }
    }
  } catch (e) { console.warn('[borrower-intake-manual-review] lookup failed:', e && e.message); }

  if (!review || !review.docs || !review.docs[slug]) {
    return json(404, { error: 'No uploaded document for that item yet.' });
  }
  const now = new Date().toISOString();
  const d = review.docs[slug];
  d.manualReviewRequested = true;
  d.manualReviewNote = note;
  d.manualReviewRequestedAt = now;
  d.manualReviewRequestedBy = normalizeEmail(user.email);
  d.borrowerStatus = 'manual_review';
  review.docs[slug] = d;
  review.updatedAt = now;

  try { await reviewsStore.setJSON(reviewKey || keySafe(review.id), review); }
  catch (e) { return json(500, { error: 'Failed to save: ' + (e && e.message || 'unknown') }); }

  return json(200, { ok: true, slug, manualReviewRequested: true });
}
