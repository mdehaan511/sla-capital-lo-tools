/**
 * _shared/doc-naming.mjs — Deploy 237.133 (Mike, 11415 Prairie Ct SE loan file)
 *
 * ONE namer for every document on a doc review:
 *
 *     {Doc Type} - {Property Address | Entity Name | Borrower Name}[ - {Mon YYYY}].ext
 *
 * Mike: "the file names should be the {Doc Type} - {Property Address or Entity
 * Name or Borrower Name} depending on which one makes sense. For Bank Statements
 * say which month its for. Those renames should be happening as things are
 * uploaded to keep it easier during the download."
 *
 * Why a shared module: the old namer (236.503 _finalizeDocName) lived inside
 * loan-review-doc-upload and only ran when the AI review happened INLINE. Long
 * documents (background review), chunked uploads, borrower-portal uploads, moved
 * documents and AI retries all kept the raw upload name — which is how a loan
 * file ended up with "Statement_082026_8251.pdf" and "Untitled spreadsheet -
 * Sheet1.pdf" beside properly named files. It also named docs after whatever
 * entity the AI read OFF the page (a tax cert came out as the SELLER's name).
 *
 * The subject now comes from the LOAN, by what kind of document it is:
 *     guarantor docs            → that guarantor (the tray's own guarantor on a
 *                                 per-guarantor tray; the roster otherwise)
 *     entity docs               → the borrowing entity (Articles → vesting → client)
 *     collateral / loan / closing → the property's street address
 *     bank statements, voided check → the account holder the AI read, matched back
 *                                 to the entity / roster, + the statement month
 * The AI's extraction is only consulted for which PERSON a shared tray's document
 * belongs to, the account holder, and the statement date — all of which the
 * review call already returns. Naming never makes an AI call of its own.
 *
 * Names are applied twice, both free: a provisional name when the file is stored
 * (no AI needed for most docs), and a refinement when a review result lands (adds
 * the bank-statement month, resolves the person on a shared tray). A name a
 * processor typed by hand (entry.nameManual) or an app-generated name
 * (entry.nameLocked) is never overwritten.
 */
import { findCategory, SECTIONS } from './loan-review-checklists.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Tray labels are written for the checklist ("This Month's Bank Statements",
// "ID for each Guarantor"); these read better in a file name.
const TYPE_OVERRIDES = {
  bank_stmt_current: 'Bank Statement',
  bank_stmt_previous: 'Bank Statement',
  guarantor_id: 'Guarantor ID',
  ein_letter: 'EIN Letter',
  ein_or_w9: 'EIN Letter or W9',
  articles_of_organization: 'Articles of Organization',
  track_record_reo: 'Track Record',
  track_record: 'Track Record',
  voided_check_ach: 'Voided Check',
  voided_check: 'Voided Check',
  flood_certificate: 'Flood Certificate',
  tax_certificate: 'Tax Certificate',
  loan_application: 'Loan Application',
  cpl: 'Closing Protection Letter',
  title_eo_insurance: 'Title E&O Insurance',
  title_commitment: 'Title Commitment',
  prelim_settlement: 'Estimated Settlement Statement',
  final_hud: 'Final Settlement Statement',
  wire_instructions: 'Wire Instructions',
  evidence_of_insurance: 'Evidence of Insurance',
  property_insurance_binder: 'Insurance Binder',
  proof_of_insurance_pif: 'Insurance Paid in Full',
  psa: 'Purchase Agreement',
  sow: 'Statement of Work',
  bpo_valuation: 'BPO',
  mortgage_statements_payoffs: 'Mortgage Statement',
  pfs: 'Personal Financial Statement',
};
// Whose name goes on the file when the section alone does not say.
const HOLDER_SLUGS = { bank_stmt_current: 1, bank_stmt_previous: 1, voided_check_ach: 1, voided_check: 1 };
const PERSON_SLUGS = { track_record_reo: 1, track_record: 1 };
const PERIOD_SLUGS = { bank_stmt_current: 1, bank_stmt_previous: 1 };

export function baseSlugOf(slug) { return String(slug || '').replace(/__[pg]\d+$/, ''); }
export function extOf(name) {
  const m = String(name || '').match(/\.([a-z0-9]{1,8})$/i);
  return m ? m[1].toLowerCase() : '';
}
export function stripExt(name) { return String(name || '').replace(/\.[a-z0-9]{1,8}$/i, ''); }

