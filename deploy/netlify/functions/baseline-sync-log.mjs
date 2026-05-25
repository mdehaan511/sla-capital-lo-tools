/**
 * baseline-sync-log.mjs — GET /api/baseline-sync-log
 *
 * Super-admin only. Lists recent Baseline sync attempts (dry-run or
 * live) newest-first. Also returns the current Baseline configuration
 * mode so the UI can show a "Mode: dry-run / live / disabled" badge.
 *
 * Query params:
 *   ?limit=<n>      default 200, max 1000
 *   ?loanId=<id>    optional — filter to a single loan's history
 *
 * Response:
 *   {
 *     enabled, mode, configured, baseUrl, phase,  // from baselineStatus()
 *     logs: [{ id, ts, step, mode, ok, ... }, ...]
 *   }
 *
 * Mirrors brevo-sync-log-list.mjs in shape so the viewer pattern is
 * already familiar.
 */
import { handleOptions, json, requireAuth, isSuperAdmin } from './_shared/auth.mjs';
import { baselineStatus, listLog } from './_shared/baseline-sync.mjs';

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });

  const url = new URL(req.url);
  const limit = Math.min(1000, Math.max(1, parseInt(url.searchParams.get('limit') || '200', 10)));
  const loanId = url.searchParams.get('loanId') || null;

  const status = baselineStatus();
  let logs = [];
  try {
    logs = await listLog({ limit, loanId });
  } catch (e) {
    console.error('baseline-sync-log list error:', e);
    return json(500, { error: 'Failed to load sync log', ...status });
  }

  return json(200, { ...status, logs });
};
