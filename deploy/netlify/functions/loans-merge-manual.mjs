/**
 * loans-merge-manual.mjs — POST /api/loans-merge-manual
 *
 * Deploy 236.187 — admin-only manual merge of two loans. Where the
 * automatic dedupe (id + address+amount) missed a pair, an admin
 * checks two rows on loans.html, picks a winner, and this endpoint
 * consolidates the pair.
 *
 * Body:
 *   {
 *     winner: { ownerKey, clientId, loanId },
 *     loser:  { ownerKey, clientId, loanId },
 *     winnerOverrides?: { <fieldName>: <value>, ... },
 *   }
 *
 * winnerOverrides (Deploy 236.233) — client-picked field values that
 * override the automatic gap-fill. Applied AFTER gap-fill, so the
 * caller's choices always win — including forcing an empty string
 * ("") to clear a field intentionally. NEVER_TOUCH_ON_WINNER fields
 * (id, createdAt, slaDisplayId) are still protected. Used by the
 * loan-details.html two-stage merge picker where the LO explicitly
 * chose per-field values from either side.
 *
 * Behavior:
 *   - Winner is authoritative on every non-empty field.
 *   - Loser fills gaps: any winner field that is null / '' / undefined
 *     gets the loser's value if the loser has one.
 *   - Baseline metadata (baselineStatus, baselineSubstatus,
 *     baselineOwnerName, _baselineRaw, _baselineImport,
 *     _baselineImportedAt, _baselineMirroredAt, _baselineExternalId,
 *     _baselineId, baselineArchivedAt) is pulled onto the winner
 *     even when the winner already has data — Baseline is the more
 *     authoritative source for those fields regardless of who won.
 *   - Loser client's loans[] loses this entry. If that leaves the
 *     loser client empty AND it was owned by IMPORT_OWNER_KEY, delete
 *     the client outright (baseline pseudo-owner cleanup). Otherwise
 *     keep the emptied client so LO-facing history isn't yanked.
 *   - If either side had a Baseline external Id (via _baselineRaw.Id
 *     or _baselineExternalId), write a native-link so future Migrate
 *     runs route to the winner.
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { IMPORT_OWNER_KEY, setNativeLink } from './_shared/baseline-upsert.mjs';

// Fields that Baseline is authoritative on — always overwrite winner
// with loser's value when loser has one, even if winner is non-empty.
const BASELINE_FIELDS = [
  'baselineStatus', 'baselineSubstatus', 'baselineOwnerName',
  'baselineArchivedAt', '_baselineRaw', '_baselineImport',
  '_baselineImportedAt', '_baselineMirroredAt', '_baselineId',
  '_baselineExternalId',
];

// Fields the winner always keeps verbatim, no matter what.
const NEVER_TOUCH_ON_WINNER = ['id', 'createdAt', 'slaDisplayId'];

function _isEmpty(v) {
  return v === undefined || v === null || v === '' ||
    (Array.isArray(v) && v.length === 0);
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loans-merge-manual error:', e);
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
  const w = body.winner || {};
  const l = body.loser  || {};
  if (!w.ownerKey || !w.clientId || !w.loanId) return json(400, { error: 'winner {ownerKey, clientId, loanId} required' });
  if (!l.ownerKey || !l.clientId || !l.loanId) return json(400, { error: 'loser {ownerKey, clientId, loanId} required' });
  if (w.ownerKey === l.ownerKey && w.clientId === l.clientId && w.loanId === l.loanId) {
    return json(400, { error: 'winner and loser are the same loan' });
  }

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const winnerKey = w.ownerKey + '/' + keySafe(w.clientId);
  const loserKey  = l.ownerKey + '/' + keySafe(l.clientId);
  const winnerClient = await store.get(winnerKey, { type: 'json' }).catch(() => null);
  const loserClient  = winnerKey === loserKey
    ? winnerClient
    : await store.get(loserKey, { type: 'json' }).catch(() => null);

  if (!winnerClient) return json(404, { error: 'Winner client not found' });
  if (!loserClient)  return json(404, { error: 'Loser client not found' });
  if (!Array.isArray(winnerClient.loans)) return json(400, { error: 'Winner client has no loans[]' });
  if (!Array.isArray(loserClient.loans))  return json(400, { error: 'Loser client has no loans[]' });

  const winnerIdx = winnerClient.loans.findIndex((x) => x && x.id === w.loanId);
  const loserIdx  = loserClient.loans.findIndex((x) => x && x.id === l.loanId);
  if (winnerIdx < 0) return json(404, { error: 'Winner loan not found on client' });
  if (loserIdx < 0)  return json(404, { error: 'Loser loan not found on client' });

  const winnerLoan = winnerClient.loans[winnerIdx];
  const loserLoan  = loserClient.loans[loserIdx];
  const now = new Date().toISOString();

  // ── Merge ────────────────────────────────────────────────────
  // 1. Gap-fill winner from loser.
  const filledFields = [];
  const overriddenBaselineFields = [];
  for (const k of Object.keys(loserLoan)) {
    if (NEVER_TOUCH_ON_WINNER.indexOf(k) >= 0) continue;
    if (BASELINE_FIELDS.indexOf(k) >= 0) {
      // Baseline always wins.
      if (loserLoan[k] !== undefined && loserLoan[k] !== null) {
        if (winnerLoan[k] !== loserLoan[k]) overriddenBaselineFields.push(k);
        winnerLoan[k] = loserLoan[k];
      }
      continue;
    }
    if (_isEmpty(winnerLoan[k]) && !_isEmpty(loserLoan[k])) {
      winnerLoan[k] = loserLoan[k];
      filledFields.push(k);
    }
  }
  // Deploy 236.233 — apply client-picked field overrides. Runs AFTER
  // gap-fill so the caller's choices always win. Includes the ability
  // to force an empty string to clear a field intentionally.
  const overriddenPickFields = [];
  const rawOverrides = body.winnerOverrides;
  if (rawOverrides && typeof rawOverrides === 'object' && !Array.isArray(rawOverrides)) {
    for (const k of Object.keys(rawOverrides)) {
      if (NEVER_TOUCH_ON_WINNER.indexOf(k) >= 0) continue;
      if (BASELINE_FIELDS.indexOf(k) >= 0) continue; // Baseline still authoritative
      const v = rawOverrides[k];
      // Skip undefined but allow '' and null (client explicitly clearing).
      if (v === undefined) continue;
      if (winnerLoan[k] !== v) overriddenPickFields.push(k);
      winnerLoan[k] = v;
    }
  }

  winnerLoan.updatedAt = now;
  winnerLoan._mergedFromLoanId    = loserLoan.id;
  winnerLoan._mergedFromClientId  = loserClient.id;
  winnerLoan._mergedFromOwnerKey  = l.ownerKey;
  winnerLoan._mergedAt            = now;
  winnerLoan._mergedBy            = user.email || '';

  // 2. Gap-fill winner client from loser client.
  const filledClientFields = [];
  const CLIENT_MERGE_FIELDS = [
    'firstName', 'lastName', 'email', 'phone', 'entityName',
    'displayName', 'address', 'city', 'state', 'zip', 'ssn',
  ];
  for (const k of CLIENT_MERGE_FIELDS) {
    if (_isEmpty(winnerClient[k]) && !_isEmpty(loserClient[k])) {
      winnerClient[k] = loserClient[k];
      filledClientFields.push(k);
    }
  }

  // Audit note on the winner loan
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(winnerLoan, {
      kind: 'status',
      text: 'Merged with loan ' + (loserLoan.id) + ' from client ' + (loserClient.id) + ' (owner ' + l.ownerKey + '). ' +
        filledFields.length + ' winner field' + (filledFields.length === 1 ? '' : 's') + ' gap-filled; ' +
        overriddenBaselineFields.length + ' Baseline field' + (overriddenBaselineFields.length === 1 ? '' : 's') + ' pulled' +
        (overriddenPickFields.length ? '; ' + overriddenPickFields.length + ' field' + (overriddenPickFields.length === 1 ? '' : 's') + ' picked manually (' + overriddenPickFields.join(', ') + ')' : '') + '.',
      author,
      authorEmail: user.email || '',
      meta: {
        via: 'manual_merge',
        fromLoanId:    loserLoan.id,
        fromClientId:  loserClient.id,
        fromOwnerKey:  l.ownerKey,
        filledFields,
        overriddenBaselineFields,
        overriddenPickFields,
      },
    });
  }

  // ── Persist ──────────────────────────────────────────────────
  // Remove loser from its client's loans[]. If cross-client, save
  // both. If same client, splice on the same object we already
  // updated (winnerClient === loserClient).
  loserClient.loans.splice(loserIdx, 1);
  loserClient.updatedAt = now;

  // If the loser client is now empty AND was owned by IMPORT_OWNER_KEY,
  // it's a baseline import shell — safe to delete.
  const deleteLoserClient = loserClient.loans.length === 0 && l.ownerKey === IMPORT_OWNER_KEY;

  try {
    await store.setJSON(winnerKey, winnerClient);
    if (winnerKey !== loserKey) {
      if (deleteLoserClient) await store.delete(loserKey);
      else                    await store.setJSON(loserKey, loserClient);
    }
  } catch (e) {
    return json(500, { error: 'Failed to persist merged records: ' + (e.message || 'unknown') });
  }

  // ── Native link for future Migrates ──────────────────────────
  // Pick the Baseline external Id from whichever side has it. If
  // both sides have different extIds, prefer the loser's (that's
  // typically the import-copy side). The link ensures the next
  // Migrate routes to the winner, not the (now-deleted) import
  // client.
  const extId = (loserLoan._baselineExternalId
    || (loserLoan._baselineRaw && loserLoan._baselineRaw.Id)
    || winnerLoan._baselineExternalId
    || (winnerLoan._baselineRaw && winnerLoan._baselineRaw.Id)
    || ''
  );
  let linkWritten = false;
  if (extId) {
    try {
      await setNativeLink(String(extId).trim(), {
        ownerKey: w.ownerKey,
        clientId: w.clientId,
        loanId:   winnerLoan.id,
        source:   'manual_merge',
      });
      linkWritten = true;
    } catch (e) {
      console.warn('loans-merge-manual: setNativeLink failed:', e && e.message);
    }
  }

  return json(200, {
    ok: true,
    winner: { ownerKey: w.ownerKey, clientId: w.clientId, loanId: winnerLoan.id },
    filledFields, overriddenBaselineFields, filledClientFields,
    overriddenPickFields,
    loserClientDeleted: deleteLoserClient,
    linkWritten,
    externalId: extId ? String(extId).trim() : '',
  });
}
