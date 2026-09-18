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
// Deploy 237.152 (Mike: "Each guarantor should sign their own credit auth") -- 237.150
// carved out a SHARED_FORM exemption here so a jointly-signed credit authorization
// would pass in every guarantor's tray. That is not the model, and it is not what the
// application produces: renderSignedApplicationPDF writes one prequal-credit-auth page
// PER SIGNER and borrower-info-sign emails guarantors 2-4 their own link, so every
// guarantor already signs their own. There is no exemption -- one note, for everyone.

export function isMultiGuarantorReview(review) {
  // Deploy 237.160 -- ACTIVE guarantors. A loan back down to one person stops showing
  // per-person groups; the departed guarantor's trays stay on the review, hidden.
  return activeGuarantors(review).length > 1;
}

// The note always opens with the same marker so adoptGuarantorsFromLoan can strip
// and rewrite it when a guarantor is renamed.
export function guarantorNote(name, label) {
  const who = String(name || label || 'this guarantor');
  return ' THIS TRAY IS FOR ONE GUARANTOR ONLY: ' + who +
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

/** Loose name key so case, punctuation and double spaces don't split one person in two. */
function _nameKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Deploy 237.160 -- reconcile the stored roster against the loan's CURRENT guarantors.
 * Slots never move: a name keeps its index for the life of the review, so the trays and
 * documents filed under "<slug>__g<i>" always belong to the same person.
 *
 * @returns { next, removed: [index], restored: [index], renamed }
 */
function _reconcileRoster(have, roster) {
  const next = have.map((g, i) => Object.assign({}, g, { index: i }));
  const out = { next, removed: [], restored: [], renamed: 0 };
  const takenIncoming = new Set();

  // 1. Name matches keep their slot.
  const matchedSlot = new Map();   // slot index -> incoming index
  next.forEach((g, i) => {
    const k = _nameKey(g.name);
    if (!k) return;
    const j = roster.findIndex((r, ri) => !takenIncoming.has(ri) && _nameKey(r) === k);
    if (j >= 0) { takenIncoming.add(j); matchedSlot.set(i, j); }
  });

  const freeSlots = next.map((g, i) => i).filter((i) => !matchedSlot.has(i));
  const freeIncoming = roster.map((r, i) => i).filter((i) => !takenIncoming.has(i));

  // 2. A name being CORRECTED, not one person swapped for another. The bar is
  //    deliberately high, because re-pointing a slot at a different human hands them
  //    someone else's documents: exactly one unmatched on each side, at the SAME
  //    position, roster the same size, AND the two names sharing a word. "Marcus P."
  //    replaced by "Sarah Jones" shares nothing and is read as a removal plus an
  //    addition; "Jeremy Wilsonn" -> "Jeremy Wilson" is read as the typo it is. The old
  //    name is kept on the slot either way, so nothing is silently lost.
  if (freeSlots.length === 1 && freeIncoming.length === 1 &&
      freeSlots[0] === freeIncoming[0] && have.length === roster.length) {
    const wasName = next[freeSlots[0]].name || '';
    const wasWords = new Set(_nameKey(wasName).split(' ').filter(Boolean));
    const nowWords = _nameKey(roster[freeIncoming[0]]).split(' ').filter(Boolean);
    if (wasWords.size && nowWords.some((w) => wasWords.has(w))) {
      const slot = next[freeSlots[0]];
      slot.previousNames = (Array.isArray(slot.previousNames) ? slot.previousNames : []).concat([wasName]);
      slot.name = roster[freeIncoming[0]];
      out.renamed++;
      matchedSlot.set(freeSlots[0], freeIncoming[0]);
      takenIncoming.add(freeIncoming[0]);
      freeSlots.length = 0;
      freeIncoming.length = 0;
    }
  }

  // 3. Slots with nobody left to match are off the loan; slots that matched are on it.
  next.forEach((g, i) => {
    const on = matchedSlot.has(i);
    if (!on && !g.removed) { g.removed = true; g.removedAt = new Date().toISOString(); out.removed.push(i); }
    if (on && g.removed) { delete g.removed; delete g.removedAt; out.restored.push(i); }
  });

  // 4. Anyone still unmatched on the loan is new, and takes a NEW slot.
  freeIncoming.forEach((j) => {
    next.push({ index: next.length, name: roster[j], label: 'Guarantor ' + (next.length + 1) });
  });
  next.forEach((g, i) => { g.index = i; if (!g.label) g.label = 'Guarantor ' + (i + 1); });
  return out;
}

/** Guarantors currently ON the loan (the roster keeps everyone who ever was). */
export function activeGuarantors(review) {
  const list = (review && Array.isArray(review.guarantors)) ? review.guarantors : [];
  return list.filter((g) => g && !g.removed);
}

/**
 * Hide (or un-hide) every tray belonging to a guarantor, keeping the documents.
 * Only trays WE hid are ever un-hidden -- `hiddenByGuarantorRemoval` is the marker, so a
 * processor's own hide survives that guarantor coming back.
 */
export function setGuarantorTraysHidden(review, gi, hidden, who) {
  const docs = (review && review.docs) || {};
  const touched = [];
  for (const slug of Object.keys(docs)) {
    const t = docs[slug];
    if (!t || t.guarantorIndex !== gi) continue;
    if (hidden) {
      if (t.hidden) continue;                              // already hidden, by us or by a human
      t.hidden = true;
      t.hiddenConfirmedAt = new Date().toISOString();      // no underwriter confirmation needed
      t.hiddenByGuarantorRemoval = true;
      touched.push(slug);
    } else {
      if (!t.hiddenByGuarantorRemoval) continue;           // a human hid this one -- leave it
      delete t.hidden;
      delete t.hiddenConfirmedAt;
      delete t.hiddenByGuarantorRemoval;
      touched.push(slug);
    }
    t.history = Array.isArray(t.history) ? t.history : [];
    t.history.push({ ts: new Date().toISOString(), action: hidden ? 'guarantor_removed' : 'guarantor_restored',
      note: (hidden ? 'Hidden \u2014 ' : 'Shown again \u2014 ') + (who || 'this guarantor') +
        (hidden ? ' is no longer a guarantor on this loan. The documents are kept.' : ' is a guarantor on this loan again.') });
  }
  return touched;
}

/**
 * @param review  the review (mutated)
 * @param names   the resolved roster, primary first (review-truth resolveGuarantorNames)
 * @returns { adopted, from, to, migrated: [slug], renamed, removed: [], restored: [], hidden: [], shown: [] }
 */
export function adoptGuarantorsFromLoan(review, names) {
  const out = { adopted: false, from: 0, to: 0, migrated: [], renamed: 0, removed: [], restored: [], hidden: [], shown: [] };
  if (!review) return out;
  const roster = (Array.isArray(names) ? names : []).map((n) => String(n || '').trim()).filter(Boolean);
  const have = Array.isArray(review.guarantors) ? review.guarantors : [];
  out.from = have.length;
  if (roster.length < 2 && have.length < 2) return out;   // single guarantor: nothing to split
  // Deploy 237.160 -- an EMPTY roster is never "everyone was removed": resolveGuarantorNames
  // is zero-throw and hands back [] when a client read fails, and acting on that would hide
  // every guarantor tray on the loan. A loan always has at least the primary borrower.
  if (!roster.length) return out;

  // Deploy 237.160 (Jessy) -- match by NAME and keep every slot for good, so a guarantor
  // who leaves keeps their trays and documents and comes back to the same ones.
  const rec = _reconcileRoster(have, roster);
  const next = rec.next;
  out.renamed = rec.renamed;
  out.removed = rec.removed;
  out.restored = rec.restored;
  review.guarantors = next;
  out.to = next.length;
  out.adopted = next.length > have.length;

  review.docs = review.docs || {};
  // Mike: "their information still saved in case they come back but the doc trays for
  // that borrower should get hidden with the docs still saved in them."
  rec.removed.forEach((i) => { out.hidden = out.hidden.concat(setGuarantorTraysHidden(review, i, true, next[i] && next[i].name)); });
  rec.restored.forEach((i) => { out.shown = out.shown.concat(setGuarantorTraysHidden(review, i, false, next[i] && next[i].name)); });

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
      // Deploy 237.160 -- a guarantor who is off the loan gets no new trays; the ones
      // they already have stay, hidden, with their documents.
      if (g.removed) continue;
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
