/**
 * notifications-dismiss.mjs — POST /api/notifications-dismiss
 *
 * Deploy 237.050 (Mike) — dismiss the caller's in-app notifications
 * (the ✓ on a bell item, or "Clear all"). Server-side, so a dismissed
 * mention is gone on every device.
 *
 * Body: { ids?: [id, ...], all?: true }
 * Returns: { ok: true, removed, remaining }
 */
import { handleOptions, json, requireAuth, readJsonBody } from './_shared/auth.mjs';
import { dismissUserNotifications } from './_shared/user-notifications.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const body = (await readJsonBody(req)) || {};
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 200) : [];
    const all = body.all === true;
    if (!ids.length && !all) return json(400, { error: 'ids or all required' });
    const r = await dismissUserNotifications(user.email, ids, all);
    return json(200, Object.assign({ ok: true }, r));
  } catch (e) {
    console.error('notifications-dismiss error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
