/**
 * summary-save-recovery.mjs — pure planning logic for repairing records hit by
 * the Pipeline summary-save bug.
 *
 * Deploy 237.006 (Mike). From Deploy 236.346 (2026-07-15 12:43 PT) until
 * 236.999 (2026-09-13 08:54 PT), pipeline.html's "pre-discussed" and "Submit
 * for UW" flows loaded SUMMARY client records via SLA.Clients.list(), mutated
 * one loan and POSTed the whole summary back to clients-save. Each such save:
 *   - wiped client-level fields the summary omits (homeAddress,
 *     mailingAddress, company EIN/address details, other profile fields),
 *   - replaced that loan's notesLog with ONE entry (kind pre_discussed|submit,
 *     meta.to awaiting_app|submitted) and its legacy notes string,
 *   - re-stamped submittedAt,
 *   - and until 236.348 (2026-07-16 08:20 PT) also wiped every non-summary
 *     field on EVERY loan of that client (no loan merge existed yet).
 *
 * No version history exists anywhere (blobs have none, PG upserts overwrite,
 * the change log never saw these saves). What survives are partial copies:
 *   - loan_reviews.sourceLoanSnapshot (full loan, taken at review create or
 *     truth refresh),
 *   - loan_reviews.sourceClientSnapshot — the FULL client record (with loans)
 *     when the review was auto-created by a borrower upload
 *     (createdBy 'auto:borrower-intake'); staff-created / refreshed reviews
 *     carry only 7 contact fields,
 *   - borrower_info long-app records (prefill copies + borrower answers),
 *   - the borrower_entities vault (EIN / state / address per entity).
 *
 * Everything here is GAP-FILL: a value is only written where the current
 * record is empty. Nothing a person has entered since is ever overwritten.
 * Reports carry field NAMES and counts only — never values.
 */
import { parseAddress } from './address.mjs';

export const DAMAGE_START_MS = Date.parse('2026-07-15T19:43:43Z'); // Deploy 236.346
export const LOAN_MERGE_FIX_MS = Date.parse('2026-07-16T15:20:35Z'); // Deploy 236.348
export const DAMAGE_END_MS = Date.parse('2026-09-13T16:10:00Z');   // 236.999 + build slack

const FINGERPRINT_KINDS = { pre_discussed: 1, submit: 1 };
const FINGERPRINT_TO = { awaiting_app: 1, submitted: 1 };

// Client keys never restored: identity, structure, secrets, bookkeeping.
const CLIENT_SKIP = {
  id: 1, loans: 1, createdAt: 1, updatedAt: 1, companies: 1, notesLog: 1,
  ssn: 1, ssn_enc: 1, ssnLast4: 1, hasSSN: 1, _owner: 1, owner: 1, ownerEmail: 1,
  _recoveredSummarySave: 1,
};
// Loan keys never gap-filled from a snapshot (handled explicitly or live state).
const LOAN_SKIP = {
  id: 1, status: 1, notesLog: 1, notes: 1, submittedAt: 1, createdAt: 1, updatedAt: 1,
  _editingLoanId: 1, _editingClientId: 1, _recoveredSummarySave: 1,
};

export function tsOf(e) {
  if (!e) return NaN;
  return Date.parse(e.ts || e.at || e.createdAt || '');
}

export function isEmptyVal(v) {
  if (v === undefined || v === null || v === '') return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === 'object') return Object.keys(v).every((k) => isEmptyVal(v[k]));
  return false;
}

// A notesLog entry written by the buggy Pipeline flow inside the damage window.
export function isFingerprint(e) {
  if (!e || !FINGERPRINT_KINDS[e.kind]) return false;
  const to = e.meta && e.meta.to;
  if (!FINGERPRINT_TO[to]) return false;
  const t = tsOf(e);
  return t >= DAMAGE_START_MS && t <= DAMAGE_END_MS;
}

// A loan whose notes history was wiped: its EARLIEST surviving entry is a
// fingerprint (a wipe leaves nothing older behind). Returns the wipe time.
export function loanWipeTs(loan) {
  const log = (loan && Array.isArray(loan.notesLog)) ? loan.notesLog : [];
  let earliest = null;
  for (const e of log) {
    const t = tsOf(e);
    if (!isFinite(t)) continue;
    if (!earliest || t < tsOf(earliest)) earliest = e;
  }
  return earliest && isFingerprint(earliest) ? tsOf(earliest) : null;
}

// Every fingerprint across a client's loans (each one was a whole-client save).
export function clientEvents(client) {
  const out = [];
  for (const l of (client && client.loans) || []) {
    for (const e of (l && Array.isArray(l.notesLog)) ? l.notesLog : []) {
      if (isFingerprint(e)) out.push(tsOf(e));
    }
  }
  return out.sort((a, b) => a - b);
}

