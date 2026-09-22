/**
 * _shared/ownership-chain.mjs — Deploy 237.242 (Mike, SLA-20260616-2306 / 5909 Cates)
 *
 * A borrower can hold the subject property through a stack of companies. On 5909
 * Cates the file holds EIGHT operating agreements: the borrowing entity, the two
 * LLCs that are its members, the partnership above one of those, a trust above
 * that, and so on. Each agreement states only its own level, and the underwriting
 * rubric asks each one in isolation whether "the guarantors' combined ownership
 * interest is at least 51%" — a question no single document on that loan can
 * answer. Until now a human read eight agreements side by side and multiplied.
 *
 * Each reviewed operating agreement now carries an `ownership` block (the AI
 * transcribes the membership table; see anthropic-doc-review.mjs). This assembles
 * them into one chain and multiplies down it.
 *
 * WHAT IT REFUSES TO DO is the point. A percent nobody wrote down is null, not a
 * guess; a branch whose operating agreement is not in the file is `unresolved`,
 * not assumed; a cycle stops rather than looping. The answer therefore comes in
 * two parts — what the documents prove, and what is still missing — because "the
 * guarantors hold 51%" computed over a chain with a hole in it is worse than no
 * answer at all.
 *
 * Pure. No I/O, no AI call. Exported for the page, the loan-file ZIP and the gate.
 */

// ── names ──────────────────────────────────────────────────────────────────
// One company is one node however each document spells it. Mirrors the naming
// rules in doc-naming.mjs: drop the corporate suffix and the punctuation, and a
// dotted abbreviation ("L.L.C.") collapses before anything else happens.
const NOISE = { llc: 1, inc: 1, corp: 1, co: 1, ltd: 1, lp: 1, llp: 1, the: 1, company: 1, trust: 1, limited: 1, partnership: 1, incorporated: 1, corporation: 1 };
export function nameKey(s) {
  const t = String(s == null ? '' : s)
    .replace(/(?:\b[a-z]\.){2,}/gi, (m) => m.replace(/\./g, ''))
    .toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean)
    .filter((w) => !NOISE[w]);
  return t.join(' ');
}
const ENTITY_SUFFIX = /\b(l\.?l\.?c|inc|incorporated|corp|corporation|ltd|limited|lp|l\.?p|llp|l\.?l\.?p|partnership|trust|company|holdings)\b\.?$/i;
// The AI says person or entity; a name that plainly carries a company suffix is an
// entity whatever it said, because that mistake silently truncates the chain.
function kindOf(m) {
  const name = String((m && m.name) || '');
  if (ENTITY_SUFFIX.test(name.trim())) return 'entity';
  return (m && m.kind === 'entity') ? 'entity' : 'person';
}

// ── the documents ──────────────────────────────────────────────────────────
// Every ownership block on the review, newest first, one per company: two
// agreements for one entity (an original and a restatement) would otherwise
// double-count it, and the most recently reviewed reading is the one to trust.
function ownershipDocs(review) {
  const out = [];
  const docs = (review && review.docs) || {};
  for (const slug of Object.keys(docs)) {
    const tray = docs[slug] || {};
    const entries = Array.isArray(tray.documents) ? tray.documents : [];
    const seen = [];
    entries.forEach((e) => {
      if (!e || e.hidden || !e.ownership) return;
      seen.push({ slug, docId: e.docId || '', filename: e.filename || '', at: e.aiReviewedAt || '', own: e.ownership });
    });
    // A tray whose reading only ever landed at tray level (older reviews).
    if (!seen.length && tray.ownership) {
      seen.push({ slug, docId: tray.currentDocId || '', filename: tray.currentFilename || '', at: tray.aiReviewedAt || '', own: tray.ownership });
    }
    out.push(...seen);
  }
  out.sort((a, b) => String(b.at).localeCompare(String(a.at)));
  const byEntity = new Map();
  for (const d of out) {
    const k = nameKey(d.own && d.own.entity);
    if (!k || byEntity.has(k)) continue;
    byEntity.set(k, d);
  }
  return byEntity;
}

