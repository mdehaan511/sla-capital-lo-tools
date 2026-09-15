/**
 * armory-run-start.mjs — POST /api/armory-run-start
 *
 * Deploy 237.072 (Mike) — the game calls this the moment a ride begins and
 * gets back a SIGNED, single-use run token. The token's issue time is what
 * armory-score-submit measures the ride against (see _shared/armory.mjs).
 *
 * Returns: { ok, token, expiresAt }
 */
import { handleOptions, json, requireAuth } from './_shared/auth.mjs';
import { isTeamMember, issueRunToken } from './_shared/armory.mjs';

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!(await isTeamMember(user))) return json(403, { error: 'The Armory is for SLA Capital team members.' });
    const t = issueRunToken(user.email);
    return json(200, { ok: true, token: t.token, expiresAt: t.expiresAt });
  } catch (e) {
    console.error('armory-run-start error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
