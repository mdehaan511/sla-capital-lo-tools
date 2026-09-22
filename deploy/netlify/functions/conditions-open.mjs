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
 *   trays: [ { slug, label, open, priorToDocs, priorToFunding, oldestDays, hasDoc,
 *              conditions: [ { id, title, priorTo, status, docLabel, createdAt, createdBy, ageDays } ],
 *              notes: [ { id, ts, author, text } ] } ],
 *   conditions: [ ...the same items, flat, for the row's counts ] } ],
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

// Deploy 237.248 (Mike: "the same form of the Conditions tab in the loan, with the
// Document Tray that you can click down and see the conditions and notes inside")
// — the unit is the TRAY, the way it is on the loan's own Conditions tab, and a
// tray brings its processor notes with it. The notes are where the back-and-forth
// actually lives ("emailed the borrower 9/18", "title says Thursday"), so a list
// of conditions without them is a list of questions with the answers left behind.
//
// The note log is `noteLog` (236.561); a tray that only ever had the old free-text
// processorNotes field shows that as one earlier note, the same fallback the page
// makes in _docNoteLog.
function notesOf(d) {
  const log = Array.isArray(d.noteLog) ? d.noteLog : [];
  if (!log.length) {
    const legacy = String(d.processorNotes || '').trim();
    if (!legacy) return [];
    return [{ id: 'legacy', ts: d.aiReviewedAt || d.uploadedAt || '', author: 'Earlier note', text: legacy.slice(0, 1200), legacy: true }];
  }
  return log.filter(Boolean).map((n) => ({
    id: String(n.id || ''),
    ts: n.ts || '',
    author: String(n.author || n.authorEmail || 'Note'),
    text: String(n.text || '').slice(0, 1200),
    editedAt: n.editedAt || '',
  })).filter((n) => n.text);
}

/** The trays on this review that have something open, each with its items. */
export function openTraysOf(review) {
  const docs = (review && review.docs) || {};
  const trays = [];
  for (const slug of Object.keys(docs)) {
    const d = docs[slug] || {};
    // A hidden tray's conditions are not on anyone's list — the tray itself is
    // out of the review (236.161), so an item on it is not outstanding work.
    if (d.hidden) continue;
    const conds = (Array.isArray(d.conditions) ? d.conditions : []).filter((c) => c && c.status !== 'cleared');
    if (!conds.length) continue;
    const conditions = conds.map((c) => ({
      id: String(c.id || ''),
      title: String(c.title || '').slice(0, 400),
      priorTo: c.priorTo === 'funding' ? 'funding' : 'docs',
      status: c.status === 'received' ? 'received' : 'outstanding',
      slug,
      docLabel: String(d.label || slug),
      createdAt: c.createdAt || '',
      createdBy: String(c.createdBy || ''),
      ageDays: ageDays(c.createdAt),
    })).sort((a, b) => {
      // Prior to DOCS first (those block the closing), then oldest first: the
      // order a processor would work them in.
      if (a.priorTo !== b.priorTo) return a.priorTo === 'docs' ? -1 : 1;
      return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
    });
    const oldest = conditions.map((c) => c.createdAt).filter(Boolean).sort()[0] || '';
    trays.push({
      slug,
      label: String(d.label || slug),
      status: String(d.status || ''),
      hasDoc: !!(d.currentDocId || (Array.isArray(d.documents) && d.documents.some((x) => x && !x.hidden))),
      open: conditions.length,
      priorToDocs: conditions.filter((c) => c.priorTo !== 'funding').length,
      priorToFunding: conditions.filter((c) => c.priorTo === 'funding').length,
      oldestAt: oldest,
      oldestDays: ageDays(oldest),
      conditions,
      notes: notesOf(d),
    });
  }
  // A tray blocking the docs outranks one blocking the funding; then the one that
  // has waited longest.
  trays.sort((a, b) => {
    if (!!a.priorToDocs !== !!b.priorToDocs) return a.priorToDocs ? -1 : 1;
    return String(a.oldestAt || '9999').localeCompare(String(b.oldestAt || '9999'));
  });
  return trays;
}

/** The same items, flat — for counting and sorting. */
export function openConditionsOf(review) {
  return openTraysOf(review).reduce((a, t) => a.concat(t.conditions), []);
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
    const trays = openTraysOf(r);
    if (!trays.length) continue;
    const conditions = trays.reduce((a, t) => a.concat(t.conditions), []);
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
      trays,
      conditions, // flat, for the counts on the row
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
