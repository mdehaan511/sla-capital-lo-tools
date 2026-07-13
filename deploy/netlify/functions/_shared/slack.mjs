/**
 * _shared/slack.mjs — Slack webhook helper. Reads admin-managed
 * webhook URLs from the `settings` blob store and POSTs messages to
 * them. Multiple channels supported (Deploy 236.311) — apply
 * notifications and processing-pipeline notifications can go to
 * different Slack channels by pointing each at its own webhook.
 *
 * Settings keys:
 *   slack_webhook             — legacy / default fallback for any post
 *                                without an explicit channel key.
 *   slack_webhook_apply       — new loan applications (apply.html flow).
 *   slack_webhook_submitted   — loans submitted for processing (LO
 *                                clicks Submit on Loan Details).
 *   ...more can be added as new channel keys ship.
 *
 * Any per-channel key falls back to `slack_webhook` when unset, so
 * partial configuration keeps working.
 *
 * Failure philosophy: NEVER throw. A failed Slack notification must
 * not break the user-facing operation that triggered it. All errors
 * are caught and logged; the caller gets a result object.
 *
 * Why settings-store not env: rotatable without redeploying. Per
 * CLAUDE.md: "SLACK_WEBHOOK_URL — admin-managed via Settings, not env."
 */
import { getStore } from '@netlify/blobs';

const DEFAULT_KEY = 'slack_webhook';

async function readWebhook(settingsKey) {
  try {
    const store = getStore({ name: 'settings', consistency: 'strong' });
    const rec = await store.get(settingsKey, { type: 'json' });
    if (!rec || !rec.value) return null;
    const url = String(rec.value).trim();
    if (!url.startsWith('https://hooks.slack.com/')) return null;
    return url;
  } catch (e) {
    console.warn(`slack readWebhook(${settingsKey}) failed:`, e && e.message);
    return null;
  }
}

/**
 * Resolve which webhook URL to use for a channel key. Tries the
 * channel-specific key first, falls back to the default `slack_webhook`
 * so unconfigured channels still work.
 *
 * channel examples: 'apply', 'submitted', 'closed', or a full settings
 * key like 'slack_webhook_apply'. Bare names are prefixed with
 * `slack_webhook_`.
 */
async function resolveWebhook(channel) {
  if (!channel) return readWebhook(DEFAULT_KEY);
  const key = channel.startsWith('slack_webhook') ? channel : `slack_webhook_${channel}`;
  const specific = await readWebhook(key);
  if (specific) return specific;
  return readWebhook(DEFAULT_KEY);
}

/**
 * Post a message to a configured Slack webhook.
 *
 * @param {string|object} msg      Plain string → { text }, or full
 *                                 Slack Block Kit body.
 * @param {object} [opts]
 * @param {string} [opts.channel]  Channel key (e.g. 'apply', 'submitted').
 *                                 Falls back to the default webhook.
 * @returns {Promise<{ok, skipped?, error?, status?, channel?}>}
 */
export async function postSlack(msg, opts) {
  const channel = (opts && opts.channel) || null;
  const webhookUrl = await resolveWebhook(channel);
  if (!webhookUrl) {
    return { ok: false, skipped: true, reason: 'no_webhook_configured', channel };
  }

  const body = (typeof msg === 'string') ? { text: msg } : (msg || {});
  if (!body.text && !body.blocks && !body.attachments) {
    return { ok: false, skipped: true, reason: 'empty_message', channel };
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, status: resp.status, channel };
    }
    const respText = await resp.text().catch(() => '');
    console.warn(`slack post non-2xx (channel=${channel || 'default'}):`, resp.status, respText.slice(0, 200));
    return { ok: false, status: resp.status, error: respText.slice(0, 200), channel };
  } catch (e) {
    console.warn('slack post threw:', e && e.message);
    return { ok: false, error: e && e.message, channel };
  }
}

/**
 * Whether the default webhook is configured. Useful for admin UI
 * indicators without exposing the URL.
 */
export async function slackConfigured() {
  return !!(await resolveWebhook(null));
}
