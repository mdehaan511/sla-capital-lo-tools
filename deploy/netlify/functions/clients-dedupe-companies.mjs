/**
 * clients-dedupe-companies.mjs — POST /api/clients-dedupe-companies
 *
 * Admin-only one-shot. Walks all client records and dedupes the companies
 * array on each by name+EIN. Preserves the most recent entry for each match.
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
    console.error('clients-dedupe-companies error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canListAllClients(user).ok) return json(403, { error: 'Admin only' });

  const body = await readJsonBody(req) || {};
  const dryRun = !!body.dryRun;

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await store.list();
  let touched = 0, removed = 0;
  const samples = [];

  const norm = (s) => String(s || '').trim().toLowerCase();
  const ed = (s) => String(s || '').replace(/\D/g, '');

  for (const { key } of blobs) {
    const c = await store.get(key, { type: 'json' });
    if (!c || !Array.isArray(c.companies) || c.companies.length === 0) continue;
    const before = c.companies.length;
    const seen = new Map(); // key → first entry
    const dedup = [];
    for (const co of c.companies) {
      const k = norm(co.name) + '|' + ed(co.ein);
      if (!co.name && !co.ein) { dedup.push(co); continue; } // truly empty stays
      if (seen.has(k)) {
        // Merge into the existing one — prefer non-empty fields from the newer
        const idx = seen.get(k);
        ['address','city','addrState','zip','state'].forEach((f) => {
          if (!dedup[idx][f] && co[f]) dedup[idx][f] = co[f];
        });
        continue;
      }
      seen.set(k, dedup.length);
      dedup.push(co);
    }
    if (dedup.length !== before) {
      removed += (before - dedup.length);
      touched++;
      if (samples.length < 10) samples.push({ key, before, after: dedup.length });
      if (!dryRun) {
        c.companies = dedup;
        c.updatedAt = new Date().toISOString();
        await store.setJSON(key, c);
        const _ownerKey = key.split('/')[0] || '';
        pgMirror.upsertClientWithLoans(_ownerKey, c).catch(() => {});
      }
    }
  }
  return json(200, { ok: true, dryRun, clientsTouched: touched, companiesRemoved: removed, samples });
}
