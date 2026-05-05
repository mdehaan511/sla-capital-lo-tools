/**
 * chat-logs-list.mjs — GET /api/chat-logs
 *
 * Returns chat log entries. Super-admin only.
 *
 * Query params:
 *   ?owner=<keySafe(email)>   restrict to one user (optional)
 *   ?limit=<n>                cap results (default 200, max 1000)
 *   ?since=<ISO>              only logs after this timestamp (optional)
 *
 * Response: { logs: [{ id, ts, ownerKey, ownerEmail, ownerName,
 *                      question, answer, pageUrl }, ...] }
 *   Sorted newest first.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isSuperAdmin } from './_shared/auth.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  const url = new URL(req.url);
  const owner = (url.searchParams.get('owner') || '').toLowerCase();
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));
  const since = url.searchParams.get('since') || '';

  const store = getStore({ name: 'chat-logs', consistency: 'eventual' });

  try {
    const listOpts = owner ? { prefix: owner + '/' } : {};
    const { blobs } = await store.list(listOpts);
    // Each key is `${ownerKey}/${id}` where id starts with the ISO timestamp,
    // so sorting keys lexicographically descending puts newest first.
    const sortedKeys = blobs
      .map((b) => b.key)
      .filter((k) => !since || k.split('/').slice(1).join('/') >= since)
      .sort()
      .reverse()
      .slice(0, limit);

    const logs = await Promise.all(sortedKeys.map(async (key) => {
      const rec = await store.get(key, { type: 'json' });
      return rec || null;
    }));
    return json(200, { logs: logs.filter(Boolean) });
  } catch (e) {
    console.error('chat-logs-list error:', e);
    return json(500, { error: 'Failed to load chat logs' });
  }
};
