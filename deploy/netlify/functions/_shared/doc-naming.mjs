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
import { findCategory, SECTIONS, displaySection } from './loan-review-checklists.mjs';
// Deploy 237.242 — who owns whom, from the operating agreements on the review.
import { buildOwnershipChain, parentOf } from './ownership-chain.mjs';

// Naming touches every document on a tray in a loop, and the chain is the same
// answer every time. Built once per review object, kept off the record itself
// (a non-enumerable property is never serialized into the stored review).
function chainFor(review) {
  if (!review || typeof review !== 'object') return null;
  if (review.ownershipChain) return review.ownershipChain; // already derived upstream
  try {
    if (!Object.prototype.hasOwnProperty.call(review, '__chain')) {
      Object.defineProperty(review, '__chain', { value: buildOwnershipChain(review), enumerable: false, configurable: true });
    }
    return review.__chain;
  } catch (e) { return null; }
}

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
// Deploy 237.237 -- collapse a dotted abbreviation before tokenizing, so the same
// company written "L.L.C." and "LLC" is one company ("KALAHARI CAPITAL, L.L.C."
// otherwise tokenized to l / l / c and matched nothing).
const tokens = (s) => String(s || '').replace(/(?:\b[a-z]\.){2,}/gi, (m) => m.replace(/\./g, ''))
  .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean);
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

// ── WHICH COMPANY an entity document is about ──────────────────────────────
// Deploy 237.237 (Jessy, via Mike: "I did a Zip upload of different Operating
// Agreements but it named each file with the same name"). A borrower-section
// document used to be named after the entity OF RECORD — the LLC on the Articles
// — whatever company the document itself was about. On 5909 Cates that is exactly
// wrong: the borrowing entity is one of several LLCs in the ownership chain, and
// six operating agreements for six different companies all came out as
// "Operating Agreement - Kalahari Capital LLC (3..8).pdf".
//
// Same rule the guarantor documents have had since 237.133: the party ON the
// document beats the tray it was dropped in. When the AI has read an LLC off this
// page and it is a DIFFERENT company than the loan's, that is the name. When it is
// the same company, the loan's spelling wins, so one entity is spelled one way
// across the file ("IMAGINE INVESTORS LLC" → "Imagine Investors, LLC").
//
// A document that is never individually reviewed has no read name at all — three
// of Jessy's six did not. For those, the uploader's own file name is the only
// evidence there is, and it is usually good evidence, which is what Jessy asked
// for ("if we could please add a function where it accepts the original file
// name"). We do not take the file name wholesale — Mike's objection stands,
// borrowers upload "4h789215nu9snamf25.pdf" — we look in it for a COMPANY: a
// phrase ending in LLC / Inc / Corp / Trust / Limited Partnership and so on.
// "Treeline Capital LLC - OA - Borrower - 5909 Cates Ave LLC.pdf" gives
// "Treeline Capital LLC"; a hash of a file name gives nothing and the entity of
// record is used, exactly as before.
const ENTITY_SUFFIX = /^(llc|l\.l\.c\.?|inc|inc\.|incorporated|corp|corp\.|corporation|ltd|ltd\.|limited|lp|l\.p\.?|llp|l\.l\.p\.?|partnership|trust|company|holdings|associates|group|enterprises|properties|ventures)$/i;
// Words that are about the DOCUMENT, not the company. Stripped off the front of a
// mined phrase ("OA DTCM Management LLC" → "DTCM Management LLC").
const DOC_WORDS = /^(oa|op|operating|agreement|articles|article|art|org|organization|ein|w9|w-9|cogs|certificate|cert|good|standing|ofac|background|check|entity|borrower|guarantor|signed|executed|final|copy|scan|scanned|doc|document|file|the|of|and|for|fully)$/i;

