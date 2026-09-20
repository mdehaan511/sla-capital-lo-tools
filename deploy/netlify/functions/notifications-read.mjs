/**
 * notifications-read.mjs — POST /api/notifications-read
 *
 * Deploy 237.197 (Mike, the notifications page): mark the caller's notifications read, or
 * unread again.
 *
 * Body: { ids: [id, ...] }        mark those read
 *       { all: true }             mark everything read ("Mark all as read")
 *       { ids: [...], unread: true }  put them back to unread
 *
 * Read state is per-user and server-side, so a notification read on a phone is read on
 * the desktop too. Deleting is a different endpoint (notifications-dismiss) and a
 * different intent: this one never loses anything.
 *
 * Returns: { ok, changed, unread }
 */
import { handleOptions, json, requireAuth, readJsonBody } from './_shared/auth.mjs';
import { markUserNotifications } from './_shared/user-notifications.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const body = (await readJsonBody(req)) || {};
    const ids = Array.isArray(body.ids) ? body.ids.map(String).slice(0, 500) : [];
    const all = body.all === true;
    const unread = body.unread === true;
    if (!ids.length && !all) return json(400, { error: 'ids or all required' });
    // "Mark everything UNREAD" is not a thing anyone means to do, and it would bury a
    // real unread item in a pile of ones you had already dealt with.
    if (all && unread) return json(400, { error: 'Marking everything unread is not supported' });
    const r = await markUserNotifications(user.email, { ids, all, unread });
    return json(200, Object.assign({ ok: true }, r));
  } catch (e) {
    console.error('notifications-read error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