// A file-name-safe fragment; '' for the AI's "null" / "n/a" / "unknown".
export function cleanPart(s) {
  if (s == null) return '';
  const t = String(s).replace(/[\/\\:*?"<>|]+/g, ' ').replace(/\s*[—–]\s*/g, ' ').replace(/\s{2,}/g, ' ').trim().replace(/[. ]+$/, '');
  if (!t || /^(null|n\/?a|none|unknown|undefined)$/i.test(t)) return '';
  return t.slice(0, 80);
}

// The tray knows its own section / label (minted from the right checklist for the
// review's loan type — the same slug reads differently on an RTL and a DSCR
// review); the cross-checklist lookup is only the fallback.
export function sectionOf(slug, docState) {
  const own = String((docState && docState.section) || '').toLowerCase();
  if (own) return own;
  const meta = findCategory(baseSlugOf(slug));
  return String((meta && meta.section) || '').toLowerCase();
}

export function docTypeLabel(slug, docState) {
  const base = baseSlugOf(slug);
  if (TYPE_OVERRIDES[base]) return TYPE_OVERRIDES[base];
  const d = docState || {};
  // Portfolio trays carry a " — Property N" suffix on the label; the address in
  // the subject already says which property.
  const own = cleanPart(String(d.label || '').replace(/\s*[—–-]\s*Property\s+\d+\s*$/i, ''));
  if (own) return own;
  const meta = findCategory(base);
  return cleanPart((meta && meta.label) || base.replace(/_/g, ' ')) || 'Document';
}

// ── the loan's own facts ───────────────────────────────────────────────────
function rosterOf(review) {
  const gs = Array.isArray(review && review.guarantors) ? review.guarantors.map((g) => cleanPart(g && g.name)).filter(Boolean) : [];
  if (gs.length) return gs;
  const names = Array.isArray(review && review.guarantorNames) ? review.guarantorNames.map(cleanPart).filter(Boolean) : [];
  if (names.length) return names;
  const b = cleanPart(review && review.borrowerName);
  return b ? [b] : [];
}
function entityOf(review) {
  const r = review || {};
  const art = (r.docs && r.docs.articles_of_organization) || {};
  const fromArticles = art.aiReviewedAt ? cleanPart((art.aiExtractedEntities || {}).llcName) : '';
  if (fromArticles) return fromArticles;
  const loan = r.sourceLoanSnapshot || r.snapshotLoan || {};
  const v = Array.isArray(loan.vestingLLCs) ? loan.vestingLLCs[0] : null;
  const vest = cleanPart(v && typeof v === 'object' ? v.name : v);
  if (vest) return vest;
  const client = r.sourceClientSnapshot || {};
  return cleanPart(loan.entityName) || cleanPart(client.entityName) || '';
}
function streetOf(review, slug) {
  const r = review || {};
  const pm = /__p(\d+)$/.exec(String(slug || ''));
  if (pm && Array.isArray(r.properties)) {
    const p = r.properties[Number(pm[1])];
    const a = cleanPart(String((p && p.address) || '').split(',')[0]);
    if (a) return a;
  }
  const loan = r.sourceLoanSnapshot || r.snapshotLoan || {};
  return cleanPart(String(loan.address || r.address || '').split(',')[0]);
}
const tokens = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
const ENTITY_NOISE = { llc: 1, inc: 1, corp: 1, co: 1, ltd: 1, lp: 1, llp: 1, the: 1, company: 1, trust: 1 };
function sameEntity(a, b) {
  const ta = tokens(a).filter((t) => !ENTITY_NOISE[t]), tb = tokens(b).filter((t) => !ENTITY_NOISE[t]);
  return !!ta.length && ta.join(' ') === tb.join(' ');
}

// Every roster member an AI-read string names ("Jeremy Wilson / Dilma Herrera
// Aguilar", "WILSON, JEREMY", "Herrera Aguilar, Dilma Leticia").
function rosterHits(roster, extracted) {
  const et = tokens(extracted);
  if (!et.length) return [];
  return roster.filter((name) => {
    const nt = tokens(name);
    if (!nt.length) return false;
    const last = nt[nt.length - 1], first = nt[0];
    if (et.indexOf(last) < 0) return false;
    return et.indexOf(first) >= 0 || roster.filter((o) => { const ot = tokens(o); return ot[ot.length - 1] === last; }).length === 1;
  });
}
const joinPeople = (list) => (list.length === 1 ? list[0] : (list.length === 2 ? list.join(' & ') : (list.length ? 'Guarantors' : '')));

// WHO a guarantor document is about. The document's own page wins over the tray
// it was dropped in: on the Prairie Ct file both guarantors' IDs, OFAC checks and
// background checks sat in guarantor 1's tray — naming them after the TRAY would
// have put one person's name on another person's ID.
function personFor(review, docState, entities) {
  const d = docState || {};
  const roster = rosterOf(review);
  const read = cleanPart((entities || {}).borrowerName);
  const hits = rosterHits(roster, read);
  if (hits.length) return joinPeople(hits);
  const own = cleanPart(d.guarantorName) || ((d.guarantorIndex != null && roster[Number(d.guarantorIndex)]) || '');
  if (own) return own;
  if (roster.length === 1) return roster[0];
  if (read) return read;
  return joinPeople(roster);
}
function holderFor(review, docState, entities) {
  const ee = entities || {};
  const entity = entityOf(review), roster = rosterOf(review);
  const llc = cleanPart(ee.llcName), person = cleanPart(ee.borrowerName);
  if (llc && entity && sameEntity(llc, entity)) return entity;
  const hits = rosterHits(roster, person);
  if (hits.length) return joinPeople(hits);
  return llc || person || entity || roster[0] || '';
}

export function docSubject(review, slug, docState, entities) {
  const base = baseSlugOf(slug);
  const d = docState || {};
  if (HOLDER_SLUGS[base]) return holderFor(review, d, entities);
  const section = sectionOf(slug, d);
  if (section === 'guarantor' || d.guarantorIndex != null || PERSON_SLUGS[base]) return personFor(review, d, entities) || entityOf(review);
  if (section === 'borrower') return entityOf(review) || cleanPart((entities || {}).llcName) || rosterOf(review)[0] || '';
  return streetOf(review, slug) || entityOf(review) || rosterOf(review)[0] || '';
}

// "2026-08-31" → "Aug 2026". A statement that closes in the first days of a
// month (cycle Aug 3 – Sep 2) is the PREVIOUS month's statement.
export function statementPeriod(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateStr || ''));
  if (!m) return '';
  let y = Number(m[1]), mo = Number(m[2]);
  if (Number(m[3]) <= 10) { mo -= 1; if (mo < 1) { mo = 12; y -= 1; } }
  if (mo < 1 || mo > 12) return '';
  return MONTHS[mo - 1] + ' ' + y;
}