export function entityFromFilename(name) {
  const stem = stripExt(String(name || ''));
  if (!stem) return '';
  // The separators people actually type between the parts of a file name.
  const phrases = stem.split(/\s+[-–—]\s+|\s*[_|]\s*|\s+[-–—](?=[A-Za-z])|(?<=[A-Za-z])[-–—]\s+/);
  for (const raw of phrases) {
    const words = String(raw).trim().split(/\s+/).filter(Boolean);
    // Cut the phrase AT the company suffix: "Kalahari Capital LLC Operating
    // Agreement" is a company followed by a document type, not a company.
    let end = -1;
    for (let i = 0; i < words.length; i++) {
      const w = words[i].replace(/[,.;:]+$/, '');
      if (ENTITY_SUFFIX.test(w)) end = i;
      // "LIMITED PARTNERSHIP" / "LIMITED LIABILITY COMPANY" keep going.
      else if (end >= 0 && i === end + 1 && ENTITY_SUFFIX.test(w)) end = i;
      else if (end >= 0) break;
    }
    if (end < 0) continue;
    let start = 0;
    while (start < end && DOC_WORDS.test(words[start].replace(/[,.;:]+$/, ''))) start++;
    if (start >= end) continue; // nothing but document words in front of the suffix
    const phrase = cleanPart(words.slice(start, end + 1).join(' '));
    // A bare "LLC", or a suffix with only a number in front of it, is not a name.
    if (!phrase || phrase.length < 4) continue;
    if (!/[a-z]{3}/i.test(phrase.replace(new RegExp(words[end], 'i'), ''))) continue;
    return phrase;
  }
  return '';
}

// Every spelling of a company this review has seen, the loan's own first. One
// company must be spelled ONE way across a loan file, however each document (or
// each uploader) happened to write it — otherwise the same LLC shows up as
// "5909 Cates Ave, LLC" on one file and "5909 Cates Ave LLC" on the next, and the
// tray looks like it holds two companies' papers when it holds one company's twice.
function knownEntities(review) {
  const out = [];
  const push = (v) => {
    const c = cleanPart(v);
    if (c && !out.some((x) => sameEntity(x, c))) out.push(c);
  };
  push(entityOf(review));
  const docs = (review && review.docs) || {};
  for (const k of Object.keys(docs)) {
    const d = docs[k] || {};
    push((d.aiExtractedEntities || {}).llcName);
    (Array.isArray(d.documents) ? d.documents : []).forEach((x) => push(((x && x.aiExtractedEntities) || {}).llcName));
  }
  return out;
}

function entityFor(review, entities, incomingFilename) {
  const known = knownEntities(review);
  const settle = (name) => known.find((x) => sameEntity(x, name)) || name;
  const read = cleanPart((entities || {}).llcName);
  if (read) return settle(read);
  const mined = entityFromFilename(incomingFilename);
  if (mined) return settle(mined);
  return entityOf(review) || rosterOf(review)[0] || '';
}

