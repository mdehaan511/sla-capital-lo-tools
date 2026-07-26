/**
 * admin-find-record.mjs — GET /api/admin-find-record?q=<substring>
 *
 * Deploy 236.235 — admin diagnostic. Grep every blob store for
 * records whose fields (borrower name, address, email, entity name,
 * loan address, notes) contain a case-insensitive substring. Used
 * for tracking down phantom pipeline cards / orphaned records that
 * the standard admin tools can't locate.
 *
 * Query params:
 *   q       — required substring
 *   stores  — comma-separated: clients, quotes, prospects, reminders,
 *             borrower_info (default: clients,quotes,prospects)
 *   maxHits — cap per store (default 30, hard cap 200)
 *
 * Returns:
 *   {
 *     query: '335 trevor',
 *     matches: {
 *       clients:   [{key, ownerKey, client, hitFields}],
 *       quotes:    [{key, ownerKey, quote,  hitFields}],
 *       prospects: [{key, ownerKey, prospect, hitFields}],
 *     },
 *     scanned: { clients: 1234, quotes: 456, prospects: 78 },
 *   }
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin,
} from './_shared/auth.mjs';

function _hasHit(obj, needle, path) {
  if (obj == null) return false;
  if (typeof obj === 'string') {
    if (obj.toLowerCase().indexOf(needle) >= 0) return true;
    return false;
  }
  if (typeof obj !== 'object') return false;
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (_hasHit(v, needle, path.concat(k))) return true;
  }
  return false;
}

function _hitFields(obj, needle, path = [], out = []) {
  if (out.length >= 20) return out;
  if (obj == null) return out;
  if (typeof obj === 'string') {
    if (obj.toLowerCase().indexOf(needle) >= 0) out.push({ path: path.join('.'), value: obj.slice(0, 120) });
    return out;
  }
  if (typeof obj !== 'object') return out;
  for (const k of Object.keys(obj)) {
    _hitFields(obj[k], needle, path.concat(k), out);
    if (out.length >= 20) break;
  }
  return out;
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-find-record error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin required' });

  const url = new URL(req.url);
  const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
  if (!q) return json(400, { error: 'q required' });
  const storesParam = String(url.searchParams.get('stores') || 'clients,quotes,prospects').toLowerCase();
  const wantStores = new Set(storesParam.split(',').map((s) => s.trim()).filter(Boolean));
  const maxHits = Math.min(200, Math.max(1, parseInt(url.searchParams.get('maxHits') || '30', 10)));

  const matches = {};
  const scanned = {};

  async function scanStore(storeName, keyName) {
    if (!wantStores.has(storeName)) return;
    const store = getStore({ name: storeName, consistency: 'strong' });
    matches[storeName] = [];
    scanned[storeName] = 0;
    try {
      const { blobs } = await store.list();
      for (const { key } of blobs) {
        scanned[storeName]++;
        const rec = await store.get(key, { type: 'json' }).catch(() => null);
        if (!rec) continue;
        if (!_hasHit(rec, q, [])) continue;
        const slash = key.indexOf('/');
        const ownerKey = slash > 0 ? key.slice(0, slash) : '';
        matches[storeName].push({
          key,
          ownerKey,
          [keyName]: rec,
          hitFields: _hitFields(rec, q),
        });
        if (matches[storeName].length >= maxHits) break;
      }
    } catch (e) {
      matches[storeName] = { error: (e && e.message) || 'scan failed' };
    }
  }

  await Promise.all([
    scanStore('clients',   'client'),
    scanStore('quotes',    'quote'),
    scanStore('prospects', 'prospect'),
    scanStore('reminders', 'reminder'),
    scanStore('borrower_info', 'borrowerInfo'),
  ]);

  return json(200, {
    query: q,
    scanned,
    matches,
  });
}
