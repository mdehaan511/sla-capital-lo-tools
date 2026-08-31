/**
 * admin-baseline-pii-backfill-status.mjs — GET /api/admin-baseline-pii-backfill-status
 *
 * Deploy 236.830 — read the latest report from the Baseline PII backfill
 * (admin-baseline-pii-backfill-background). The report carries counts and
 * SSN FIELD NAMES only — never any PII values.
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
    const store = getStore({ name: 'baseline_pii_backfill', consistency: 'strong' });
    const report = await store.get('latest', { type: 'json' }).catch(() => null);
    return json(200, { ok: true, report: report || null });
  } catch (e) {
    console.error('admin-baseline-pii-backfill-status error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
