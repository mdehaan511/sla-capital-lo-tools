/**
 * baseline-dedupe-merge.mjs — POST /api/baseline-dedupe-merge
 *
 * Deploy 236.182 — merges Baseline-imported duplicates into their
 * SLA-native counterparts.
 *
 * The 236.177 migration created a synthetic client per Baseline
 * loan under the `baseline-migration@sla-import.local` pseudo-
 * owner. If a real LO already had that loan in SLA (same
 * slaDisplayId, since Baseline external Ids match the SLA
 * SLA-YYYYMMDD-NNNN format), both records now coexist — a
 * duplicate.
 *
 * Dedupe strategy: for each slaDisplayId, if a non-import owner
 * has the loan AND the import owner has the loan, we treat the
 * non-import copy as authoritative:
 *   - Copy Baseline-only metadata onto the SLA-native loan
 *     (baselineStatus, baselineSubstatus, baselineOwnerName,
 *      _baselineRaw, _baselineImport*, _baselineMirroredAt).
 *   - Preserve every SLA-authored field on the native loan (id,
 *     ownerKey, LO's notes, guarantors, formData, status,
 *     processingStage, everything else).
 *   - Delete the entire import client record.
 *
 * Ambiguous cases (slaDisplayId under 2+ non-import owners, or
 * present only under the import owner) are reported but NOT
 * modified.
 *
 * Body: { dryRun?: bool (default TRUE) }
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
} from './_shared/auth.mjs';
import { IMPORT_OWNER_KEY } from './_shared/baseline-upsert.mjs';

// Fields we PULL from the Baseline copy onto the native record.
// Everything else on the native loan stays untouched.
const BASELINE_METADATA_FIELDS = [
  'baselineStatus', 'baselineSubstatus', 'baselineOwnerName',
  'baselineArchivedAt', '_baselineRaw', '_baselineImport',
  '_baselineImportedAt', '_baselineMirroredAt', '_baselineId',
];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-dedupe-merge error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;

  const store = getStore({ name: 'clients', consistency: 'strong' });

  // 1) Walk every client + build an index of slaDisplayId ->
  //    [{ ownerKey, clientId, clientKey, loan, client }].
  const index = new Map();
  let clientCount = 0;
  try {
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      clientCount++;
      const idx = key.indexOf('/');
      if (idx < 0) continue;
      const ownerKey = key.slice(0, idx);
      const clientId = key.slice(idx + 1);
      const client   = await store.get(key, { type: 'json' });
      if (!client || !Array.isArray(client.loans)) continue;
      for (const loan of client.loans) {
        const disp = loan && loan.slaDisplayId;
        if (!disp) continue;
        if (!index.has(disp)) index.set(disp, []);
        index.get(disp).push({ ownerKey, clientId, clientKey: key, loan, client });
      }
    }
  } catch (e) {
    return json(500, { error: 'clients store walk failed: ' + (e && e.message) });
  }

  // 2) Find duplicates.
  const duplicates = [];
  const ambiguous  = [];
  const importOnly = [];
  for (const [disp, entries] of index.entries()) {
    if (entries.length < 2) continue;
    const importCopies = entries.filter((e) => e.ownerKey === IMPORT_OWNER_KEY);
    const native       = entries.filter((e) => e.ownerKey !== IMPORT_OWNER_KEY);
    if (!importCopies.length) continue; // no baseline copy — nothing to merge
    if (native.length === 0)   { importOnly.push({ slaDisplayId: disp, entries }); continue; }
    if (native.length > 1) {
      ambiguous.push({ slaDisplayId: disp, nativeOwners: native.map((e) => e.ownerKey) });
      continue;
    }
    duplicates.push({ slaDisplayId: disp, native: native[0], importCopies });
  }

  // 3) Merge Baseline metadata onto native, delete import copies.
  let merged = 0;
  let deleted = 0;
  const errors = [];
  const samples = [];
  const sampleCap = 20;

  for (const d of duplicates) {
    try {
      const nativeClient = d.native.client;
      const nativeLoan   = d.native.loan;
      // Pick the freshest import copy (in case something weird
      // happened and there are 2+ — should be exactly 1).
      const importEntry = d.importCopies[0];
      const importLoan  = importEntry.loan;

      // Merge Baseline metadata onto the native loan.
      const pulled = [];
      for (const f of BASELINE_METADATA_FIELDS) {
        if (importLoan[f] !== undefined && importLoan[f] !== null) {
          if (nativeLoan[f] !== importLoan[f]) pulled.push(f);
          nativeLoan[f] = importLoan[f];
        }
      }
      nativeLoan.updatedAt = new Date().toISOString();

      // Persist the merged native client.
      if (!dryRun) {
        await store.setJSON(d.native.clientKey, nativeClient);
        // Delete all import copies (usually one, defensive).
        for (const ic of d.importCopies) {
          await store.delete(ic.clientKey);
        }
      }

      merged += 1;
      deleted += d.importCopies.length;
      if (samples.length < sampleCap) {
        samples.push({
          slaDisplayId:     d.slaDisplayId,
          nativeOwner:      d.native.ownerKey,
          importOwner:      IMPORT_OWNER_KEY,
          deletedClientIds: d.importCopies.map((e) => e.clientId),
          fieldsPulled:     pulled,
        });
      }
    } catch (e) {
      errors.push({ slaDisplayId: d.slaDisplayId, error: (e && e.message) || 'unknown' });
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    clientCount,
    duplicateCount: duplicates.length,
    merged, deleted,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
    ambiguousCount: ambiguous.length,
    ambiguous: ambiguous.slice(0, 20),
    importOnlyCount: importOnly.length,
    samples,
  });
}