function entryKey(e) {
  return e && e.id ? 'id:' + e.id : 'ts:' + (e && (e.ts || e.at || e.createdAt)) + '|' + String((e && e.text) || '').slice(0, 80);
}

// Newest snapshot taken strictly before `beforeMs`.
export function pickSnapshot(snaps, beforeMs) {
  let best = null;
  for (const s of snaps || []) {
    if (!s || !isFinite(s.time) || !(s.time < beforeMs)) continue;
    if (!best || s.time > best.time) best = s;
  }
  return best;
}

function gapFillObject(target, source, skip, filled, prefix) {
  for (const k of Object.keys(source || {})) {
    if (skip && skip[k]) continue;
    const sv = source[k];
    if (isEmptyVal(sv)) continue;
    const tv = target[k];
    if (isEmptyVal(tv)) {
      target[k] = JSON.parse(JSON.stringify(sv));
      filled.push(prefix + k);
    } else if (tv && sv && typeof tv === 'object' && typeof sv === 'object' && !Array.isArray(tv) && !Array.isArray(sv)
               && /address/i.test(k)) {
      // Address objects: fill empty sub-fields only (street/city/state/zip).
      for (const sk of Object.keys(sv)) {
        if (isEmptyVal(tv[sk]) && !isEmptyVal(sv[sk])) { tv[sk] = sv[sk]; filled.push(prefix + k + '.' + sk); }
      }
    }
  }
}

/**
 * Plan (and apply in memory) the repair of one loan from a pre-wipe snapshot.
 *   wipeTs      — this loan's notes wipe time (null if its notes weren't wiped)
 *   fieldWipeTs — pre-236.348 whole-loan wipe time for this client (or null)
 * Returns { changed, notesRestored, notesTextRestored, submittedAtRestored,
 *           fieldsFilled[], snapTime }.
 */
export function repairLoan(loan, snaps, wipeTs, fieldWipeTs) {
  const res = { changed: false, notesRestored: 0, notesTextRestored: false, submittedAtRestored: false, fieldsFilled: [], snapTime: null };
  const cutoff = Math.min(wipeTs || Infinity, fieldWipeTs || Infinity);
  if (!isFinite(cutoff)) return res;
  const pick = pickSnapshot(snaps, cutoff);
  if (!pick || !pick.loan) return res;
  const snap = pick.loan;
  res.snapTime = new Date(pick.time).toISOString();

  if (wipeTs) {
    const cur = Array.isArray(loan.notesLog) ? loan.notesLog : [];
    const have = new Set(cur.map(entryKey));
    const add = (Array.isArray(snap.notesLog) ? snap.notesLog : [])
      .filter((e) => e && tsOf(e) < wipeTs && !have.has(entryKey(e)));
    if (add.length) {
      loan.notesLog = cur.concat(add.map((e) => JSON.parse(JSON.stringify(e))))
        .sort((a, b) => (tsOf(a) || 0) - (tsOf(b) || 0));
      res.notesRestored = add.length;
    }
    const oldNotes = String(snap.notes || '').trim();
    const curNotes = String(loan.notes || '');
    if (oldNotes && curNotes.indexOf(oldNotes) < 0) {
      loan.notes = curNotes.trim() ? oldNotes + '\n\n' + curNotes : oldNotes;
      res.notesTextRestored = true;
    }
    const oldSub = Date.parse(snap.submittedAt || '');
    const curSub = Date.parse(loan.submittedAt || '');
    if (isFinite(oldSub) && (!isFinite(curSub) || oldSub < curSub)) {
      loan.submittedAt = snap.submittedAt;
      res.submittedAtRestored = true;
    }
  }
  if (fieldWipeTs) gapFillObject(loan, snap, LOAN_SKIP, res.fieldsFilled, '');

  res.changed = !!(res.notesRestored || res.notesTextRestored || res.submittedAtRestored || res.fieldsFilled.length);
  return res;
}

