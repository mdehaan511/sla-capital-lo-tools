/**
 * _shared/review-truth.mjs — Deploy 236.818
 *
 * The Doc Review's "point of truth" (sourceLoanSnapshot / sourceClientSnapshot
 * + the attached signed Loan Application) is captured at review-create time and
 * used to go STALE when the underlying application changed — a removed
 * guarantor kept being graded against (Mike's Linda/Kelsey Gordon loan: docs
 * flagged because "Guarantor 1 Kelsey Gordon, score 600" was still the truth
 * after Kelsey was removed).
 *
 * This module is the glue for the fix:
 *   - queueTruthRefresh(...)  — fire-and-forget POST to the background
 *     refresher (loan-review-refresh-background.mjs), callable from ANY
 *     server-side flow that mutates the application (guarantor add/remove/
 *     make-primary, long-app completion). Auth is an internal HMAC header,
 *     so an LO-triggered mutation can queue it without a processor JWT.
 *   - internalTruthSig / internalBgSig — the HMAC pair (ESIGN_SEAL_SECRET)
 *     the background functions accept in place of a staff JWT.
 */
import crypto from 'node:crypto';
import { getStore } from '@netlify/blobs';   // Deploy 237.049
import { keySafe } from './auth.mjs';        // Deploy 237.049

function _secret() { return process.env.ESIGN_SEAL_SECRET || ''; }

export function internalTruthSig(loanId) {
  if (!_secret()) return '';
  return crypto.createHmac('sha256', _secret()).update('truth:' + String(loanId || '')).digest('hex');
}

export function internalBgSig(reviewId, slug) {
  if (!_secret()) return '';
  return crypto.createHmac('sha256', _secret()).update('bg:' + String(reviewId || '') + ':' + String(slug || '')).digest('hex');
}

/**
 * Queue a point-of-truth refresh for the loan's review. Fire-and-forget:
 * the background function returns 202 immediately; failures are logged and
 * swallowed (a refresh hiccup must never block the mutation that queued it).
 *
 * @param {string} opts.ownerKey  keySafe'd owner (raw email)
 * @param {string} opts.clientId  the loan-holding client's CURRENT id
 * @param {string} opts.loanId
 * @param {string} opts.reason    human-readable, lands in the re-review notes
 * @param {string} opts.actorEmail
 * @param {boolean} opts.guarantorsChanged  Deploy 236.850 — the refresher then
 *   flags any still-signed loan application / rate sheet as needing re-signature
 *   (signed docs must not silently carry an outdated guarantor set).
 */
export async function queueTruthRefresh(opts) {
  try {
    const { ownerKey, clientId, loanId, reason, actorEmail, guarantorsChanged } = opts || {};
    if (!loanId || !ownerKey || !clientId) return { ok: false, reason: 'missing args' };
    const sig = internalTruthSig(loanId);
    if (!sig) return { ok: false, reason: 'no secret configured' };
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
    const r = await fetch(base + '/.netlify/functions/loan-review-refresh-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sla-internal': sig },
      body: JSON.stringify({ ownerKey, clientId, loanId, reason: reason || '', actorEmail: actorEmail || '', guarantorsChanged: guarantorsChanged === true }),
    });
    return { ok: r.status === 202 || r.ok, status: r.status };
  } catch (e) {
    console.warn('[review-truth] queue failed (non-fatal):', e && e.message);
    return { ok: false, reason: e && e.message };
  }
}

// Deploy 237.074 (Mike) -- the point of truth also went stale when the TERMS changed:
// a sizer re-price (higher purchase price / lower loan = bigger down payment)
// or a Loan Details Terms/Valuation edit never queued the refresher, so the
// UW panel kept showing the old liquidity requirement and the AI kept grading
// bank statements against it. Callers diff before/after and queue when one of
// these fields moved. Cheap no-op when the loan has no review (refresher
// returns skipped:no-review) and coalesced server-side within 10 minutes.
export const TRUTH_MATERIAL_FIELDS = [
  'loanAmt', 'purchasePrice', 'rehabBudget', 'arv', 'arvBpo', 'aivBpo', 'propValue', 'currentLoanAmt',
  'rate', 'points', 'loanTerm', 'loanType', 'isIO', 'downPayment', 'initialAdvance', 'holdback',
  'loanPurpose', 'purpose', 'transactionType', 'address', 'entityName', 'llcName', 'rent', 'monthlyRent',
  'toolType', 'fundingDate', 'expectedCloseDate', 'closeDate',
];
export function truthMaterialChanges(before, after) {
  const b = before || {}, a = after || {};
  const norm = (v) => (v == null ? '' : String(v)).trim();
  return TRUTH_MATERIAL_FIELDS.filter((k) => norm(b[k]) !== norm(a[k]));
}
export async function queueTruthRefreshIfMaterial(opts) {
  try {
    const changed = truthMaterialChanges(opts && opts.before, opts && opts.after);
    if (!changed.length) return { ok: true, skipped: 'no-material-change' };
    return await queueTruthRefresh({
      ownerKey: opts.ownerKey, clientId: opts.clientId, loanId: opts.loanId, actorEmail: opts.actorEmail,
      reason: (opts.reason || 'loan terms updated') + ': ' + changed.slice(0, 6).join(', ') + (changed.length > 6 ? ', …' : ''),
    });
  } catch (e) { return { ok: false, reason: e && e.message }; }
}

