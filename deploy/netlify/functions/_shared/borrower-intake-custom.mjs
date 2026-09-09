/**
 * _shared/borrower-intake-custom.mjs — Deploy 236.918
 *
 * Trays the BORROWER adds from their document page.
 *
 * Team question: "Is there a way for borrowers to add another tray/category,
 * similar to how we can add one from our view?" Staff mint `custom_<ts>_<rand>`
 * trays into a section of their choosing; the old portal upload already
 * minted `borrower_<ts>_<rand>` trays into the `borrower` section. This is
 * the one place that says what a borrower-originated tray IS, so the three
 * endpoints that have to agree (add-category, status, upload) can't drift:
 *
 *   - slug prefix `borrower_`  → it's theirs, it shows on their page, they
 *                                may upload into it
 *   - section `borrower`       → staff see it under Borrower in Doc Review,
 *                                alongside the LOE tray that already lives there
 *   - no rubric                → it lands as "needs manual review", never a
 *                                green tick from an AI that had nothing to
 *                                check it against
 */

export const BORROWER_TRAY_PREFIX = 'borrower_';
// The MINTED shape — borrower_<ms timestamp>_<random>. Both this module and
// the older portal upload (borrower-doc-upload.mjs) mint exactly this. The
// prefix alone is not enough: the checklist's own `borrower_loe` (Letter of
// Explanation) starts with it too, and a future `borrower_bank_statements`
// would as well. The gate pins this.
const BORROWER_TRAY_RE = /^borrower_\d{10,}_[a-z0-9]+$/;

/** True for a tray the borrower originated (this page OR the older portal upload). */
export function isBorrowerTray(slug, doc) {
  return typeof slug === 'string' && BORROWER_TRAY_RE.test(slug) &&
    !!doc && typeof doc === 'object';
}

export function normalizeTrayLabel(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

/** Slug of an existing borrower tray with this label (case-insensitive), else ''. */
export function findBorrowerTrayByLabel(docs, label) {
  const want = normalizeTrayLabel(label).toLowerCase();
  if (!want) return '';
  for (const slug of Object.keys(docs || {})) {
    const d = docs[slug];
    if (isBorrowerTray(slug, d) && String(d.label || '').trim().toLowerCase() === want) return slug;
  }
  return '';
}

/**
 * A blank borrower tray, the same shape loan-doc-review.js's _blankCustomDoc
 * mints for staff-added trays so every renderer + upload path treats it as a
 * normal doc. `addedBy` is the borrower's email for the history line.
 */
export function mintBorrowerTray(label, opts) {
  const now = new Date().toISOString();
  const addedBy = (opts && opts.addedBy) || '';
  const slug = BORROWER_TRAY_PREFIX + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  return {
    slug,
    doc: {
      slug,
      isCustom:         true,
      borrowerAdded:    true,
      label:            normalizeTrayLabel(label),
      section:          'borrower',
      conditions:       'Added by the borrower from their document page — not on the checklist. Needs manual review.',
      required:         false,
      verdict:          'pending',
      processorNotes:   '',
      naReason:         '',
      currentDocId:     '',
      currentFilename:  '',
      currentSize:      0,
      currentUploadedAt:'',
      currentMimeType:  '',
      aiVerdict:        '',
      aiNotes:          '',
      aiFindings:       [],
      aiExtractedEntities: {},
      aiReviewedAt:     '',
      aiError:          '',
      processorOverrideReason: '',
      approvedAt:       '',
      approvedBy:       '',
      history:          [{ ts: now, action: 'created', by: addedBy, note: 'Category added by the borrower from their document page.' }],
      createdAt:        now,
      createdBy:        addedBy,
    },
  };
}

/** Every borrower-originated tray in a review, oldest first. */
export function borrowerTrayEntries(docs) {
  return Object.keys(docs || {})
    .filter((slug) => isBorrowerTray(slug, docs[slug]))
    .sort((a, b) => String(docs[a].createdAt || '').localeCompare(String(docs[b].createdAt || '')))
    .map((slug) => ({ slug, doc: docs[slug] }));
}

/**
 * Deploy 236.920 (Mike: "add an additional tray and request it from the
 * borrower") — the SECOND way a non-checklist tray reaches the borrower's
 * page: the team flags it `borrowerRequested`. Staff add a category in Doc
 * Review, click "request from borrower", and it shows up on the borrower's
 * list with an Upload button (and, optionally, an email).
 *
 * Visible to the borrower = they minted it, OR the team requested it.
 * Everything else the team adds stays internal.
 */
export function isBorrowerVisibleTray(slug, doc) {
  if (!doc || typeof doc !== 'object' || doc.hidden) return false;
  return isBorrowerTray(slug, doc) || doc.borrowerRequested === true;
}

/** Visible trays with why they're visible: kind 'own' | 'requested'. Oldest first. */
export function borrowerVisibleEntries(docs) {
  return Object.keys(docs || {})
    .filter((slug) => isBorrowerVisibleTray(slug, docs[slug]))
    .sort((a, b) => {
      const ta = String(docs[a].borrowerRequestedAt || docs[a].createdAt || '');
      const tb = String(docs[b].borrowerRequestedAt || docs[b].createdAt || '');
      return ta.localeCompare(tb);
    })
    .map((slug) => ({
      slug, doc: docs[slug],
      kind: isBorrowerTray(slug, docs[slug]) ? 'own' : 'requested',
    }));
}
