/**
 * loan-review-refresh-background.mjs — POST /api/loan-review-refresh-truth
 *
 * Deploy 236.818 — refresh a Doc Review's POINT OF TRUTH and re-run its
 * already-reviewed documents against it (Mike). The review snapshots the
 * client + loan at create time (236.73) and attaches the signed Loan
 * Application; when the application changes afterwards — a guarantor is
 * added/removed, the primary switches, the long app is re-signed — the AI
 * kept grading docs against the OLD truth (e.g. flagging Linda Gordon's
 * docs because removed guarantor Kelsey Gordon was still "Guarantor 1").
 *
 * This is a Netlify BACKGROUND function (202 immediately, 15-min budget):
 *   1. Re-reads the client + loan at their CURRENT location and repairs
 *      review.source (ownerKey/clientId drift after LO reassignment was
 *      part of the Gordon-loan staleness).
 *   2. Refreshes sourceLoanSnapshot / sourceClientSnapshot / header fields.
 *   3. Signed application: re-attaches the current PDF when it differs from
 *      the attached copy; when NO signed app exists (application reset for
 *      re-sign), flags the attached copy as outdated so nobody trusts it.
 *   4. Marks every previously-AI-reviewed doc "re-review queued" and fires
 *      loan-review-ai-background for each — those re-reviews read the review
 *      fresh, so they see the new snapshot and the current signed app.
 *
 * Auth: processor/admin JWT, OR the internal HMAC header `x-sla-internal`
 * (= HMAC(ESIGN_SEAL_SECRET, 'truth:'+loanId)) so LO-triggered mutations
 * (guarantor add/remove) can queue a refresh server-side.
 *
 * Body: { ownerKey|owner, clientId, loanId, reason?, actorEmail? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { findReviewForLoan, readSignedApp, attachToSlug } from './_shared/loan-review-auto-attach.mjs';
import { internalTruthSig, internalBgSig } from './_shared/review-truth.mjs';

const LOAN_APP_SLUG   = 'loan_application';
const RATE_SHEET_SLUG = 'term_sheet';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-refresh-background error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId || !body.loanId) return json(400, { error: 'clientId and loanId required' });
  const loanId = String(body.loanId);

  // Internal HMAC OR staff JWT.
  const hdrSig = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('x-sla-internal') || '') : '';
  const wantSig = internalTruthSig(loanId);
  let actorEmail = String(body.actorEmail || '');
  if (!(wantSig && hdrSig && hdrSig === wantSig)) {
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });
    actorEmail = normalizeEmail(user.email);
  }

  const ownerKey = keySafe(normalizeEmail(String(body.ownerKey || body.owner || '')));
  if (!ownerKey) return json(400, { error: 'ownerKey/owner required' });
  const reason = String(body.reason || 'loan application updated').slice(0, 300);

  // ── 1. Current client + loan ─────────────────────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(body.clientId), { type: 'json' }).catch(() => null);
  if (!client) return json(404, { error: 'Client not found' });
  const loan = (client.loans || []).find((l) => l && l.id === loanId);
  if (!loan) return json(404, { error: 'Loan not found on client' });

  const review = await findReviewForLoan({ ownerKey, clientId: client.id, loanId, address: loan.address });
  if (!review) return json(200, { ok: true, skipped: 'no-review' });

  const now = new Date().toISOString();
  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const docsStore   = getStore({ name: 'loan-review-docs', consistency: 'strong' });

  // ── 2. Repair source + refresh snapshots ─────────────────────────
  review.source = { kind: 'existing', ownerKey, clientId: client.id, loanId };
  review.sourceLoanSnapshot = loan;
  review.sourceClientSnapshot = {
    id: client.id,
    firstName: client.firstName || '',
    lastName:  client.lastName || '',
    email:     client.email || '',
    phone:     client.phone || '',
    entityName: client.entityName || '',
    createdAt: client.createdAt || '',
  };
  const borrowerName = ((client.firstName || '') + ' ' + (client.lastName || '')).replace(/\s+/g, ' ').trim();
  if (borrowerName) review.borrowerName = borrowerName;
  if (loan.address) review.address = loan.address;
  if (loan.loanAmt) review.loanAmount = Number(loan.loanAmt || 0);
  review._truthRefreshedAt = now;
  review._truthRefreshReason = reason;
  review._truthRefreshedBy = actorEmail || 'internal';

  // ── 3. Signed application ────────────────────────────────────────
  let appAction = 'unchanged';
  try {
    const signedApp = await readSignedApp({ ownerKey, clientId: client.id, loanId });
    const tray = review.docs && review.docs[LOAN_APP_SLUG];
    if (signedApp && signedApp.bytes && tray) {
      // Re-attach only when the current attachment isn't already this exact
      // PDF (the attach copies these bytes verbatim, so size equality means
      // same document — avoids duplicating the auto-attach that runs at
      // first-time signing).
      if (!tray.currentDocId || Number(tray.currentSize || 0) !== signedApp.bytes.length) {
        const filename = 'Signed Loan Application - ' + String(loan.address || 'loan').split(',')[0].trim() + '.pdf';
        attachToSlug({
          review, slug: LOAN_APP_SLUG, bytes: signedApp.bytes,
          filename, mimeType: 'application/pdf',
          sourceNote: 'point of truth refreshed (' + reason + ')',
          actorEmail: actorEmail || 'auto:truth-refresh',
        });
        await docsStore.set(keySafe(review.id) + '/' + tray.currentDocId, signedApp.bytes, {
          metadata: {
            reviewId: review.id, slug: LOAN_APP_SLUG, filename, mimeType: 'application/pdf',
            uploadedAt: now, uploadedBy: actorEmail || 'auto:truth-refresh', source: 'signed_applications',
          },
        });
        appAction = 'reattached';
      }
    } else if (!signedApp && tray && tray.currentDocId) {
      // Application was reset for re-sign (or never moved with the loan) —
      // the attached copy no longer reflects the deal. Flag it.
      tray.aiVerdict = 'needs_manual_review';
      tray.aiNotes = 'The loan application changed (' + reason + ') and no current signed application is on file — this attached copy is OUTDATED. It will refresh automatically when the corrected application is signed.';
      tray.aiReviewedAt = now;
      tray.verdict = 'pending';
      tray.approvedAt = ''; tray.approvedBy = '';
      appAction = 'flagged-stale';
    }
  } catch (e) {
    console.warn('truth-refresh: signed-app step failed (non-fatal):', e && e.message);
  }

  // ── 3b. Deploy 236.850 (Mike, Locust Ave loan) — a GUARANTOR change makes
  // every already-signed source document unacceptable: the parties on the
  // signed copy are no longer the parties on the deal. Flag the attached
  // signed application (when it wasn't just reattached fresh above) AND the
  // signed rate sheet / term sheet as needing re-signature. Both clear
  // themselves: a re-signed application re-attaches via this refresher /
  // borrower-info-sign, and a newly signed rate sheet attaches via the
  // envelope-sign completion hook (236.849) — attachToSlug resets the flag.
  const guarantorsChanged = body.guarantorsChanged === true || /guarantor/i.test(reason);
  let flagged = [];
  if (guarantorsChanged) {
    const flagTray = (slug, what, how) => {
      const t = review.docs && review.docs[slug];
      if (!t || !t.currentDocId) return false;
      t.verdict = 'pending';
      t.approvedAt = ''; t.approvedBy = '';
      t.aiVerdict = 'needs_manual_review';
      t.aiReviewedAt = now;
      t.aiNotes = 'GUARANTORS CHANGED (' + reason + ') — the signed ' + what +
        ' on file was executed by the previous guarantor set and is NO LONGER ACCEPTABLE. ' + how;
      return true;
    };
    if (appAction === 'unchanged' &&
        flagTray(LOAN_APP_SLUG, 'loan application',
          'Re-send the application for signature; the corrected signed copy will attach and clear this automatically.')) {
      appAction = 'flagged-guarantor-change';
      flagged.push(LOAN_APP_SLUG);
    }
    if (flagTray(RATE_SHEET_SLUG, 'rate sheet / term sheet',
        'Re-send the rate sheet for signature; the newly signed copy will attach and clear this automatically.')) {
      flagged.push(RATE_SHEET_SLUG);
    }
  }

  // ── 4. Queue re-reviews ──────────────────────────────────────────
  // Coalesce: an identical refresh within 10 minutes (double-fired completion
  // event, double-click) still refreshes the snapshot above but doesn't pay
  // for a second round of AI re-reviews.
  const _prevAt = new Date(review._truthPrevRefreshAt || 0).getTime();
  const _coalesce = review._truthPrevRefreshReason === reason && isFinite(_prevAt) && (Date.now() - _prevAt) < 10 * 60 * 1000;
  review._truthPrevRefreshAt = now;
  review._truthPrevRefreshReason = reason;
  const rerunSlugs = [];
  if (!_coalesce) for (const slug of Object.keys(review.docs || {})) {
    if (slug === LOAN_APP_SLUG || slug === RATE_SHEET_SLUG) continue;
    const ds = review.docs[slug];
    if (!ds || !ds.currentDocId || ds.noReview) continue;
    if (ds.aiSkippedForMimeType || ds.aiSkippedNoRubric) continue;
    const v = String(ds.aiVerdict || '');
    // Requeue docs that were AI-reviewed AND docs stuck aiReviewing (a
    // queued background review whose fire was lost leaves the flag on
    // forever — Deploy 236.819: re-firing is safe, the reviewer merges
    // surgically, and a genuinely in-flight duplicate just costs one
    // redundant call against the same fresh truth).
    if (!ds.aiReviewing && (!v || v === 'stored')) continue;
    ds.aiReviewing = true;
    ds.aiVerdict = '';
    ds.aiNotes = 'Re-review queued — point of truth updated (' + reason + ').';
    ds.aiError = '';
    rerunSlugs.push(slug);
  }

  review.updatedAt = now;
  review.lastEditedBy = actorEmail || 'auto:truth-refresh';
  review.lastEditedAt = now;
  await reviewStore.setJSON(keySafe(review.id), review);

  // Fire the per-doc background reviewers (each reads the review fresh, so
  // they all see the snapshot + attachment written above).
  const base = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
  let fired = 0;
  for (const slug of rerunSlugs) {
    try {
      const r = await fetch(base + '/.netlify/functions/loan-review-ai-background', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sla-internal': internalBgSig(review.id, slug) },
        body: JSON.stringify({ reviewId: review.id, slug }),
      });
      if (r.status === 202 || r.ok) fired++;
      else console.warn('truth-refresh: bg fire for ' + slug + ' got ' + r.status);
    } catch (e) {
      console.warn('truth-refresh: bg fire failed for ' + slug + ':', e && e.message);
    }
  }

  console.log('[truth-refresh] loan ' + loanId + ' review ' + review.id + ': app=' + appAction + ' flagged=' + flagged.join(',') + ' requeued=' + rerunSlugs.length + ' fired=' + fired + ' (' + reason + ')');
  return json(200, { ok: true, reviewId: review.id, appAction, flagged, requeued: rerunSlugs.length, fired });
}
