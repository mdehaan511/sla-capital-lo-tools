/**
 * clients-merge-manual.mjs — POST /api/clients-merge-manual
 *
 * Deploy 236.230 — merge two clients into one. The admin picks a
 * winner and a loser; loser's data folds into winner and loser is
 * deleted. Same shape as loans-merge-manual (236.187) but scoped to
 * a whole client instead of a single loan.
 *
 * Body: { winnerClientId, loserClientId, owner? }
 *       cross-owner: { winnerOwner, loserOwner, resultOwner? }
 *
 * Deploy 236.853 — WHICH RECORD WINS and WHICH LO KEEPS IT are two
 * separate choices. `resultOwner` (must be one of the two owners
 * involved) decides the namespace the merged client lands in; it
 * defaults to the winner's owner, which is the pre-236.853 behavior.
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

  const user = await requireAuth(context, req);
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

  // Deploy 236.853 (Mike: "if there are 2 different owners of the client
  // allow me to select which owner keeps the client"). Which RECORD wins
  // (whose profile data is authoritative) and which LO KEEPS the merged
  // client are now separate choices. Before this, picking the winner also
  // silently picked the owner, so keeping the better record meant losing the
  // right book — the LO had to reassign first, which the UI didn't offer
  // either.
  //
  // Restricted to one of the two owners already in the merge. This endpoint
  // is a merge, not a general reassign: dropping a client into an uninvolved
  // LO's book is a different operation and shouldn't ride in on this one.
  let resultOwner = winnerOwner;
  if (body.resultOwner) {
    const want = normalizeEmail(body.resultOwner);
    if (want !== winnerOwner && want !== loserOwner) {
      return json(400, { error: 'resultOwner must be one of the two clients\' owners' });
    }
    if (want !== normalizeEmail(user.email) && !isAdmin(user)) {
      return json(403, { error: 'Assigning the merged client to another LO requires admin' });
    }
    resultOwner = want;
  }
  const resultOwnerKey = keySafe(resultOwner);
  // Every cross-store re-key block below moves records INTO this namespace.
  const ownerKey = resultOwnerKey;
  // True when the winning RECORD has to change hands as well — that's the
  // case that needs a second sweep over the winner's own supporting data.
  const winnerMoves = resultOwnerKey !== winnerOwnerKey;

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
  // Deploy 236.853 — snapshot the winner's OWN loan ids before the loser's
  // are appended. When the merged client changes hands these are the loans
  // whose supporting records still sit in the winner's old namespace.
  const winnerOwnLoanIds = Array.from(winnerLoanIds);
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
          gapFilled.length + ' field' + (gapFilled.length === 1 ? '' : 's') + ' gap-filled.' +
          // Deploy 236.853 — an ownership change is the kind of thing an LO
          // discovers by noticing a client vanished from their book, so say
          // it in the audit trail.
          (winnerMoves ? ' Ownership moved from ' + winnerOwner + ' to ' + resultOwner + '.' : ''),
    author: authorName,
    authorEmail: user.email || '',
    meta: {
      via: 'clients_merge_manual', loserClientId: loser.id, gapFilled, loansAdded, companiesAdded,
      winnerOwner, loserOwner, resultOwner, ownerChanged: winnerMoves,
    },
  });
  winner.updatedAt = now;

  // Deploy 236.853 — some loans carry a denormalized `_owner` (read by
  // loan-advance-status to decide who to notify). Left alone it would keep
  // routing to the LO who no longer holds the client. Only refreshed where
  // it was already set — this isn't the place to start stamping it on loans
  // that never had one.
  if (winnerMoves) {
    for (const l of winner.loans) {
      if (l && l._owner) l._owner = resultOwner;
    }
  }

  // 6. Re-key borrower_info + signed_applications into the RESULT owner's
  //    namespace under the winner's client id.
  //
  //    Deploy 236.853 — two sources, not one. The loser's records always
  //    move (its client id is going away). The WINNER's records move too
  //    whenever the LO keeping the client isn't the winner's own owner:
  //    without that second pass a "keep it under the other LO" merge left
  //    the winner's own signed applications and long-app answers stranded
  //    in a namespace nothing reads any more.
  const biStore  = getStore({ name: 'borrower_info', consistency: 'strong' });
  const appStore = getStore({ name: 'signed_applications', consistency: 'strong' });
  let biMoved = 0, appsMoved = 0;

  const reKeySources = [
    {
      fromOwnerKey: loserOwnerKey,
      fromClientId: loser.id,
      loanIds: (Array.isArray(loser.loans) ? loser.loans : []).map((l) => l && l.id).filter(Boolean),
    },
  ];
  if (winnerMoves) {
    reKeySources.push({
      fromOwnerKey: winnerOwnerKey,
      fromClientId: winner.id,
      loanIds: winnerOwnLoanIds,
    });
  }

  for (const src of reKeySources) {
    for (const lid of src.loanIds) {
      const oldK = src.fromOwnerKey + '/' + keySafe(src.fromClientId) + '/' + keySafe(lid);
      const newK = resultOwnerKey   + '/' + keySafe(winner.id)        + '/' + keySafe(lid);
      if (oldK === newK) continue;
      // borrower_info per-loan key
      try {
        const rec = await biStore.get(oldK, { type: 'json' });
        if (rec) {
          rec.clientId = winner.id;
          rec.ownerKey = resultOwnerKey;
          await biStore.setJSON(newK, rec);
          await biStore.delete(oldK);
          biMoved++;
        }
      } catch (_) { /* non-fatal */ }
      // signed_applications
      try {
        const rec = await appStore.get(oldK, { type: 'json' });
        if (rec) {
          rec.clientId = winner.id;
          rec.ownerKey = resultOwnerKey;
          await appStore.setJSON(newK, rec);
          await appStore.delete(oldK);
          appsMoved++;
        }
      } catch (_) { /* non-fatal */ }
    }
    // Legacy per-client borrower_info key (Deploy 168 fallback).
    try {
      const oldK = src.fromOwnerKey + '/' + keySafe(src.fromClientId);
      const newK = resultOwnerKey   + '/' + keySafe(winner.id);
      if (oldK === newK) continue;
      const rec = await biStore.get(oldK, { type: 'json' });
      if (rec && !(await biStore.get(newK, { type: 'json' }))) {
        rec.clientId = winner.id;
        rec.ownerKey = resultOwnerKey;
        await biStore.setJSON(newK, rec);
        await biStore.delete(oldK);
      }
    } catch (_) {}
  }

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
  // Deploy 236.370 — cross-owner merge: scan BOTH the loser's and
  // the winner's quote namespaces. Winner-side catches quotes that
  // referenced the loser's id (rare, but possible for post-merge
  // links). Loser-side is where the loser's own quotes live and
  // need to be moved to the winner's namespace + rewritten.
  // Deploy 236.853 — scan every namespace involved, including the result
  // owner's (a quote may already be filed there and still name the loser).
  const quotesPrefixes = Array.from(new Set([
    winnerOwnerKey + '/', loserOwnerKey + '/', resultOwnerKey + '/',
  ]));
  let quotesRestamped = 0, quotesLoanIdDropped = 0, quotesMoved = 0;
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
        // Deploy 236.853 — does this quote belong to the merged client at
        // all? Only quotes tied to one of the two client ids (or to one of
        // their surviving loans) may change namespace. The winner's prefix
        // holds every OTHER client that LO owns, so a blanket move would
        // drag their whole book along with it.
        const belongsToMerged =
          q.clientId === winner.id ||
          fd._editingClientId === winner.id ||
          (qLid && winnerLoanIds.has(qLid));
        const mustMove = belongsToMerged && prefix !== resultOwnerKey + '/';
        if (!dirty && !mustMove) continue;

        if (mustMove) {
          const newKey = resultOwnerKey + '/' + key.slice(prefix.length);
          q.ownerKey = resultOwnerKey;
          await quotesStore.setJSON(newKey, q);
          if (newKey !== key) await quotesStore.delete(key);
          quotesMoved++;
        } else {
          await quotesStore.setJSON(key, q);
        }
        quotesRestamped++;
      }
    }
  } catch (_) { /* non-fatal — merge itself still succeeds */ }

  // Deploy 236.853 — repoint Doc Reviews. A review is keyed by its own id
  // and carries source.{ownerKey, clientId, loanId}; Loan Details links to
  // it by matching that tuple, so a merge that changed either half left
  // "Open Loan Doc Review" pointing at a client that no longer exists. That
  // was already true of the cross-owner merge added in 236.370 — it moved
  // the client and never told the reviews.
  let reviewsRepointed = 0;
  try {
    const reviewsStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await reviewsStore.list();
    for (const { key } of blobs) {
      const r = await reviewsStore.get(key, { type: 'json' }).catch(() => null);
      if (!r || !r.source) continue;
      const srcCid = r.source.clientId;
      if (srcCid !== loser.id && srcCid !== winner.id) continue;
      if (r.source.loanId && !winnerLoanIds.has(r.source.loanId)) continue;
      // Already pointing exactly where the merge is going.
      if (srcCid === winner.id && r.source.ownerKey === resultOwnerKey) continue;
      r.source.clientId = winner.id;
      r.source.ownerKey = resultOwnerKey;
      const wName = ((winner.firstName || '') + ' ' + (winner.lastName || '')).trim();
      if (wName) r.borrowerName = wName;
      r.updatedAt = now;
      await reviewsStore.setJSON(key, r);
      reviewsRepointed++;
    }
  } catch (e) {
    console.warn('clients-merge-manual: review repoint failed (non-fatal):', e && e.message);
  }

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
      toOwnerKey:   resultOwnerKey,
      toClientId:   winner.id,
      via:          'clients_merge_manual',
    });
  }
  // Deploy 236.853 — the WINNER's own loans need a redirect too when the
  // merged client changes hands. Their (owner, client) tuple was valid a
  // moment ago and is cached in every open Pipeline tab; the client id is
  // unchanged, only the owner moved.
  if (winnerMoves) {
    for (const lid of winnerOwnLoanIds) {
      await recordLoanRedirect({
        loanId:       lid,
        fromOwnerKey: winnerOwnerKey,
        fromClientId: winner.id,
        toOwnerKey:   resultOwnerKey,
        toClientId:   winner.id,
        via:          'clients_merge_manual:owner-move',
      });
    }
  }

  // 7. Persist winner + delete loser.
  try {
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient —
    // also covers the winner's clients-index upsert that used to run
    // after this block (Deploy 236.363).
    // Deploy 236.853 — written under the RESULT owner. Postgres upserts
    // clients and loans on id alone (pg-mirror: onConflict 'id'), so this
    // updates owner_email in place rather than leaving a duplicate row
    // behind; the stale BLOB under the old owner key is what needs the
    // explicit delete below.
    await writeClient(resultOwnerKey, winner, { clientsStore });
    await clientsStore.delete(loserKey);
    if (winnerMoves) {
      await clientsStore.delete(winnerOwnerKey + '/' + keySafe(winner.id));
    }
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
  // Deploy 236.853 — and drop the winner from its OLD owner's bucket when
  // the client changed hands. The index is byOwner[ownerKey] = [...], so
  // this only touches the bucket it left.
  if (winnerMoves) await indexRemoveClient(winnerOwnerKey, winner.id);

  return json(200, {
    ok: true,
    winnerClientId: winner.id,
    resultOwner,
    ownerChanged: winnerMoves,
    loanCount: winner.loans.length,
    loansAdded,
    companiesAdded,
    gapFilled,
    biMoved,
    appsMoved,
    quotesRestamped,
    quotesMoved,
    quotesLoanIdDropped,
    reviewsRepointed,
  });
}
