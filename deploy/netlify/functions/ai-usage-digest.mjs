/**
 * ai-usage-digest.mjs — Deploy 237.093 (Mike: "consistently monitor this and give
 * me suggestions on how to keep cost lower")
 *
 * Weekly (Monday 15:00 UTC = 8am PT) rollup of the per-call records that
 * _shared/ai-usage.mjs writes: spend by feature and by day, cache hit ratio,
 * the loans / reviews that cost the most, and rule-based suggestions. Emailed
 * to Mike. Netlify refuses direct HTTP calls to a scheduled function (plain 403
 * before the handler runs), so the on-demand admin pull lives in
 * ai-usage-report.mjs (GET /api/ai-usage-report?days=7[&send=1]), which imports
 * buildDigest / sendDigest from here. Deploy 237.094.
 *
 * Netlify invokes scheduled functions with a POST whose body carries next_run;
 * that path needs no JWT. Anything else must be an admin (kept for local dev).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, isAdmin } from './_shared/auth.mjs';

export const config = { schedule: '0 15 * * 1' };

const DIGEST_TO = (process.env.AI_USAGE_DIGEST_TO || 'mike@slacapital.com').split(',').map((s) => s.trim()).filter(Boolean);
const TIME_BUDGET_MS = 20000;

function _day(d) { return d.toISOString().slice(0, 10); }
function _money(c) { return '$' + (Number(c || 0) / 100).toFixed(2); }
function _pct(n) { return (Math.round(n * 1000) / 10).toFixed(1) + '%'; }

export async function buildDigest(days) {
  const started = Date.now();
  const store = getStore({ name: 'ai_usage', consistency: 'eventual' });
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(_day(new Date(Date.now() - i * 86400000)));
  const recs = [];
  let truncated = false;
  for (const day of dayKeys) {
    const { blobs } = await store.list({ prefix: day + '/' });
    const keys = blobs.map((b) => b.key);
    for (let i = 0; i < keys.length; i += 25) {
      if (Date.now() - started > TIME_BUDGET_MS) { truncated = true; break; }
      const batch = await Promise.all(keys.slice(i, i + 25).map((k) => store.get(k, { type: 'json' }).catch(() => null)));
      for (const r of batch) if (r && r.t) recs.push(r);
    }
    if (truncated) break;
  }
  const byFeature = {}, byDay = {}, byReview = {}, byOrigin = {}; // Deploy 237.107 -- origin = upload / retry / truth-refresh / requeue:*
  let tot = { calls: 0, cents: 0, in: 0, cw5: 0, cw1h: 0, cr: 0, out: 0 };
  for (const r of recs) {
    const f = r.feature || 'other';
    const add = (o) => { o.calls++; o.cents += Number(r.cents || 0); o.in += Number(r.in || 0); o.cw5 += Number(r.cw5 || 0); o.cw1h += Number(r.cw1h || 0); o.cr += Number(r.cr || 0); o.out += Number(r.out || 0); };
    add(tot);
    add(byFeature[f] = byFeature[f] || { calls: 0, cents: 0, in: 0, cw5: 0, cw1h: 0, cr: 0, out: 0 });
    const d = String(r.t).slice(0, 10);
    add(byDay[d] = byDay[d] || { calls: 0, cents: 0, in: 0, cw5: 0, cw1h: 0, cr: 0, out: 0 });
    if (r.feature === 'doc-review') { const o = r.origin || 'unknown'; byOrigin[o] = byOrigin[o] || { calls: 0, cents: 0 }; byOrigin[o].calls++; byOrigin[o].cents += Number(r.cents || 0); }
    if (r.reviewId) {
      const k = r.reviewId;
      byReview[k] = byReview[k] || { calls: 0, cents: 0, address: r.address || '', reviewId: k };
      byReview[k].calls++; byReview[k].cents += Number(r.cents || 0);
      if (!byReview[k].address && r.address) byReview[k].address = r.address;
    }
  }
  const cacheable = tot.cw5 + tot.cw1h + tot.cr;
  const hitRatio = cacheable ? tot.cr / cacheable : 0;
  const topReviews = Object.values(byReview).sort((a, b) => b.cents - a.cents).slice(0, 5);
  const docReview = byFeature['doc-review'] || { calls: 0, cents: 0 };
  const avgReview = docReview.calls ? docReview.cents / docReview.calls : 0;

  // Rule-based suggestions — the point of the digest.
  const tips = [];
  if (!recs.length) tips.push('No usage records yet for this window.');
  if (cacheable && hitRatio < 0.7) tips.push('Cache hit ratio is ' + _pct(hitRatio) + ' (target 80%+): reviews are not reusing the guidelines / loan-application prefix. Check that the 1-hour guidelines breakpoint is still first in the request and that nothing dynamic sits before it.');
  if (cacheable && hitRatio >= 0.8) tips.push('Cache reuse is healthy (' + _pct(hitRatio) + ' of cacheable tokens were reads).');
  if (avgReview > 15) tips.push('Average document review costs ' + _money(avgReview) + ' — the attached PDFs are still the driver. Next lever: store the investor guidelines as extracted TEXT instead of the PDF (about 60% fewer tokens per review).');
  const hot = Object.entries(byDay).filter(([, v]) => v.cents > 6000).map(([d, v]) => d + ' ' + _money(v.cents));
  if (hot.length) tips.push('Days over $60: ' + hot.join(', ') + '. Bulk zip uploads and "Retry AI" sweeps re-review whole loans — spot-check whether those re-runs were needed.');
  const busy = topReviews.filter((r) => r.calls >= 40);
  if (busy.length) tips.push('Loans with 40+ AI calls this week: ' + busy.map((r) => (r.address || r.reviewId) + ' (' + r.calls + ' calls, ' + _money(r.cents) + ')').join('; ') + '. Repeated retries on the same trays add up — the compact AI block and Ready-for-UW panel should reduce the need.');
  if (tot.out && tot.out / Math.max(1, tot.calls) > 1500) tips.push('Average reply is ' + Math.round(tot.out / tot.calls) + ' output tokens — shorter rubric answers would trim the (small) output line.');
  const _auto = Object.entries(byOrigin).filter(([o]) => /^(truth-refresh|requeue)/.test(o)).reduce((s, [, v]) => s + v.calls, 0);
  if (docReview.calls && _auto / docReview.calls > 0.4) tips.push('Automatic re-reviews (point-of-truth refresh + Articles / ID requeues) were ' + _pct(_auto / docReview.calls) + ' of document reviews. If loans are being edited repeatedly, each material edit re-grades the still-open trays; consider batching edits.');
  if (truncated) tips.push('Note: the rollup hit its time budget and may be incomplete for the last day(s).');

  return { days, from: dayKeys[0], to: dayKeys[dayKeys.length - 1], records: recs.length, truncated, totals: tot, hitRatio, byFeature, byDay, byOrigin, topReviews, avgReviewCents: avgReview, tips };
}

function _html(d) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = Object.entries(d.byFeature).sort((a, b) => b[1].cents - a[1].cents).map(([f, v]) =>
    '<tr><td>' + esc(f) + '</td><td align="right">' + v.calls + '</td><td align="right">' + _money(v.cents) + '</td><td align="right">' + _money(v.calls ? v.cents / v.calls : 0) + '</td></tr>').join('');
  const dayRows = Object.entries(d.byDay).sort().map(([day, v]) =>
    '<tr><td>' + esc(day) + '</td><td align="right">' + v.calls + '</td><td align="right">' + _money(v.cents) + '</td><td align="right">' + (v.cw5 + v.cw1h + v.cr ? _pct(v.cr / (v.cw5 + v.cw1h + v.cr)) : '—') + '</td></tr>').join('');
  const top = d.topReviews.map((r) => '<li>' + esc(r.address || r.reviewId) + ' — ' + r.calls + ' calls, ' + _money(r.cents) + '</li>').join('');
  const tips = d.tips.map((t) => '<li>' + esc(t) + '</li>').join('');
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:680px;margin:0 auto;font-family:Georgia,serif;color:#1A1520">' +
      '<div style="background:#261A36;padding:20px 24px"><h1 style="color:#C8813A;margin:0;font-size:18px">Claude spend — ' + esc(d.from) + ' to ' + esc(d.to) + '</h1></div>' +
      '<div style="padding:20px 24px;font-size:14px;line-height:1.55">' +
        '<p><strong>' + _money(d.totals.cents) + '</strong> across ' + d.totals.calls + ' calls · cache hit ratio <strong>' + _pct(d.hitRatio) + '</strong>' +
        ' · tokens: ' + d.totals.in.toLocaleString() + ' input, ' + (d.totals.cw5 + d.totals.cw1h).toLocaleString() + ' cache writes, ' + d.totals.cr.toLocaleString() + ' cache reads, ' + d.totals.out.toLocaleString() + ' output.</p>' +
        '<h3 style="font-size:14px;margin:18px 0 6px">Suggestions</h3><ul>' + tips + '</ul>' +
        '<h3 style="font-size:14px;margin:18px 0 6px">By feature</h3>' +
        '<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr><th align="left">Feature</th><th>Calls</th><th>Cost</th><th>Avg/call</th></tr>' + rows + '</table>' +
        (Object.keys(d.byOrigin || {}).length ? '<h3 style="font-size:14px;margin:18px 0 6px">Document reviews by origin</h3>' +
          '<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr><th align="left">Origin</th><th>Calls</th><th>Cost</th></tr>' +
          Object.entries(d.byOrigin).sort((a, b) => b[1].calls - a[1].calls).map(([o, v]) => '<tr><td>' + esc(o) + '</td><td align="right">' + v.calls + '</td><td align="right">' + _money(v.cents) + '</td></tr>').join('') + '</table>' : '') +
        '<h3 style="font-size:14px;margin:18px 0 6px">By day</h3>' +
        '<table cellpadding="4" style="border-collapse:collapse;font-size:13px"><tr><th align="left">Day</th><th>Calls</th><th>Cost</th><th>Cache hits</th></tr>' + dayRows + '</table>' +
        (top ? '<h3 style="font-size:14px;margin:18px 0 6px">Most expensive loans</h3><ul>' + top + '</ul>' : '') +
        '<p style="font-size:12px;color:#7A7488;margin-top:24px">Costs are computed from each call\'s reported token usage at list prices; the Anthropic Console is the invoice of record. Sir Lends A Lot LLC dba SLA Capital.</p>' +
      '</div></div></body></html>';
}

export async function sendDigest(d) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey || !DIGEST_TO.length) return false;
  const resp = await fetch('https://api.resend.com/emails', {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: DIGEST_TO,
      subject: 'Claude spend this week: ' + _money(d.totals.cents) + ' · cache hits ' + _pct(d.hitRatio),
      html: _html(d),
      text: 'Claude spend ' + d.from + ' to ' + d.to + ': ' + _money(d.totals.cents) + ' across ' + d.totals.calls + ' calls; cache hit ratio ' + _pct(d.hitRatio) + '.\n\n' + d.tips.map((t) => '- ' + t).join('\n'),
    }),
  });
  return resp.ok;
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const url = new URL(req.url);
    let scheduled = false;
    if (req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      scheduled = !!(body && body.next_run);
    }
    let send = scheduled;
    let days = 7;
    if (!scheduled) {
      const user = await requireAuth(context, req);
      if (!user) return json(401, { error: 'Not authenticated' });
      if (!isAdmin(user)) return json(403, { error: 'Admin only' });
      send = url.searchParams.get('send') === '1';
      days = Math.min(31, Math.max(1, parseInt(url.searchParams.get('days') || '7', 10) || 7));
    }
    const d = await buildDigest(days);
    let emailed = false;
    if (send) { try { emailed = await sendDigest(d); } catch (e) { console.warn('[ai-usage-digest] email failed:', e && e.message); } }
    console.log('[ai-usage-digest] ' + d.from + '..' + d.to + ' calls=' + d.totals.calls + ' cents=' + Math.round(d.totals.cents) + ' hit=' + _pct(d.hitRatio) + ' emailed=' + emailed);
    return json(200, Object.assign({ ok: true, emailed }, d));
  } catch (e) {
    console.error('ai-usage-digest error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
