/**
 * broker-logo.mjs — /api/broker-logo
 *
 * Deploy 236.872. A Preferred Partner's own logo for their rate sheets.
 *
 *   GET     → { ok, logo: { mime, dataB64, uploadedAt } | null }
 *   POST    { dataB64, mime? }  → store it
 *   DELETE  → remove it
 *
 * Scoped to the CALLER. An admin may act on a partner's behalf with
 * ?as=<email> (the same preview affordance the sizer uses), which is how
 * support uploads a logo a broker emailed in.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, normalizeEmail,
} from './_shared/auth.mjs';
import { isBrokerRole } from './_shared/access.mjs';
import { checkPartnerAccess } from './_shared/broker-partners.mjs';
import { getLogo, saveLogo, deleteLogo } from './_shared/broker-assets.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('broker-logo error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

/** Whose logo is this request about? Null when the caller may not act. */
async function subjectOf(req, user) {
  const me = normalizeEmail(user.email || '');
  if (isAdmin(user)) {
    let as = '';
    try { as = normalizeEmail(new URL(req.url).searchParams.get('as') || ''); } catch (_) {}
    return as || me;
  }
  if (!isBrokerRole(user)) return null;
  const access = await checkPartnerAccess(me);
  return access.ok ? me : null;
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const subject = await subjectOf(req, user);
  if (!subject) return json(403, { error: 'Not a Preferred Partner account.' });

  if (req.method === 'GET') {
    return json(200, { ok: true, logo: await getLogo(subject) });
  }

  if (req.method === 'DELETE') {
    await deleteLogo(subject);
    return json(200, { ok: true, removed: true });
  }

  if (req.method === 'POST') {
    const body = (await readJsonBody(req)) || {};
    try {
      const rec = await saveLogo(subject, body.dataB64, body.mime);
      // Don't echo the bytes back — the caller already has them.
      return json(200, { ok: true, logo: { mime: rec.mime, bytes: rec.bytes, uploadedAt: rec.uploadedAt } });
    } catch (e) {
      // saveLogo's messages are written for the broker to read.
      return json(400, { error: (e && e.message) || 'Could not save that image.' });
    }
  }

  return json(405, { error: 'Method not allowed' });
}