export function docSubject(review, slug, docState, entities, incomingFilename) {
  const base = baseSlugOf(slug);
  const d = docState || {};
  if (HOLDER_SLUGS[base]) return holderFor(review, d, entities);
  const section = sectionOf(slug, d);
  if (section === 'guarantor' || d.guarantorIndex != null || PERSON_SLUGS[base]) return personFor(review, d, entities) || entityOf(review);
  if (section === 'borrower') return entityFor(review, entities, incomingFilename) || cleanPart((entities || {}).llcName) || rosterOf(review)[0] || '';
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
// Deploy 237.237 — when two documents in ONE tray still land on the same name
// (the same company's operating agreement twice, two versions of one certificate,
// an amendment beside the original), "(2)" says nothing about which is which.
// Before falling back to the counter, take from the uploader's own file name
// whatever it says that the canonical name does not: "Operating Agreement -
// Kalahari Capital LLC - Amendment 2.pdf". A junk file name contributes nothing
// and still gets the counter, which is Mike's half of the bargain
// ("most times people upload documents with names like 4h789215nu9snamf25.pdf").
const JUNK_WORD = /^(img|image|scan|scanned|photo|dsc|dscn|pxl|screenshot|copy|final|new|untitled|document|doc|file|pdf|page|pages|version|v|signed|fully|executed|borrower|guarantor|the|of|and|for|a)$/i;
function hashish(w) {
  if (/^\d+$/.test(w)) return w.length > 4;                             // a bare long number
  if (/[a-z]/i.test(w) && /\d/.test(w) && w.length >= 8) return true;   // 4h789215nu9snamf25
  return /^[a-z]{6,}$/i.test(w) && !/[aeiouy]/i.test(w);                // no vowels, not a word
}
export function distinguisher(given, base) {
  const stem = stripExt(String(given || ''));
  if (!stem) return '';
  const have = {};
  tokens(base).forEach((t) => { have[t] = true; });
  const out = [];
  for (const raw of stem.split(/[\s_|—–-]+/)) {
    const w = raw.replace(/[^A-Za-z0-9]/g, '');
    if (!w) continue;
    const lc = w.toLowerCase();
    if (have[lc] || JUNK_WORD.test(lc) || DOC_WORDS.test(lc) || hashish(lc)) continue;
    out.push(raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''));
  }
  const tail = cleanPart(out.join(' ')).slice(0, 40).trim();
  return /[a-z]{3}/i.test(tail) ? tail : '';
}

