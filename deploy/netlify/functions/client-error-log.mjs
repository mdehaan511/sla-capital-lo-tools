/**
 * client-error-log.mjs — POST /api/client-error-log
 * Hardening Phase A2 (Deploy 236.388).
 *
 * Receives frontend error beacons (window.onerror / unhandledrejection
 * from sla-api.js) and forwards them to the Slack errors channel via
 * the shared throttled alerter.
 *
 * Auth: OPTIONAL. Errors on public pages (apply.html, borrower-info,
 * borrower portal) matter MOST — those users can't report bugs. When a
 * JWT is present we tag the user; anonymous beacons are accepted but
 * ride the same hard throttle as everything else (max 5 alerts/min per
 * warm instance), so this can't be used to flood Slack.
 *
 * Body: { message, stack?, page?, ua? } — all size-capped server-side.
 * Response: always 200 { ok: true } (a beacon endpoint must never
 * cause follow-on errors client-side).
 */
import {
  handleOptions, json, requireAuth,
} from './_shared/auth.mjs';
import { alertServerError } from './_shared/error-alert.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    let body = null;
    try { body = await req.json(); } catch (_) {}
    if (!body || !body.message) return json(200, { ok: true, ignored: true });

    let who = 'anonymous';
    try {
      const user = requireAuth(context, req);
      if (user && user.email) who = user.email;
    } catch (_) {}

    const page = String(body.page || '').slice(0, 200);
    const ua = String(body.ua || '').slice(0, 120);
    const stack = String(body.stack || '').slice(0, 400);

    alertServerError({
      source: 'frontend:' + (page || 'unknown-page'),
      message: String(body.message).slice(0, 400),
      extra: 'user: ' + who + (stack ? '\nstack: ' + stack : '') + (ua ? '\nua: ' + ua : ''),
    });

    return json(200, { ok: true });
  } catch (_) {
    // Never let the beacon endpoint itself produce a 5xx (which would
    // fire the json() hook and could loop). Swallow everything.
    return new Response('{"ok":true}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  }
};
