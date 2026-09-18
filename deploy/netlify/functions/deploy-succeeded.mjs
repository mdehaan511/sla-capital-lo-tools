/**
 * deploy-succeeded.mjs — Netlify deploy event function (Deploy 237.089, Mike)
 *
 * Netlify invokes a function named `deploy-succeeded` after every successful
 * production deploy. We use it for one thing: announce DSCR pricing changes in
 * Slack (see _shared/pricing-announce.mjs). No rate change → no post.
 *
 * Netlify triggers this itself; it is not routed through netlify.toml and it
 * carries no user JWT, so it must never do anything a caller could abuse.
 */
import { announcePricingChanges } from './_shared/pricing-announce.mjs';
import { createHmac } from 'node:crypto';
import { getStore } from '@netlify/blobs';

// Deploy 237.106 — one-shot post-deploy jobs, keyed by a version marker in
// the settings store so each runs exactly once no matter how many deploys
// follow. Today: the per-guarantor tray backfill (fires the background fn
// with the internal HMAC header; it returns 202 and runs up to 15 min).
const ONE_SHOT_JOBS = [
  // Deploy 237.150 -- bumped to v2 so the sweep re-runs for Credit Authorization,
  // which became a per-guarantor tray. Idempotent (the nightly cron runs the same
  // function), so a re-run only migrates what has not moved yet.
  // Deploy 237.160 -- v3 so the sweep re-runs and folds away the trays of guarantors
  // already off their loans (Jessy's 621 Stewart Ave). Documents are kept; the trays
  // are hidden, reachable from the section's "Show N hidden".
  { key: 'guarantor-trays-backfill-v3', fn: 'guarantor-trays-backfill-background', sig: 'guarantor-trays' },
  // Deploy 237.118 (Mike, "run a blanks only backfill") -- DIYA / TPO 1 onto pipeline
  // DSCR loans that predate the 237.084 save-time rule (blanks only; report in
  // settings/dscr_defaults_backfill_last).
  { key: 'dscr-defaults-backfill-v1', fn: 'dscr-defaults-backfill-background', sig: 'dscr-defaults' },
];
async function runOneShotJobs() {
  const out = [];
  const secret = process.env.ESIGN_SEAL_SECRET || '';
  const base = String(process.env.URL || 'https://slaloantools.netlify.app').replace(/\/+$/, '');
  const store = getStore({ name: 'settings', consistency: 'strong' });
  for (const job of ONE_SHOT_JOBS) {
    try {
      const marker = 'oneshot_' + job.key;
      if (await store.get(marker, { type: 'json' }).catch(() => null)) { out.push(job.key + ':done-before'); continue; }
      if (!secret) { out.push(job.key + ':no-secret'); continue; }
      await store.setJSON(marker, { at: new Date().toISOString(), fn: job.fn });
      const r = await fetch(base + '/.netlify/functions/' + job.fn, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-sla-internal': createHmac('sha256', secret).update(job.sig).digest('hex') },
        body: JSON.stringify({ source: 'deploy-succeeded' }),
      });
      out.push(job.key + ':' + r.status);
    } catch (e) { out.push(job.key + ':error ' + (e && e.message)); }
  }
  return out;
}

export default async (req) => {
  try {
    let deployId = '';
    try { const b = await req.json(); deployId = (b && b.payload && b.payload.id) || ''; } catch (_) {}
    const r = await announcePricingChanges({ source: 'deploy-succeeded' + (deployId ? ':' + deployId : '') });
    console.log('[deploy-succeeded] pricing announce:', r.reason || (r.posted ? 'posted' : 'not-posted'), r.basis);
    console.log('[deploy-succeeded] one-shot jobs:', (await runOneShotJobs()).join(', '));
    return new Response(JSON.stringify({ ok: true, posted: r.posted, reason: r.reason || '' }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    console.error('[deploy-succeeded] failed:', e && e.message);
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
};