function entryOf(docState, docId) {
  const docs = Array.isArray(docState && docState.documents) ? docState.documents : [];
  return docs.find((x) => x && x.docId === docId) || null;
}
function dedupe(docState, selfId, name, takenExtra) {
  const taken = Object.assign({}, takenExtra || {});
  (Array.isArray(docState && docState.documents) ? docState.documents : []).forEach((x) => {
    if (x && x.docId !== selfId && x.filename) taken[String(x.filename).toLowerCase()] = true;
  });
  if (!taken[name.toLowerCase()]) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  let i = 2;
  while (taken[(stem + ' (' + i + ')' + ext).toLowerCase()]) i++;
  return stem + ' (' + i + ')' + ext;
}

/**
 * The canonical name for one document. Pure — reads the review, writes nothing.
 * opts: { incomingFilename?, entities?, documentDate?, version? }
 */
export function canonicalDocName(review, slug, docId, opts) {
  const o = opts || {};
  const docState = (review && review.docs && review.docs[slug]) || {};
  const entry = entryOf(docState, docId) || {};
  const isCurrent = docState.currentDocId === docId;
  // ignoreTray: at upload time the tray-level ai* / documentDate still describe
  // the PREVIOUS document — never let them name the new one.
  const tray = (isCurrent && !o.ignoreTray) ? docState : {};
  const entities = o.entities || entry.aiExtractedEntities || tray.aiExtractedEntities || {};
  const ext = extOf(o.incomingFilename) || extOf(entry.filename) || (isCurrent ? extOf(docState.currentFilename) : '') || 'pdf';
  const parts = [docTypeLabel(slug, docState), docSubject(review, slug, docState, entities)];
  if (PERIOD_SLUGS[baseSlugOf(slug)]) {
    parts.push(statementPeriod(o.documentDate || entry.documentDate || entities.documentDate || tray.documentDate || ''));
  }
  let base = parts.filter(Boolean).join(' - ') || 'Document';
  const ver = Number(o.version || entry.nameVersion) || 0;
  if (ver > 1) base += ' V' + ver;
  return base + '.' + ext;
}

// "{something} - {the right subject}" with a single separator was named on purpose
// — by the app ("Signed Loan Application - 11415 Prairie Ct SE", "Rate Sheet - …")
// or by a person — and is usually MORE specific than the tray's type, so it stays.
// The retired namer's three-part names ("Credit Report - Guarantor - Jeremy
// Wilson") do not qualify, and statements always get their month.
function alreadyNamed(stored, review, slug, docState, entities) {
  if (!stored || PERIOD_SLUGS[baseSlugOf(slug)]) return false;
  const stem = stripExt(stored).replace(/\s+V\d+\s*$/i, '').replace(/\s+\(\d+\)\s*$/, '').trim();
  const subject = docSubject(review, slug, docState, entities);
  if (!subject) return false;
  const cut = stem.toLowerCase().lastIndexOf(' - ' + subject.toLowerCase());
  if (cut <= 0 || cut + 3 + subject.length !== stem.length) return false;
  return stem.slice(0, cut).indexOf(' - ') < 0;
}

