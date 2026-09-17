/**
 * esign-roles.mjs — GET/POST /api/esign-roles
 *
 * Deploy 237.134 (Mike): the E-Sign tool's saved signer ROLES (see
 * _shared/esign-roles.mjs). Org-wide, like the template library: everyone who
 * can use E-Sign sees every role and may save one; removing a role is for its
 * creator or staff (the built-in starters: staff only).
 *
 * GET                                  → { roles:[{ id, name, kind, order, defaultName, defaultEmail }] }
 * POST { action:'save', role:{ id?, name, kind, order, defaultName?, defaultEmail?, keepPerson? } }
 *                                      → { ok, role, created, roles }
 * POST { action:'delete', id }         → { ok, roles }
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor, normalizeEmail,
} from './_shared/auth.mjs';
import { readRoles, writeRoles, upsertRole, removeRole } from './_shared/esign-roles.mjs';

const staff = (u) => isAdmin(u) || isProcessor(u);

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const selfEmail = normalizeEmail(user.email);

    if (req.method === 'GET') return json(200, { roles: await readRoles() });
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

    const body = await readJsonBody(req);
    if (!body) return json(400, { error: 'Invalid JSON body' });
    const current = await readRoles();

    if (body.action === 'delete') {
      const target = current.find((r) => r.id === String(body.id || ''));
      if (!target) return json(404, { error: 'Role not found' });
      const mine = target.createdBy && normalizeEmail(target.createdBy) === selfEmail;
      if (!mine && !staff(user)) return json(403, { error: 'Only the person who saved this role or staff can remove it' });
      const { list } = removeRole(current, target.id);
      return json(200, { ok: true, roles: await writeRoles(list) });
    }

    if (body.action === 'save') {
      let out;
      try { out = upsertRole(current, body.role, selfEmail); }
      catch (e) { return json(400, { error: e.message }); }
      const roles = await writeRoles(out.list);
      return json(200, { ok: true, role: out.role, created: out.created, roles });
    }
    return json(400, { error: 'Unknown action' });
  } catch (e) {
    console.error('esign-roles error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
