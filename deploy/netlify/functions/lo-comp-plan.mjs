/**
 * lo-comp-plan.mjs — GET /api/lo-comp-plan
 *
 * Deploy 236.952 (Mike: "make it so that the LOs can see their commissions and
 * status of the pay out in their profiles.")
 *
 * The one thing an LO's own commission view can't read for itself: which comp
 * plan they are on. Plans live in settings.lo_comp_plans (admin-only settings),
 * so this hands back JUST the caller's plan — never the whole map. Any signed-in
 * user; the math itself runs in the browser from the shared lo-comp.js, the
 * same code the admin page uses.
 *
 * Returns { ok, email, plan, label, note, configured }
 *   configured — true when an admin has saved a plan for this person (false =
 *                first-run default / fallback, so the page can say so)
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, normalizeEmail } from './_shared/auth.mjs';
import comp from '../../lo-comp.js';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('lo-comp-plan error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const self = normalizeEmail(user.email);

  let plans = null;
  try { plans = await getStore({ name: 'settings', consistency: 'strong' }).get('lo_comp_plans', { type: 'json' }); }
  catch (e) { console.warn('lo-comp-plan: settings read failed:', e && e.message); }
  const configured = !!(plans && typeof plans === 'object' && plans[self]);
  const plan = configured ? String(plans[self]) : (comp.DEFAULT_PLANS[self] || 'flat50');
  return json(200, {
    ok: true, email: self, plan, configured,
    label: comp.PLAN_LABEL[plan] || plan,
    note: plan === 'salary' ? comp.SALARY_PLAN_NOTE : '',
  });
}
