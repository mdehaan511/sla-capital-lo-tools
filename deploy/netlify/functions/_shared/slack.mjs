/**
 * _shared/slack.mjs — Slack webhook helper. Reads the admin-managed
 * webhook URL from the `settings` blob store (key: 'slack_webhook',
 * value: { value: 'https://hooks.slack.com/...' }) and POSTs a message
 * to it. Reusable beyond Baseline — anything that needs to nudge the
 * admin can call postSlack().
 *
 * Failure philosophy: NEVER throw. A failed Slack notification must
 * not break the user-facing operation that triggered it. All errors
 * are caught and logged to console; the caller gets back a result
 * object describing what happened.
 *
 * Why this is a settings-store webhook (not an env var):
 *   The webhook URL is admin-managed via the Settings UI on profile.html
 *   so it can be rotated without redeploying. Per CLAUDE.md: "SLACK_
 *   WEBHOOK_URL — admin-managed via Settings, not env."
 */
import { getStore } from '@netlify/blobs';

/**
 * Look up the configured Slack webhook URL.
 * Returns null if unset (in which case callers should silently skip).
 */
async function getWebhookUrl() {
  try {
    const store = getStore({ name: 'settings', consistency: 'strong' });
    const rec = await store.get('slack_webhook', { type: 'json' });
    if (!rec || !rec.value) return null;
    const url = String(rec.value).trim();
    if (!url.startsWith('https://hooks.slack.com/')) return null;
    return url;
  } catch (e) {
    console.warn('slack getWebhookUrl failed:', e && e.message);
    return null;
  }
}

/**
 * Post a message to the configured Slack webhook.
 *
 * @param {string|object} msg  Either a plain string (becomes the `text`)
 *                             or a full Slack message object with
 *                             { text, blocks, attachments, ... }.
 * @returns {Promise<{ok, skipped?, error?, status?}>}
 *
 * Examples:
 *   await postSlack('Baseline sync failed for loan l_123');
 *   await postSlack({
 *     text: 'Loan approved',
 *     blocks: [{ type: 'section', text: { type: 'mrkdwn', text: '*Loan approved*\nLoan: ...' }}],
 *   });
 */
export async function postSlack(msg) {
  const webhookUrl = await getWebhookUrl();
  if (!webhookUrl) {
    return { ok: false, skipped: true, reason: 'no_webhook_configured' };
  }

  // Normalize to a Slack message body. A bare string becomes { text }.
  const body = (typeof msg === 'string') ? { text: msg } : (msg || {});
  if (!body.text && !body.blocks && !body.attachments) {
    return { ok: false, skipped: true, reason: 'empty_message' };
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (resp.status >= 200 && resp.status < 300) {
      return { ok: true, status: resp.status };
    }
    const respText = await resp.text().catch(() => '');
    console.warn('slack post non-2xx:', resp.status, respText.slice(0, 200));
    return { ok: false, status: resp.status, error: respText.slice(0, 200) };
  } catch (e) {
    console.warn('slack post threw:', e && e.message);
    return { ok: false, error: e && e.message };
  }
}

/**
 * Whether a webhook is currently configured. Useful for the admin UI
 * to show a "Slack is wired up ✓" indicator without exposing the URL.
 */
export async function slackConfigured() {
  return !!(await getWebhookUrl());
}
