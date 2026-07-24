/**
 * _shared/client-lookup.mjs — Postgres-backed client lookups.
 * Deploy 236.418 (incident fix — the guarantor 504s).
 *
 * Replaces the "walk every client blob" relic pattern that survived
 * in the guarantor/borrower flows: sequential per-blob gets over a
 * large owner book (hundreds of records) was blowing gateway
 * timeouts — a borrower signing with 2 guarantors paid the walk per
 * guarantor; the LO Add Guarantor flow paid it per click.
 *
 * Pattern (proven in prospects-save since 236.387): one indexed
 * Postgres query finds the candidate id(s); the client BLOB remains
 * the authoritative read, fetched directly by key. On PG failure
 * these return null (callers treat as "no match" — a rare duplicate
 * client beats a 504).
 */
import { getStore } from '@netlify/blobs';
import { db } from './supabase-db.mjs';
import { keySafe, normalizeEmail } from './auth.mjs';

function _store() {
  return getStore({ name: 'clients', consistency: 'strong' });
}

// PostgREST ilike treats % and _ as wildcards — escape for literal match.
function _escLike(s) {
  return String(s).replace(/([%_\\])/g, '\\$1');
}

/**
 * Find a client under `ownerKey` whose email equals `email`
 * (case-insensitive). Returns { key, client } or null.
 */
export async function findClientByEmail(ownerKey, email, clientsStore) {
  const wanted = normalizeEmail(email);
  if (!wanted || !ownerKey) return null;
  const store = clientsStore || _store();
  let rows;
  try {
    rows = await db.select('clients', {
      select: 'id,email',
      eq: { owner_email: normalizeEmail(ownerKey) },
      ilike: { email: _escLike(wanted) },
      limit: 5,
    });
  } catch (e) {
    console.warn('[client-lookup] byEmail PG query failed:', e && e.message);
    return null;
  }
  for (const row of (rows || [])) {
    if (normalizeEmail(row.email) !== wanted) continue; // ilike is looser than eq
    const key = ownerKey + '/' + keySafe(row.id);
    const client = await store.get(key, { type: 'json' }).catch(() => null);
    if (client) return { key, client };
  }
  return null;
}

/**
 * Find a client blob anywhere (cross-owner) by id. Returns
 * { key, ownerKey, client } or null.
 */
export async function findClientById(clientId, clientsStore) {
  if (!clientId) return null;
  let row;
  try {
    row = await db.first('clients', {
      select: 'id,owner_email',
      eq: { id: clientId },
    });
  } catch (e) {
    console.warn('[client-lookup] byId PG query failed:', e && e.message);
    return null;
  }
  if (!row) return null;
  const ownerKey = keySafe(normalizeEmail(row.owner_email || ''));
  const key = ownerKey + '/' + keySafe(clientId);
  const client = await (clientsStore || _store()).get(key, { type: 'json' }).catch(() => null);
  return client ? { key, ownerKey, client } : null;
}
