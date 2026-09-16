/**
 * pricing-announce.mjs — GET/POST /api/pricing-announce (admin) — Deploy 237.089
 *
 * Manual twin of the deploy-succeeded hook.
 *   GET            → dry run: current vs last-announced pricing + the Slack text
 *                    that would go out (nothing is posted or recorded).
 *   POST           → post if the rates changed since the last announcement.
 *   POST ?force=1  → post even when unchanged (re-announce the current sheet).
 */
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';
import { announcePricingChanges } from './_shared/pricing-announce.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isAdmin(user)) return json(403, { error: 'Admin only' });
    const url = new URL(req.url);
    if (req.method === 'GET') return json(200, await announcePricingChanges({ dryRun: true, source: 'admin:' + user.email }));
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const force = url.searchParams.get('force') === '1';
    return json(200, await announcePricingChanges({ force, source: 'admin:' + user.email }));
  } catch (e) {
    console.error('pricing-announce error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
