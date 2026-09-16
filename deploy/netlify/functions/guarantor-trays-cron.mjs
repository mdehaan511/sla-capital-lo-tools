/**
 * guarantor-trays-cron.mjs — nightly 09:40 UTC
 *
 * Deploy 237.106 — keeps per-guarantor trays current on every in-progress
 * review even when nobody opens Doc Review: a loan that gains a second
 * guarantor gets its "<slug>__g<i>" trays by the next morning. Idempotent;
 * budgeted under Netlify's scheduled-function limit.
 */
import { backfillGuarantorTrays } from './_shared/guarantor-trays-backfill.mjs';

export const config = { schedule: '40 9 * * *' };

export default async () => {
  try {
    const stats = await backfillGuarantorTrays({ budgetMs: 24000 });
    console.log('[guarantor-trays-cron]', JSON.stringify({ scanned: stats.scanned, multi: stats.multi, updated: stats.updated, truncated: stats.truncated }));
  } catch (e) {
    console.error('[guarantor-trays-cron] failed:', e && e.message);
  }
  return new Response('ok');
};
