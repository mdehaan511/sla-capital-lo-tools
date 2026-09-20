/**
 * notifications-list.mjs — GET /api/notifications-list
 *
 * Deploy 237.050 (Mike) — the caller's in-app notifications (today:
 * @-mentions in loan notes). Polled by the notification bell alongside
 * reminders / tasks; one blob read per call (see _shared/user-notifications).
 *
 * Returns: { ok: true, items: [...], unread } newest first.
 */
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';
import { listUserNotifications } from './_shared/user-notifications.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    // Deploy 237.197 (Mike) -- two callers, one endpoint:
    //   ?unread=1  the BELL. Only what is still outstanding, so a 60s poll does not
    //              carry six months of history to the browser every minute.
    //   (no flag)  the notifications PAGE. Everything, read and unread, because
    //              "shows all historical notifications" is the point of it.
    const url = new URL(req.url);
    const unreadOnly = url.searchParams.get('unread') === '1';
    const items = await listUserNotifications(user.email, { unreadOnly });
    const unread = unreadOnly ? items.length : items.filter((it) => !it.readAt).length;
    return json(200, { ok: true, items, unread });
  } catch (e) {
    console.error('notifications-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
