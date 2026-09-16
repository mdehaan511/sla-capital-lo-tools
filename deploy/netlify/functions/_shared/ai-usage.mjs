/**
 * _shared/ai-usage.mjs — Deploy 237.093 (Mike: "reduce my spend … consistently monitor")
 *
 * One place that knows what a Claude call costs and writes a tiny usage record
 * per call so the weekly digest (ai-usage-digest.mjs) can show spend by
 * feature, the cache hit ratio, and the loans that burned the most.
 *
 *   aiCostCents(model, usage)   — cache-aware cost from the API's `usage` block
 *     (input / 5-minute cache write 1.25x / 1-hour cache write 2x / cache read
 *     0.1x / output), priced per model family.
 *   logAiUsage({ feature, model, usage, meta }) — appends
 *     ai_usage/<YYYY-MM-DD>/<ts>_<rand> = { t, feature, model, in, cw5, cw1h, cr,
 *     out, cents, ...meta }. Best-effort; never throws into the caller.
 *
 * Why per-call records and not a per-day counter: 200 calls/day would race a
 * read-modify-write counter and silently lose updates; appends never collide.
 */
import { getStore } from '@netlify/blobs';

// USD per million tokens: [input, output]. Cache writes = 1.25x (5m) / 2x (1h)
// of input; cache reads = 0.1x of input.
const PRICES = [
  [/opus/i,   [15, 75]],
  [/haiku/i,  [1, 5]],
  [/sonnet/i, [3, 15]],
];
function _price(model) {
  const m = String(model || '');
  for (const [re, p] of PRICES) if (re.test(m)) return p;
  return [3, 15];
}

export function usageParts(usage) {
  const u = usage || {};
  const cc = u.cache_creation || {};
  const cwTotal = Number(u.cache_creation_input_tokens || 0);
  const cw1h = Number(cc.ephemeral_1h_input_tokens || 0);
  const cw5 = cc.ephemeral_5m_input_tokens != null ? Number(cc.ephemeral_5m_input_tokens || 0) : Math.max(0, cwTotal - cw1h);
  return {
    in: Number(u.input_tokens || 0),
    cw5, cw1h,
    cr: Number(u.cache_read_input_tokens || 0),
    out: Number(u.output_tokens || 0),
  };
}

export function aiCostCents(model, usage) {
  const [pin, pout] = _price(model);
  const p = usageParts(usage);
  const perTok = pin / 1e6 * 100; // cents per input token
  return p.in * perTok
       + p.cw5 * perTok * 1.25
       + p.cw1h * perTok * 2
       + p.cr * perTok * 0.10
       + p.out * (pout / 1e6 * 100);
}

export async function logAiUsage({ feature, model, usage, meta }) {
  try {
    const p = usageParts(usage);
    const cents = aiCostCents(model, usage);
    const t = new Date().toISOString();
    const rec = Object.assign({ t, feature: String(feature || 'other'), model: String(model || ''), cents: Math.round(cents * 1000) / 1000 }, p, meta || {});
    console.log('[ai-usage] ' + rec.feature + ' ' + rec.model + ' in=' + p.in + ' cw5=' + p.cw5 + ' cw1h=' + p.cw1h + ' cr=' + p.cr + ' out=' + p.out + ' cents=' + rec.cents.toFixed(2));
    const store = getStore({ name: 'ai_usage', consistency: 'eventual' });
    await store.setJSON(t.slice(0, 10) + '/' + t.replace(/[:.]/g, '-') + '_' + Math.random().toString(36).slice(2, 7), rec);
    return cents;
  } catch (e) {
    console.warn('[ai-usage] log failed (non-fatal):', e && e.message);
    return 0;
  }
}