// Deploy 237.049 -- Articles-as-truth follow-up (237.041/043). Every tray whose
// rubric compares the entity name to the ENTITY NAME OF RECORD is graded either
// "unclear - Articles not reviewed yet" or against a stale name until the Articles
// tray is (re)reviewed. Once the Articles land an extracted llcName, re-queue those
// dependents in the background so the processor doesn't Retry AI on each by hand.
// Same re-read + aiReviewing flag + internal-HMAC kick as the truth refresher.
// Skips: trays with no doc, storage-only trays, trays already reviewing, trays a
// human already approved / marked N/A, trays never graded (a fresh upload reads
// the name of record anyway), trays graded after this Articles review, and -- when
// the name did not change -- trays graded after the PREVIOUS Articles review.
export const ENTITY_NAME_DEPENDENT_SLUGS = [
  'certificate_of_good_standing', 'ein_letter', 'ein_or_w9', 'ofac_entity',
  'operating_agreement', 'entity_background_check', 'foreign_entity_registration', 'loan_application',
];
export async function queueEntityNameDependents(reviewId, prevArticles) {
  try {
    if (!reviewId || !_secret()) return { ok: false, queued: [] };
    const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const review = await store.get(keySafe(reviewId), { type: 'json' });
    const art = review && review.docs && review.docs.articles_of_organization;
    const ee = (art && art.aiExtractedEntities) || {};
    const name = (art && art.aiReviewedAt && typeof ee.llcName === 'string') ? ee.llcName.trim() : '';
    if (!name) return { ok: true, queued: [] };
    const prevName = String((prevArticles && prevArticles.llcName) || '').trim();
    const prevAt = String((prevArticles && prevArticles.aiReviewedAt) || '');
    const nameChanged = !prevName || prevName.toLowerCase() !== name.toLowerCase();
    const queued = [];
    for (const slug of ENTITY_NAME_DEPENDENT_SLUGS) {
      const ds = review.docs[slug];
      if (!ds || !ds.currentDocId || ds.hidden || ds.noReview || ds.aiReviewing) continue;
      if (ds.verdict === 'approved' || ds.verdict === 'na') continue;
      if (!ds.aiReviewedAt) continue;
      if (ds.aiReviewedAt >= art.aiReviewedAt) continue;
      if (!nameChanged && prevAt && ds.aiReviewedAt >= prevAt) continue;
      ds.aiReviewing = true;
      queued.push(slug);
    }
    if (!queued.length) return { ok: true, queued };
    review.lastEntityNameRequeue = { at: new Date().toISOString(), name, slugs: queued };
    review.updatedAt = new Date().toISOString();
    await store.setJSON(keySafe(review.id), review);
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
    for (const slug of queued) {
      let ok = false;
      try {
        const r = await fetch(base + '/.netlify/functions/loan-review-ai-background', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-sla-internal': internalBgSig(review.id, slug) },
          body: JSON.stringify({ reviewId: review.id, slug }),
        });
        ok = r.status === 202 || r.ok;
        if (!ok) console.warn('[review-truth] entity-name requeue kickoff HTTP', r.status, slug);
      } catch (e) { console.warn('[review-truth] entity-name requeue kickoff failed:', slug, e && e.message); }
      if (!ok) {
        // don't leave the tray spinning: clear the flag we just set
        try {
          const fresh = await store.get(keySafe(review.id), { type: 'json' });
          if (fresh && fresh.docs && fresh.docs[slug]) { fresh.docs[slug].aiReviewing = false; await store.setJSON(keySafe(fresh.id), fresh); }
        } catch (_) {}
      }
    }
    console.log('[review-truth] entity-name requeue', review.id, name, queued.join(','));
    return { ok: true, queued };
  } catch (e) {
    console.warn('[review-truth] entity-name requeue failed (non-fatal):', e && e.message);
    return { ok: false, queued: [] };
  }
}
