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

  let owner = normalizeEmail(user.email);
  if (body.owner && body.owner !== owner) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    owner = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(owner);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const winnerKey = ownerKey + '/' + keySafe(winnerId);
  const loserKey  = ownerKey + '/' + keySafe(loserId);
  const winner = await clientsStore.get(winnerKey, { type: 'json' }).catch(() => null);
  const loser  = await clientsStore.get(loserKey,  { type: 'json' }).catch(() => null);
  if (!winner) return json(404, { error: 'Winner client not found' });
  if (!loser)  return json(404, { error: 'Loser client not found' });

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
      const oldK = ownerKey + '/' + keySafe(loser.id) + '/' + keySafe(l.id);
      const newK = ownerKey + '/' + keySafe(winner.id) + '/' + keySafe(l.id);
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
      const oldK = ownerKey + '/' + keySafe(loser.id) + '/' + keySafe(l.id);
      const newK = ownerKey + '/' + keySafe(winner.id) + '/' + keySafe(l.id);
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
    const oldK = ownerKey + '/' + keySafe(loser.id);
    const newK = ownerKey + '/' + keySafe(winner.id);
    const rec = await biStore.get(oldK, { type: 'json' });
    if (rec && !(await biStore.get(newK, { type: 'json' }))) {
      rec.clientId = winner.id;
      await biStore.setJSON(newK, rec);
      await biStore.delete(oldK);
    }
  } catch (_) {}

  // 7. Persist winner + delete loser.
  try {
    await clientsStore.setJSON(winnerKey, winner);
    await clientsStore.delete(loserKey);
  } catch (e) {
    return json(500, { error: 'Failed to persist merge: ' + (e && e.message) });
  }

  return json(200, {
    ok: true,
    winnerClientId: winner.id,
    loanCount: winner.loans.length,
    loansAdded,
    companiesAdded,
    gapFilled,
    biMoved,
    appsMoved,
  });
}