/**
 * Name (or re-name) one document IN PLACE on the review object: the documents[]
 * entry and, when it is the tray's current doc, currentFilename. Never touches a
 * hand-typed or app-generated name. Returns { name, changed }. Never throws.
 * opts: canonicalDocName's, plus { mode } — 'replace' stamps the V-number once.
 */
export function applyCanonicalDocName(review, slug, docId, opts) {
  try {
    const o = opts || {};
    const docState = review && review.docs && review.docs[slug];
    if (!docState || !docId) return { name: '', changed: false };
    const entry = entryOf(docState, docId);
    const isCurrent = docState.currentDocId === docId;
    if (!entry && !isCurrent) return { name: '', changed: false };
    if ((entry && (entry.nameManual || entry.nameLocked)) || (isCurrent && docState.currentNameManual)) {
      return { name: (entry && entry.filename) || docState.currentFilename || '', changed: false };
    }
    {
      const stored = (entry && entry.filename) || (isCurrent ? docState.currentFilename : '') || '';
      const ents = o.entities || (entry && entry.aiExtractedEntities) || {};
      if (!(entry && entry.nameAuto) && alreadyNamed(stored, review, slug, docState, ents)) return { name: stored, changed: false };
    }
    let version = entry ? Number(entry.nameVersion) || 0 : 0;
    if (!version && String(o.mode || '').toLowerCase() === 'replace') {
      version = (Array.isArray(docState.documents) ? docState.documents : []).filter((x) => x && x.hidden).length + 1;
      if (entry && version > 1) entry.nameVersion = version;
    }
    const wanted = canonicalDocName(review, slug, docId, Object.assign({}, o, { version }));
    const name = dedupe(docState, docId, wanted);
    const before = (entry && entry.filename) || (isCurrent ? docState.currentFilename : '') || '';
    if (entry) {
      if (!entry.originalFilename && before && before !== name) entry.originalFilename = String(o.incomingFilename || before).slice(0, 200);
      entry.filename = name;
      entry.nameAuto = true;
    }
    if (isCurrent) docState.currentFilename = name;
    return { name, changed: before !== name };
  } catch (e) {
    console.warn('[doc-naming] apply failed (non-fatal):', e && e.message);
    return { name: '', changed: false };
  }
}

// ── ZIP layout ─────────────────────────────────────────────────────────────
// Folders follow the Documents tab's own sections, numbered so a file browser
// keeps the on-screen order; a guarantor's documents sit in their own folder.
const SECTION_FOLDER = { borrower: 'Borrower Entity', guarantor: 'Guarantor', collateral: 'Collateral', loan: 'Loan', closing: 'Closing' };
export function zipFolderFor(review, slug, docState, docId) {
  const section = sectionOf(slug, docState);
  const idx = SECTIONS.findIndex((s) => s.key === section);
  if (idx < 0) return (SECTIONS.length + 1) + ' - Other';
  let folder = (idx + 1) + ' - ' + (SECTION_FOLDER[section] || section);
  const d = docState || {};
  const roster = rosterOf(review);
  if (section === 'guarantor' && roster.length > 1) {
    // The person on the DOCUMENT (one roster member) decides the folder; the
    // tray's own guarantor is the fallback. A joint document stays at the root.
    const entry = docId ? (entryOf(d, docId) || {}) : {};
    const hits = rosterHits(roster, cleanPart((entry.aiExtractedEntities || {}).borrowerName));
    const who = hits.length === 1 ? hits[0]
      : (hits.length ? '' : (cleanPart(d.guarantorName) || ((d.guarantorIndex != null && roster[Number(d.guarantorIndex)]) || '')));
    if (who) folder += '/' + who;
  }
  const pm = /__p(\d+)$/.exec(String(slug || ''));
  if (pm && Array.isArray(review && review.properties) && review.properties.length > 1) {
    const st = streetOf(review, slug);
    if (st) folder += '/' + st;
  }
  return folder;
}
// The name a document gets INSIDE the zip: the stored name when it was typed by
// hand or generated by the app, the canonical name otherwise — so loans filed
// before this deploy download clean without anyone re-uploading anything.
export function zipNameFor(review, slug, docId) {
  const docState = (review && review.docs && review.docs[slug]) || {};
  const entry = entryOf(docState, docId) || {};
  const stored = entry.filename || (docState.currentDocId === docId ? docState.currentFilename : '') || '';
  if (stored && (entry.nameManual || entry.nameLocked || (docState.currentDocId === docId && docState.currentNameManual))) return stored;
  if (!entry.nameAuto && alreadyNamed(stored, review, slug, docState, entry.aiExtractedEntities || {})) return stored;
  return canonicalDocName(review, slug, docId, { incomingFilename: stored });
}
