/**
 * admin-baseline-raw-audit-status.mjs — GET /api/admin-baseline-raw-audit-status
 *
 * Deploy 237.022 — read the latest report from the Baseline raw-record audit
 * (admin-baseline-raw-audit-background). Auth: admin only.
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
    const store = getStore({ name: 'baseline_raw_audit', consistency: 'strong' });
    // Deploy 237.025 — ?report=isio reads the interest-only rule pass instead.
    const which = new URL(req.url).searchParams.get('report') === 'isio' ? 'isio-latest' : 'latest';
    const report = await store.get(which, { type: 'json' }).catch(() => null);
    return json(200, { ok: true, report: report || null });
  } catch (e) {
    console.error('admin-baseline-raw-audit-status error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
