/**
 * pandadoc-send-log-list.mjs — GET /api/pandadoc-send-log
 *
 * Super-admin only. Lists recent PandaDoc send attempts (dry-run or live)
 * plus current PandaDoc configuration mode.
 *
 * Query params:
 *   ?limit=<n>   default 200, max 1000
 *
 * Response: { mode, enabled, dryRun, logs: [...] }  (newest first)
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isSuperAdmin } from './_shared/auth.mjs';
import { pandadocStatus } from './_shared/pandadoc.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  const url = new URL(req.url);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));

  const status = pandadocStatus();
  let logs = [];
  try {
    const store = getStore({ name: 'pandadoc-send-log', consistency: 'eventual' });
    const { blobs } = await store.list();
    const keys = blobs.map((b) => b.key).sort().reverse().slice(0, limit);
    logs = await Promise.all(keys.map(async (k) => {
      try { return await store.get(k, { type: 'json' }); }
      catch (_) { return null; }
    }));
    logs = logs.filter(Boolean);
  } catch (e) {
    console.error('pandadoc-send-log-list error:', e);
    return json(500, { error: 'Failed to load send log', ...status });
  }

  return json(200, { ...status, logs });
};
