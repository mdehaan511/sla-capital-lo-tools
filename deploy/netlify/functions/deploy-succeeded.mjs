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

export default async (req) => {
  try {
    let deployId = '';
    try { const b = await req.json(); deployId = (b && b.payload && b.payload.id) || ''; } catch (_) {}
    const r = await announcePricingChanges({ source: 'deploy-succeeded' + (deployId ? ':' + deployId : '') });
    console.log('[deploy-succeeded] pricing announce:', r.reason || (r.posted ? 'posted' : 'not-posted'), r.basis);
    return new Response(JSON.stringify({ ok: true, posted: r.posted, reason: r.reason || '' }), { status: 200, headers: { 'content-type': 'application/json' } });
  } catch (e) {
    console.error('[deploy-succeeded] failed:', e && e.message);
    return new Response(JSON.stringify({ ok: false }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
};
