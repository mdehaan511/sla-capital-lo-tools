/**
 * guarantor-trays-backfill-background.mjs — Netlify BACKGROUND function
 * (name ends in `-background`: returns 202 at once, runs up to 15 minutes).
 *
 * Deploy 237.106 (Mike: "push live on all loans with multiple guarantors") —
 * one-shot walk of every in-progress review splitting guarantor docs per
 * person. Fired by deploy-succeeded after this deploy (internal HMAC header)
 * and callable by an admin (JWT) if it ever needs re-running.
 *
 * Auth: `x-sla-internal` = HMAC(ESIGN_SEAL_SECRET, 'guarantor-trays') OR an
 * admin JWT. Body: { budgetMs? } (default 13 minutes).
 */
import { createHmac } from 'node:crypto';
import { handleOptions, json, requireAuth, isAdmin, readJsonBody } from './_shared/auth.mjs';
import { backfillGuarantorTrays } from './_shared/guarantor-trays-backfill.mjs';

export function internalBackfillSig() {
  const secret = process.env.ESIGN_SEAL_SECRET || '';
  if (!secret) return '';
  return createHmac('sha256', secret).update('guarantor-trays').digest('hex');
}

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const hdrSig = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('x-sla-internal') || '') : '';
    const wantSig = internalBackfillSig();
    if (!(wantSig && hdrSig && hdrSig === wantSig)) {
      const user = await requireAuth(context, req);
      if (!user) return json(401, { error: 'Not authenticated' });
      if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    }
    const body = await readJsonBody(req).catch(() => ({})) || {};
    const stats = await backfillGuarantorTrays({ budgetMs: Math.min(14 * 60000, Number(body.budgetMs) || 13 * 60000), onlyInProgress: body.all !== true });
    return json(200, { ok: true, stats });
  } catch (e) {
    console.error('guarantor-trays-backfill-background error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
