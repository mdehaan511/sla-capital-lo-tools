/**
 * _shared/pricing-announce.mjs — Deploy 237.089 (Mike)
 *
 * "When we update pricing a notice is posted in Slack for everyone to see so
 * we know they all know."
 *
 * DSCR pricing lives in code (deploy/dscr-pricing.js + deploy/mf-pricing.js,
 * PRICING_HISTORY), so a "pricing update" IS a deploy. This module reads the
 * base rates the deployed engines carry, compares them to the last set it
 * announced (blob store `pricing_announce` / `last`), and posts to Slack when
 * they moved. Idempotent: a deploy with no rate change posts nothing, and the
 * same change is never posted twice.
 *
 * First run (no `last` on record): compares against the PREVIOUS sheet in
 * PRICING_HISTORY so the change that shipped with the feature is announced.
 *
 * Callers: netlify/functions/deploy-succeeded.mjs (Netlify deploy event) and
 * netlify/functions/pricing-announce.mjs (admin dry-run / manual post).
 *
 * Slack channel key: `pricing` (settings `slack_webhook_pricing`, falling back
 * to the default `slack_webhook` so it lands where everyone already looks).
 */
import { getStore } from '@netlify/blobs';
import { postSlack } from './slack.mjs';
import dscr from '../../../dscr-pricing.js';
import mf from '../../../mf-pricing.js';

const STORE = 'pricing_announce';
const KEY = 'last';
const PRODUCTS = [
  { key: 'dscr', label: 'DSCR 1-4', engine: dscr },
  { key: 'mf',   label: 'Multifamily 5+', engine: mf },
];

function baseOf(engine) {
  const b = (engine && engine.DIYA && engine.DIYA.baseRate) || {};
  return { fixed: Number(b['30Y Fixed']), arm: Number(b['7/6 ARM']) };
}
function prevFromHistory(engine) {
  const h = (engine && engine.PRICING_HISTORY) || [];
  const prev = h[1] && h[1].overrides && h[1].overrides.baseRate;
  if (!prev) return null;
  return { fixed: Number(prev['30Y Fixed']), arm: Number(prev['7/6 ARM']) };
}
function effectiveOf(engine) {
  const h = (engine && engine.PRICING_HISTORY) || [];
  return (h[0] && h[0].effective) || (engine && engine.DIYA && engine.DIYA.effectiveDate) || '';
}
const fmtRate = (n) => (isFinite(n) ? n.toFixed(3) + '%' : '—');
const fmtDelta = (n) => Math.abs(n).toFixed(3);

export function currentPricing() {
  const out = {};
  for (const p of PRODUCTS) out[p.key] = { effective: effectiveOf(p.engine), ...baseOf(p.engine) };
  return out;
}

export async function readLast() {
  try {
    const store = getStore({ name: STORE, consistency: 'strong' });
    return await store.get(KEY, { type: 'json' });
  } catch (e) { console.warn('[pricing-announce] read last failed:', e && e.message); return null; }
}

/**
 * Build the Slack text for the change between prev and cur (per product).
 * Returns null when nothing moved.
 */
export function buildMessage(cur, prev) {
  const moves = [];
  for (const p of PRODUCTS) {
    const c = cur[p.key], pv = prev && prev[p.key];
    if (!c || !pv || !isFinite(pv.fixed)) continue;
    const dFixed = Math.round((c.fixed - pv.fixed) * 1000) / 1000;
    const dArm = Math.round((c.arm - pv.arm) * 1000) / 1000;
    if (!dFixed && !dArm) continue;
    moves.push({ label: p.label, key: p.key, dFixed, dArm, fixed: c.fixed, arm: c.arm, effective: c.effective });
  }
  if (!moves.length) return null;

  const up = moves.every((m) => m.dFixed >= 0 && m.dArm >= 0 && (m.dFixed > 0 || m.dArm > 0));
  const down = moves.every((m) => m.dFixed <= 0 && m.dArm <= 0 && (m.dFixed < 0 || m.dArm < 0));
  const sameAmount = moves.every((m) => m.dFixed === moves[0].dFixed && m.dArm === moves[0].dArm && m.dFixed === m.dArm);
  const sameRates = moves.every((m) => m.fixed === moves[0].fixed && m.arm === moves[0].arm);
  const who = moves.length === PRODUCTS.length ? 'DSCR' : moves.map((m) => m.label).join(' and ');
  const floor = (m) => fmtRate(m.fixed) + ' (30Y Fixed / 10-6 ARM) · ' + fmtRate(m.arm) + ' (7/6 & 5/6 ARM)';

  let head;
  if ((up || down) && sameAmount) {
    head = `<!channel> ${who} rates have ${up ? 'increased' : 'decreased'} by ${fmtDelta(moves[0].dFixed)}. Floor rate is now `
      + (sameRates ? floor(moves[0]) + '.' : moves.map((m) => m.label + ': ' + floor(m)).join('; ') + '.');
  } else {
    head = `<!channel> DSCR pricing has changed:\n` + moves.map((m) =>
      `• ${m.label}: 30Y/10-6 ${m.dFixed >= 0 ? '+' : '−'}${fmtDelta(m.dFixed)}, 7/6 & 5/6 ${m.dArm >= 0 ? '+' : '−'}${fmtDelta(m.dArm)} — floor now ${floor(m)}`).join('\n');
  }
  const tail = down
    ? 'Loans not locked will price at the new lower rates. Existing locks are unaffected — check with leadership before re-locking a loan at the lower pricing.'
    : 'Any loans not locked need to be repriced and any locks that expire will be priced on worst case pricing.';
  const eff = moves[0].effective ? ` (effective ${moves[0].effective})` : '';
  return head + eff + '\n' + tail;
}

/**
 * Compare, post, record. { dryRun, force, source } → result.
 */
export async function announcePricingChanges(opts) {
  const o = opts || {};
  const cur = currentPricing();
  let last = await readLast();
  let prev = last && last.pricing;
  let basis = 'last-announced';
  if (!prev) {
    prev = {};
    for (const p of PRODUCTS) { const ph = prevFromHistory(p.engine); if (ph) prev[p.key] = ph; }
    basis = 'pricing-history';
  }
  const text = buildMessage(cur, prev);
  const result = { ok: true, basis, current: cur, previous: prev, text, posted: false, source: o.source || '',
    last: last ? { at: last.at, posted: !!last.posted, source: last.source || '', text: last.text || '' } : null }; // Deploy 237.090 -- admin dry-run shows what the deploy hook did
  if (!text && !o.force) { result.reason = 'no-change'; return result; }
  if (o.dryRun) { result.reason = 'dry-run'; return result; }
  const body = text || buildMessage(cur, {}) || `<!channel> DSCR pricing re-announced: ${PRODUCTS.map((p) => p.label + ' ' + fmtRate(cur[p.key].fixed) + ' / ' + fmtRate(cur[p.key].arm)).join('; ')}.`;
  const r = await postSlack(body, { channel: 'pricing' });
  result.slack = r;
  result.posted = !!(r && r.ok);
  if (r && r.skipped) { result.reason = r.reason; }
  // Record what we announced (also when the webhook is missing, so a later
  // webhook config doesn't replay a stale change) — but NOT on a failed post,
  // so the next deploy retries.
  if (result.posted || (r && r.skipped)) {
    try {
      const store = getStore({ name: STORE, consistency: 'strong' });
      await store.setJSON(KEY, { pricing: cur, at: new Date().toISOString(), text: body, posted: result.posted, source: o.source || '' });
    } catch (e) { console.warn('[pricing-announce] save last failed:', e && e.message); }
  }
  return result;
}
