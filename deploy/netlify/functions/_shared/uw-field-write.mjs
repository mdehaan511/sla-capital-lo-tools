/**
 * _shared/uw-field-write.mjs — Deploy 236.768.
 *
 * Shared writer for AI-extracted document fields. Lifted verbatim out of
 * loan-review-doc-upload.mjs so the BACKGROUND reviewer can use it too.
 *
 * WHY: a large BPO is handed to loan-review-ai-background (15-min budget), and
 * that path used to review the doc but never ran the per-field extraction — so
 * aivBpo / arvBpo were silently never written for exactly the big BPOs this
 * feature exists for. One copy here, used by both paths.
 *
 *   buildProposals()      — extractSpec + the AI's extractedFields → proposals[]
 *   writeFieldProposals() — persist them onto the loan (strict writeClient)
 *   bpoAlertFor()         — the "BPO under purchase price" tray alert string
 */
import { getStore } from "@netlify/blobs";
import { keySafe } from "./auth.mjs";
import { writeClient } from "./client-write.mjs";
import { diffLoan, recordLoanChanges } from "./loan-change-log.mjs";

// Deploy 236.777 — dataset:'loan' keys that are MONEY. These get numeric
// coercion + the FromBpo provenance stamp that locks the Loan Details input.
// Any other dataset:'loan' key is written as plain text (e.g. felonyFound).
const LOAN_NUMERIC_KEYS = { aivBpo: 1, arvBpo: 1 };

// Turn the AI's extractedFields answer into proposals. Only fields the AI
// actually FOUND (found:true + a non-empty value) — a "not on this document"
// answer must never overwrite an existing value.
export function buildProposals(extractSpec, extractedFields, docLabel) {
  const ef = extractedFields || {};
  if (!Array.isArray(extractSpec) || !extractSpec.length || !Object.keys(ef).length) return null;
  const specByKey = {};
  extractSpec.forEach(function (s) { specByKey[s.key] = s; });
  const props = [];
  Object.keys(ef).forEach(function (k) {
    const spec = specByKey[k];
    const got  = ef[k];
    if (!spec || !got || got.found !== true) return;
    if (got.value === null || got.value === undefined || got.value === "") return;
    props.push({
      dataset: spec.dataset,
      key:     k,
      value:   got.value,
      aiNote:  String(docLabel || "") + (got.where ? " — " + got.where : ""),
      // Deploy 237.224 -- which tray, and whether the key belongs to ONE guarantor
      perGuarantor: spec.perGuarantor === true,
      traySlug: String(spec.traySlug || ""),
    });
  });
  return props.length ? props : null;
}

// Deploy 236.767 — the BPO guardrail string (as-is under the purchase price),
// shown on the BPO tray in Documents. Returns "" to CLEAR a stale alert once a
// fresh BPO reads fine, or null when this doc has nothing to say.
export function bpoAlertFor(slug, proposals, snapshotLoan) {
  // Deploy 237.221 -- an RTL APPRAISAL now carries aivBpo too (uw-field-map), and the
  // per-property suffix (__p0) was never stripped, so portfolio BPO trays could not alert.
  const _base = String(slug || "").replace(/__[pg]\d+$/, "");
  if (_base !== "bpo_valuation" && _base !== "appraisal") return null;
  const n = (v) => Number(String(v == null ? "" : v).replace(/[^0-9.]/g, "")) || 0;
  const aivProp = Array.isArray(proposals) ? proposals.find((p) => p && p.key === "aivBpo") : null;
  const aiv = aivProp ? n(aivProp.value) : 0;
  const pp  = n(snapshotLoan && snapshotLoan.purchasePrice);
  if (aiv > 0 && pp > 0 && aiv < pp) {
    // Named for the document it came from: "repriced due to the BPO" on an APPRAISAL tray
    // sends someone looking for a BPO that does not exist.
    const _doc = _base === "appraisal" ? "appraisal" : "BPO";
    const _Doc = _base === "appraisal" ? "Appraisal" : "BPO";
    return _Doc + " as-is value ($" + aiv.toLocaleString("en-US") + ") is BELOW the purchase price ($" +
      pp.toLocaleString("en-US") + ") — this loan needs to be repriced due to the " + _doc + ".";
  }
  if (aiv > 0) return "";
  return null;
}

