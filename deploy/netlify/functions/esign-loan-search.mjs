/**
 * esign-loan-search.mjs — GET /api/esign-loan-search
 *
 * Deploy 237.028 (Mike): the loan picker behind "File to loan" on a completed
 * E-Sign document. Same PostgREST search the Mail Room uses (address, borrower
 * / entity name, SLA-YYYYMMDD-NNNN) so both tools find loans the same way.
 *
 *   ?q=<text>                         → { loans:[candidate…] }  (≤25)
 *   ?slugsFor=<loanId>&clientId=&owner= → { slugs:[{slug,label,section}], reviewId }
 *       the trays the target loan's Doc Review actually has; falls back to
 *       the full union vocabulary when the loan has no review yet.
 */
import { handleOptions, json, requireAuth, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { pgGet, LOAN_PICK_SELECT, loanRowToCandidate } from './_shared/mail-match.mjs';
import { deriveBaselineLoanId } from './_shared/baseline-sync.mjs';
import { findReviewForLoan } from './_shared/loan-review-auto-attach.mjs';
import { findCategory, SECTIONS, displaySection } from './_shared/loan-review-checklists.mjs';
import { docTypeOptions } from './_shared/esign-docs.mjs';

export async function searchLoans(q) {
  const base = 'select=' + encodeURIComponent(LOAN_PICK_SELECT) + '&order=updated_at.desc';
  const frag = String(q || '').replace(/[*%(),."\\]/g, ' ').replace(/\s+/g, ' ').trim();
  const tasks = [];
  if (frag) tasks.push(pgGet('loans', base + '&limit=15&address=ilike.' + encodeURIComponent('*' + frag + '*')));
  const word = frag.split(' ').sort((a, b) => b.length - a.length)[0] || '';
  if (word.length >= 2) {
    const orClause = '(first_name.ilike.*' + word + '*,last_name.ilike.*' + word + '*,entity_name.ilike.*' + word + '*,email.ilike.*' + word + '*)';
    tasks.push(pgGet('clients', 'select=id&limit=25&or=' + encodeURIComponent(orClause)).then((rows) =>
      rows.length ? pgGet('loans', base + '&limit=25&client_id=in.(' + rows.map((r) => encodeURIComponent(r.id)).join(',') + ')') : []));
  }
  const m = /^sla[-\s]?(\d{8})(?:[-\s]?(\d{1,4}))?$/i.exec(String(q || '').trim());
  if (m) {
    const date = m[1].slice(0, 4) + '-' + m[1].slice(4, 6) + '-' + m[1].slice(6, 8);
    tasks.push(pgGet('loans', base + '&limit=100&funding_date=eq.' + date).then((rows) => rows.filter((r) =>
      !m[2] || deriveBaselineLoanId({ id: r.id, fundingDate: r.funding_date }).slice(-4).indexOf(m[2]) === 0)));
  }
  const settled = await Promise.all(tasks.map((t) => t.catch((e) => { console.warn('esign search-loans:', e && e.message); return []; })));
  const seen = new Set();
  const out = [];
  [].concat.apply([], settled).forEach((r) => {
    if (!r || !r.id || seen.has(r.id)) return;
    seen.add(r.id);
    out.push(loanRowToCandidate(r));
  });
  return out.slice(0, 25);
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const url = new URL(req.url);

    const slugsFor = url.searchParams.get('slugsFor');
    if (slugsFor) {
      const ownerKey = keySafe(normalizeEmail(url.searchParams.get('owner') || user.email));
      const clientId = url.searchParams.get('clientId') || '';
      let review = null;
      try { review = await findReviewForLoan({ ownerKey, clientId, loanId: slugsFor, address: '' }); } catch (_) {}
      if (review && review.docs && Object.keys(review.docs).length) {
        const secLabel = {}; SECTIONS.forEach((s) => { secLabel[s.key] = s.label; });
        const slugs = Object.keys(review.docs).map((slug) => {
          const d = review.docs[slug] || {};
          const cat = findCategory(slug);
          // Deploy 237.150 -- 'loan' is retired; displaySection maps it (and any
          // custom tray) to the section the Documents tab actually shows.
          const section = displaySection(d.section || (cat && cat.section) || '', slug);
          return { slug, label: d.label || (cat && cat.label) || slug, section,
            sectionLabel: secLabel[section] || '' };
        }).sort((a, b) => a.section.localeCompare(b.section) || a.label.localeCompare(b.label));
        return json(200, { slugs, reviewId: review.id, hasReview: true });
      }
      return json(200, { slugs: docTypeOptions(), reviewId: null, hasReview: false });
    }

    const q = String(url.searchParams.get('q') || '').trim();
    if (q.length < 2) return json(200, { loans: [] });
    const loans = await searchLoans(q);
    return json(200, { loans });
  } catch (e) {
    console.error('esign-loan-search error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
