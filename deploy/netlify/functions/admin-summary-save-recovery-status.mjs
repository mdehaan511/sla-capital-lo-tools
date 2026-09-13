/**
 * admin-summary-save-recovery-status.mjs — GET /api/admin-summary-save-recovery-status
 *
 * Deploy 237.006 — read the latest report from the Pipeline summary-save data
 * recovery (admin-summary-save-recovery-background). Reports carry ids, names,
 * field NAMES and counts only — never restored values.
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    const store = getStore({ name: 'summary_save_recovery', consistency: 'strong' });
    const report = await store.get('latest', { type: 'json' }).catch(() => null);
    return json(200, { ok: true, report: report || null });
  } catch (e) {
    console.error('admin-summary-save-recovery-status error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
