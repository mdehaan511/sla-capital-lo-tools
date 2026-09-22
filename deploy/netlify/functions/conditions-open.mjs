/**
 * conditions-open.mjs — GET /api/conditions-open
 *
 * Deploy 237.244 (Mike: "a page that shows all open conditions for all loans …
 * make it a tab at the top of the processing pipeline by Team Overview").
 *
 * Every open condition on every loan, grouped by loan. A condition lives on the
 * document review — review.docs[slug].conditions[] — so the only way to answer
 * "what is outstanding across the book" is to read the reviews. The loan record
 * carries a COUNT (loan.openConditions, 236.564 / 237.102) but never the items,
 * which is what a processor working a morning list actually needs.
 *
 * Cleared conditions are left out by definition: "open" is outstanding + received
 * (the same rule the Conditions tab on a loan uses — 237.136 _onConditionsTab).
 *
 * Scope mirrors loan-reviews-list: staff see the whole book, a loan officer sees
 * the loans they own, by the review's own source.ownerKey and never by anything
 * the caller sent.
 *
 * Response 200: { loans: [ { reviewId, address, borrowerName, loanType, loanAmount,
 *   loEmail, processorEmail, expectedCloseDate, href, open, oldestAt,
 *   conditions: [ { id, title, priorTo, status, slug, docLabel, createdAt, createdBy, ageDays } ] } ],
 *   totals: { loans, open, priorToDocs, priorToFunding } }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('conditions-open error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

const DAY = 86400000;
function ageDays(iso) {
  const t = Date.parse(String(iso || ''));
  if (!isFinite(t)) return null;
  return Math.max(0, Math.floor((Date.now() - t) / DAY));
}

// The loan this review is for, as a link the pipeline can open.
function hrefFor(r) {
  const s = (r && r.source) || {};
  if (!s.loanId) return '';
  let h = '/loan-details/' + encodeURIComponent(s.loanId);
  if (s.ownerKey) h += '?owner=' + encodeURIComponent(String(s.ownerKey).replace(/_at_/g, '@').replace(/_dot_/g, '.'));
  return h + '#documents';
}

export function openConditionsOf(review) {
  const docs = (review && review.docs) || {};
  const out = [];
  for (const slug of Object.keys(docs)) {
    const d = docs[slug] || {};
    // A hidden tray's conditions are not on anyone's list — the tray itself is
    // out of the review (236.161), so an item on it is not outstanding work.
    if (d.hidden) continue;
    const conds = Array.isArray(d.conditions) ? d.conditions : [];
    for (const c of conds) {
      if (!c || c.status === 'cleared') continue;
      out.push({
        id: String(c.id || ''),
        title: String(c.title || '').slice(0, 400),
        priorTo: c.priorTo === 'funding' ? 'funding' : 'docs',
        status: c.status === 'received' ? 'received' : 'outstanding',
        slug,
        docLabel: String(d.label || slug),
        createdAt: c.createdAt || '',
        createdBy: String(c.createdBy || ''),
        ageDays: ageDays(c.createdAt),
      });
    }
  }
  // Prior to DOCS first (those block the closing), then oldest first: the order a
  // processor would work them in.
  out.sort((a, b) => {
    if (a.priorTo !== b.priorTo) return a.priorTo === 'docs' ? -1 : 1;
    return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
  });
  return out;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const staff = isProcessor(user);
  const mine = keySafe(normalizeEmail(user.email || ''));
  if (!staff && !mine) return json(403, { error: 'Not authorized' });

  const store = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const { blobs } = await store.list();
  // In PARALLEL, for the reason loan-reviews-list spells out: a serial loop over
  // a store is a timeout waiting to happen (236.881).
  const recs = await Promise.all(blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)));

  const loans = [];
  const totals = { loans: 0, open: 0, priorToDocs: 0, priorToFunding: 0 };
  for (const r of recs) {
    if (!r) continue;
    if (!staff && ((r.source && r.source.ownerKey) || '') !== mine) continue;
    const conditions = openConditionsOf(r);
    if (!conditions.length) continue;
    const oldest = conditions.map((c) => c.createdAt).filter(Boolean).sort()[0] || '';
    loans.push({
      reviewId: r.id || '',
      address: r.address || '',
      borrowerName: r.borrowerName || '',
      loanType: r.loanType || '',
      loanAmount: r.loanAmount || 0,
      loEmail: r.loEmail || '',
      processorEmail: r.processorEmail || '',
      expectedCloseDate: r.expectedCloseDate || '',
      status: r.status || 'in_progress',
      source: r.source || null,
      href: hrefFor(r),
      open: conditions.length,
      oldestAt: oldest,
      oldestDays: ageDays(oldest),
      conditions,
    });
    totals.loans += 1;
    totals.open += conditions.length;
    conditions.forEach((c) => { if (c.priorTo === 'funding') totals.priorToFunding += 1; else totals.priorToDocs += 1; });
  }

  // The loan whose oldest condition has sat longest comes first — the list reads
  // as a worklist rather than an index.
  loans.sort((a, b) => String(a.oldestAt || '9999').localeCompare(String(b.oldestAt || '9999')));

  return json(200, { loans, totals });
}
