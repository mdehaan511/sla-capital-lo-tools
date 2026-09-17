/**
 * _shared/esign-roles.mjs — Deploy 237.134 (Mike: "make it so 'roles' can be saved
 * for the signers and that fields can be assigned to those roles so its easier
 * to just assign those roles without having to modify too much")
 *
 * The E-Sign tool's saved ROLES library. A role is WHAT someone signs as —
 * "Borrower", "Guarantor", "SLA Signer", "Title / Escrow" — with the kind of
 * person it is, where it falls in the signing order, and (optionally) the person
 * who normally fills it, so a role like "SLA Signer" arrives already assigned.
 *
 * In a document a signer slot carries `roleName`; fields belong to the SLOT, so a
 * layout can be built for roles first and people dropped in later — by hand,
 * from a loan prefill, or from the role's remembered person. Templates already
 * stored roles (237.028); this makes them first-class outside templates and
 * reusable across documents.
 *
 * Org-wide, like the template library: one JSON doc, `esign-roles` / `library`.
 * Until somebody saves a role the built-in starter set below is what everyone
 * sees; the first save writes the starters + the new role.
 */
import { getStore } from '@netlify/blobs';

export const ROLE_KINDS = ['borrower', 'user', 'other'];
export const MAX_ROLES = 40;
const LIB_KEY = 'library';

export const DEFAULT_ROLES = [
  { id: 'esr_borrower',  name: 'Borrower',       kind: 'borrower', order: 1 },
  { id: 'esr_guarantor', name: 'Guarantor',      kind: 'borrower', order: 1 },
  { id: 'esr_sla',       name: 'SLA Signer',     kind: 'user',     order: 2 },
  { id: 'esr_broker',    name: 'Broker',         kind: 'other',    order: 1 },
  { id: 'esr_title',     name: 'Title / Escrow', kind: 'other',    order: 1 },
];

const rolesStore = () => getStore({ name: 'esign-roles', consistency: 'strong' });
const cleanName = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim().slice(0, 60);
const cleanEmail = (s) => { const e = String(s == null ? '' : s).trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e.slice(0, 160) : ''; };
export const roleKey = (name) => cleanName(name).toLowerCase();

/** One role record from untrusted input; null when it has no name. */
export function normalizeRole(raw) {
  const r = raw || {};
  const name = cleanName(r.name || r.roleName);
  if (!name) return null;
  const defaultEmail = cleanEmail(r.defaultEmail);
  return {
    id: /^esr_[0-9a-z_]{1,40}$/i.test(String(r.id || '')) ? String(r.id) : '',
    name,
    kind: ROLE_KINDS.indexOf(r.kind) >= 0 ? r.kind : 'borrower',
    order: Math.max(1, Math.min(10, parseInt(r.order, 10) || 1)),
    // The person who normally fills the role — only kept as a PAIR.
    defaultName: defaultEmail ? cleanName(r.defaultName).slice(0, 120) : '',
    defaultEmail: defaultEmail && cleanName(r.defaultName) ? defaultEmail : '',
  };
}

/**
 * Insert or update. A role is matched by id, else by NAME (case-insensitive) —
 * saving "borrower" again updates "Borrower" instead of minting a twin.
 * Returns { list, role, created }. Throws on a bad name or a full library.
 */
export function upsertRole(list, raw, actorEmail, nowIso) {
  const role = normalizeRole(raw);
  if (!role) throw new Error('Role name required');
  const now = nowIso || new Date().toISOString();
  const next = (Array.isArray(list) ? list : []).map((r) => Object.assign({}, r));
  let hit = role.id ? next.find((r) => r.id === role.id) : null;
  if (!hit) hit = next.find((r) => roleKey(r.name) === roleKey(role.name));
  const clash = next.find((r) => r !== hit && roleKey(r.name) === roleKey(role.name));
  if (clash) throw new Error('A role named "' + clash.name + '" already exists');
  if (hit) {
    // `keepPerson`: a caller that did not touch the remembered person must not erase it.
    const keep = raw && raw.keepPerson === true;
    Object.assign(hit, {
      name: role.name, kind: role.kind, order: role.order,
      defaultName: keep ? (hit.defaultName || '') : role.defaultName,
      defaultEmail: keep ? (hit.defaultEmail || '') : role.defaultEmail,
      updatedAt: now, updatedBy: String(actorEmail || ''),
    });
    return { list: next, role: hit, created: false };
  }
  if (next.length >= MAX_ROLES) throw new Error('At most ' + MAX_ROLES + ' saved roles');
  const fresh = Object.assign({}, role, {
    id: 'esr_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
    createdBy: String(actorEmail || ''), createdAt: now, updatedAt: now,
  });
  next.push(fresh);
  return { list: next, role: fresh, created: true };
}

/** Remove by id. Returns { list, removed }. */
export function removeRole(list, id) {
  const cur = Array.isArray(list) ? list : [];
  const removed = cur.find((r) => r && r.id === id) || null;
  return { list: cur.filter((r) => r && r.id !== id), removed };
}

const sortRoles = (list) => list.slice().sort((a, b) => (a.order || 1) - (b.order || 1) || String(a.name).localeCompare(String(b.name)));

/** The library as every page sees it (starter set until the first save). */
export async function readRoles() {
  const doc = await rolesStore().get(LIB_KEY, { type: 'json' }).catch(() => null);
  if (doc && Array.isArray(doc.roles)) return sortRoles(doc.roles.filter((r) => r && r.id && r.name));
  return sortRoles(DEFAULT_ROLES.map((r) => Object.assign({ builtin: true, defaultName: '', defaultEmail: '' }, r)));
}
export async function writeRoles(list) {
  const roles = sortRoles(list);
  await rolesStore().setJSON(LIB_KEY, { roles, updatedAt: new Date().toISOString() });
  return roles;
}