function normName(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

function findCompany(list, src) {
  if (!src) return null;
  return (list || []).find((c) => c && src.id && c.id === src.id)
    || (list || []).find((c) => c && src._vaultId && c._vaultId === src._vaultId)
    || (list || []).find((c) => c && normName(c.name) && normName(c.name) === normName(src.name))
    || null;
}

// Long-app company answers → client.companies shape (borrower-info-sync.mjs).
export function biCompanyToClient(c) {
  const parsed = parseAddress(String(c.address || ''));
  return {
    id: c.id || '', name: String(c.name || ''), state: String(c.state || ''), ein: String(c.ein || ''),
    address: (parsed.street1 && String(c.address || '').indexOf(',') >= 0) ? parsed.street1 : String(c.address || ''),
    city: String(c.city || '').trim() || parsed.city || '',
    addrState: String(c.addrState || '').trim() || parsed.state || '',
    zip: String(c.zip || '').trim() || parsed.zip || '',
  };
}
export function biHomeAddress(g0) {
  if (!g0 || !(g0.address || g0.city || g0.state || g0.zip)) return null;
  const parsed = parseAddress(g0.address || '');
  return {
    street: (parsed.street1 && String(g0.address || '').indexOf(',') >= 0) ? parsed.street1 : (g0.address || ''),
    city: String(g0.city || '').trim() || parsed.city || '',
    state: String(g0.state || '').trim() || parsed.state || '',
    zip: String(g0.zip || '').trim() || parsed.zip || '',
  };
}

/**
 * Repair client-level fields.
 *   fullSnaps  — [{ time, client }] full client snapshots (borrower-intake reviews)
 *   biRecords  — borrower_info records for this client's loans
 *   vault      — borrower_entities entities for the client's email
 *   lastEvent  — the client's latest fingerprint time
 */
export function repairClient(client, { fullSnaps, biRecords, vault, lastEvent }) {
  const res = { changed: false, fieldsFilled: [], companyFieldsFilled: [], notesRestored: 0, sources: [] };
  client.companies = Array.isArray(client.companies) ? client.companies : [];

  const pick = pickSnapshot(fullSnaps, lastEvent);
  if (pick && pick.client) {
    res.sources.push('reviewClientSnapshot');
    const snap = pick.client;
    gapFillObject(client, snap, CLIENT_SKIP, res.fieldsFilled, '');
    for (const sc of Array.isArray(snap.companies) ? snap.companies : []) {
      const cc = findCompany(client.companies, sc);
      if (cc) gapFillObject(cc, sc, { id: 1, name: 1 }, res.companyFieldsFilled, 'companies.');
    }
    if (Array.isArray(snap.notesLog) && snap.notesLog.length) {
      const cur = Array.isArray(client.notesLog) ? client.notesLog : [];
      const have = new Set(cur.map(entryKey));
      const add = snap.notesLog.filter((e) => e && tsOf(e) < lastEvent && !have.has(entryKey(e)));
      if (add.length) {
        client.notesLog = cur.concat(add).sort((a, b) => (tsOf(a) || 0) - (tsOf(b) || 0));
        res.notesRestored = add.length;
      }
    }
  }

  // Long-app records: the borrower's own answers, then the invite-time prefill.
  for (const r of biRecords || []) {
    if (!r) continue;
    let used = false;
    const d = r.data || {};
    const g0 = Array.isArray(d.guarantors) ? d.guarantors[0] : null;
    const home = biHomeAddress(g0);
    const before = res.fieldsFilled.length + res.companyFieldsFilled.length;
    if (home) gapFillObject(client, { homeAddress: home }, null, res.fieldsFilled, '');
    for (const c of Array.isArray(d.companies) ? d.companies : []) {
      if (!c || !(c.name || c.ein)) continue;
      const cc = findCompany(client.companies, c);
      if (cc) gapFillObject(cc, biCompanyToClient(c), { id: 1, name: 1 }, res.companyFieldsFilled, 'companies.');
    }
    const pf = r.prefill || {};
    if (pf.borrower && pf.borrower.homeAddress) gapFillObject(client, { homeAddress: pf.borrower.homeAddress }, null, res.fieldsFilled, '');
    for (const c of Array.isArray(pf.companies) ? pf.companies : []) {
      const cc = findCompany(client.companies, c);
      if (cc) gapFillObject(cc, c, { id: 1, name: 1 }, res.companyFieldsFilled, 'companies.');
    }
    used = (res.fieldsFilled.length + res.companyFieldsFilled.length) > before;
    if (used && res.sources.indexOf('borrowerInfo') < 0) res.sources.push('borrowerInfo');
  }

  // Entity vault: EIN / filing state / address per entity.
  const beforeVault = res.companyFieldsFilled.length;
  for (const ent of vault || []) {
    if (!ent || !ent.name) continue;
    const cc = findCompany(client.companies, { _vaultId: ent.id, name: ent.name });
    if (cc) gapFillObject(cc, { ein: ent.ein, state: ent.state, address: ent.address }, null, res.companyFieldsFilled, 'companies.');
  }
  if (res.companyFieldsFilled.length > beforeVault) res.sources.push('entityVault');

  res.changed = !!(res.fieldsFilled.length || res.companyFieldsFilled.length || res.notesRestored);
  return res;
}
