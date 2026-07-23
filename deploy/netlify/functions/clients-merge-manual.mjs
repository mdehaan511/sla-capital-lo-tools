/**
 * clients-merge-manual.mjs — POST /api/clients-merge-manual
 *
 * Deploy 236.230 — merge two clients into one. The admin picks a
 * winner and a loser; loser's data folds into winner and loser is
 * deleted. Same shape as loans-merge-manual (236.187) but scoped to
 * a whole client instead of a single loan.
 *
 * Body: { winnerClientId, loserClientId, owner? }
 *
 * Behavior:
 *   1. Winner scalar fields are authoritative; loser fills empty gaps
 *      (firstName, lastName, email, phone, dob, fico, ssn_enc,
 *       homeAddress, entityName, notes).
 *   2. Loser's loans[] are appended onto winner (deduped by id).
 *   3. Loser's companies[] are merged into winner (deduped by
 *      normalized name).
 *   4. borrower_info records under (owner, loserClientId, loanId)
 *      are re-keyed under winnerClientId.
 *   5. signed_applications same.
 *   6. Loser client record deleted.
 *   7. loans-merge-manual's linked-quote sync is NOT re-run — quotes
 *      still key by loanId which is unchanged. Rate-sheet PDFs will
 *      pick up the winner's data next open.
 *
 * Response: { ok, winnerClientId, loanCount, companiesAdded, biMoved, appsMoved }
 * Auth: LO owns both clients (or admin owner-override).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.362 — persist redirects for every loan that moved from
// loser → winner. Pipeline / other pages may still hold cached tiles
// pointing at (ownerKey, loser.id, loanId); loan-details reads the
// redirect map and auto-redirects instead of dead-ending with
// "Client not found" once the loser blob is deleted.
import { record as recordLoanRedirect } from './_shared/loan-redirects.mjs';
// Deploy 236.363 — the merge writes the primary client blobs but
// never told the materialized index about them. Result: loan-locate
// walked the STALE index, found the loan under the (deleted) loser,
// and my auto-redirect in loan-details bounced right back to the
// dead URL. Update the index in-flight so subsequent reads are
// consistent.
import { removeClient as indexRemoveClient } from './_shared/clients-index.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write (kept for deleteClientStrict)
// Deploy 236.402 (C2 slice 2): winner persists route through the shared
// PG-first writeClient helper (covers blob + pg + clients-index).
import { writeClient } from './_shared/client-write.mjs';

function _isEmpty(v) {
  return v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length);
}
function _normCompanyName(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(llc|l\.l\.c\.|inc|incorporated|corporation|corp|ltd|limited|co)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

const SCALAR_FIELDS = [
  'firstName', 'lastName', 'email', 'phone', 'dob', 'fico',
  'ssn_enc', 'entityName', 'displayName', 'notes',
  '_isBroker', '_brokerCompany',
];
const NESTED_OBJECT_FIELDS = ['homeAddress', 'mailingAddress', 'prevAddress', 'declarations'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('clients-merge-manual error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  const winnerId = String(body.winnerClientId || '').trim();
  const loserId  = String(body.loserClientId  || '').trim();
  if (!winnerId || !loserId) return json(400, { error: 'winnerClientId + loserClientId required' });
  if (winnerId === loserId) return json(400, { error: 'winner and loser are the same client' });

  // Deploy 236.370 — cross-owner merge. Legacy shape: `owner` (single
  // value, assumes both are under the same key). New shape:
  // `winnerOwner` + `loserOwner` (separate), used by the Brokers page
  // when the 5-copies-of-Jaelen case spans multiple LO namespaces.
  // Falls back to the legacy shape when the new params aren't present.
  let winnerOwner, loserOwner;
  if (body.winnerOwner || body.loserOwner) {
    if (!isAdmin(user)) return json(403, { error: 'Cross-owner merge requires admin' });
    winnerOwner = normalizeEmail(body.winnerOwner || body.owner || user.email);
    loserOwner  = normalizeEmail(body.loserOwner  || body.owner || user.email);
  } else {
    let owner = normalizeEmail(user.email);
    if (body.owner && body.owner !== owner) {
      if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
      owner = normalizeEmail(body.owner);
    }
    winnerOwner = owner;
    loserOwner  = owner;
  }
  const winnerOwnerKey = keySafe(winnerOwner);
  const loserOwnerKey  = keySafe(loserOwner);
  // Keep an ownerKey alias equal to the WINNER's owner for the
  // downstream cross-store re-key blocks (borrower_info, quotes,
  // reviews) — they all move records into the winner's namespace.
  const ownerKey = winnerOwnerKey;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const winnerKey = winnerOwnerKey + '/' + keySafe(winnerId);
  const loserKey  = loserOwnerKey  + '/' + keySafe(loserId);
  const winner = await clientsStore.get(winnerKey, { type: 'json' }).catch(() => null);
  const loser  = await clientsStore.get(loserKey,  { type: 'json' }).catch(() => null);
  if (!winner) return json(404, { error: 'Winner client not found at ' + winnerKey });
  if (!loser)  return json(404, { error: 'Loser client not found at '  + loserKey });

  const now = new Date().toISOString();

  // 1. Gap-fill winner scalars from loser.
  const gapFilled = [];
  for (const k of SCALAR_FIELDS) {
    if (_isEmpty(winner[k]) && !_isEmpty(loser[k])) {
      winner[k] = loser[k];
      gapFilled.push(k);
    }
  }
  // 2. Nested-object gap-fill (per-key on the nested object).
  for (const f of NESTED_OBJECT_FIELDS) {
    if (!loser[f] || typeof loser[f] !== 'object') continue;
    winner[f] = winner[f] && typeof winner[f] === 'object' ? winner[f] : {};
    for (const k of Object.keys(loser[f])) {
      if (_isEmpty(winner[f][k]) && !_isEmpty(loser[f][k])) {
        winner[f][k] = loser[f][k];
      }
    }
  }
  // 3. Loans — append with id dedupe.
  winner.loans = Array.isArray(winner.loans) ? winner.loans : [];
  const winnerLoanIds = new Set(winner.loans.map((l) => l && l.id).filter(Boolean));
  const loanCountBefore = winner.loans.length;
  for (const l of (Array.isArray(loser.loans) ? loser.loans : [])) {
    if (l && l.id && !winnerLoanIds.has(l.id)) {
      winner.loans.push(l);
      winnerLoanIds.add(l.id);
    }
  }
  const loansAdded = winner.loans.length - loanCountBefore;

  // 4. Companies — merge with normalized-name dedupe.
  winner.companies = Array.isArray(winner.companies) ? winner.companies : [];
  const winnerCompanyNames = new Set(winner.companies.map((c) => _normCompanyName(c && c.name)));
  let companiesAdded = 0;
  for (const co of (Array.isArray(loser.companies) ? loser.companies : [])) {
    if (!co) continue;
    const n = _normCompanyName(co.name);
    if (n && !winnerCompanyNames.has(n)) {
      winner.companies.push(co);
      winnerCompanyNames.add(n);
      companiesAdded++;
    }
  }

  // 5. Audit note on the winner.
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  const loserLabel = ((loser.firstName || '') + ' ' + (loser.lastName || '')).trim()
    || loser.email || loser.id;
  appendNoteEntry(winner, {
    kind: 'status',
    text: 'Merged with client "' + loserLabel + '" (' + loser.id + '). ' +
          loansAdded + ' loan' + (loansAdded === 1 ? '' : 's') + ' + ' +
          companiesAdded + ' compan' + (companiesAdded === 1 ? 'y' : 'ies') + ' absorbed; ' +
          gapFilled.length + ' field' + (gapFilled.length === 1 ? '' : 's') + ' gap-filled.',
    author: authorName,
    authorEmail: user.email || '',
    meta: { via: 'clients_merge_manual', loserClientId: loser.id, gapFilled, loansAdded, companiesAdded },
  });
  winner.updatedAt = now;

  // 6. Re-key borrower_info + signed_applications from loser → winner.
  const biStore  = getStore({ name: 'borrower_info', consistency: 'strong' });
  const appStore = getStore({ name: 'signed_applications', consistency: 'strong' });
  let biMoved = 0, appsMoved = 0;
  for (const l of (Array.isArray(loser.loans) ? loser.loans : [])) {
    if (!l || !l.id) continue;
    // borrower_info per-loan key
    try {
      const oldK = loserOwnerKey  + '/' + keySafe(loser.id)  + '/' + keySafe(l.id);
      const newK = winnerOwnerKey + '/' + keySafe(winner.id) + '/' + keySafe(l.id);
      const rec = await biStore.get(oldK, { type: 'json' });
      if (rec) {
        rec.clientId = winner.id;
        await biStore.setJSON(newK, rec);
        await biStore.delete(oldK);
        biMoved++;
      }
    } catch (_) { /* non-fatal */ }
    // signed_applications
    try {
      const oldK = loserOwnerKey  + '/' + keySafe(loser.id)  + '/' + keySafe(l.id);
      const newK = winnerOwnerKey + '/' + keySafe(winner.id) + '/' + keySafe(l.id);
      const rec = await appStore.get(oldK, { type: 'json' });
      if (rec) {
        rec.clientId = winner.id;
        await appStore.setJSON(newK, rec);
        await appStore.delete(oldK);
        appsMoved++;
      }
    } catch (_) { /* non-fatal */ }
  }
  // Legacy per-client borrower_info key (Deploy 168 fallback).
  try {
    const oldK = loserOwnerKey  + '/' + keySafe(loser.id);
    const newK = winnerOwnerKey + '/' + keySafe(winner.id);
    const rec = await biStore.get(oldK, { type: 'json' });
    if (rec && !(await biStore.get(newK, { type: 'json' }))) {
      rec.clientId = winner.id;
      await biStore.setJSON(newK, rec);
      await biStore.delete(oldK);
    }
  } catch (_) {}

  // Deploy 236.236 — sweep the quotes store so pipeline cards don't
  // silently misroute after the merge. Without this, a quote stamped
  // with loser.id / <a loanId that only existed on loser> lingers
  // pointing at nothing; the pipeline card resolves to a dead client
  // (Randy Dargan / Vinnie Pastura / 335 Trevor incident 2026-07-07).
  // For each quote under this owner:
  //   - if quote.clientId === loser.id → rewrite to winner.id
  //   - if quote's stamped loanId (or _editingLoanId) belonged only to
  //     the loser and NOT a loan we just carried into winner → drop it
  //     so pipeline can fall through to address resolution.
  const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
  const loserLoanIds  = new Set((Array.isArray(loser.loans) ? loser.loans : []).map((l) => l && l.id).filter(Boolean));
  // winnerLoanIds already exists from the loan-merge loop above and
  // reflects the final set including any loser loans that were
  // appended. Reusing it avoids a redeclaration collision that
  // broke the Netlify function bundler in 236.236 (fixed 236.237).
  let quotesRestamped = 0, quotesLoanIdDropped = 0;
  // Deploy 236.370 — cross-owner merge: scan BOTH the loser's and
  // the winner's quote namespaces. Winner-side catches quotes that
  // referenced the loser's id (rare, but possible for post-merge
  // links). Loser-side is where the loser's own quotes live and
  // need to be moved to the winner's namespace + rewritten.
  const quotesPrefixes = winnerOwnerKey === loserOwnerKey
    ? [ownerKey + '/']
    : [winnerOwnerKey + '/', loserOwnerKey + '/'];
  try {
    for (const prefix of quotesPrefixes) {
      const { blobs } = await quotesStore.list({ prefix });
      for (const { key } of blobs) {
        const q = await quotesStore.get(key, { type: 'json' }).catch(() => null);
        if (!q) continue;
        const fd = q.formData || (q.formData = {});
        let dirty = false;
        // Rewrite clientId if it points at the loser.
        if (q.clientId === loser.id)     { q.clientId = winner.id; dirty = true; }
        if (fd._editingClientId === loser.id) { fd._editingClientId = winner.id; dirty = true; }
        // Drop a stamped loanId that lived only on the loser and didn't
        // survive the merge into winner. Address resolution takes over.
        const qLid = q.loanId || fd._editingLoanId || '';
        if (qLid && loserLoanIds.has(qLid) && !winnerLoanIds.has(qLid)) {
          if (q.loanId === qLid)          { q.loanId = ''; dirty = true; }
          if (fd._editingLoanId === qLid) { fd._editingLoanId = ''; dirty = true; }
          quotesLoanIdDropped++;
        }
        if (dirty) {
          // Cross-owner: rewrite the quote's blob key to the winner's
          // namespace, delete the old key. Same-owner keeps the key.
          if (prefix === loserOwnerKey + '/' && winnerOwnerKey !== loserOwnerKey) {
            const newKey = winnerOwnerKey + '/' + key.slice(loserOwnerKey.length + 1);
            q.ownerKey = winnerOwnerKey;
            await quotesStore.setJSON(newKey, q);
            await quotesStore.delete(key);
          } else {
            await quotesStore.setJSON(key, q);
          }
          quotesRestamped++;
        }
      }
    }
  } catch (_) { /* non-fatal — merge itself still succeeds */ }

  // Deploy 236.362 — record a redirect per moved loan BEFORE the
  // loser blob gets deleted. Pipeline / clients / dashboards etc. may
  // still hold cached rows pointing at (owner, loser.id, loanId);
  // when the LO clicks one, loan-details will consult the redirect
  // map and auto-navigate to (owner, winner.id, loanId) instead of
  // dead-ending with "Client not found". Use loserLoanIds computed
  // earlier (all loans on the losing client, whether or not they
  // dedup'd against a winner loan of the same id).
  for (const lid of loserLoanIds) {
    await recordLoanRedirect({
      loanId:       lid,
      fromOwnerKey: loserOwnerKey,
      fromClientId: loser.id,
      toOwnerKey:   winnerOwnerKey,
      toClientId:   winner.id,
      via:          'clients_merge_manual',
    });
  }

  // 7. Persist winner + delete loser.
  try {
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient —
    // also covers the winner's clients-index upsert that used to run
    // after this block (Deploy 236.363).
    await writeClient(winnerOwnerKey, winner, { clientsStore });
    await clientsStore.delete(loserKey);
    await pgMirror.deleteClientStrict(loser.id);
  } catch (e) {
    return json(500, { error: 'Failed to persist merge: ' + (e && e.message) });
  }

  // Deploy 236.363 — index sync (loser removal). Without this the
  // materialized clients-index still shows the loser (with its old
  // loans), which causes loan-locate to resolve the loan under the
  // deleted loser. The winner's index upsert now happens inside
  // writeClient above (Deploy 236.402). removeClient swallows errors
  // so an index-write blip doesn't roll back the successful merge.
  //
  // Deploy 236.370 — cross-owner-aware: remove loser under its own
  // owner (which may differ from the winner's).
  await indexRemoveClient(loserOwnerKey, loser.id);

  return json(200, {
    ok: true,
    winnerClientId: winner.id,
    loanCount: winner.loans.length,
    loansAdded,
    companiesAdded,
    gapFilled,
    biMoved,
    appsMoved,
    quotesRestamped,
    quotesLoanIdDropped,
  });
}
