/**
 * broker-me.mjs — GET /api/broker-me
 *
 * Deploy 236.867 — Broker Portal, Phase 2. "Who am I and what may I do?"
 * The broker sizer asks this on load so it can render only the programs
 * the partner is approved for and enforce their fee cap in the form
 * before the server has to refuse it.
 *
 * This is a CONVENIENCE, not a gate. broker-price re-checks everything
 * server-side — a partner who edits the page still gets refused there.
 *
 * Admins get a synthetic "preview" context (all programs, no cap) so they
 * can review the broker surface without a partner record, or `?as=<email>`
 * to see it exactly as that partner does.
 *
 * Response:
 *   { ok, mode: 'partner'|'admin-preview', email, company, name,
 *     programs[], feeCapPoints, status, ownerKey }
 */
import {
  handleOptions, json, requireAuth, isAdmin, normalizeEmail,
} from './_shared/auth.mjs';
import { isBrokerRole } from './_shared/access.mjs';
import { getPartner, checkPartnerAccess, ALL_PROGRAMS } from './_shared/broker-partners.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-me error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function shape(mode, email, p) {
  return {
    ok: true,
    mode,
    email,
    status:       p ? p.status : 'preview',
    company:      p ? (p.company || '') : '',
    name:         p ? ((p.firstName || '') + ' ' + (p.lastName || '')).trim() : '',
    ownerKey:     p ? (p.ownerKey || '') : '',
    programs:     p ? (Array.isArray(p.programs) ? p.programs : []) : ALL_PROGRAMS.slice(),
    feeCapPoints: p ? (p.feeCapPoints == null ? null : p.feeCapPoints) : null,
  };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const me = normalizeEmail(user.email || '');

  if (isAdmin(user)) {
    // Preview as a specific partner, so an admin sees exactly what that
    // broker sees — including a program they're NOT approved for being
    // absent rather than merely disabled.
    let as = '';
    try { as = normalizeEmail(new URL(req.url).searchParams.get('as') || ''); } catch (_) {}
    if (as) {
      const p = await getPartner(as);
      if (!p) return json(404, { error: 'No partner record for ' + as });
      return json(200, Object.assign(shape('admin-preview', as, p), { previewOf: as }));
    }
    return json(200, shape('admin-preview', me, null));
  }

  if (!isBrokerRole(user)) {
    return json(403, { error: 'This account is not a Preferred Partner.' });
  }
  const access = await checkPartnerAccess(me);
  if (!access.ok) return json(403, { error: access.reason, code: 'partner_not_approved' });

  return json(200, shape('partner', me, access.partner));
}
