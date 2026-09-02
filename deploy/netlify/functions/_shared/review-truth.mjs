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
 */
export async function queueTruthRefresh(opts) {
  try {
    const { ownerKey, clientId, loanId, reason, actorEmail } = opts || {};
    if (!loanId || !ownerKey || !clientId) return { ok: false, reason: 'missing args' };
    const sig = internalTruthSig(loanId);
    if (!sig) return { ok: false, reason: 'no secret configured' };
    const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
    const r = await fetch(base + '/.netlify/functions/loan-review-refresh-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-sla-internal': sig },
      body: JSON.stringify({ ownerKey, clientId, loanId, reason: reason || '', actorEmail: actorEmail || '' }),
    });
    return { ok: r.status === 202 || r.ok, status: r.status };
  } catch (e) {
    console.warn('[review-truth] queue failed (non-fatal):', e && e.message);
    return { ok: false, reason: e && e.message };
  }
}