// Deploy 236.777 (Mike) — FELONY hard stop on a background check. Same shape as
// bpoAlertFor: a string to raise the alert on that tray, "" to CLEAR a stale one
// when a re-read comes back clean, null when this doc has nothing to say.
// Applies to BOTH products — a felony of any age is a hard stop on RTL and DSCR.
export function felonyAlertFor(slug, proposals) {
  const s = String(slug);
  if (s !== 'entity_background_check' && s !== 'guarantor_background_check') return null;
  const isEntity = (s === 'entity_background_check');
  const flagKey   = isEntity ? 'felonyEntity' : 'felonyGuarantor';
  const detailKey = isEntity ? 'felonyEntityDetail' : 'felonyGuarantorDetail';
  const find = (k) => (Array.isArray(proposals) ? proposals.find((p) => p && p.key === k) : null);
  const flag = find(flagKey);
  if (!flag) return null;                       // AI didn't answer — leave as-is
  const yes = /^y/i.test(String(flag.value || '').trim());
  if (!yes) return '';                          // clean read clears any stale alert
  const detailProp = find(detailKey);
  const detail = detailProp ? String(detailProp.value || '').trim() : '';
  return 'FELONY FOUND on this ' + (isEntity ? 'entity' : 'guarantor') + ' background check' +
    (detail ? ' — ' + detail : '') +
    '. A felony of any age is a hard stop on both RTL and DSCR; this loan cannot proceed without a documented exception.';
}

