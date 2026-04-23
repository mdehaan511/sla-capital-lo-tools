/**
 * settings.js — GET/POST /api/settings
 *
 * GET:  Returns all settings as a flat object.
 *       Signed-in users see all public settings (banner, submit_email display).
 *       No auth required for reading banner specifically via ?key=banner.
 * POST: Admin-only. Body: { key, value }. Overwrites that single setting.
 *
 * Settings keys in use:
 *   banner        → { text, type, ts } or null
 *   submit_email  → { value: "mike@slacapital.com" }
 *   slack_webhook → { value: "https://hooks.slack.com/..." }
 *   lo_email/{loSlug} → { email: "loEmail@..." }  (optional per-LO routing)
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
} from './_shared/auth.mjs';

const ALLOWED_KEYS = new Set(['banner', 'submit_email', 'slack_webhook']);

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;

  const store = getStore({ name: 'settings', consistency: 'strong' });

  if (req.method === 'GET') {
    const url = new URL(req.url);
    const onlyKey = url.searchParams.get('key');

    // banner is readable by anyone (used by all tool pages for the dashboard banner)
    if (onlyKey === 'banner') {
      try {
        const val = await store.get('banner', { type: 'json' });
        return json(200, { banner: val || null });
      } catch (e) {
        return json(200, { banner: null });
      }
    }

    // Everything else requires auth
    const user = requireAuth(context);
    if (!user) return json(401, { error: 'Not authenticated' });

    try {
      const out = {};
      for (const key of ALLOWED_KEYS) {
        out[key] = (await store.get(key, { type: 'json' })) || null;
      }
      return json(200, out);
    } catch (e) {
      console.error('settings GET error:', e);
      return json(500, { error: 'Failed to load settings' });
    }
  }

  if (req.method === 'POST') {
    const user = requireAuth(context);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin required' });

    const body = await readJsonBody(req);
    if (body === null) return json(400, { error: 'Invalid JSON' });
    if (!body || !body.key) return json(400, { error: 'key required' });
    if (!ALLOWED_KEYS.has(body.key)) return json(400, { error: 'Unknown setting key' });

    try {
      if (body.value === null || body.value === undefined) {
        await store.delete(body.key);
      } else {
        await store.setJSON(body.key, body.value);
      }
      return json(200, { ok: true });
    } catch (e) {
      console.error('settings POST error:', e);
      return json(500, { error: 'Failed to save setting' });
    }
  }

  return json(405, { error: 'Method not allowed' });
};
