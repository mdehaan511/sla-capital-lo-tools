/**
 * ai-usage-report.mjs — GET /api/ai-usage-report?days=7[&send=1]
 *
 * Deploy 237.094 — on-demand twin of the scheduled ai-usage-digest.mjs.
 * Netlify refuses direct HTTP calls to a scheduled function (plain 403 before
 * the handler runs), so admins pull the Claude spend rollup here instead.
 * Same builder, same email; `send=1` also emails it.
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { buildDigest, sendDigest } from './ai-usage-digest.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    const url = new URL(req.url);
    const days = Math.min(31, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
    const d = await buildDigest(days);
    let emailed = false;
    if (url.searchParams.get('send') === '1') {
      try { emailed = await sendDigest(d); } catch (e) { console.warn('[ai-usage-report] email failed:', e && e.message); }
    }
    return json(200, Object.assign({ ok: true, emailed }, d));
  } catch (e) {
    console.error('ai-usage-report error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
