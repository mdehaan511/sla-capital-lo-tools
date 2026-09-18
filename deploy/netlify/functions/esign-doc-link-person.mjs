/**
 * esign-doc-link-person.mjs — POST /api/esign-doc-link-person
 *
 * Deploy 237.167 (Mike). The EXPLICIT half of "linked to the profiles of people".
 *
 * Most completed documents reach a profile on their own: the signer list already names
 * who signed, so esign-people.docBelongsTo derives it (see that file). This endpoint is
 * for the documents a signer list cannot describe — a trade assignment that matters to
 * the investor who never signed it, a payoff a broker needs on file.
 *
 * Body: { id, owner?, person: { kind:'client'|'broker'|'investor', id, name?, email?, ownerKey? } }
 *       { id, owner?, unlink: { kind, id } }
 *
 * Only COMPLETED documents can be linked: a draft on someone's profile is a promise, not
 * a record.
 */
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin, isProcessor,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { readDoc, writeDoc, sanitizeDoc, pushHistory, fullName } from './_shared/esign-docs.mjs';
import { normalizePersonRef } from './_shared/esign-people.mjs';

const MAX_PEOPLE = 12;

export default async (req, context) => {
  try {
    const pre = handleOptions(req); if (pre) return pre;
    if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    const body = await readJsonBody(req);
    if (!body || !body.id) return json(400, { error: 'id required' });

    const selfEmail = normalizeEmail(user.email);
    const actorName = fullName(user) || selfEmail;
    const staff = isAdmin(user) || isProcessor(user);
    let ownerKey = keySafe(selfEmail);
    if (body.owner && normalizeEmail(body.owner) !== selfEmail) {
      if (!staff) return json(403, { error: 'Owner override requires admin' });
      ownerKey = keySafe(normalizeEmail(body.owner));
    }

    const doc = await readDoc(ownerKey, body.id);
    if (!doc) return json(404, { error: 'Document not found' });
    if (doc.status !== 'completed') {
      return json(400, { error: 'Only a completed document can be linked to a profile' });
    }
    if (!Array.isArray(doc.people)) doc.people = [];

    if (body.unlink) {
      const kind = String(body.unlink.kind || '');
      const id = String(body.unlink.id || '');
      const before = doc.people.length;
      doc.people = doc.people.filter((p) => !(p && String(p.id) === id && (!kind || p.kind === kind)));
      if (doc.people.length === before) return json(404, { error: 'That link is not on this document' });
      pushHistory(doc, 'person_unlinked', 'Unlinked from ' + (kind || 'profile') + ' ' + id, selfEmail);
      doc.updatedAt = new Date().toISOString();
      await writeDoc(doc);
      return json(200, { ok: true, doc: sanitizeDoc(doc) });
    }

    const person = normalizePersonRef(body.person);
    if (!person) return json(400, { error: 'person needs a kind (client / broker / investor) and an id' });
    if (doc.people.some((p) => p && String(p.id) === person.id && p.kind === person.kind)) {
      return json(200, { ok: true, doc: sanitizeDoc(doc), already: true });
    }
    if (doc.people.length >= MAX_PEOPLE) return json(400, { error: 'At most ' + MAX_PEOPLE + ' linked profiles' });

    doc.people.push(Object.assign({}, person, {
      by: selfEmail, byName: actorName, at: new Date().toISOString(),
    }));
    pushHistory(doc, 'person_linked',
      'Linked to ' + person.kind + ' ' + (person.name || person.id), selfEmail);
    doc.updatedAt = new Date().toISOString();
    await writeDoc(doc);
    return json(200, { ok: true, doc: sanitizeDoc(doc) });
  } catch (e) {
    console.error('esign-doc-link-person error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};