// ── the root ───────────────────────────────────────────────────────────────
// The borrowing entity: the Articles are the name of record (237.074), then the
// loan's vesting LLC, then the entity on the client record.
// Every LLC name the AI has read off an ENTITY document, with how many documents
// said it. Borrower-section trays only: a title company on a CPL and the lender on
// a HUD are also "an LLC name on a document" and neither is the borrower.
const ENTITY_TRAYS = /^(articles_of_organization|certificate_of_good_standing|ein_letter|ein_or_w9|ofac_entity|operating_agreement|entity_background_check|bank_stmt_current|bank_stmt_previous|voided_check|voided_check_ach|foreign_entity_registration|borrower_loe)(__[pg]\d+)?$/;
function entityVotes(review) {
  const votes = new Map(); // key -> { name, n }
  const cast = (v) => {
    const name = String(v == null ? '' : v).trim();
    const k = nameKey(name);
    if (!k) return;
    const got = votes.get(k) || { name, n: 0 };
    got.n += 1;
    votes.set(k, got);
  };
  const docs = (review && review.docs) || {};
  for (const slug of Object.keys(docs)) {
    if (!ENTITY_TRAYS.test(slug)) continue;
    const tray = docs[slug] || {};
    const entries = Array.isArray(tray.documents) ? tray.documents : [];
    if (entries.length) entries.forEach((e) => { if (e && !e.hidden) cast((e.aiExtractedEntities || {}).llcName); });
    else cast((tray.aiExtractedEntities || {}).llcName);
  }
  return votes;
}

/**
 * The borrowing entity — the root of the chain.
 *
 * Deploy 237.243 (found while checking the chain on 5909 Cates). It used to be the
 * ARTICLES TRAY's reading, full stop. That tray holds one document on a normal
 * loan and four on this one — one each for Treeline, Kalahari, 5909 Cates Ave and
 * DTCM — and the tray-level reading is simply whichever was reviewed most recently.
 * So the loan's "entity of record" was Kalahari last week and Treeline today, which
 * is the root of this chain, the subject a file is named after, and the name every
 * entity document is GRADED against. Eight operating agreements failing "entity
 * name matches the entity name of record" is that, not eight bad documents.
 *
 * The Articles still govern the SPELLING (237.074, Mike). What changes is WHICH
 * Articles, when there are several: the loan record decides if it names an entity,
 * otherwise the company the rest of the entity documents agree on. On a loan with
 * one Articles — every loan before this one — all three roads lead to the same name.
 */
export function entityOfRecord(review) {
  const r = review || {};
  const loan = r.sourceLoanSnapshot || r.snapshotLoan || {};
  const client = r.sourceClientSnapshot || {};
  const v = Array.isArray(loan.vestingLLCs) ? loan.vestingLLCs[0] : null;
  const stated = String((v && typeof v === 'object' ? v.name : v) || loan.entityName || client.entityName || '').trim();

  // What the Articles on file actually say — one candidate per document.
  const art = (r.docs && r.docs.articles_of_organization) || {};
  const entries = Array.isArray(art.documents) ? art.documents : [];
  const candidates = [];
  const push = (v2) => {
    const name = String(v2 == null ? '' : v2).trim();
    if (name && !candidates.some((c) => nameKey(c) === nameKey(name))) candidates.push(name);
  };
  entries.forEach((e) => { if (e && !e.hidden) push((e.aiExtractedEntities || {}).llcName); });
  if (art.aiReviewedAt) push((art.aiExtractedEntities || {}).llcName);

  if (!candidates.length) return stated;
  if (candidates.length === 1) return candidates[0];
  // Several companies have Articles on this file. The loan record picks, if it
  // says anything; the Articles' spelling is what comes back either way.
  if (stated) {
    const hit = candidates.find((c) => nameKey(c) === nameKey(stated));
    if (hit) return hit;
  }
  const votes = entityVotes(review);
  let best = '', bestN = 0;
  for (const c of candidates) {
    const n = (votes.get(nameKey(c)) || { n: 0 }).n;
    if (n > bestN) { bestN = n; best = c; }
  }
  if (best) return best;
  return stated || candidates[0];
}

export function borrowingEntity(review) {
  return entityOfRecord(review);
}

function rosterOf(review) {
  const gs = Array.isArray(review && review.guarantors) ? review.guarantors : [];
  const names = gs.filter((g) => g && !g.removed).map((g) => String(g.name || '').trim()).filter(Boolean);
  if (names.length) return names;
  const b = String((review && review.borrowerName) || '').trim();
  return b ? [b] : [];
}

/**
 * The chain, from the borrowing entity down to the people.
 *
 * Returns:
 *   root        { name, key, resolved }        — the borrowing entity
 *   nodes       [{ key, name, kind, doc }]     — every company in the chain
 *   edges       [{ parent, child, percent, kind, role }]
 *   people      [{ name, percent|null, partial }]  — effective, multiplied down
 *   unresolved  [{ entity, under, percent }]   — a company with no agreement on file
 *   unstated    [{ entity, member }]           — a member whose percent nobody wrote
 *   guarantors  { named, percent|null, complete }
 *   depth       how many levels deep the chain goes
 */
