/**
 * loan-contacts-delete.mjs — POST /api/loan-contacts-delete
 *
 * Deploy 236.113 — delete an additional contact. Creator or admin only.
 *
 * Body: { contactId, owner? }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-contacts-delete top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });
  const contactId = String(body.contactId || '').trim();
  if (!contactId) return json(400, { error: 'contactId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!isAdmin(user)) return json(403, { error: 'Owner override requires admin' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const store = getStore({ name: 'loan-contacts', consistency: 'strong' });
  const key = ownerKey + '/' + keySafe(contactId);
  let contact;
  try { contact = await store.get(key, { type: 'json' }); }
  catch (e) { return json(500, { error: 'Failed to read contact: ' + (e.message || 'unknown') }); }
  if (!contact) return json(404, { error: 'Contact not found' });

  const isCreator = String(contact.createdBy || '').toLowerCase() === selfEmail;
  if (!isCreator && !isAdmin(user)) {
    return json(403, { error: 'Only the contact creator or an admin can delete this contact' });
  }

  try { await store.delete(key); }
  catch (e) { return json(500, { error: 'Failed to delete contact: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, deletedId: contactId });
}
