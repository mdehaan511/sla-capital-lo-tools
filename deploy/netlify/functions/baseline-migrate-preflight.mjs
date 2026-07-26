/**
 * baseline-migrate-preflight.mjs — POST /api/baseline-migrate-preflight
 *
 * Deploy 236.186 — self-healing pre-step for the Migrate button.
 * Runs BEFORE the chunk loop so Migrate can't recreate duplicates
 * even if the user never ran Merge Duplicates. Two responsibilities:
 *
 *   1. Back-fill native links for previously-merged loans. Every
 *      native loan carrying _baselineImport:true has a discoverable
 *      Baseline external Id (from _baselineExternalId, set by
 *      236.184 dedupe/upsert, or from _baselineRaw.Id, set by every
 *      prior merge). Write a link ext -> {ownerKey, clientId,
 *      loanId} so upsertBaselineLoan routes updates to the LO's
 *      loan.
 *
 *   2. Orphan cleanup. Any client under IMPORT_OWNER_KEY whose
 *      loans point to an ext Id that's now linked to a native
 *      record is a leftover from a pre-link Migrate run (e.g. the
 *      one that recreated Diana Faberman's duplicate after 236.183).
 *      Delete it — the real record lives on the LO's side now, and
 *      the link will keep it there.
 *
 * Fully idempotent. Safe to call at the start of every Migrate.
 * Uses parallel blob reads (concurrency 10) so ~250 clients walk
 * in ~2-3s instead of ~25s serial.
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { IMPORT_OWNER_KEY, getNativeLink, setNativeLink } from './_shared/baseline-upsert.mjs';

const CONCURRENCY = 10;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-migrate-preflight error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const store = getStore({ name: 'clients', consistency: 'strong' });

  // ── 1. Walk the clients store in parallel. ────────────────────
  let blobs;
  try { blobs = (await store.list()).blobs || []; }
  catch (e) { return json(500, { error: 'clients store list failed: ' + (e && e.message) }); }

  const walked = [];
  for (let i = 0; i < blobs.length; i += CONCURRENCY) {
    const chunk = blobs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async ({ key }) => ({
      key,
      client: await store.get(key, { type: 'json' }).catch(() => null),
    })));
    for (const r of results) walked.push(r);
  }

  // ── 2. Back-fill links for previously-merged native loans. ────
  let linksWritten = 0, linksAlreadyOk = 0;
  const linkedExtIds = new Set();
  const linkSamples = [];
  for (const { key, client } of walked) {
    const slash = key.indexOf('/');
    if (slash < 0) continue;
    const ownerKey = key.slice(0, slash);
    if (ownerKey === IMPORT_OWNER_KEY) continue; // native only
    const clientId = key.slice(slash + 1);
    if (!client || !Array.isArray(client.loans)) continue;
    for (const loan of client.loans) {
      if (!loan || !loan._baselineImport) continue;
      const extId = String(
        loan._baselineExternalId
        || (loan._baselineRaw && loan._baselineRaw.Id)
        || ''
      ).trim();
      if (!extId) continue;
      linkedExtIds.add(extId);
      const existing = await getNativeLink(extId);
      const ok = existing
        && existing.ownerKey === ownerKey
        && existing.clientId === clientId
        && existing.loanId === loan.id;
      if (ok) { linksAlreadyOk++; continue; }
      await setNativeLink(extId, {
        ownerKey, clientId, loanId: loan.id, source: 'preflight',
      });
      linksWritten++;
      if (linkSamples.length < 20) {
        linkSamples.push({ externalId: extId, ownerKey, clientId, loanId: loan.id, address: loan.address || '' });
      }
    }
  }

  // ── 3. Orphan cleanup. ────────────────────────────────────────
  // Any client under IMPORT_OWNER_KEY whose loan's extId is now
  // linked to a native LO is a leftover from a pre-link Migrate.
  // Delete it. The next Migrate will route the extId to the native
  // via the link we just wrote.
  let orphanedDeleted = 0;
  const orphanSamples = [];
  for (const { key, client } of walked) {
    const slash = key.indexOf('/');
    if (slash < 0) continue;
    const ownerKey = key.slice(0, slash);
    if (ownerKey !== IMPORT_OWNER_KEY) continue;
    if (!client || !Array.isArray(client.loans) || !client.loans.length) continue;
    const extIds = client.loans
      .map((l) => (l && (l.slaDisplayId || (l._baselineRaw && l._baselineRaw.Id))) || '')
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    const anyLinked = extIds.some((extId) => linkedExtIds.has(extId));
    if (!anyLinked) continue;
    await store.delete(key);
    orphanedDeleted++;
    if (orphanSamples.length < 20) {
      orphanSamples.push({ clientKey: key, extIds });
    }
  }

  return json(200, {
    ok: true,
    clientCount:    walked.length,
    linksWritten,
    linksAlreadyOk,
    orphanedDeleted,
    linkSamples,
    orphanSamples,
  });
}
