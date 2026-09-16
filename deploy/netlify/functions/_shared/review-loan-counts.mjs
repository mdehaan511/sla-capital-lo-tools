/**
 * _shared/review-loan-counts.mjs — Deploy 237.102 (Mike)
 *
 * The Processing Pipeline loads LOANS, not reviews, so the per-loan document
 * status it shows has to be denormalized onto the loan record every time the
 * review changes. Deploy 236.564 did this for open conditions
 * (loan.openConditions / totalConditions, from loan-reviews-save only). This
 * generalizes it: one helper, called from every endpoint that writes review
 * docs (loan-reviews-save, the two upload paths, the borrower upload, doc move).
 *
 * Counts (ACTIVE trays only — hidden trays and N/A trays never count; an
 * optional tray with nothing in it is not "active" either):
 *   docsActive      — active trays
 *   docsCollected   — active trays holding at least one live document
 *   docsApproved    — active trays UW-approved (uwVerdict 'approved')
 *   docsConditions  — active trays with at least one open (not cleared) condition
 *   openConditions / totalConditions — condition ITEMS across all trays (unchanged)
 *
 * Mirrors the page's _stageOf / _trayHasDoc in loan-doc-review.js.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { writeClient } from './client-write.mjs';

function hasDoc(d) {
  return !!(d && (d.currentDocId || (Array.isArray(d.documents) && d.documents.some((x) => x && !x.hidden))));
}

export function reviewDocCounts(review) {
  const docs = (review && review.docs) || {};
  const c = { docsActive: 0, docsCollected: 0, docsApproved: 0, docsConditions: 0, openConditions: 0, totalConditions: 0 };
  for (const slug of Object.keys(docs)) {
    const d = docs[slug];
    if (!d) continue;
    const conds = Array.isArray(d.conditions) ? d.conditions : [];
    let open = 0;
    for (const x of conds) { c.totalConditions += 1; if (x && x.status !== 'cleared') { c.openConditions += 1; open += 1; } }
    if (d.hidden || d.verdict === 'na' || d.noReview) continue;
    const has = hasDoc(d);
    if (d.required === false && !has) continue; // optional + empty = not on the board
    c.docsActive += 1;
    if (has) c.docsCollected += 1;
    if (d.uwVerdict === 'approved' && (d.verdict === 'approved' || d.verdict === 'na')) c.docsApproved += 1;
    if (open > 0) c.docsConditions += 1;
  }
  return c;
}

const KEYS = ['docsActive', 'docsCollected', 'docsApproved', 'docsConditions', 'openConditions', 'totalConditions'];

/**
 * Mirror the counts onto the loan record. Only writes when something moved.
 * Never throws — the review write that triggered it must never fail over this.
 */
export async function syncReviewCountsToLoan(review) {
  try {
    const src = review && review.source;
    if (!src || src.kind !== 'existing' || !src.clientId || !src.loanId || !src.ownerKey) return { ok: false, skipped: 'no-source' };
    const counts = reviewDocCounts(review);
    const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
    const ownerKey = keySafe(src.ownerKey);
    const client = await clientsStore.get(ownerKey + '/' + keySafe(src.clientId), { type: 'json' });
    if (!client || !Array.isArray(client.loans)) return { ok: false, skipped: 'no-client' };
    const loan = client.loans.find((l) => l && l.id === src.loanId);
    if (!loan) return { ok: false, skipped: 'no-loan' };
    const changed = KEYS.filter((k) => (Number(loan[k]) || 0) !== counts[k]);
    if (!changed.length) return { ok: true, unchanged: true, counts };
    for (const k of KEYS) loan[k] = counts[k];
    loan.updatedAt = new Date().toISOString();
    await writeClient(ownerKey, client, { clientsStore });
    return { ok: true, changed, counts };
  } catch (e) {
    console.warn('[review-loan-counts] sync failed (non-fatal):', e && e.message);
    return { ok: false, error: e && e.message };
  }
}
