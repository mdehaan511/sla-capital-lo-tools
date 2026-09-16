/**
 * armory-pulse.mjs — GET /api/armory-pulse
 *
 * Deploy 237.085 (Mike) — "is there something new in the Armory?" for the
 * nav link blink. One blob read; called by sla-nav.js on every staff page
 * load, so the team gate is the cheap token-only check (no role-table read).
 *
 * Returns: { ok, pulse: { at, kind, text } | null }
 */
import { handleOptions, json, requireAuth, getRoles, normalizeEmail } from './_shared/auth.mjs';
import { classifyAccount } from './_shared/team-roster-rules.mjs';
import { getPulse } from './_shared/armory.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (classifyAccount({ email: normalizeEmail(user.email), appRoles: getRoles(user), tableRoles: [] }) !== 'staff') return json(403, { error: 'Team members only' });
    const p = await getPulse();
    return json(200, { ok: true, pulse: p ? { at: p.at, kind: p.kind, text: p.text } : null });
  } catch (e) {
    console.error('armory-pulse error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
