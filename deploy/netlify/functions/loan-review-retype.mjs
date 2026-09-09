/**
 * loan-review-retype.mjs — POST /api/loan-review-retype   (admin only)
 *
 * Deploy 236.927 (Mike: "Can you flip any and all of them to match the sizer.")
 *
 * A Doc Review's loanType — its checklist and the RTL/DSCR pill on the
 * Documents tab — is a snapshot taken when the review is created and never
 * re-derived from the loan. Before Deploy 236.702 (Aug 25 2026) the "Start
 * Document Review" button read `_loan.product` and defaulted to RTL, so DSCR
 * sizer loans (which have no `product` field) reviewed before then carry an
 * RTL checklist: six reviews as of 2026-09-09. This flips a review to its
 * loan's toolType.
 *
 * Body: { reviewId } | { all: true }, plus dryRun?: true (report, write nothing)
 *
 * What a flip does — retypeReview(), pure and exported for the gate:
 *   - loanType := loan.toolType (dscr | rtl | guc)
 *   - investor := the new type's default, but only when it was the OLD type's
 *     default (or blank); a processor's explicit investor choice is kept
 *   - trays that exist ONLY on the old checklist: PRISTINE ones (never a doc,
 *     note, N/A, verdict or borrower request) are removed; anything with work
 *     on it stays exactly as it is, so no document is ever lost
 *   - the new checklist's missing trays are minted by syncMissingCategories,
 *     per property on a portfolio review — the same thing a page open does
 *   - custom / borrower-added trays and every existing document are untouched
 *   - the flip is stamped on the review (retypedAt/From/By + a history line)
 *
 * Returns { ok, dryRun, scanned, results: [{ id, address, owner, from, to,
 *           investor, removed, kept, added }], skipped: [{ id, reason }] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { getChecklist, getDefaultInvestor, portfolioCollateralEntries } from './_shared/loan-review-checklists.mjs';
import { syncMissingCategories } from './loan-review-sync-categories.mjs';
import { locateLoan } from './_shared/loan-locate.mjs';

const TYPES = ['dscr', 'rtl', 'guc'];

// A tray nobody has touched: no document (live or current), no processor
// note, no N/A reason, no verdict, no AI pass, not requested from the borrower.
function _isPristine(tray) {
  if (!tray || typeof tray !== 'object') return true;
  const live = (Array.isArray(tray.documents) ? tray.documents : []).filter((d) => d && !d.deleted);
  return !tray.currentDocId && !live.length &&
    !String(tray.processorNotes || '').trim() && !String(tray.naReason || '').trim() &&
    (tray.verdict || 'pending') === 'pending' && !tray.aiVerdict && !tray.borrowerRequested;
}

// Every standard slug a review of this type can carry (base slugs; per-property
// trays are "<base>__p<i>" and resolve through their base).
function _slugSet(loanType, portfolio) {
  const set = new Set(getChecklist(loanType).map((e) => e.slug));
  if (portfolio) for (const e of portfolioCollateralEntries(loanType)) set.add(e.slug);
  return set;
}

export function retypeReview(review, toType, opts = {}) {
  const out = { changed: false, from: '', to: '', investorFrom: '', investorTo: '', removed: [], kept: [], added: [] };
  if (!review || typeof review !== 'object') return out;
  const from = String(review.loanType || '').toLowerCase();
  const to = String(toType || '').toLowerCase();
  out.from = from; out.to = to;
  if (!TYPES.includes(from) || !TYPES.includes(to) || from === to) return out;

  const now = opts.now || new Date().toISOString();
  const by = opts.by || 'system';
  const portfolio = Array.isArray(review.properties) && review.properties.length > 1;
  const oldSet = _slugSet(from, portfolio);
  const newSet = _slugSet(to, portfolio);

  review.docs = review.docs || {};
  for (const key of Object.keys(review.docs)) {
    const tray = review.docs[key];
    if (!tray || typeof tray !== 'object' || tray.isCustom) continue;
    const base = String(key).replace(/__p\d+$/, '');
    if (!oldSet.has(base) || newSet.has(base)) continue;   // not an old-checklist-only standard tray
    if (_isPristine(tray)) { delete review.docs[key]; out.removed.push(key); }
    else out.kept.push(key);
  }

  review.loanType = to;
  out.investorFrom = review.investor || '';
  if (!review.investor || review.investor === getDefaultInvestor(from)) review.investor = getDefaultInvestor(to);
  out.investorTo = review.investor;

  const { added } = syncMissingCategories(review);
  out.added = added;

  const FROM = from.toUpperCase(), TO = to.toUpperCase();
  review.retypedAt = now; review.retypedFrom = from; review.retypedBy = by;
  review.history = Array.isArray(review.history) ? review.history : [];
  review.history.push({
    ts: now, action: 'retype', by, from, to,
    note: 'Checklist changed from ' + FROM + ' to ' + TO + ' to match the loan' +
      (out.removed.length ? '; removed ' + out.removed.length + ' empty ' + FROM + '-only tray(s)' : '') +
      (out.kept.length ? '; kept ' + out.kept.length + ' ' + FROM + '-only tray(s) that have work on them' : '') +
      (added.length ? '; added ' + added.length + ' ' + TO + ' tray(s)' : '') + '.',
  });
  review.updatedAt = now; review.lastEditedBy = by; review.lastEditedAt = now;
  out.changed = true;
  return out;
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-retype error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = !!body.dryRun;
  const single = !!body.reviewId;
  const self = normalizeEmail(user.email);
  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });

  let reviews = [];
  if (single) {
    const r = await store.get(keySafe(String(body.reviewId)), { type: 'json' }).catch(() => null);
    if (!r) return json(404, { error: 'Review not found' });
    reviews = [r];
  } else if (body.all === true) {
    // Same parallel walk as loan-reviews-list (a serial loop here is a timeout).
    const { blobs } = await store.list();
    reviews = (await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)))).filter(Boolean);
  } else {
    return json(400, { error: 'reviewId or all:true required' });
  }

  // Locate every review's loan in parallel; the loan's toolType is the target.
  const located = await Promise.all(reviews.map(async (review) => {
    const from = String(review.loanType || '').toLowerCase();
    if (!TYPES.includes(from)) return { review, reason: 'review type ' + (from || '(none)') + ' is not a sizer type', quiet: true };
    const src = review.source || {};
    if (!src.loanId) return { review, reason: 'no source loan' };
    let found = null;
    try {
      found = await locateLoan({ ownerKey: src.ownerKey ? keySafe(src.ownerKey) : '', clientId: src.clientId || '', loanId: src.loanId });
    } catch (e) { return { review, reason: 'locate failed: ' + ((e && e.message) || 'unknown') }; }
    if (!found || !found.loan) return { review, reason: 'loan not found' };
    const to = String(found.loan.toolType || '').toLowerCase();
    if (!TYPES.includes(to)) return { review, reason: 'loan toolType ' + (to || '(none)') };
    if (to === from) return { review, reason: 'already ' + to, quiet: true };
    return { review, to, loan: found.loan };
  }));

  const results = [], skipped = [];
  for (const item of located) {
    const { review } = item;
    if (!item.to) {
      // In "all" mode only the surprising skips are worth reporting.
      if (single || !item.quiet) skipped.push({ id: review.id, address: review.address || '', reason: item.reason });
      continue;
    }
    const r = retypeReview(review, item.to, { by: self });
    if (!r.changed) { skipped.push({ id: review.id, address: review.address || '', reason: 'no change' }); continue; }
    if (!dryRun) await store.setJSON(keySafe(review.id), review);
    results.push({
      id: review.id, address: review.address || item.loan.address || '', owner: (review.source && review.source.ownerKey) || '',
      from: r.from, to: r.to, investor: r.investorFrom + ' -> ' + r.investorTo,
      removed: r.removed, kept: r.kept, added: r.added,
    });
  }
  return json(200, { ok: true, dryRun, scanned: reviews.length, results, skipped });
}
