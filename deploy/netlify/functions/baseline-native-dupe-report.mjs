/**
 * baseline-native-dupe-report.mjs — POST /api/baseline-native-dupe-report
 *
 * Deploy 236.735 — READ-ONLY report. Finds same-property duplicate loan records
 * created by the Baseline migration that the dashboard Dedupe MISSES: a native
 * SLA loan (id `l_<ts>_<rand>`) alongside a Baseline copy (id `l_baseline_*`) at
 * the same address+amount, but living under a REAL LO account (not the dedicated
 * IMPORT_OWNER_KEY the Dedupe tool keys off). Also catches copy+copy groups.
 *
 * DRY-RUN by default (makes NO changes): groups every loan portal-wide by
 * normalized address, keeps groups with >1 record where at least one is a
 * Baseline copy, and classifies each (safe_exact / likely_safe / review) with a
 * proposed keeper. Cross-owner + amount-mismatch groups are flagged for a human
 * decision (never auto-deleted). Admin only.
 *
 * Deploy 236.755 — { apply:true, limit? } DELETES the redundant copy for
 * SAFE_EXACT groups ONLY (identical loan filed under a solo c_baseline_* client
 * AND the real grouped client). Re-writes the keeper first to claim the shared
 * loan's PG row, then deletes the candidate (blob + PG). Re-scans each call and
 * processes slice(0,limit); loop until deleted==0.
 *
 * Body: {} (report) | { apply:true, limit? } (delete safe_exact copies)
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe } from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs';
import { IMPORT_OWNER_KEY } from './_shared/baseline-upsert.mjs';

function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }
function loanAmt(l) { return num(l.finalLoanAmount) || num(l.loanAmt) || 0; }
// Normalize an address for collision grouping (street + city + state, unit stripped).
function normAddr(a) {
  return String(a || '').toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(apt|unit|ste|suite|apartment|bldg|building|lot|rm|room)\b[\s\S]*$/, '')
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+(usa|us)$/, '')
    .replace(/\s+/g, ' ').trim();
}
const isBaselineCopy = (l) => /^l_baseline_/i.test(String(l.id || ''));

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-native-dupe-report error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await clientsStore.list();

  // ── Walk every client blob, collect one entry per loan ────────────
  const byAddr = new Map();   // normAddr -> [entry]
  const CONC = 60;
  let loansSeen = 0;
  for (let i = 0; i < blobs.length; i += CONC) {
    const chunk = blobs.slice(i, i + CONC);
    const recs = await Promise.all(chunk.map(({ key }) =>
      clientsStore.get(key, { type: 'json' }).then((c) => ({ key, c })).catch(() => ({ key, c: null }))));
    for (const { key, c } of recs) {
      const slash = key.indexOf('/'); if (slash < 0) continue;
      const ownerKey = key.slice(0, slash);
      if (!c || !Array.isArray(c.loans)) continue;
      for (const loan of c.loans) {
        if (!loan || !loan.id || !loan.address) continue;
        const na = normAddr(loan.address); if (na.length < 6) continue;
        loansSeen += 1;
        if (!byAddr.has(na)) byAddr.set(na, []);
        byAddr.get(na).push({
          ownerKey, clientId: c.id, loanId: loan.id,
          address: loan.address, slaDisplayId: loan.slaDisplayId || '',
          isCopy: isBaselineCopy(loan),
          amt: loanAmt(loan),
          status: loan.status || '', disposition: loan.disposition || '',
          servicerName: loan.servicerName || '', toolType: loan.toolType || '',
          fundingDate: loan.fundingDate || '', maturityDate: loan.maturityDate || '',
          updatedAt: loan.updatedAt || '', createdAt: loan.createdAt || '',
          soloLoanInClient: c.loans.length === 1,
        });
      }
    }
  }

  // ── Keep address groups with >1 record AND at least one Baseline copy ──
  const groups = [];
  for (const [na, entries] of byAddr) {
    if (entries.length < 2) continue;
    const copies = entries.filter((e) => e.isCopy);
    const natives = entries.filter((e) => !e.isCopy);
    if (!copies.length) continue;  // no Baseline artifact here — not a migration dupe

    const owners = [...new Set(entries.map((e) => e.ownerKey))];
    // Deploy 236.761 — the baseline-migration IMPORT account is NOT a real owner:
    // a copy under it is the same import artifact the dashboard Dedupe removes. So
    // a group whose only "cross-owner" is import-account-vs-one-real-LO is NOT
    // ambiguous → keep the real LO's record, delete the import copy.
    const realOwners = [...new Set(entries.filter((e) => e.ownerKey !== IMPORT_OWNER_KEY).map((e) => e.ownerKey))];
    const amts = entries.map((e) => e.amt).filter((a) => a > 0);
    const amountMismatch = amts.length > 1 && (Math.max(...amts) - Math.min(...amts)) > Math.max(...amts) * 0.02;

    let type;
    if (natives.length === 1 && copies.length >= 1) type = 'native_plus_copy';
    else if (natives.length === 0) type = 'copies_only';
    else type = 'multi_native';

    const flags = [];
    if (realOwners.length > 1) flags.push('cross_owner');   // needs Mike to pick the owning LO (import account doesn't count)
    if (amountMismatch) flags.push('amount_mismatch');  // maybe two different loans — do NOT auto-delete
    if (type === 'multi_native') flags.push('multi_native');

    // Sub-classify by how safe a collapse is:
    //   safe_exact  — the group is one loan re-copied (a single distinct display id,
    //                 same amount + funding date) → deleting the extras loses nothing.
    //   likely_safe — one loan under >1 Baseline id FORMAT (e.g. SLA-YYYYMMDD-NNNN +
    //                 SLA-NNNN), same amount + funding date → collapse, keep newest.
    //   review      — differing amount / funding date / owner / a native in the mix →
    //                 could be TWO real loans (a payoff + a new loan) — never auto-delete.
    const distinctIds = new Set(entries.map((e) => e.slaDisplayId || e.loanId)).size;
    const distinctAmts = new Set(entries.filter((e) => e.amt > 0).map((e) => Math.round(e.amt / 500))).size;
    const distinctFunding = new Set(entries.map((e) => e.fundingDate).filter(Boolean)).size;
    let safety;
    if (flags.length || type !== 'copies_only') safety = 'review';
    else if (distinctAmts > 1 || distinctFunding > 1) safety = 'review';
    else if (distinctIds <= 1) safety = 'safe_exact';
    else safety = 'likely_safe';

    // Record identity is (clientId, loanId) — exact dups SHARE a loanId across two
    // DIFFERENT clients (a solo c_baseline_<id> client + a grouped c_bl_* client),
    // so keep/delete must key on the CLIENT, not the loan id. Proposed keeper:
    // prefer the grouped (multi-loan) client, then one carrying servicing data,
    // then the SLA-YYYYMMDD-NNNN id format, then most-recently-updated.
    const isNewFmt = (e) => /^SLA-\d{8}-\d+$/.test(e.slaDisplayId || '');
    const ranked = entries.slice().sort((a, b) =>
      (a.ownerKey === IMPORT_OWNER_KEY ? 1 : 0) - (b.ownerKey === IMPORT_OWNER_KEY ? 1 : 0) ||  // never keep an import-account copy
      (a.soloLoanInClient ? 1 : 0) - (b.soloLoanInClient ? 1 : 0) ||
      (b.servicerName ? 1 : 0) - (a.servicerName ? 1 : 0) ||
      (isNewFmt(b) ? 1 : 0) - (isNewFmt(a) ? 1 : 0) ||
      String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
      String(a.clientId).localeCompare(String(b.clientId)));
    const keeper = ranked[0];
    const sameRec = (e) => e.clientId === keeper.clientId && e.loanId === keeper.loanId;

    groups.push({
      address: entries[0].address, norm: na, count: entries.length,
      type, safety, flags, owners,
      keeper: { ownerKey: keeper.ownerKey, clientId: keeper.clientId, loanId: keeper.loanId, soloLoanInClient: keeper.soloLoanInClient },
      deleteCandidates: (safety === 'review') ? []
        : ranked.slice(1).filter((e) => !sameRec(e)).map((e) => ({ ownerKey: e.ownerKey, clientId: e.clientId, loanId: e.loanId, soloLoanInClient: e.soloLoanInClient })),
      records: entries.map((e) => ({
        loanId: e.loanId, slaDisplayId: e.slaDisplayId, isBaselineCopy: e.isCopy,
        keep: sameRec(e),
        owner: e.ownerKey, clientId: e.clientId, soloLoanInClient: e.soloLoanInClient,
        amount: e.amt, status: e.status, disposition: e.disposition,
        servicerName: e.servicerName, toolType: e.toolType,
        fundingDate: e.fundingDate, maturityDate: e.maturityDate,
        updatedAt: e.updatedAt,
      })),
    });
  }

  // Order: safe_exact → likely_safe → review, then biggest groups first.
  const rank = { safe_exact: 0, likely_safe: 1, review: 2 };
  groups.sort((a, b) => (rank[a.safety] - rank[b.safety]) || (b.count - a.count));

  const bySafety = (s) => groups.filter((g) => g.safety === s);
  const delCount = (arr) => arr.reduce((s, g) => s + g.deleteCandidates.length, 0);
  const safeExact = bySafety('safe_exact'), likely = bySafety('likely_safe'), review = bySafety('review');

  // ── Optional APPLY (Deploy 236.755) — delete the redundant copy for SAFE_EXACT
  // groups ONLY. Never touches likely_safe / review. Each candidate is a SOLO
  // c_baseline_* client holding just the duplicate loan. PG keys loans by id
  // alone, so the shared loanId's PG row belongs to whichever client wrote last —
  // deleting the candidate's PG rows could take the loan with it ("loan
  // disappeared"). So per candidate: (1) re-write the KEEPER to claim the loan's
  // PG row (upsert onConflict:'id'); (2) delete the candidate (blob + PG client,
  // whose loans are now 0). Re-scans each call, so processing slice(0,limit)
  // shrinks the list; loop until nothing is deleted.
  const body = (await readJsonBody(req)) || {};
  const mode = String(body.mode || (body.apply === true ? 'safe_exact' : '')).trim();

  // ── TARGETED delete (Deploy 236.763) — delete EXACTLY the records named in
  // body.deletes:[{ownerKey,clientId,loanId}]. For the cross-owner / Baseline-match
  // decisions where the loser has its OWN loanId (no shared PG row to reclaim): a
  // solo client → delete client (blob + PG); a multi-loan client → splice that loan
  // out + strict re-write (its PG row goes with the client_id match). No reclaim.
  if (body.apply === true && mode === 'targeted') {
    const list = Array.isArray(body.deletes) ? body.deletes : [];
    const deleted = [], skipped = [], errors = [];
    for (const d of list) {
      try {
        if (!d || !d.ownerKey || !d.clientId || !d.loanId) { skipped.push({ reason: 'missing ownerKey/clientId/loanId', d }); continue; }
        const ck = d.ownerKey + '/' + keySafe(d.clientId);
        const client = await clientsStore.get(ck, { type: 'json' }).catch(() => null);
        if (!client || !Array.isArray(client.loans)) { skipped.push({ clientId: d.clientId, reason: 'client vanished' }); continue; }
        if (!client.loans.some((l) => l && l.id === d.loanId)) { skipped.push({ clientId: d.clientId, loanId: d.loanId, reason: 'loan not on client (already gone?)' }); continue; }
        if (client.loans.length === 1) {
          await clientsStore.delete(ck);
          try { await pgMirror.deleteClientStrict(d.clientId); }
          catch (e) { errors.push({ clientId: d.clientId, error: 'PG client delete failed: ' + ((e && e.message) || 'unknown') }); }
          deleted.push({ op: 'delete_client', clientId: d.clientId, loanId: d.loanId });
        } else {
          client.loans = client.loans.filter((l) => !(l && l.id === d.loanId));
          await writeClient(d.ownerKey, client, { clientsStore });
          deleted.push({ op: 'splice_loan', clientId: d.clientId, loanId: d.loanId });
        }
      } catch (e) {
        errors.push({ clientId: d && d.clientId, error: (e && e.message) || 'unknown' });
      }
    }
    return json(200, { ok: true, apply: true, mode: 'targeted',
      summary: { requested: list.length, deleted: deleted.length, skipped: skipped.length, errors: errors.length },
      deleted, skipped, errors });
  }

  // ── RECLAIM-then-delete: safe_exact (default) OR collapse_loanid. The two records
  // SHARE a loanId, so reclaim the keeper's PG row first (Deploy 236.755).
  if (body.apply === true) {
    const limit = (Number(body.limit) > 0) ? Math.floor(Number(body.limit)) : 15;
    const targets = [];
    if (mode === 'collapse_loanid') {
      // Deploy 236.763 — collapse EVERY loanId in >1 record. A loanId is globally
      // unique, so two records with it are ALWAYS the same loan → keep one, delete
      // the rest is safe. Handles per-loan dups inside multi-loan-per-address groups
      // (① keep-both) + import copies in review groups (③). Keeper: never import,
      // then prefer the grouped (multi-loan) client, then most-recent.
      const byLoan = new Map();
      for (const [, entries] of byAddr) for (const e of entries) {
        if (!byLoan.has(e.loanId)) byLoan.set(e.loanId, []);
        byLoan.get(e.loanId).push(e);
      }
      for (const [, recs] of byLoan) {
        if (recs.length < 2) continue;
        const rk = recs.slice().sort((a, b) =>
          (a.ownerKey === IMPORT_OWNER_KEY ? 1 : 0) - (b.ownerKey === IMPORT_OWNER_KEY ? 1 : 0) ||
          (a.soloLoanInClient ? 1 : 0) - (b.soloLoanInClient ? 1 : 0) ||
          String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
          String(a.clientId).localeCompare(String(b.clientId)));
        const keeper = rk[0];
        for (const c of rk.slice(1)) {
          if (c.clientId === keeper.clientId && c.loanId === keeper.loanId) continue;
          targets.push({ address: c.address, keeper: { ownerKey: keeper.ownerKey, clientId: keeper.clientId, loanId: keeper.loanId }, cand: { ownerKey: c.ownerKey, clientId: c.clientId, loanId: c.loanId } });
        }
      }
    } else {
      for (const g of safeExact) for (const dc of g.deleteCandidates) targets.push({ address: g.address, keeper: g.keeper, cand: dc });
    }
    targets.sort((a, b) => (a.cand.ownerKey + '|' + a.cand.clientId + '|' + a.cand.loanId).localeCompare(b.cand.ownerKey + '|' + b.cand.clientId + '|' + b.cand.loanId));
    const batch = targets.slice(0, limit);
    const deleted = [], skipped = [], errors = [];
    for (const t of batch) {
      try {
        const candKey = t.cand.ownerKey + '/' + keySafe(t.cand.clientId);
        const keepKey = t.keeper.ownerKey + '/' + keySafe(t.keeper.clientId);
        const cand = await clientsStore.get(candKey, { type: 'json' }).catch(() => null);
        const keep = await clientsStore.get(keepKey, { type: 'json' }).catch(() => null);
        const candOk = cand && Array.isArray(cand.loans) && cand.loans.length === 1 && cand.loans.some((l) => l && l.id === t.cand.loanId);
        const keepOk = keep && Array.isArray(keep.loans) && keep.loans.some((l) => l && l.id === t.cand.loanId);
        if (!candOk) { skipped.push({ address: t.address, clientId: t.cand.clientId, reason: 'candidate is no longer a solo holder of the loan' }); continue; }
        if (!keepOk) { skipped.push({ address: t.address, clientId: t.cand.clientId, reason: 'keeper no longer holds the loan — NOT deleting' }); continue; }
        await writeClient(t.keeper.ownerKey, keep, { clientsStore });   // 1) claim the loan's PG row for the keeper
        await clientsStore.delete(candKey);                              // 2a) blob delete of the candidate
        try { await pgMirror.deleteClientStrict(t.cand.clientId); }     // 2b) PG client delete (loans already reclaimed)
        catch (e) { errors.push({ address: t.address, clientId: t.cand.clientId, error: 'PG client delete failed (blob already deleted; empty PG client may linger): ' + ((e && e.message) || 'unknown') }); }
        deleted.push({ address: t.address, deletedClientId: t.cand.clientId, keptClientId: t.keeper.clientId, loanId: t.cand.loanId });
      } catch (e) {
        errors.push({ address: t.address, clientId: t.cand.clientId, error: (e && e.message) || 'unknown' });
      }
    }
    return json(200, { ok: true, apply: true, mode: mode || 'safe_exact',
      summary: { targets: targets.length, deleted: deleted.length, skipped: skipped.length, errors: errors.length, remaining: Math.max(0, targets.length - deleted.length) },
      deleted, skipped, errors });
  }

  return json(200, {
    ok: true,
    scanned: { clientBlobs: blobs.length, loans: loansSeen, addresses: byAddr.size },
    summary: {
      duplicateGroups: groups.length,
      redundantRecords: groups.reduce((s, g) => s + (g.count - 1), 0),
      safeExactGroups: safeExact.length, safeExactDeletes: delCount(safeExact),
      likelySafeGroups: likely.length, likelySafeDeletes: delCount(likely),
      reviewGroups: review.length,
      byType: {
        native_plus_copy: groups.filter((g) => g.type === 'native_plus_copy').length,
        copies_only: groups.filter((g) => g.type === 'copies_only').length,
        multi_native: groups.filter((g) => g.type === 'multi_native').length,
      },
      flags: {
        cross_owner: groups.filter((g) => g.flags.indexOf('cross_owner') >= 0).length,
        amount_mismatch: groups.filter((g) => g.flags.indexOf('amount_mismatch') >= 0).length,
      },
    },
    groups,
  });
}
