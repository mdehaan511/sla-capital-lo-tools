/**
 * admin-summary-save-recovery-background.mjs — POST /api/admin-summary-save-recovery
 *
 * Deploy 237.006 (Mike) — recover data lost to the Pipeline summary-save bug
 * (236.346 → 236.999; see _shared/summary-save-recovery.mjs for the full
 * story and the gap-fill rules). BACKGROUND function: 202 immediately,
 * 15-minute budget, because it walks every loan_reviews record for snapshots.
 *
 * Flow:
 *   1. Page the PG loans table for notesLog fingerprints → candidate clients.
 *   2. Read each candidate's client BLOB (the record of truth) and recompute
 *      its fingerprint events from it.
 *   3. Walk loan_reviews once, keeping only snapshots for candidate
 *      loans/clients (sourceLoanSnapshot; full sourceClientSnapshot from
 *      borrower-upload reviews).
 *   4. Pull borrower_info records (per loan + legacy per client) and the
 *      borrower_entities vault for the client's email.
 *   5. Plan the gap-fill repair. With dryRun:false, RE-READ the blob, re-plan
 *      on the fresh copy and writeClient (PG + blob), plus a Loan Audit Log
 *      entry per repaired loan.
 *   6. Report (ids, names, field NAMES, counts — never values) →
 *      store summary_save_recovery, key 'latest' (and 'applied-<ts>').
 *      Read it via GET /api/admin-summary-save-recovery-status.
 *
 * Body: { dryRun?: bool (default TRUE), clientIds?: [..] (limit the run) }
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { db } from './_shared/supabase-db.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { recordLoanChanges } from './_shared/loan-change-log.mjs';
import {
  isFingerprint, clientEvents, loanWipeTs, repairLoan, repairClient, LOAN_MERGE_FIX_MS,
} from './_shared/summary-save-recovery.mjs';

const REPORT_STORE = 'summary_save_recovery';
const BUDGET_MS = 13.5 * 60 * 1000;

function vaultKey(email) {
  // Same key shape as borrower-entities.mjs emailKey().
  return String(email || '').toLowerCase().trim().replace(/[^a-z0-9@._+-]/g, '_');
}

async function pool(items, size, fn) {
  let i = 0;
  const workers = new Array(Math.min(size, items.length || 1)).fill(0).map(async () => {
    while (i < items.length) { const idx = i++; await fn(items[idx], idx); }
  });
  await Promise.all(workers);
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-summary-save-recovery error:', e);
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
  const only = Array.isArray(body.clientIds) && body.clientIds.length ? new Set(body.clientIds.map(String)) : null;
  const actor = normalizeEmail(user.email);
  const started = Date.now();

  const report = {
    startedAt: new Date().toISOString(), startedBy: actor, dryRun, status: 'running', phase: 'pg-scan',
    loansScanned: 0, fingerprintLoans: 0, candidateClients: 0, clientBlobMissing: 0,
    reviewsScanned: 0, reviewsUsed: 0, borrowerInfoRecords: 0, vaultHits: 0,
    clientsRepairable: 0, clientsWritten: 0, writeErrors: 0,
    loansNotesWiped: 0, loansNotesRestored: 0, loansWipedNoSnapshot: 0,
    notesEntriesRestored: 0, clientFieldFills: 0, companyFieldFills: 0,
    preMergeFixClients: 0, timedOut: false,
    clients: [], finishedAt: '', tookSeconds: 0,
  };
  const reportStore = getStore({ name: REPORT_STORE, consistency: 'strong' });
  const saveReport = () => reportStore.setJSON('latest', report).catch(() => {});
  const overBudget = () => Date.now() - started > BUDGET_MS;
  await saveReport();

  // 1. PG scan for fingerprints.
  const candidates = new Map(); // clientId -> owner_email
  for (let offset = 0; ; offset += 1000) {
    const rows = await db.select('loans', { select: 'id,client_id,owner_email,notes_log', order: { id: 'asc' }, limit: 1000, offset });
    for (const r of rows || []) {
      report.loansScanned++;
      const log = Array.isArray(r.notes_log) ? r.notes_log : [];
      if (!log.some(isFingerprint)) continue;
      report.fingerprintLoans++;
      if (only && !only.has(String(r.client_id))) continue;
      if (!candidates.has(r.client_id)) candidates.set(r.client_id, r.owner_email || '');
    }
    if (!rows || rows.length < 1000 || overBudget()) break;
  }
  report.candidateClients = candidates.size;

  // 2. Client blobs.
  report.phase = 'client-blobs'; await saveReport();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const work = []; // { ownerKey, client, events }
  await pool(Array.from(candidates.entries()), 10, async ([clientId, ownerEmail]) => {
    const ownerKey = keySafe(normalizeEmail(ownerEmail));
    const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
    if (!client) { report.clientBlobMissing++; return; }
    const events = clientEvents(client);
    if (events.length) work.push({ ownerKey, client, events });
  });
  const loanIds = new Set();
  const clientIds = new Set();
  for (const w of work) {
    clientIds.add(w.client.id);
    for (const l of w.client.loans || []) if (l && l.id) loanIds.add(l.id);
  }

  // 3. loan_reviews snapshots.
  report.phase = 'reviews'; await saveReport();
  const loanSnaps = {};  // loanId -> [{time, loan}]
  const fullSnaps = {};  // clientId -> [{time, client}]
  const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const { blobs } = await reviewsStore.list();
  await pool(blobs || [], 16, async (b) => {
    if (overBudget()) return;
    const r = await reviewsStore.get(b.key, { type: 'json' }).catch(() => null);
    report.reviewsScanned++;
    if (!r) return;
    let used = false;
    const created = Date.parse(r.createdAt || '');
    const loanTime = Date.parse(r._truthRefreshedAt || r.createdAt || '');
    const sl = r.sourceLoanSnapshot;
    if (sl && sl.id && loanIds.has(sl.id) && isFinite(loanTime)) {
      (loanSnaps[sl.id] = loanSnaps[sl.id] || []).push({ time: loanTime, loan: sl });
      used = true;
    }
    const sc = r.sourceClientSnapshot;
    // Only an un-refreshed borrower-upload snapshot is the FULL client record.
    if (sc && sc.id && clientIds.has(sc.id) && Array.isArray(sc.loans) && !r._truthRefreshedAt && isFinite(created)) {
      (fullSnaps[sc.id] = fullSnaps[sc.id] || []).push({ time: created, client: sc });
      for (const l of sc.loans) {
        if (l && l.id && loanIds.has(l.id)) (loanSnaps[l.id] = loanSnaps[l.id] || []).push({ time: created, loan: l });
      }
      used = true;
    }
    if (used) report.reviewsUsed++;
  });
  if (overBudget()) report.timedOut = true;

  // 4 + 5. Per client: borrower_info + vault, plan, (apply).
  report.phase = dryRun ? 'planning' : 'applying'; await saveReport();
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const vaultStore = getStore({ name: 'borrower_entities', consistency: 'strong' });

  async function sourcesFor(ownerKey, client) {
    const keys = [ownerKey + '/' + keySafe(client.id)];
    for (const l of client.loans || []) if (l && l.id) keys.push(ownerKey + '/' + keySafe(client.id) + '/' + keySafe(l.id));
    const biRecords = [];
    for (const k of keys) {
      const rec = await biStore.get(k, { type: 'json' }).catch(() => null);
      if (rec) biRecords.push(rec);
    }
    let vault = [];
    if (client.email) {
      const v = await vaultStore.get(vaultKey(client.email), { type: 'json' }).catch(() => null);
      vault = (v && Array.isArray(v.entities)) ? v.entities : [];
    }
    return { biRecords, vault };
  }

  function plan(client, events, src) {
    const lastEvent = events[events.length - 1];
    const fieldWipeTs = events[0] < LOAN_MERGE_FIX_MS ? events[0] : null;
    const loans = [];
    for (const l of client.loans || []) {
      if (!l || !l.id) continue;
      const wipe = loanWipeTs(l);
      const snaps = loanSnaps[l.id] || [];
      const res = repairLoan(l, snaps, wipe, fieldWipeTs);
      if (wipe || res.changed) {
        loans.push({
          loanId: l.id, address: l.address || '', notesWipedAt: wipe ? new Date(wipe).toISOString() : null,
          snapshots: snaps.length, snapTime: res.snapTime, notesRestored: res.notesRestored,
          notesTextRestored: res.notesTextRestored, submittedAtRestored: res.submittedAtRestored,
          fieldsFilled: res.fieldsFilled, changed: res.changed,
        });
        if (res.changed) {
          l._recoveredSummarySave = { at: new Date().toISOString(), by: actor, notesRestored: res.notesRestored, fieldsFilled: res.fieldsFilled.length };
        }
      }
    }
    const cres = repairClient(client, { fullSnaps: fullSnaps[client.id] || [], biRecords: src.biRecords, vault: src.vault, lastEvent });
    const changed = cres.changed || loans.some((x) => x.changed);
    if (changed) {
      client._recoveredSummarySave = { at: new Date().toISOString(), by: actor, fields: cres.fieldsFilled.length, companyFields: cres.companyFieldsFilled.length };
    }
    return { loans, cres, changed, fieldWipeTs };
  }

  for (const w of work) {
    if (overBudget()) { report.timedOut = true; break; }
    const src = await sourcesFor(w.ownerKey, w.client);
    report.borrowerInfoRecords += src.biRecords.length;
    if (src.vault.length) report.vaultHits++;

    const p = plan(w.client, w.events, src);
    const row = {
      clientId: w.client.id, ownerKey: w.ownerKey,
      name: ((w.client.firstName || '') + ' ' + (w.client.lastName || '')).trim() || w.client.entityName || '',
      events: w.events.length, firstEvent: new Date(w.events[0]).toISOString(),
      preMergeFix: !!p.fieldWipeTs,
      clientSources: p.cres.sources, clientFieldsFilled: p.cres.fieldsFilled,
      companyFieldsFilled: p.cres.companyFieldsFilled.length, clientNotesRestored: p.cres.notesRestored,
      loans: p.loans, changed: p.changed, written: false,
    };
    if (p.fieldWipeTs) report.preMergeFixClients++;
    for (const l of p.loans) {
      if (l.notesWipedAt) report.loansNotesWiped++;
      if (l.notesWipedAt && !l.snapTime) report.loansWipedNoSnapshot++;
      if (l.notesRestored || l.notesTextRestored) report.loansNotesRestored++;
      report.notesEntriesRestored += l.notesRestored;
    }
    report.clientFieldFills += p.cres.fieldsFilled.length;
    report.companyFieldFills += p.cres.companyFieldsFilled.length;
    if (p.changed) report.clientsRepairable++;

    if (!dryRun && p.changed) {
      try {
        // Re-read and re-plan on the freshest copy so a concurrent edit is kept.
        const fresh = await clientsStore.get(w.ownerKey + '/' + keySafe(w.client.id), { type: 'json' });
        if (fresh) {
          const fp = plan(fresh, clientEvents(fresh), src);
          if (fp.changed) {
            fresh.updatedAt = new Date().toISOString();
            await writeClient(w.ownerKey, fresh, { clientsStore });
            row.written = true;
            report.clientsWritten++;
            for (const l of fp.loans) {
              if (!l.changed) continue;
              const changes = [];
              if (l.notesRestored) changes.push({ field: 'notesLog', label: 'Notes history restored', from: '', to: l.notesRestored + ' entries' });
              if (l.notesTextRestored) changes.push({ field: 'notes', label: 'Legacy notes restored', from: '', to: 'restored' });
              if (l.submittedAtRestored) changes.push({ field: 'submittedAt', label: 'Original submitted date restored', from: '', to: 'restored' });
              if (l.fieldsFilled.length) changes.push({ field: 'fields', label: 'Fields restored', from: '', to: l.fieldsFilled.slice(0, 20).join(', ') });
              await recordLoanChanges({
                ownerKey: w.ownerKey, clientId: fresh.id, loanId: l.loanId, actor, actorName: actor,
                source: 'Data recovery (Pipeline save bug)', changes,
              });
            }
          }
        }
      } catch (e) {
        report.writeErrors++;
        row.writeError = (e && e.message) || 'unknown';
      }
    }
    report.clients.push(row);
    if (report.clients.length % 25 === 0) await saveReport();
  }

  report.status = report.timedOut ? 'timed_out' : 'done';
  report.phase = 'done';
  report.finishedAt = new Date().toISOString();
  report.tookSeconds = Math.round((Date.now() - started) / 1000);
  await saveReport();
  if (!dryRun) await reportStore.setJSON('applied-' + Date.now(), report).catch(() => {});
  return json(200, { ok: true });
}
