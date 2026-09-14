/**
 * mail-backfill.mjs - POST /api/mail-backfill
 *
 * Deploy 237.012 (Mike: "pull in all of the old mail so we can keep it on
 * file for those loans"). One-time archival import of the ENTIRE Stable
 * mailbox history. Each not-yet-stored piece is ingested with our own
 * envelope image + OCR (+ the content scan when Stable has one) and filed
 * into the ARCHIVE: it shows under All Mail and is searchable + fileable to a
 * loan from its detail pane, but never enters the daily Unsorted queue or the
 * AI-suggestion queue (that would flood both and hijack the "open the oldest
 * to review" jump). Time-budgeted + resumable via meta/backfill; the caller
 * re-POSTs until { done:true }. Leaves the forward sync watermark alone.
 *
 * Body: { dryRun?: bool, restart?: bool }.  Admin only (heavy, one-time).
 */
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail, isAdmin } from './_shared/auth.mjs';
import { stableConfigured } from './_shared/stable-api.mjs';
import { runBackfill } from './mail-sync.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { console.error('mail-backfill error:', e); return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') }); }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only - importing the full mail history is a one-time archival job.' });
  if (!stableConfigured()) return json(503, { error: 'STABLE_API_KEY is not set on this site yet - add it in Netlify to connect the Stable mailbox.' });
  const body = (await readJsonBody(req)) || {};
  const result = await runBackfill({ dryRun: body.dryRun === true, restart: body.restart === true, budgetMs: 22000, actor: normalizeEmail(user.email) });
  return json(200, Object.assign({ ok: true }, result));
}
