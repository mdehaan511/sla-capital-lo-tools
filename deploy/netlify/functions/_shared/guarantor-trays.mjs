/**
 * _shared/guarantor-trays.mjs — Deploy 237.106 (Raissa via Mike)
 *
 * "Is it possible to make a separate tray for each guarantor when there are
 * two, similar to the setup in Baseline?" — Yes. Mirrors the portfolio
 * per-property trays (loan-review-sync-categories: adoptPortfolioFromLoan +
 * the "<slug>__p<i>" expansion), for people instead of properties:
 *
 *   review.guarantors = [{ index, name, label }]   (index 0 = the primary
 *                                                   borrower, per the resolved
 *                                                   roster review.guarantorNames)
 *   docs["<slug>__g<i>"]                            one tray per guarantor for
 *                                                   each GUARANTOR_PER_PERSON
 *                                                   document (ID, citizenship,
 *                                                   credit report, background,
 *                                                   OFAC, LOE, PFS)
 *
 * Trays are self-describing: label / rubric / guarantorIndex / guarantorName
 * live on the tray, and the rubric ends with a "this tray is for <name>" line
 * so the AI grades the document against THAT person.
 *
 * adoptGuarantorsFromLoan(review, names) — records the roster (only ever
 *   grows, like portfolio properties), refreshes names on existing __g trays,
 *   and moves a legacy shared base tray (guarantor_id, credit_report, …) to
 *   Guarantor 1's "<slug>__g0" keeping its documents + a history note (an
 *   existing __g0 is never clobbered; a base tray then stays as a shared inbox
 *   the processor can file from — borrower-portal uploads still land there).
 * expandGuarantorTrays(review) — mints any missing "<slug>__g<i>". Pure,
 *   idempotent; returns the slugs it added.
 *
 * Runs at review create (loan-reviews-save), on every Doc Review page open
 * (loan-review-sync-categories), from the nightly guarantor-trays cron and the
 * post-deploy backfill (guarantor-trays-backfill-background).
 */
import { guarantorPersonEntries, GUARANTOR_PER_PERSON } from './loan-review-checklists.mjs';

const PER_PERSON = new Set(GUARANTOR_PER_PERSON);

export function isMultiGuarantorReview(review) {
  return !!(review && Array.isArray(review.guarantors) && review.guarantors.length > 1);
}

export function guarantorNote(name, label) {
  return ' THIS TRAY IS FOR ONE GUARANTOR ONLY: ' + String(name || label || 'this guarantor') +
    ' (' + String(label || 'Guarantor') + '). The document must belong to this person; a document for a different guarantor is filed in the wrong tray — flag it and name the person it actually belongs to.';
}

function _blankTray(item, g) {
  return {
    slug: item.slug + '__g' + g.index,
    label: item.label || item.slug,
    conditions: (item.conditions || '') + guarantorNote(g.name, g.label),
    section: 'guarantor',
    guarantorIndex: g.index,
    guarantorName: g.name || '',
    guarantorLabel: g.label || ('Guarantor ' + (g.index + 1)),
    verdict: 'pending',
    required: !(item.optional || item.investor),
    processorNotes: '', naReason: '',
    currentDocId: '', currentFilename: '', currentSize: 0, currentUploadedAt: '', currentMimeType: '',
    aiVerdict: '', aiNotes: '', aiFindings: [], aiExtractedEntities: {}, aiReviewedAt: '', aiError: '', aiCostCents: 0,
    processorOverrideReason: '', approvedAt: '', approvedBy: '', history: [], documents: [],
  };
}

/**
 * @param review  the review (mutated)
 * @param names   the resolved roster, primary first (review-truth resolveGuarantorNames)
 * @returns { adopted, from, to, migrated: [slug], renamed }
 */
export function adoptGuarantorsFromLoan(review, names) {
  const out = { adopted: false, from: 0, to: 0, migrated: [], renamed: 0 };
  if (!review) return out;
  const roster = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  const have = Array.isArray(review.guarantors) ? review.guarantors : [];
  out.from = have.length;
  if (roster.length < 2 && have.length < 2) return out;   // single guarantor: nothing to split

  // The roster only grows (a removed guarantor's trays keep their documents);
  // names refresh in place by index.
  const n = Math.max(have.length, roster.length);
  const next = [];
  for (let i = 0; i < n; i++) {
    const prior = have[i] || {};
    const name = roster[i] || prior.name || '';
    next.push({ index: i, name, label: prior.label || ('Guarantor ' + (i + 1)) });
    if (prior.name !== undefined && prior.name !== name) out.renamed++;
  }
  review.guarantors = next;
  out.to = next.length;
  out.adopted = next.length > have.length;

  review.docs = review.docs || {};
  // Refresh names on existing per-guarantor trays (and the rubric's "for" line).
  for (const slug of Object.keys(review.docs)) {
    const tray = review.docs[slug];
    if (!tray || tray.guarantorIndex == null) continue;
    const g = next[tray.guarantorIndex];
    if (!g) continue;
    if (tray.guarantorName !== g.name) {
      tray.guarantorName = g.name;
      tray.guarantorLabel = g.label;
      tray.conditions = String(tray.conditions || '').replace(/ THIS TRAY IS FOR ONE GUARANTOR ONLY:.*$/, '') + guarantorNote(g.name, g.label);
    }
  }

  // Legacy shared base trays → Guarantor 1 (the primary borrower).
  if (next.length > 1) {
    const g0 = next[0];
    for (const slug of GUARANTOR_PER_PERSON) {
      const tray = review.docs[slug];
      if (!tray || typeof tray !== 'object' || tray.isCustom) continue;
      const gslug = slug + '__g0';
      if (review.docs[gslug]) continue;                    // would clobber — leave the base as a shared inbox
      const moved = { ...tray, slug: gslug, guarantorIndex: 0, guarantorName: g0.name, guarantorLabel: g0.label };
      moved.conditions = String(tray.conditions || '') + guarantorNote(g0.name, g0.label);
      moved.history = Array.isArray(tray.history) ? tray.history.slice() : [];
      moved.history.push({ ts: new Date().toISOString(), action: 'guarantor_adopt',
        note: 'Loan has ' + next.length + ' guarantors; this tray now belongs to ' + g0.label + (g0.name ? ' (' + g0.name + ')' : '') + '.' });
      review.docs[gslug] = moved;
      delete review.docs[slug];
      out.migrated.push(slug);
    }
  }
  return out;
}

/** Mint any missing "<slug>__g<i>" trays. Returns the slugs added. */
export function expandGuarantorTrays(review) {
  const added = [];
  if (!isMultiGuarantorReview(review)) return added;
  review.docs = review.docs || {};
  for (const item of guarantorPersonEntries(review.loanType || '')) {
    if (!item || !item.slug) continue;
    for (const g of review.guarantors) {
      const gslug = item.slug + '__g' + g.index;
      if (review.docs[gslug]) continue;                    // present (incl. hidden) — leave it
      review.docs[gslug] = _blankTray(item, g);
      added.push(gslug);
    }
  }
  return added;
}

/** True when this base slug is collected per guarantor (so no shared tray should be minted). */
export function isPerPersonSlug(slug) { return PER_PERSON.has(String(slug || '')); }