// Deploy 236.887 (Mike) — bank-statement liquidity accounts. The acctStmt*
// virtual keys (uw-field-map, bank_stmt_current slug) are synthesized into
// the UW tab's account1..5 rows: value {type, balance, weight}, unverified,
// aiNote tagged "<tray label> (acct N)" so a re-review updates its own rows
// in place instead of eating fresh slots. Weights mirror loan-uw-fields.js
// ACCOUNT_WEIGHTS (and trade-tapes.mjs TAPE_ACCOUNT_WEIGHTS) — keep in sync.
// Match order matters: "Business Checking" must hit Business before Checking.
const STMT_TYPES = [
  { type: 'Business Checking Acct.',    weight: 1.00, match: /business/i },
  { type: 'IRA/401k/Retirement Plans',  weight: 0,    match: /ira|401|retire|roth|sep\b|pension/i },
  { type: 'HELOC',                      weight: 0,    match: /heloc|line of credit|credit line/i },
  { type: 'Stocks/Mutual Funds',        weight: 0.50, match: /stock|mutual|brokerage|invest|securities/i },
  { type: 'Checking/Savings',           weight: 0.70, match: /check|saving|money market|\bcd\b|deposit/i },
];
function normStmtType(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  const exact = STMT_TYPES.find((t) => t.type.toLowerCase() === s.toLowerCase());
  if (exact) return exact;
  return STMT_TYPES.find((t) => t.match.test(s)) || null;
}
export function applyStmtAccountProposals(loan, stmtProps, now) {
  loan.uwData  = (loan.uwData && typeof loan.uwData === 'object') ? loan.uwData : {};
  loan.uwAudit = Array.isArray(loan.uwAudit) ? loan.uwAudit : [];
  const byIdx = {};
  let doubt = '';
  let label = '';
  stmtProps.forEach((p) => {
    if (!label) label = String(p.aiNote || '').split(' — ')[0]; // aiNote = docLabel [— where]
    if (p.key === 'acctStmtDoubt') { doubt = String(p.value || '').trim(); return; }
    // Deploy 237.224 -- five accounts, each with its printed name and last four
    const m = /^acctStmt([1-5])(Type|Balance|Name|Last4)$/.exec(p.key);
    if (m) (byIdx[m[1]] = byIdx[m[1]] || {})[m[2].toLowerCase()] = p.value;
  });
  let wrote = 0;
  Object.keys(byIdx).sort().forEach((i) => {
    const balance = Number(String(byIdx[i].balance == null ? '' : byIdx[i].balance).replace(/[^0-9.\-]/g, ''));
    if (!isFinite(balance) || balance < 0) return;
    const name  = String(byIdx[i].name == null ? '' : byIdx[i].name).trim().slice(0, 80);
    const last4 = String(byIdx[i].last4 == null ? '' : byIdx[i].last4).replace(/\D/g, '').slice(-4);
    let rowDoubt = doubt;
    // The category the AI answered, else read it off the printed name ("Fidelity Brokerage").
    let t = normStmtType(byIdx[i].type) || normStmtType(name);
    if (!t) {
      // Unrecognized category → safest common bucket, and force a human look.
      t = STMT_TYPES[STMT_TYPES.length - 1];
      rowDoubt = (rowDoubt ? rowDoubt + '; ' : '') + 'account type unclear ("' + String(byIdx[i].type || name || '').slice(0, 60) + '")';
    }
    const tag = label + ' (acct ' + i + ')';
    const aiNote = tag + (rowDoubt ? ' — ⚠ VERIFY: ' + rowDoubt.slice(0, 240) : '');
    // Slot (Deploy 237.224): THIS account's row -- same last four -- whoever wrote it, so a
    // second statement for the same account updates in place and two banks' statements
    // get two rows. Then this statement's own prior unverified row (no last four), then
    // the first genuinely empty row. Never a person's row.
    let slot = null;
    if (last4) {
      for (let n = 1; n <= 5 && !slot; n++) {
        const e = loan.uwData['account' + n];
        const v = e && e.value;
        if (v && typeof v === 'object' && String(v.last4 || '') === last4) slot = 'account' + n;
      }
    }
    for (let n = 1; n <= 5 && !slot; n++) {
      const e = loan.uwData['account' + n];
      const v = e && e.value;
      // The tag is per TRAY, so two banks' statements share it: a row that already names a
      // DIFFERENT account (its own last four) is never this one's.
      const otherAcct = !!(last4 && v && typeof v === 'object' && v.last4 && String(v.last4) !== last4);
      if (e && e.isAI === true && e.verified !== true && !otherAcct && String(e.aiNote || '').indexOf(tag) === 0) slot = 'account' + n;
    }
    for (let n = 1; n <= 5 && !slot; n++) {
      const e = loan.uwData['account' + n];
      const v = e && e.value;
      const empty = !e || v == null || v === '' ||
        (typeof v === 'object' && (v.balance == null || v.balance === '') && !v.type);
      if (empty) slot = 'account' + n;
    }
    if (!slot) return; // all five rows in use by real values — leave them be
    const prior = loan.uwData[slot] || null;
    if (prior && prior.verified === true && prior.isAI !== true) return; // human truth wins
    const value = { type: t.type, balance: balance, weight: t.weight };
    if (name)  value.name  = name;
    if (last4) value.last4 = last4;
    if (prior && prior.isAI === true && JSON.stringify(prior.value) === JSON.stringify(value)
        && prior.aiNote === aiNote) return; // no churn on identical re-reads
    loan.uwData[slot] = {
      value, source: 'doc', sourceNote: '', isAI: true, aiNote,
      verified: false, by: 'ai', byName: 'AI', at: now,
    };
    loan.uwAudit.push({
      key: slot, from: prior ? prior.value : undefined, to: value,
      by: 'ai', byName: 'AI', isAI: true, aiNote, at: now,
    });
    wrote++;
  });
  if (loan.uwAudit.length > _UW_AUDIT_CAP) {
    loan.uwAudit = loan.uwAudit.slice(loan.uwAudit.length - _UW_AUDIT_CAP);
  }
  return wrote;
}