function dedupe(docState, selfId, name, takenExtra, given) {
  const taken = Object.assign({}, takenExtra || {});
  (Array.isArray(docState && docState.documents) ? docState.documents : []).forEach((x) => {
    if (x && x.docId !== selfId && x.filename) taken[String(x.filename).toLowerCase()] = true;
  });
  if (!taken[name.toLowerCase()]) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
  const tail = distinguisher(given, stem);
  if (tail && !taken[(stem + ' - ' + tail + ext).toLowerCase()]) return stem + ' - ' + tail + ext;
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
  // Deploy 237.237 — the name the UPLOADER gave it, for entityFromFilename. Never
  // entry.filename: that is this namer's own output, so mining it is circular.
  const given = o.incomingFilename || entry.originalFilename || '';
  const subject = docSubject(review, slug, docState, entities, given);
  const parts = [docTypeLabel(slug, docState), subject];
  // Deploy 237.242 (Mike: "the borrower had a bunch of LLCs with ownership
  // interests in the others") — on a stacked-entity file the company name alone
  // does not say which company this is, and a tray of eight operating agreements
  // reads as eight strangers. Where the agreements themselves establish that this
  // company is a member of another one, the name says so. Only from the chain:
  // never a guess, and never for the borrowing entity itself.
  if (subject && sectionOf(slug, docState) === 'borrower') {
    const parent = parentOf(chainFor(review), subject);
    if (parent) parts[parts.length - 1] = subject + ' (member of ' + parent + ')';
  }
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
function alreadyNamed(stored, review, slug, docState, entities, given) {
  if (!stored || PERIOD_SLUGS[baseSlugOf(slug)]) return false;
  const stem = stripExt(stored).replace(/\s+V\d+\s*$/i, '').replace(/\s+\(\d+\)\s*$/, '').trim();
  const subject = docSubject(review, slug, docState, entities, given);
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
      const given = o.incomingFilename || (entry && entry.originalFilename) || '';
      if (!(entry && entry.nameAuto) && alreadyNamed(stored, review, slug, docState, ents, given)) return { name: stored, changed: false };
    }
    let version = entry ? Number(entry.nameVersion) || 0 : 0;
    if (!version && String(o.mode || '').toLowerCase() === 'replace') {
      version = (Array.isArray(docState.documents) ? docState.documents : []).filter((x) => x && x.hidden).length + 1;
      if (entry && version > 1) entry.nameVersion = version;
    }
    const wanted = canonicalDocName(review, slug, docId, Object.assign({}, o, { version }));
    const name = dedupe(docState, docId, wanted, null, o.incomingFilename || (entry && entry.originalFilename) || '');
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

/**
 * Deploy 237.237 — re-name every AUTO-named document on one tray, together.
 *
 * A tray is named one document at a time, each one seeing only the names already
 * stored beside it, so a tray that filled up under an older rule stays wrong
 * forever: on 5909 Cates six operating agreements for six different companies are
 * all "Operating Agreement - Kalahari Capital LLC (3..8).pdf", and nothing the
 * processor does short of re-running every AI review would fix them.
 *
 * Doing them as a set is what makes it safe to re-run: the current names are
 * cleared first, so the dedupe counter is not deciding against names that are
 * themselves about to change. A name a person typed (nameManual) or the app
 * generated (nameLocked) is never touched, a document that kept its uploaded name
 * is never touched, and a tray that is already right recomputes to itself and
 * reports no change. Returns how many names actually moved.
 */
export function renameTrayDocuments(review, slug) {
  try {
    const ds = review && review.docs && review.docs[slug];
    const docs = Array.isArray(ds && ds.documents) ? ds.documents : [];
    if (docs.length < 2) return 0;
    // One auto-named document is enough to be worth recomputing, as long as the tray
    // holds more than one: its name had to dodge a sibling's, and the sibling may be
    // the reason it is wrong.
    const auto = docs.filter((d) => d && d.docId && d.nameAuto && !d.nameManual && !d.nameLocked);
    if (!auto.length) return 0;
    const before = {};
    auto.forEach((d) => { before[d.docId] = d.filename || ''; d.filename = ''; });
    let changed = 0;
    // A document the AI has actually read takes the clean name; one identified only
    // from its file name takes the tie-breaker if they land on the same company.
    // Naming order only — documents[] keeps the order the tray displays.
    const order = auto.slice().sort((a, b) => {
      const read = (x) => (((x.aiExtractedEntities || {}).llcName || (x.aiExtractedEntities || {}).borrowerName) ? 0 : 1);
      return read(a) - read(b);
    });
    for (const d of order) {
      const r = applyCanonicalDocName(review, slug, d.docId, {
        // undefined, not {} — an empty object would short-circuit the fall-back
        // chain inside canonicalDocName and lose the tray's own reading.
        entities: d.aiExtractedEntities || undefined,
        incomingFilename: d.originalFilename || before[d.docId] || '',
        documentDate: d.documentDate || '',
        // ignoreTray exists so a tray's stale reading cannot name a document that
        // just arrived. Here nothing just arrived, and for the tray's CURRENT
        // document that reading is its own.
        ignoreTray: ds.currentDocId !== d.docId,
      });
      if (!d.filename) d.filename = before[d.docId]; // never leave a document nameless
      if (d.filename !== before[d.docId]) changed++;
      if (ds.currentDocId === d.docId) ds.currentFilename = d.filename;
    }
    return changed;
  } catch (e) {
    console.warn('[doc-naming] tray rename failed (non-fatal):', e && e.message);
    return 0;
  }
}

// ── ZIP layout ─────────────────────────────────────────────────────────────
// Folders follow the Documents tab's own sections, numbered so a file browser
// keeps the on-screen order; a guarantor's documents sit in their own folder.
// Deploy 237.150 (Dan) -- 'loan' folds into Application & Terms and every
// non-checklist tray into one Other folder, so the ZIP mirrors what the processor
// sees on the page (displaySection is the single source for that mapping).
// Deploy 237.228 (Dan) -- Post Close is its own section on the page, so it is its
// own folder in the ZIP. A section with no folder name here would fall back to the
// raw section key, which is not a folder name anyone wants to read.
const SECTION_FOLDER = { application: 'Application & Terms', borrower: 'Borrower Entity', guarantor: 'Guarantor', collateral: 'Collateral', closing: 'Closing', post_close: 'Post Close', other: 'Other' };
export function zipFolderFor(review, slug, docState, docId) {
  const section = displaySection(sectionOf(slug, docState), slug);
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
