/**
 * lo-commission-payment-cron.mjs — nightly BILL payment-status refresh.
 *
 * Deploy 236.821 (Mike). Payments clear on BILL's schedule, not ours, so a bill
 * paid today may not settle for days. Polling nightly means the LO Commissions
 * badges keep up on their own instead of waiting for someone to press Sync
 * Payments.
 *
 * Calls the same handler as POST /api/lo-commission-bill { action:'sync-payments' }
 * over loopback rather than importing it: that module's export is an HTTP
 * handler that does its own auth, and a cron has no user. Building a fake
 * Request here would mean duplicating the auth bypass in two places. Instead the
 * work loop lives in syncPaymentsCore(), which both entry points share.
 *
 * READ-ONLY against BILL — it only stamps our own loan records. Loans already
 * marked PAID are skipped, so a steady state costs one login and a handful of
 * lookups.
 */
import { syncPaymentsCore } from './lo-commission-bill.mjs';
import { billConfigured } from './_shared/billcom.mjs';

// 15:40 UTC ≈ 8:40am PT — after overnight ACH settlement posts, before anyone
// looks at the commissions page.
export const config = { schedule: '40 15 * * *' };

export default async () => {
  if (!billConfigured()) {
    console.warn('[lo-commission-payment-cron] BILL not configured — skipping');
    return new Response(JSON.stringify({ ok: true, skipped: 'BILL not configured' }),
      { headers: { 'Content-Type': 'application/json' } });
  }
  let out;
  try {
    out = await syncPaymentsCore({ actor: 'lo-commission-payment-cron' });
  } catch (e) {
    console.error('[lo-commission-payment-cron] failed:', e && e.message);
    return new Response(JSON.stringify({ ok: false, error: (e && e.message) || 'failed' }),
      { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
  console.log('[lo-commission-payment-cron] checked=' + out.checked + ' bills=' + out.bills +
    ' resolved=' + out.resolved + ' updated=' + out.updated + ' unchanged=' + out.unchanged +
    ' lookupErrors=' + (out.lookupErrors || []).length + ' writeErrors=' + (out.writeErrors || []).length +
    ' statuses=' + JSON.stringify(out.statusCounts || {}));
  return new Response(JSON.stringify({ ok: true, ...out }), { headers: { 'Content-Type': 'application/json' } });
};
