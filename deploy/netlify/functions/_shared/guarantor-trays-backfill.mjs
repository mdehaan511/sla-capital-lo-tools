/**
 * _shared/guarantor-trays-backfill.mjs — Deploy 237.106 (Mike: "push live on
 * all loans with multiple guarantors as well")
 *
 * Walks EVERY in-progress review, re-resolves its guarantor roster from the
 * loan, and splits the guarantor documents per person (guarantor-trays.mjs).
 * Idempotent — a review that is already split is a no-op. Newest-first with a
 * time budget, like the fix-reminder cron. Used by:
 *   • guarantor-trays-backfill-background (post-deploy, one shot)
 *   • guarantor-trays-cron (nightly, so a loan that gains a second guarantor
 *     without anyone opening Doc Review still gets its trays)
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';
import { locateLoan } from './loan-locate.mjs';
import { resolveGuarantorNames } from './review-truth.mjs';
import { adoptGuarantorsFromLoan, expandGuarantorTrays } from './guarantor-trays.mjs';

export async function backfillGuarantorTrays({ budgetMs = 24000, onlyInProgress = true } = {}) {
  const started = Date.now();
  const stats = { scanned: 0, multi: 0, updated: 0, skipped: 0, failed: 0, addedTrays: 0, truncated: false, updatedIds: [] };
  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const { blobs } = await store.list();
  const keys = blobs.map((b) => b.key).filter((k) => !k.startsWith('_')).sort().reverse();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  for (const key of keys) {
    if (Date.now() - started > budgetMs) { stats.truncated = true; break; }
    let review;
    try { review = await store.get(key, { type: 'json' }); } catch (_) { review = null; }
    if (!review || !review.id) continue;
    stats.scanned++;
    if (onlyInProgress && review.status && review.status !== 'in_progress') { stats.skipped++; continue; }
    const src = review.source || {};
    if (!src.loanId) { stats.skipped++; continue; }
    try {
      const found = await locateLoan({ ownerKey: src.ownerKey ? keySafe(src.ownerKey) : '', clientId: src.clientId || '', loanId: src.loanId, clientsStore });
      if (!found || !found.loan) { stats.skipped++; continue; }
      const names = await resolveGuarantorNames({ ownerKey: found.ownerKey, client: found.client, loan: found.loan, clientsStore });
      if (names.length < 2 && !(Array.isArray(review.guarantors) && review.guarantors.length > 1)) { stats.skipped++; continue; }
      stats.multi++;
      review.docs = review.docs || {};
      if (names.length) review.guarantorNames = names;
      const a = adoptGuarantorsFromLoan(review, names);
      const added = expandGuarantorTrays(review);
      if (a.adopted || a.migrated.length || a.renamed || added.length) {
        review.updatedAt = new Date().toISOString();
        await store.setJSON(keySafe(review.id), review);
        stats.updated++; stats.addedTrays += added.length; stats.updatedIds.push(review.id);
      }
    } catch (e) {
      stats.failed++;
      console.warn('[guarantor-trays] ' + review.id + ' failed:', e && e.message);
    }
  }
  stats.ms = Date.now() - started;
  console.log('[guarantor-trays] backfill', JSON.stringify(Object.assign({}, stats, { updatedIds: stats.updatedIds.length })));
  return stats;
}