export function buildOwnershipChain(review) {
  const byEntity = ownershipDocs(review);
  const rootName = borrowingEntity(review);
  const rootKey = nameKey(rootName);
  const out = {
    root: { name: rootName, key: rootKey, resolved: byEntity.has(rootKey) },
    nodes: [], edges: [], people: [], unresolved: [], unstated: [],
    guarantors: { named: rosterOf(review), percent: null, complete: false },
    depth: 0, documents: byEntity.size,
  };
  if (!rootKey) return out;

  const people = new Map();   // key -> { name, percent, partial }
  const nodes = new Map();
  const addPerson = (name, pct, partial) => {
    const k = nameKey(name);
    if (!k) return;
    const p = people.get(k) || { name: String(name).trim(), percent: 0, partial: false, unknown: false };
    if (pct == null) { p.unknown = true; p.partial = true; } else { p.percent += pct; }
    if (partial) p.partial = true;
    people.set(k, p);
  };

  // Depth-first, carrying the share of the ROOT that this branch represents.
  // `seen` is the path, not a global visited set: the same company can appear
  // under two parents legitimately, and only a cycle back onto the current path
  // is a problem.
  const walk = (key, name, carry, seen, depth) => {
    out.depth = Math.max(out.depth, depth);
    if (!nodes.has(key)) nodes.set(key, { key, name: String(name).trim(), kind: 'entity', doc: '' });
    if (seen.includes(key)) {
      out.unresolved.push({ entity: String(name).trim(), under: seen[seen.length - 1] || '', percent: carry, reason: 'circular' });
      return;
    }
    const doc = byEntity.get(key);
    if (!doc) {
      out.unresolved.push({ entity: String(name).trim(), under: seen[seen.length - 1] || '', percent: carry, reason: 'no_agreement' });
      return;
    }
    nodes.get(key).doc = doc.filename || doc.slug;
    const members = Array.isArray(doc.own.members) ? doc.own.members : [];
    const path = seen.concat([key]);
    for (const m of members) {
      const kind = kindOf(m);
      const pct = (typeof m.percent === 'number' && isFinite(m.percent)) ? m.percent : null;
      out.edges.push({ parent: key, parentName: String(name).trim(), child: nameKey(m.name), childName: String(m.name).trim(), percent: pct, kind, role: m.role || '' });
      if (pct == null) out.unstated.push({ entity: String(name).trim(), member: String(m.name).trim() });
      // carry is the share of the BORROWING ENTITY this branch already stands for.
      const next = (carry == null || pct == null) ? null : (carry * pct) / 100;
      if (kind === 'entity') walk(nameKey(m.name), m.name, next, path, depth + 1);
      else addPerson(m.name, next, next == null);
    }
  };
  walk(rootKey, rootName, 100, [], 1);

  out.nodes = Array.from(nodes.values());
  out.people = Array.from(people.values())
    .map((p) => ({ name: p.name, percent: p.unknown && p.percent === 0 ? null : Math.round(p.percent * 10000) / 10000, partial: p.partial }))
    .sort((a, b) => (b.percent || 0) - (a.percent || 0));

  // What the guarantors ultimately hold. Only a chain with no holes in it gets a
  // number: one missing agreement or one unstated percent and the honest answer
  // is "at least this much, and here is what is missing".
  const roster = out.guarantors.named.map(nameKey).filter(Boolean);
  let sum = 0, sawPartial = false;
  for (const p of out.people) {
    if (!roster.some((g) => g === nameKey(p.name) || nameKey(p.name).indexOf(g) >= 0 || g.indexOf(nameKey(p.name)) >= 0)) continue;
    if (p.percent == null) { sawPartial = true; continue; }
    sum += p.percent;
    if (p.partial) sawPartial = true;
  }
  out.guarantors.percent = out.root.resolved ? Math.round(sum * 10000) / 10000 : null;
  out.guarantors.complete = out.root.resolved && !sawPartial && !out.unresolved.length && !out.unstated.length;
  return out;
}

/**
 * "member of 5909 Cates Ave LLC" — what to say about an entity that is not the
 * borrower. Returns '' for the borrowing entity itself and for anything the chain
 * does not place, so a file name only ever gains a parent the documents prove.
 */
export function parentOf(chain, entityName) {
  if (!chain || !entityName) return '';
  const key = nameKey(entityName);
  if (!key || key === chain.root.key) return '';
  const edge = (chain.edges || []).find((e) => e.child === key);
  return edge ? edge.parentName : '';
}
