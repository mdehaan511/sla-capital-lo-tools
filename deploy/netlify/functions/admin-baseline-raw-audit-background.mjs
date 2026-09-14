/**
 * admin-baseline-raw-audit-background.mjs — POST /api/admin-baseline-raw-audit
 *
 * Deploy 237.022 (Mike) — audit every Baseline-imported loan: does each value in
 * the raw Baseline record (loan._baselineRaw, the mirrored API payload) exist
 * in the SLA field the app actually reads? The bulk enrich (236.652,
 * baseline-enrich-migrate) only ran for import-owned loans, so loans already
 * assigned to a real LO — and anything imported after — kept most of their
 * terms/collateral only inside the raw blob (e.g. rehabBudget blank while
 * Holdback = $147,307.73, which mis-priced Non-Dutch interest).
 *
 * Mapping = the SAME mapMirrorToFields / mapPeople used by the bulk enrich,
 * plus: projectDescription (Address_Project_Summary), entityName +
 * vestingLLCs (entity Borrower_Name), and on the PRIMARY CLIENT when they are
 * the Baseline guarantor (same email): fico / flips / phone.
 *
 * Per field each loan is classified as gap (SLA blank, Baseline has it),
 * match, or conflict (both present, different). dryRun (default) only
 * reports. apply: GAP-FILL ONLY — never overwrites; honours loanAmtLocked /
 * _rateOverride / _pointsOverride; writeClient (PG + blob) + a Loan Audit Log
 * entry per loan; stamps loan._baselineRawAuditedAt.
 *
 * Body: { dryRun?: bool (default TRUE), loanIds?: [..] }
 * Report → store baseline_raw_audit key 'latest' (+ 'applied-<ts>');
 * GET /api/admin-baseline-raw-audit-status reads it. Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { pgGet } from './_shared/mail-match.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { recordLoanChanges } from './_shared/loan-change-log.mjs';
import { mapMirrorToFields, mapPeople } from './baseline-enrich-migrate.mjs';

const REPORT_STORE = 'baseline_raw_audit';
const BUDGET_MS = 13.5 * 60 * 1000;

const isEmpty = (v) => v === undefined || v === null || String(v).trim() === '';
const numOf = (v) => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };

// Compare an SLA value with the mapped Baseline value. Numbers compare
// numerically (rate: Baseline decimal 0.12 == SLA 12), booleans by truthiness,
// strings case/space-insensitively.
function sameValue(field, sla, mapped) {
  if (field === 'rate') {
    const a = numOf(sla), b = numOf(mapped);
    if (a == null || b == null) return false;
    const na = a < 1 ? a * 100 : a, nb = b < 1 ? b * 100 : b;
    return Math.abs(na - nb) < 0.0005;
  }
  if (field === 'isIO') return (sla === true || sla === 'true' || sla === 'io') === !!mapped;
  if (field === 'prepay') {
    // SLA stores "54321" / "321" / "none"; older records carry "5y6m"-style
    // labels. Treat a label whose leading year count equals the step-down
    // length as the same schedule (5y6m ≈ 54321).
    const norm = (v) => { const s = String(v).trim().toLowerCase(); if (!s || /none|no /.test(s)) return 'none'; const y = s.match(/^(\d)y/); if (y) return y[1]; const d = s.replace(/[^0-9]/g, ''); return d ? String(d.length) : s; };
    return norm(sla) === norm(mapped);
  }
  const a = numOf(sla), b = numOf(mapped);
  const numLike = (v) => /^[\d.,$\s-]+(\s*(pts?|points?|%))?$/i.test(String(v).trim());
  if (a != null && b != null && numLike(sla) && numLike(mapped)) return Math.abs(a - b) < 0.005;
  return String(sla).trim().toLowerCase() === String(mapped).trim().toLowerCase();
}

// The value we would WRITE for a gap (SLA storage conventions).
function writeValue(field, mapped) {
  if (field === 'rate') { const n = numOf(mapped); return n == null ? mapped : (n < 1 ? Math.round(n * 100000) / 1000 : n); }
  return mapped;
}

function parseRaw(l) {
  const raw = l && l._baselineRaw;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return null; }
}

function extraLoanFields(raw, mapped) {
  const f = {};
  const s = (v) => (v == null ? '' : String(v).trim());
  if (s(raw.Address_Project_Summary)) f.projectDescription = s(raw.Address_Project_Summary);
  if (String(raw.Borrower_Type || '').toLowerCase() === 'entity' && s(raw.Borrower_Name)) f.entityName = s(raw.Borrower_Name);
  // Fallbacks for raw keys the bulk mapper never read (seen on live records):
  //   Term (months) when Amortization_Term is blank; top-level Purchase_Price when
  //   Address_Purchase_Price is blank; Prepayment_Type ("No Prepayment") when
  //   Prepayment_Penalty is blank; Regular_Payment → paymentAmount (FCI's nightly
  //   sync overwrites it on serviced loans, so this only seeds the blank ones).
  if (isEmpty(mapped.loanTerm) && numOf(raw.Term) != null && numOf(raw.Term) > 0) f.loanTerm = String(numOf(raw.Term));
  if (isEmpty(mapped.purchasePrice) && numOf(raw.Purchase_Price) != null && numOf(raw.Purchase_Price) > 0) f.purchasePrice = String(numOf(raw.Purchase_Price));
  if (isEmpty(mapped.prepay) && s(raw.Prepayment_Type)) {
    const pt = s(raw.Prepayment_Type).toLowerCase();
    f.prepay = /no prepay|none/.test(pt) ? 'none' : (pt.replace(/[^0-9]/g, '') || '');
    if (!f.prepay) delete f.prepay;
  }
  // Top-level valuation keys (older records) when the Address_* copies are blank.
  const asIs = numOf(raw.As_Is_Value);
  if (isEmpty(mapped.propValue) && asIs != null && asIs > 0) { f.propValue = String(asIs); if (isEmpty(mapped.aivBpo)) f.aivBpo = String(asIs); }
  const arv = numOf(raw.After_Repair_Value_ARV);
  if (isEmpty(mapped.arv) && arv != null && arv > 0) f.arv = String(arv);
  const pay = numOf(raw.Regular_Payment) != null ? numOf(raw.Regular_Payment) : numOf(raw.Principal_Interest);
  if (pay != null && pay > 0) f.paymentAmount = String(Math.round(pay * 100) / 100);
  return f;
}

function clientFields(raw, client) {
  // Only when the primary client IS the Baseline guarantor (same email).
  const gEmail = String(raw.Guarantor_Email || '').toLowerCase().trim();
  const cEmail = String((client && client.email) || '').toLowerCase().trim();
  if (!gEmail || gEmail !== cEmail) return {};
  const f = {};
  const score = numOf(raw.Guarantor_Credit_Score);
  if (score != null && score >= 300 && score <= 900) f.fico = String(Math.round(score));
  const flips = numOf(raw.Guarantor_Num_Flipped);
  if (flips != null && flips >= 0) f.flips = String(Math.round(flips));
  const phone = raw.Guarantor_Phone == null ? '' : String(raw.Guarantor_Phone).trim();
  if (phone) f.phone = phone;
  const dob = String(raw.Guarantor_Date_Birth || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(dob)) f.dob = dob.slice(0, 10);
  const cit = String(raw.Guarantor_Citizenship || '').toLowerCase();
  if (/u\.?s\.? ?citizen/.test(cit)) f.usCitizen = 'yes';
  return f;
}

function classify(target, mapped, skip) {
  const gaps = {}, conflicts = {}, matches = [];
  Object.keys(mapped).forEach((k) => {
    if (skip && skip[k]) return;
    const m = mapped[k];
    if (isEmpty(m)) return;
    const cur = target[k];
    if (isEmpty(cur)) gaps[k] = m;
    else if (sameValue(k, cur, m)) matches.push(k);
    else conflicts[k] = [cur, m];
  });
  return { gaps, conflicts, matches };
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-baseline-raw-audit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;
  const only = Array.isArray(body.loanIds) && body.loanIds.length ? new Set(body.loanIds.map(String)) : null;
  const actor = normalizeEmail(user.email);
  const started = Date.now();
  const overBudget = () => Date.now() - started > BUDGET_MS;

  const report = {
    startedAt: new Date().toISOString(), startedBy: actor, dryRun, status: 'running',
    loansFound: 0, loansWithRaw: 0, loansNoRaw: 0, clientBlobMissing: 0,
    loansWithGaps: 0, loansWithConflicts: 0, clientsWithGaps: 0,
    loansWritten: 0, writeErrors: 0, timedOut: false,
    fieldSummary: {},   // field -> { gap, match, conflict }
    loans: [], finishedAt: '', tookSeconds: 0,
  };
  const reportStore = getStore({ name: REPORT_STORE, consistency: 'strong' });
  const saveReport = () => reportStore.setJSON('latest', report).catch(() => {});
  const bump = (field, kind) => {
    const s = (report.fieldSummary[field] = report.fieldSummary[field] || { gap: 0, match: 0, conflict: 0 });
    s[kind]++;
  };
  await saveReport();

  // 1. Every Baseline-imported loan (by id prefix or a stored raw record).
  const rows = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await pgGet('loans', 'select=id,client_id,owner_email,address' +
      '&or=(id.like.l_baseline_*,extra->>_baselineRaw.not.is.null)&order=id.asc&limit=1000&offset=' + offset);
    page.forEach((r) => rows.push(r));
    if (page.length < 1000 || overBudget()) break;
  }
  report.loansFound = rows.length;
  const byClient = new Map(); // ownerKey/clientId -> [loanIds]
  rows.forEach((r) => {
    if (only && !only.has(String(r.id))) return;
    const k = keySafe(normalizeEmail(r.owner_email || '')) + '/' + keySafe(r.client_id);
    if (!byClient.has(k)) byClient.set(k, { ownerKey: keySafe(normalizeEmail(r.owner_email || '')), clientId: r.client_id, loanIds: [] });
    byClient.get(k).loanIds.push(String(r.id));
  });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const SKIP_LOAN = { toolType: 1 }; // never re-route a loan's product from the raw record

  for (const entry of byClient.values()) {
    if (overBudget()) { report.timedOut = true; break; }
    const client = await clientsStore.get(entry.ownerKey + '/' + keySafe(entry.clientId), { type: 'json' }).catch(() => null);
    if (!client) { report.clientBlobMissing += entry.loanIds.length; continue; }
    let clientChanged = false;
    const clientGapSet = {};

    for (const loanId of entry.loanIds) {
      const loan = (client.loans || []).find((l) => l && l.id === loanId);
      if (!loan) { report.clientBlobMissing++; continue; }
      const raw = parseRaw(loan);
      if (!raw) { report.loansNoRaw++; continue; }
      report.loansWithRaw++;

      const base = mapMirrorToFields(raw);
      const mapped = Object.assign({}, base, extraLoanFields(raw, base));
      const skip = Object.assign({}, SKIP_LOAN);
      if (loan.loanAmtLocked) skip.loanAmt = 1;
      if (loan._rateOverride) skip.rate = 1;
      if (loan._pointsOverride) skip.points = 1;
      const c = classify(loan, mapped, skip);
      Object.keys(c.gaps).forEach((k) => bump(k, 'gap'));
      Object.keys(c.conflicts).forEach((k) => bump(k, 'conflict'));
      c.matches.forEach((k) => bump(k, 'match'));

      const people = mapPeople(raw);
      const wantLLC = !!(people.llcName && !(Array.isArray(loan.vestingLLCs) && loan.vestingLLCs.length));
      const cf = clientFields(raw, client);
      const cc = classify(client, cf, null);

      const row = {
        loanId, address: loan.address || '', extId: raw.Id || '',
        gaps: c.gaps, conflicts: c.conflicts, matched: c.matches.length,
        vestingLLC: wantLLC ? people.llcName : '',
        clientGaps: cc.gaps, clientConflicts: cc.conflicts, written: false,
      };
      const hasGap = Object.keys(c.gaps).length || wantLLC || Object.keys(cc.gaps).length;
      if (Object.keys(c.gaps).length || wantLLC) report.loansWithGaps++;
      if (Object.keys(c.conflicts).length) report.loansWithConflicts++;
      Object.keys(cc.gaps).forEach((k) => { clientGapSet[k] = 1; });

      if (!dryRun && hasGap) {
        Object.keys(c.gaps).forEach((k) => { loan[k] = writeValue(k, c.gaps[k]); });
        if (c.gaps.downPayment !== undefined) {
          loan.pricingSnapshot = Object.assign({}, loan.pricingSnapshot || {});
          if (isEmpty(loan.pricingSnapshot.downPayment)) loan.pricingSnapshot.downPayment = c.gaps.downPayment;
        }
        if (wantLLC) {
          const llc = { name: people.llcName };
          if (raw.Borrower_Jurisdiction) llc.state = String(raw.Borrower_Jurisdiction).trim();
          if (raw.Borrower_Entity_Type) llc.entityType = String(raw.Borrower_Entity_Type).trim();
          loan.vestingLLCs = [llc];
        }
        Object.keys(cc.gaps).forEach((k) => { client[k] = cc.gaps[k]; });
        loan._baselineRawAuditedAt = new Date().toISOString();
        loan.updatedAt = loan._baselineRawAuditedAt;
        row.written = true;
        clientChanged = true;
      }
      report.loans.push(row);
    }
    if (Object.keys(clientGapSet).length) report.clientsWithGaps++;

    if (!dryRun && clientChanged) {
      try {
        client.updatedAt = new Date().toISOString();
        await writeClient(entry.ownerKey, client, { clientsStore });
        for (const row of report.loans) {
          if (!row.written || entry.loanIds.indexOf(row.loanId) < 0 || row._logged) continue;
          row._logged = true;
          report.loansWritten++;
          const changes = Object.keys(row.gaps).map((k) => ({ field: k, label: k, from: '', to: String(row.gaps[k]).slice(0, 120) }));
          if (row.vestingLLC) changes.push({ field: 'vestingLLCs', label: 'Vesting LLC', from: '', to: row.vestingLLC });
          if (changes.length) {
            await recordLoanChanges({ ownerKey: entry.ownerKey, clientId: client.id, loanId: row.loanId, actor, actorName: actor, source: 'Baseline raw audit', changes }).catch(() => {});
          }
        }
      } catch (e) {
        report.writeErrors++;
        report.loans.filter((r) => entry.loanIds.indexOf(r.loanId) >= 0).forEach((r) => { r.written = false; r.writeError = (e && e.message) || 'unknown'; });
      }
    }
    if (report.loans.length % 40 === 0) await saveReport();
  }
  report.loans.forEach((r) => { delete r._logged; });

  report.status = report.timedOut ? 'timed_out' : 'done';
  report.finishedAt = new Date().toISOString();
  report.tookSeconds = Math.round((Date.now() - started) / 1000);
  await saveReport();
  if (!dryRun) await reportStore.setJSON('applied-' + Date.now(), report).catch(() => {});
  return json(200, { ok: true });
}