// ── Deploy 237.224 (Mike) -- credit across ALL guarantors ─────────────────────────
// "For Low Credit it should grab the lowest middle credit of all guarantors. For middle
// credit it should grab the highest middle credit of all the guarantors."
// Two sources feed one derivation: a Xactus pull (structured, keyed by the person's name,
// on loan.guarantorCreditScores) and a reviewed credit report (the AI's reading of the
// middle score on a credit_report__g<i> tray, in uwData.guarantorMidCredit__g<i>). A pull
// beats a reading of the same person. lowCredit / middleCredit are then written like any
// proposal -- unverified with Confirm when any input is an unconfirmed AI reading,
// verified when every input was pulled -- and never over a value a person typed.
function _nameKey(s) {
  return String(s == null ? '' : s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}
const _score = (v) => Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')) || 0;

export function recordGuarantorScore(loan, pull) {
  const mid = _score(pull && pull.mid);
  if (!(mid > 0)) return false;
  const name = String((pull && pull.name) || '').trim();
  const k = _nameKey(name);
  const list = Array.isArray(loan.guarantorCreditScores) ? loan.guarantorCreditScores : [];
  const next = list.filter((x) => x && (k ? _nameKey(x.name) !== k : true));
  next.push({ name, mid, source: String((pull && pull.source) || 'xactus'), reportType: String((pull && pull.reportType) || ''), at: String((pull && pull.at) || new Date().toISOString()) });
  loan.guarantorCreditScores = next;
  return true;
}

export function guarantorScores(loan) {
  const out = [];
  const seen = {};
  (Array.isArray(loan.guarantorCreditScores) ? loan.guarantorCreditScores : []).forEach((x, i) => {
    const s = _score(x && x.mid);
    if (!(s > 0)) return;
    const k = _nameKey(x.name) || ('pull-' + i);
    if (seen[k]) return;
    seen[k] = 1;
    out.push({ name: String(x.name || '').trim() || 'Pulled', score: s, source: 'pull', verified: true, at: String(x.at || '') });
  });
  const uw = (loan.uwData && typeof loan.uwData === 'object') ? loan.uwData : {};
  Object.keys(uw).filter((key) => /^guarantorMidCredit__g\d+$/.test(key))
    .sort((a, b) => Number(a.match(/\d+$/)[0]) - Number(b.match(/\d+$/)[0]))
    .forEach((key) => {
      const e = uw[key];
      const s = _score(e && e.value);
      if (!(s > 0)) return;
      const gi = Number(key.match(/\d+$/)[0]);
      const nm = String((e && e.guarantorName) || '').trim();
      const k = _nameKey(nm) || key;
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ name: nm || ('Guarantor ' + (gi + 1)), score: s, source: 'report', verified: e.verified === true, at: String(e.at || '') });
    });
  return out;
}

export function deriveGuarantorCredit(loan, now) {
  const scores = guarantorScores(loan);
  if (!scores.length) return 0;
  loan.uwData  = (loan.uwData && typeof loan.uwData === 'object') ? loan.uwData : {};
  loan.uwAudit = Array.isArray(loan.uwAudit) ? loan.uwAudit : [];
  const low  = scores.reduce((a, s) => Math.min(a, s.score), Infinity);
  const high = scores.reduce((a, s) => Math.max(a, s.score), 0);
  const anyUnverified = scores.some((s) => !s.verified);
  const breakdown = scores.map((s) => s.name + ' ' + s.score + (s.source === 'pull' ? ' (pulled)' : ' (report)')).join(' · ');
  const n = scores.length;
  let wrote = 0;
  [['lowCredit', low, 'Lowest of the ' + n + ' guarantor' + (n === 1 ? '' : 's') + '\' middle score' + (n === 1 ? '' : 's')],
   ['middleCredit', high, 'Highest of the ' + n + ' guarantor' + (n === 1 ? '' : 's') + '\' middle score' + (n === 1 ? '' : 's')]].forEach(([key, val, what]) => {
    const prior = loan.uwData[key] || null;
    if (prior && prior.verified === true && prior.isAI !== true && prior.derived !== true) return; // a person typed it
    const entry = {
      value: String(val), source: 'doc', sourceNote: what + ' — ' + breakdown, derived: true,
      isAI: anyUnverified, aiNote: anyUnverified ? 'from the guarantors\' credit reports' : '',
      verified: !anyUnverified, by: anyUnverified ? 'ai' : 'system', byName: anyUnverified ? 'AI' : 'Credit pulls', at: now,
    };
    if (prior && String(prior.value) === entry.value && prior.sourceNote === entry.sourceNote && !!prior.verified === entry.verified) return;
    loan.uwData[key] = entry;
    loan.uwAudit.push({ key, from: prior ? prior.value : undefined, to: entry.value, by: entry.by, byName: entry.byName, isAI: entry.isAI, aiNote: entry.sourceNote, at: now });
    wrote++;
  });
  if (loan.uwAudit.length > _UW_AUDIT_CAP) loan.uwAudit = loan.uwAudit.slice(loan.uwAudit.length - _UW_AUDIT_CAP);
  return wrote;
}

