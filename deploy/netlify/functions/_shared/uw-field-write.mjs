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
    });
  });
  return props.length ? props : null;
}

// Deploy 236.767 — the BPO guardrail string (as-is under the purchase price),
// shown on the BPO tray in Documents. Returns "" to CLEAR a stale alert once a
// fresh BPO reads fine, or null when this doc has nothing to say.
export function bpoAlertFor(slug, proposals, snapshotLoan) {
  if (String(slug) !== "bpo_valuation") return null;
  const n = (v) => Number(String(v == null ? "" : v).replace(/[^0-9.]/g, "")) || 0;
  const aivProp = Array.isArray(proposals) ? proposals.find((p) => p && p.key === "aivBpo") : null;
  const aiv = aivProp ? n(aivProp.value) : 0;
  const pp  = n(snapshotLoan && snapshotLoan.purchasePrice);
  if (aiv > 0 && pp > 0 && aiv < pp) {
    return "BPO as-is value ($" + aiv.toLocaleString("en-US") + ") is BELOW the purchase price ($" +
      pp.toLocaleString("en-US") + ") — this loan needs to be repriced due to the BPO.";
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
