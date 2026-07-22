/**
 * _shared/error-alert.mjs — Slack alerting for server errors.
 * Hardening Phase A1 (Deploy 236.388).
 *
 * One call: alertServerError({ source, status, message, extra }).
 * Posts to the `slack_webhook_errors` channel key (falls back to the
 * default `slack_webhook` via _shared/slack.mjs's resolution).
 *
 * Design rules:
 *   - NEVER throws, never blocks. Callers fire-and-forget.
 *   - Throttled per warm function instance: max ALERT_BUDGET alerts
 *     per THROTTLE_WINDOW_MS, and identical (source+message) pairs
 *     dedupe within the window. An error storm produces a handful of
 *     Slack messages, not hundreds.
 *   - Message bodies are size-capped; never include tokens/PII.
 */
import { postSlack } from './slack.mjs';

const THROTTLE_WINDOW_MS = 60_000;
const ALERT_BUDGET = 5; // max alerts per window per warm instance

let _windowStart = 0;
let _windowCount = 0;
const _recent = new Map(); // dedupe key → last-sent ts

function _throttled(dedupeKey) {
  const now = Date.now();
  if (now - _windowStart > THROTTLE_WINDOW_MS) {
    _windowStart = now;
    _windowCount = 0;
    _recent.clear();
  }
  if (_windowCount >= ALERT_BUDGET) return true;
  const last = _recent.get(dedupeKey);
  if (last && now - last < THROTTLE_WINDOW_MS) return true;
  _recent.set(dedupeKey, now);
  _windowCount++;
  return false;
}

function _cap(s, n) { return String(s == null ? '' : s).slice(0, n); }

/**
 * @param {object} p
 * @param {string} p.source   e.g. 'loan-cancel.mjs' or 'client-error-log:frontend'
 * @param {number} [p.status] HTTP status if applicable
 * @param {string} p.message  the error message
 * @param {string} [p.extra]  optional context (path, user agent, page url)
 */
export function alertServerError(p) {
  try {
    const source = _cap(p && p.source, 120) || 'unknown';
    const message = _cap(p && p.message, 500) || 'unknown error';
    if (_throttled(source + '|' + message)) return;

    const status = p && p.status ? ' (HTTP ' + p.status + ')' : '';
    const extra = p && p.extra ? '\n' + _cap(p.extra, 300) : '';
    const text = ':rotating_light: *Server error*' + status + ' — `' + source + '`\n' +
      '```' + message + '```' + extra;

    // Fire-and-forget. postSlack never throws.
    postSlack({ text }, { channel: 'errors' }).catch(() => {});
  } catch (_) { /* alerting must never break the caller */ }
}

/**
 * Best-effort: infer the calling function's file name from a stack
 * trace. Used by the json() 5xx hook in auth.mjs where the callsite
 * isn't otherwise known. Returns e.g. 'loan-cancel.mjs' or ''.
 */
export function inferSourceFromStack(stackStr) {
  try {
    // Accepts a pre-captured stack (callers in async contexts MUST
    // capture synchronously at the error site) or captures its own.
    const stack = String(stackStr || new Error().stack || '');
    // Match the first frame that points at a functions/*.mjs file
    // that ISN'T auth.mjs / error-alert.mjs themselves.
    const re = /functions[\\/]+([a-z0-9-]+\.mjs)/gi;
    let m;
    while ((m = re.exec(stack)) !== null) {
      const f = m[1].toLowerCase();
      if (f !== 'auth.mjs' && f !== 'error-alert.mjs' && f !== 'slack.mjs') return f;
    }
  } catch (_) {}
  return '';
}
