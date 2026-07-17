/**
 * admin-orphan-clients-cleanup.mjs — POST /api/admin-orphan-clients-cleanup
 *
 * Deploy 236.366 — one-shot cleanup for merged-loser client blobs
 * that survived their merge (either the merge's store.delete failed
 * silently, or a subsequent save flow resurrected them at the same
 * clientId). The clients-merge-manual endpoint (Deploy 236.362) writes
 * a loan_redirects entry per moved loan under a `by-source/<ownerKey>/
 * <clientId>/<loanId>` key — that's our authoritative list of clients
 * that were merged.
 *
 * Body (all optional):
 *   { dryRun?: true|false (default true),
 *     maxDelete?: number    (safety cap, default 200) }
 *
 * Behavior:
 *   1. Walks the loan_redirects blob store, groups by-source keys by
 *      (ownerKey, clientId) — one tuple per merged client.
 *   2. For each tuple, reads the current client blob.
 *      - Missing: nothing to clean (delete already succeeded).
 *      - Has loans[].length > 0: skip. Something (a save flow,
 *        another merge) added loans to this "orphan" client — it's
 *        active data now, not a stale husk. Better to leave it and
 *        let a human triage.
 *      - Empty loans array: this is a genuine orphan husk. Delete it
 *        (unless dryRun).
 *   3. Also drops the by-source key(s) from loan_redirects for
 *      tuples that no longer point at anything useful, so subsequent
 *      cleanup runs skip the ones we already handled.
 *
 * Response:
 *   { ok, dryRun, scanned, wouldDelete, deleted, skippedHasLoans, notes[] }
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';
import { removeClient as indexRemoveClient } from './_shared/clients-index.mjs';

const REDIRECTS_STORE = 'loan_redirects';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-orphan-clients-cleanup error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await req.json().catch(() => ({}))) || {};
  const dryRun = body.dryRun !== false; // default true — safer
  const maxDelete = Number.isFinite(body.maxDelete) && body.maxDelete > 0
    ? Math.min(body.maxDelete, 500)
    : 200;

  const redirectsStore = getStore({ name: REDIRECTS_STORE, consistency: 'strong' });
  const clientsStore   = getStore({ name: 'clients',       consistency: 'strong' });

  // Collect (ownerKey, clientId) tuples that show up as merge sources.
  const merged = new Map(); // key: ownerKey|clientId → { ownerKey, clientId, source }
  try {
    const { blobs } = await redirectsStore.list({ prefix: 'by-source/' });
    for (const { key } of blobs) {
      // key shape: by-source/<ownerKey>/<clientId>/<loanId>
      const parts = key.split('/');
      if (parts.length < 4) continue;
      const ownerKey = parts[1];
      const clientId = parts[2];
      if (!ownerKey || !clientId) continue;
      const mk = ownerKey + '|' + clientId;
      if (!merged.has(mk)) merged.set(mk, { ownerKey, clientId, source: 'merge' });
    }
  } catch (e) {
    return json(500, { error: 'Failed to list redirects: ' + (e && e.message) });
  }

  // Deploy 236.368 — also sweep empty Broker Deal placeholders
  // (_isBrokerPlaceholder=true, created by loan-reassign when
  // setBrokerFlag was set — Clear Primary Guarantor). Auto-cleanup
  // on reassign catches the common case, but any other path that
  // moves a loan off a placeholder without going through reassign
  // (e.g., manual delete-and-recreate, direct clients-save with the
  // loan removed) can strand one. Cheap to scan since we already
  // have to walk the clients store; only adds candidates that are
  // both flagged AND empty.
  const placeholderCandidates = new Map();
  try {
    const { blobs } = await clientsStore.list();
    for (const { key } of blobs) {
      const slash = key.indexOf('/');
      if (slash < 0) continue;
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!rec || !rec._isBrokerPlaceholder) continue;
      const loanCount = Array.isArray(rec.loans) ? rec.loans.length : 0;
      if (loanCount > 0) continue; // has active loans; not orphan
      const ownerKey = key.slice(0, slash);
      const clientId = key.slice(slash + 1);
      const mk = ownerKey + '|' + clientId;
      if (!merged.has(mk)) {
        placeholderCandidates.set(mk, { ownerKey, clientId, source: 'placeholder' });
      }
    }
  } catch (e) {
    // Fall through with just the merge candidates — non-fatal.
    console.warn('admin-orphan-clients-cleanup: placeholder scan failed (non-fatal):', e && e.message);
  }
  for (const [mk, v] of placeholderCandidates) merged.set(mk, v);

  const scanned = merged.size;
  let wouldDelete = 0;
  let deleted = 0;
  let skippedHasLoans = 0;
  let alreadyGone = 0;
  const notes = [];

  for (const { ownerKey, clientId, source } of merged.values()) {
    if (deleted >= maxDelete) {
      notes.push('Hit maxDelete cap (' + maxDelete + '); more may remain.');
      break;
    }
    const key = ownerKey + '/' + clientId;
    const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
    if (!rec) { alreadyGone++; continue; }
    const loanCount = Array.isArray(rec.loans) ? rec.loans.length : 0;
    if (loanCount > 0) {
      skippedHasLoans++;
      notes.push('Skip ' + key + ' [' + source + '] — has ' + loanCount + ' loan(s); not a husk');
      continue;
    }
    wouldDelete++;
    if (dryRun) {
      notes.push('Would delete ' + key + ' [' + source + ']');
      continue;
    }
    try {
      await clientsStore.delete(key);
      indexRemoveClient(ownerKey, clientId).catch(() => {});
      deleted++;
      notes.push('Deleted ' + key + ' [' + source + ']');
    } catch (e) {
      notes.push('Delete FAILED for ' + key + ' [' + source + ']: ' + (e && e.message));
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    scanned,
    wouldDelete,
    deleted,
    skippedHasLoans,
    alreadyGone,
    // Cap notes so the response isn't unbounded on a big cleanup.
    notes: notes.slice(0, 200),
  });
}
