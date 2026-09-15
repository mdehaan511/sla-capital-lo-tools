/**
 * notifications-list.mjs — GET /api/notifications-list
 *
 * Deploy 237.050 (Mike) — the caller's in-app notifications (today:
 * @-mentions in loan notes). Polled by the notification bell alongside
 * reminders / tasks; one blob read per call (see _shared/user-notifications).
 *
 * Returns: { ok: true, items: [...] } newest first.
 */
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';
import { listUserNotifications } from './_shared/user-notifications.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const items = await listUserNotifications(user.email);
    return json(200, { ok: true, items });
  } catch (e) {
    console.error('notifications-list error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
