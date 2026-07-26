/**
 * brevo-sync-log-list.mjs — GET /api/brevo-sync-log
 *
 * Super-admin only. Lists recent Brevo sync attempts (dry-run or live).
 * Also returns the current Brevo configuration mode so the UI can show
 * a "Mode: dry-run / live / disabled" badge.
 *
 * Query params:
 *   ?limit=<n>   default 200, max 1000
 *
 * Response: { mode: 'disabled'|'dry-run'|'live', enabled, listConfigured,
 *             logs: [{...}, ...] }  (newest first)
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isSuperAdmin } from './_shared/auth.mjs';
import { brevoStatus } from './_shared/brevo.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  const url = new URL(req.url);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));

  const status = brevoStatus();
  let logs = [];
  try {
    const store = getStore({ name: 'brevo-sync-log', consistency: 'eventual' });
    const { blobs } = await store.list();
    // Keys start with ISO timestamp so sorting descending puts newest first
    const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
    logs = await Promise.all(keys.map(async (k) => {
      try { return await store.get(k, { type: 'json' }); }
      catch (_) { return null; }
    }));
    logs = logs.filter(Boolean);
  } catch (e) {
    console.error('brevo-sync-log-list error:', e);
    return json(500, { error: 'Failed to load sync log', ...status });
  }

  return json(200, { ...status, logs });
};
