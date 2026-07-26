/**
 * clients-dedupe-loans.mjs — POST /api/clients-dedupe-loans
 *
 * Admin-only one-shot. Walks all client records and dedupes the loans array
 * on each by normalized street name. Preserves the most-recently-updated
 * entry of each duplicate group; merges status (closed > approved >
 * awaiting_app > submitted > active) and any LO-edited fields (loanAmt
 * with loanAmtLocked, projectDescription, notes).
 *
 * Body: { dryRun: true|false } — dryRun:true returns counts without writing
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody } from './_shared/auth.mjs';
import { canListAllClients } from './_shared/access.mjs'; // Deploy 236.170
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write

export default async (req, context) => {
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('clients-dedupe-loans error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canListAllClients(user).ok) return json(403, { error: 'Admin only' });

  const body = await readJsonBody(req) || {};
  const dryRun = !!body.dryRun;

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await store.list();
  let touched = 0, removed = 0;
  const samples = [];

  // Status priority: higher number = more advanced; we keep the loan with
  // the highest priority when merging duplicates.
  const STATUS_PRIORITY = {
    closed: 6, approved: 5, awaiting_app: 4, submitted: 3,
    active: 2, on_hold: 1, denied: 0,
  };
  const statusRank = (s) => STATUS_PRIORITY[s] != null ? STATUS_PRIORITY[s] : 2;

  // Normalize a loan address to its street segment for matching
  const normStreet = (addr) =>
    String(addr || '').toLowerCase().trim()
      .split(',')[0].trim()
      .replace(/\s+/g, ' ');

  for (const { key } of blobs) {
    const c = await store.get(key, { type: 'json' });
    if (!c || !Array.isArray(c.loans) || c.loans.length < 2) continue;
    const before = c.loans.length;
    // Group by normalized street
    const groups = new Map();
    for (const loan of c.loans) {
      const k = normStreet(loan.address);
      if (!k) { // empty-address loan stays as-is in its own bucket
        const uid = '__empty_' + Math.random();
        groups.set(uid, [loan]);
        continue;
      }
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(loan);
    }
    // For each group with > 1, merge into one
    const dedup = [];
    for (const [streetKey, loans] of groups) {
      if (loans.length === 1) { dedup.push(loans[0]); continue; }
      // Pick the "winner" — highest status, most recent update as tiebreaker
      loans.sort((a, b) => {
        const sa = statusRank(a.status || 'active');
        const sb = statusRank(b.status || 'active');
        if (sa !== sb) return sb - sa;
        const da = new Date(a.updatedAt || a.createdAt || 0).getTime();
        const db = new Date(b.updatedAt || b.createdAt || 0).getTime();
        return db - da;
      });
      const winner = Object.assign({}, loans[0]);
      // Merge in LO-edited fields from any duplicate that has them
      for (let i = 1; i < loans.length; i++) {
        const dup = loans[i];
        if (!winner.loanAmtLocked && dup.loanAmtLocked) {
          winner.loanAmt = dup.loanAmt;
          winner.loanAmtLocked = true;
        }
        if (!winner.projectDescription && dup.projectDescription) winner.projectDescription = dup.projectDescription;
        if (!winner.notes && dup.notes) winner.notes = dup.notes;
        if (!winner.bedrooms && dup.bedrooms) winner.bedrooms = dup.bedrooms;
        if (!winner.bathrooms && dup.bathrooms) winner.bathrooms = dup.bathrooms;
        if (!winner.sqft && dup.sqft) winner.sqft = dup.sqft;
        // Keep the longest address string (likely most complete)
        if (dup.address && (!winner.address || dup.address.length > winner.address.length)) {
          winner.address = dup.address;
        }
      }
      dedup.push(winner);
    }
    if (dedup.length !== before) {
      removed += (before - dedup.length);
      touched++;
      if (samples.length < 10) {
        samples.push({
          client: c.firstName + ' ' + c.lastName,
          email: c.email,
          before,
          after: dedup.length,
        });
      }
      if (!dryRun) {
        c.loans = dedup;
        c.updatedAt = new Date().toISOString();
        await store.setJSON(key, c);
        const _ownerKey = key.split('/')[0] || '';
        await pgMirror.upsertClientWithLoansStrict(_ownerKey, c);
      }
    }
  }
  return json(200, { ok: true, dryRun, clientsTouched: touched, loansRemoved: removed, samples });
}