// Deploy 236.500 — persist AI-extracted UW/Lightning fields onto the loan
// as unverified proposals (verified:false, isAI:true) with a provenance
// note + append-only audit entry, mirroring loan-uw-field-save.mjs's write
// shape so the UW tab renders them identically ("AI — UNVERIFIED"). We do
// NOT overwrite a field a human has already verified — human truth wins.
const _UW_AUDIT_CAP = 2000;
export async function writeFieldProposals(source, proposals, actorEmail) {
  const ownerKey  = keySafe(source.ownerKey);
  const clientId  = source.clientId;
  const loanId    = source.loanId;
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const clientKey = ownerKey + '/' + keySafe(clientId);

  const client = await clientsStore.get(clientKey, { type: 'json' });
  if (!client || !Array.isArray(client.loans)) return 0;
  const idx = client.loans.findIndex(function (l) { return l && l.id === loanId; });
  if (idx < 0) return 0;

  const loan = client.loans[idx];
  // Deploy 236.773 — audit-log snapshot so AI-written loan fields (the BPO's
  // aivBpo / arvBpo) show up in the Audit Log like any human edit.
  const _alBefore = Object.assign({}, loan);
  const now = new Date().toISOString();
  let wrote = 0;

  // Deploy 236.887 — bank-statement account proposals become account1..5 rows
  // (see applyStmtAccountProposals above), never entries under their own keys.
  const stmtProps = proposals.filter(function (p) { return /^acctStmt/.test(p.key); });
  if (stmtProps.length) {
    proposals = proposals.filter(function (p) { return !/^acctStmt/.test(p.key); });
    wrote += applyStmtAccountProposals(loan, stmtProps, now);
  }

  // Deploy 237.224 -- per-guarantor keys: grouped by tray, written to that guarantor's
  // slot (credit_report__g2 → guarantorMidCredit__g2; a legacy base tray is Guarantor 1's,
  // which is where adoptGuarantorsFromLoan files it), then Low / Middle derived below.
  const perG = proposals.filter(function (p) { return p && p.perGuarantor === true; });
  if (perG.length) {
    proposals = proposals.filter(function (p) { return !(p && p.perGuarantor === true); });
    const byTray = {};
    perG.forEach(function (p) { (byTray[p.traySlug || ''] = byTray[p.traySlug || ''] || []).push(p); });
    Object.keys(byTray).forEach(function (tray) {
      const gm = /__g(\d+)$/.exec(tray);
      const gi = gm ? Number(gm[1]) : 0;
      const mid = byTray[tray].find(function (p) { return p.key === 'guarantorMidCredit'; });
      const nm  = byTray[tray].find(function (p) { return p.key === 'guarantorReportName'; });
      const score = mid ? _score(mid.value) : 0;
      if (!(score > 0)) return;
      const key = 'guarantorMidCredit__g' + gi;
      loan.uwData  = (loan.uwData && typeof loan.uwData === 'object') ? loan.uwData : {};
      loan.uwAudit = Array.isArray(loan.uwAudit) ? loan.uwAudit : [];
      const prior = loan.uwData[key] || null;
      if (prior && prior.verified === true && prior.isAI !== true) return;
      const entry = {
        value: String(score), guarantorName: nm ? String(nm.value || '').trim().slice(0, 120) : '',
        source: 'doc', sourceNote: '', isAI: true, aiNote: mid.aiNote || '', verified: false, by: 'ai', byName: 'AI', at: now,
      };
      if (prior && prior.isAI === true && String(prior.value) === entry.value && prior.guarantorName === entry.guarantorName) return;
      loan.uwData[key] = entry;
      loan.uwAudit.push({ key, from: prior ? prior.value : undefined, to: entry.value, by: 'ai', byName: 'AI', isAI: true, aiNote: entry.aiNote, at: now });
      wrote++;
    });
    wrote += deriveGuarantorCredit(loan, now);
  }

  proposals.forEach(function (p) {
    // Deploy 236.767 (Mike) — dataset 'loan' writes a REAL loan field (the BPO's
    // own aivBpo / arvBpo), not an unverified UW-tab proposal, because those two
    // drive LTAIV + BPO LTARV in Loan Financials. The BPO is the authority here,
    // so it overwrites — and we stamp provenance so the UI can lock the input.
    // Deploy 236.777 — dataset 'loan' now carries TEXT fields too (the
    // background-check felony flag), not just the BPO's money values. Numeric
    // keys stay coerced + provenance-stamped so the AIV/ARV inputs keep locking;
    // everything else is written as trimmed text.
    if (p.dataset === 'loan') {
      if (LOAN_NUMERIC_KEYS[p.key]) {
        const numeric = Number(String(p.value).replace(/[^0-9.\-]/g, ''));
        if (!isFinite(numeric) || numeric <= 0) return;
        if (String(loan[p.key] == null ? '' : loan[p.key]) !== String(numeric)) wrote += 1;
        loan[p.key] = String(numeric);
        loan[p.key + 'FromBpo'] = true;    // → input is locked in Loan Details
        loan[p.key + 'BpoAt']   = now;
        return;
      }
      const text = String(p.value == null ? '' : p.value).trim().slice(0, 300);
      if (!text) return;
      if (String(loan[p.key] == null ? '' : loan[p.key]) !== text) wrote += 1;
      loan[p.key] = text;
      return;
    }
    const dataField  = p.dataset === 'uw' ? 'uwData'  : 'lightningData';
    const auditField = p.dataset === 'uw' ? 'uwAudit' : 'lightningAudit';
    loan[dataField]  = (loan[dataField] && typeof loan[dataField] === 'object') ? loan[dataField] : {};
    loan[auditField] = Array.isArray(loan[auditField]) ? loan[auditField] : [];

    const prior = loan[dataField][p.key] || null;
    // Human truth wins: never clobber a value a person has verified.
    if (prior && prior.verified === true && prior.isAI !== true) return;
    // Don't churn the audit if the AI would write the exact same value.
    if (prior && prior.isAI === true && String(prior.value) === String(p.value)) return;

    const entry = {
      value:      p.value,
      source:     'doc',
      sourceNote: '',
      isAI:       true,
      aiNote:     p.aiNote || '',
      verified:   false,
      by:         'ai',
      byName:     'AI',
      at:         now,
    };
    loan[dataField][p.key] = entry;
    loan[auditField].push({
      key:    p.key,
      from:   prior ? prior.value : undefined,
      to:     entry.value,
      by:     'ai',
      byName: 'AI',
      isAI:   true,
      aiNote: entry.aiNote,
      at:     now,
    });
    if (loan[auditField].length > _UW_AUDIT_CAP) {
      loan[auditField] = loan[auditField].slice(loan[auditField].length - _UW_AUDIT_CAP);
    }
    wrote++;
  });

  // Deploy 236.767 — once the BPO's own values are on the loan, record whether
  // the as-is came in under the purchase price. Loan Details reads this for its
  // "needs repricing" banner (it computes the LTARV-vs-max half itself, from the
  // live rate tables in rtl-pricing.js — never duplicated server-side).
  if (proposals.some(function (p) { return p && p.dataset === 'loan'; })) {
    const _n = (v) => Number(String(v == null ? '' : v).replace(/[^0-9.]/g, '')) || 0;
    const _aiv = _n(loan.aivBpo), _pp = _n(loan.purchasePrice);
    loan.bpoAivBelowPurchase = !!(_aiv > 0 && _pp > 0 && _aiv < _pp);
    loan.bpoValuesAt = now;
    wrote += 1;   // provenance/flags alone are worth persisting
  }

  if (!wrote) return 0;

  loan.updatedAt = now;
  client.loans[idx] = loan;
  client.updatedAt = now;
  await writeClient(ownerKey, client, { clientsStore });

  // Deploy 236.773 — audit log (best-effort; never fails the write).
  try {
    await recordLoanChanges({
      ownerKey, clientId, loanId,
      actor: actorEmail || 'ai', actorName: actorEmail || 'AI (document review)',
      source: 'Document Review (AI)', changes: diffLoan(_alBefore, loan),
    });
  } catch (e) { console.warn('uw-field-write: change log failed (non-fatal):', e && e.message); }

  return wrote;
}
