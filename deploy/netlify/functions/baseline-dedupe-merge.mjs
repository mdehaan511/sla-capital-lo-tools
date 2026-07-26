/**
 * baseline-dedupe-merge.mjs — POST /api/baseline-dedupe-merge
 *
 * Deploy 236.183 — merges Baseline-imported duplicates into their
 * SLA-native counterparts. Two passes:
 *
 *   1. Match by slaDisplayId (SLA-YYYYMMDD-NNNN). Catches loans
 *      where SLA generated the id first and pushed it to Baseline
 *      (so both sides carry the same id).
 *
 *   2. Match by normalized street address + loan amount within
 *      ±5%. Catches loans where each side independently generated
 *      its own SLA-YYYYMMDD-NNNN (e.g. Diana Faberman's 200
 *      Marabou Circle showed twice — RTL in New Loan on the SLA
 *      side, DSCR in Underwriting on the Baseline side — same
 *      property, same $277,500, different ids).
 *
 * Merge rule (both passes identical):
 *   - Pull Baseline-only metadata onto the SLA-native loan:
 *     baselineStatus, baselineSubstatus, baselineOwnerName,
 *     _baselineRaw, _baselineImport*, _baselineMirroredAt,
 *     baselineArchivedAt, _baselineId.
 *   - Preserve EVERY SLA-authored field on the native loan
 *     (id, ownerKey, LO's notes, guarantors, formData, status,
 *     processingStage — everything else).
 *   - Delete the import-copy client record.
 *
 * Ambiguous cases (2+ non-import owners, or amount mismatch on
 * address pass) are reported but NOT modified.
 *
 * Body: { dryRun?: bool (default TRUE) }
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
} from './_shared/auth.mjs';
import { IMPORT_OWNER_KEY, setNativeLink, getNativeLink } from './_shared/baseline-upsert.mjs';

// Deploy 236.184 — status + processingStage added. When we merge
// an import copy into a native loan, Baseline is authoritative for
// the loan's stage in the processing pipeline, so we pull those
// values through. The LO's manual status advances still win via
// the preservation clause in the upsert path on subsequent syncs.
const BASELINE_METADATA_FIELDS = [
  'baselineStatus', 'baselineSubstatus', 'baselineOwnerName',
  'baselineArchivedAt', '_baselineRaw', '_baselineImport',
  '_baselineImportedAt', '_baselineMirroredAt', '_baselineId',
  'status', 'processingStage',
];

// Address pass — loan amounts within this % count as the same
// deal. Anything outside is reported as suspicious, not merged.
const AMOUNT_TOLERANCE = 0.05;

// Address pass — minimum normalized-address length. Below this we
// don't trust address matching (a bare "123 Main" is too generic).
const MIN_ADDR_LEN = 15;

// Street-type abbreviations. Normalize both spellings to the same
// canonical form so "Circle" and "Cir" collide.
const ADDR_ABBREV = {
  st: 'street', str: 'street',
  ave: 'avenue', av: 'avenue',
  rd: 'road',
  dr: 'drive',
  cir: 'circle',
  ct: 'court',
  ln: 'lane',
  pl: 'place',
  blvd: 'boulevard',
  pkwy: 'parkway',
  hwy: 'highway',
  ter: 'terrace', terr: 'terrace',
  sq: 'square',
  trl: 'trail',
  n: 'north', no: 'north',
  s: 'south', so: 'south',
  e: 'east',
  w: 'west',
  ne: 'northeast', nw: 'northwest',
  se: 'southeast', sw: 'southwest',
};

function _normAddr(a) {
  if (!a) return '';
  const raw = String(a).toLowerCase();
  // Everything non-alphanumeric becomes a space.
  const cleaned = raw.replace(/[^a-z0-9]+/g, ' ').trim();
  if (!cleaned) return '';
  const tokens = cleaned.split(/\s+/).map((t) => ADDR_ABBREV[t] || t);
  return tokens.join(' ');
}

function _loanAmt(loan) {
  const n = Number(loan && loan.loanAmt);
  return Number.isFinite(n) ? n : 0;
}

function _amountsMatch(a, b) {
  if (!a && !b) return true;                    // both zero → no signal, allow
  if (!a || !b) return false;                   // one zero → suspicious
  const diff = Math.abs(a - b);
  const base = Math.max(a, b);
  return diff / base <= AMOUNT_TOLERANCE;
}

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

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;

  const store = getStore({ name: 'clients', consistency: 'strong' });

  // 1) Walk the whole clients store, build two indexes.
  const idIndex   = new Map();   // slaDisplayId  -> [entry, ...]
  const addrIndex = new Map();   // normAddr      -> [entry, ...]
  const allEntries = [];
  let clientCount = 0;
  try {
    const { blobs } = await store.list();
    for (const { key } of blobs) {
      clientCount++;
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const ownerKey = key.slice(0, slash);
      const clientId = key.slice(slash + 1);
      const client   = await store.get(key, { type: 'json' });
      if (!client || !Array.isArray(client.loans)) continue;
      for (const loan of client.loans) {
        const entry = { ownerKey, clientId, clientKey: key, loan, client };
        allEntries.push(entry);
        const disp = loan && loan.slaDisplayId;
        if (disp) {
          if (!idIndex.has(disp)) idIndex.set(disp, []);
          idIndex.get(disp).push(entry);
        }
        const norm = _normAddr(loan && loan.address);
        if (norm && norm.length >= MIN_ADDR_LEN) {
          if (!addrIndex.has(norm)) addrIndex.set(norm, []);
          addrIndex.get(norm).push(entry);
        }
      }
    }
  } catch (e) {
    return json(500, { error: 'clients store walk failed: ' + (e && e.message) });
  }

  const handled = new Set();     // clientKeys we've written or deleted
  const errors     = [];
  const samplesId   = [];
  const samplesAddr = [];
  const ambiguousId    = [];
  const ambiguousAddr  = [];
  const importOnly     = [];
  const sampleCap = 30;

  let mergedById = 0, deletedById = 0;
  let mergedByAddr = 0, deletedByAddr = 0;

  async function performMerge(nativeEntry, importCopies, matchKind, matchValue) {
    try {
      const nativeClient = nativeEntry.client;
      const nativeLoan   = nativeEntry.loan;
      const importLoan   = importCopies[0].loan;

      const pulled = [];
      for (const f of BASELINE_METADATA_FIELDS) {
        if (importLoan[f] !== undefined && importLoan[f] !== null) {
          if (nativeLoan[f] !== importLoan[f]) pulled.push(f);
          nativeLoan[f] = importLoan[f];
        }
      }
      // Stamp the Baseline extId separately from the native slaDisplayId
      // (which we preserve for LO-visible references). The extId is what
      // the link store and _upsertLinked look up.
      const extId = _pickExternalId(importLoan);
      if (extId) nativeLoan._baselineExternalId = extId;
      nativeLoan.updatedAt = new Date().toISOString();

      if (!dryRun) {
        await store.setJSON(nativeEntry.clientKey, nativeClient);
        for (const ic of importCopies) {
          await store.delete(ic.clientKey);
        }
        // Deploy 236.184 — write a native link so the NEXT Migrate
        // routes updates to nativeLoan instead of re-forking an
        // import copy. Without this we recreate every duplicate we
        // just merged on the next sync.
        if (extId) {
          await setNativeLink(extId, {
            ownerKey: nativeEntry.ownerKey,
            clientId: nativeEntry.clientId,
            loanId:   nativeLoan.id,
            source:   matchKind,
          });
        }
      }
      handled.add(nativeEntry.clientKey);
      for (const ic of importCopies) handled.add(ic.clientKey);
      return { ok: true, pulled, externalId: extId };
    } catch (e) {
      errors.push({ matchKind, matchValue, error: (e && e.message) || 'unknown' });
      return { ok: false };
    }
  }

  // Baseline external Id lives on the import copy as slaDisplayId
  // (set by upsertBaselineLoan) and/or inside _baselineRaw.Id.
  function _pickExternalId(loan) {
    if (!loan) return '';
    if (loan.slaDisplayId) return String(loan.slaDisplayId).trim();
    const raw = loan._baselineRaw;
    if (raw && raw.Id) return String(raw.Id).trim();
    return '';
  }

  // ── Pass 1: match by slaDisplayId ─────────────────────────────
  for (const [disp, entries] of idIndex.entries()) {
    if (entries.length < 2) continue;
    const importCopies = entries.filter((e) => e.ownerKey === IMPORT_OWNER_KEY);
    const native       = entries.filter((e) => e.ownerKey !== IMPORT_OWNER_KEY);
    if (!importCopies.length) continue;
    if (!native.length) { importOnly.push({ slaDisplayId: disp }); continue; }
    if (native.length > 1) {
      ambiguousId.push({ slaDisplayId: disp, nativeOwners: native.map((e) => e.ownerKey) });
      continue;
    }
    const r = await performMerge(native[0], importCopies, 'slaDisplayId', disp);
    if (!r.ok) continue;
    mergedById  += 1;
    deletedById += importCopies.length;
    if (samplesId.length < sampleCap) {
      samplesId.push({
        slaDisplayId:     disp,
        nativeOwner:      native[0].ownerKey,
        nativeAddress:    native[0].loan.address || '',
        deletedClientIds: importCopies.map((e) => e.clientId),
        fieldsPulled:     r.pulled,
      });
    }
  }

  // ── Pass 2: match by normalized address + loan amount ─────────
  // Only look at entries NOT already handled by pass 1.
  for (const [norm, entries] of addrIndex.entries()) {
    if (entries.length < 2) continue;
    const unhandled = entries.filter((e) => !handled.has(e.clientKey));
    if (unhandled.length < 2) continue;

    const importCopies = unhandled.filter((e) => e.ownerKey === IMPORT_OWNER_KEY);
    const native       = unhandled.filter((e) => e.ownerKey !== IMPORT_OWNER_KEY);
    if (!importCopies.length) continue;
    if (!native.length) continue; // will fall through to importOnly listing below
    if (native.length > 1) {
      ambiguousAddr.push({
        normAddr: norm,
        addressSample: native[0].loan.address || '',
        nativeOwners: native.map((e) => e.ownerKey),
        reason: 'multiple native LOs claim this address',
      });
      continue;
    }
    // Amount check — same address, wildly different price = suspicious.
    const nativeAmt = _loanAmt(native[0].loan);
    const importAmt = _loanAmt(importCopies[0].loan);
    if (!_amountsMatch(nativeAmt, importAmt)) {
      ambiguousAddr.push({
        normAddr: norm,
        addressSample: native[0].loan.address || '',
        nativeOwners: [native[0].ownerKey],
        nativeAmt, importAmt,
        reason: 'loan amounts differ >' + Math.round(AMOUNT_TOLERANCE * 100) + '%',
      });
      continue;
    }
    const r = await performMerge(native[0], importCopies, 'address', norm);
    if (!r.ok) continue;
    mergedByAddr  += 1;
    deletedByAddr += importCopies.length;
    if (samplesAddr.length < sampleCap) {
      samplesAddr.push({
        normAddr:         norm,
        nativeAddress:    native[0].loan.address || '',
        importAddress:    importCopies[0].loan.address || '',
        nativeOwner:      native[0].ownerKey,
        nativeAmt, importAmt,
        deletedClientIds: importCopies.map((e) => e.clientId),
        fieldsPulled:     r.pulled,
      });
    }
  }

  // ── Pass 3: back-fill native links for previously-merged loans ──
  // Any native loan carrying _baselineImport:true + an external Id
  // (either _baselineExternalId set by 236.184 dedupe/upsert, or
  // _baselineRaw.Id from the initial merge) is a loan we've already
  // merged. Without a link, the next Migrate would recreate the
  // import copy. This pass writes the link retroactively so re-runs
  // stay clean.
  let linksWritten = 0;
  let linksAlreadyOk = 0;
  const linkSamples = [];
  for (const entry of allEntries) {
    if (entry.ownerKey === IMPORT_OWNER_KEY) continue; // native only
    if (handled.has(entry.clientKey)) continue;         // just merged this run — link already written above
    const loan = entry.loan;
    if (!loan || !loan._baselineImport) continue;
    const extId = loan._baselineExternalId
      || (loan._baselineRaw && loan._baselineRaw.Id)
      || '';
    const cleaned = String(extId || '').trim();
    if (!cleaned) continue;

    try {
      const existing = await getNativeLink(cleaned);
      const alreadyOk = existing
        && existing.ownerKey === entry.ownerKey
        && existing.clientId === entry.clientId
        && existing.loanId   === loan.id;
      if (alreadyOk) { linksAlreadyOk++; continue; }

      if (!dryRun) {
        await setNativeLink(cleaned, {
          ownerKey: entry.ownerKey,
          clientId: entry.clientId,
          loanId:   loan.id,
          source:   'backfill',
        });
      }
      linksWritten++;
      if (linkSamples.length < 30) {
        linkSamples.push({
          externalId: cleaned,
          ownerKey:   entry.ownerKey,
          clientId:   entry.clientId,
          loanId:     loan.id,
          address:    loan.address || '',
        });
      }
    } catch (e) {
      errors.push({ matchKind: 'link_backfill', matchValue: cleaned, error: (e && e.message) || 'unknown' });
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    clientCount,
    // Aggregate totals for the header tiles.
    merged:  mergedById + mergedByAddr,
    deleted: deletedById + deletedByAddr,
    // Per-pass breakdown.
    byId:   { merged: mergedById,   deleted: deletedById,   ambiguousCount: ambiguousId.length,   ambiguous: ambiguousId.slice(0, 20),   samples: samplesId },
    byAddr: { merged: mergedByAddr, deleted: deletedByAddr, ambiguousCount: ambiguousAddr.length, ambiguous: ambiguousAddr.slice(0, 20), samples: samplesAddr },
    // Deploy 236.184 — link back-fill for previously-merged loans.
    links: {
      written:   linksWritten,
      alreadyOk: linksAlreadyOk,
      samples:   linkSamples,
    },
    importOnlyCount: importOnly.length,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
  });
}
