/**
 * loan-contacts-save.mjs — POST /api/loan-contacts-save
 *
 * Deploy 236.113 (Phase E — Contacts) — create or update an
 * additional contact on a loan. "Additional" because the implicit
 * contacts (LO from ownerKey, Borrower from client, Broker from
 * loan.broker* fields, Guarantors from loan.guarantorClientIds)
 * already render in their own Loan Details sections; this endpoint
 * stores everyone else (Title Company, Insurance Agent, Inspector,
 * Appraiser, Surveyor, Attorney, Other).
 *
 * Same blob-store pattern as tasks: keyed by loanOwnerKey/contactId,
 * per-loan list = prefix scan + filter by loanId.
 *
 * Body:
 *   {
 *     clientId: 'c_...',
 *     loanId:   'l_...',
 *     contactId?: 'ctc_...',          // omit to create; provide to update
 *     role:     'title' | 'insurance' | 'inspector' | 'appraiser' |
 *               'surveyor' | 'attorney' | 'other',
 *     roleLabel?: 'Title Company',    // human label override (free text)
 *     name:     'Janet at FNF',
 *     company?: 'First American Title',
 *     email?:   '...', phone?: '...',
 *     notes?:   '',
 *     owner?:   'other@lo.com'         // admin cross-LO override
 *   }
 *
 * Response: { ok: true, contact: <full contact record> }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266

// Deploy 236.467 — expanded vendor roles (Mike). contractor/realtor/lender/
// escrow added alongside the original set. Keep in sync with ROLE_LABELS in
// contacts.html (Vendors page) + loan-details.js + the ctModalRole <select>.
const VALID_ROLES = ['title', 'insurance', 'inspector', 'appraiser', 'surveyor', 'attorney', 'contractor', 'realtor', 'lender', 'escrow', 'other'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-contacts-save top-level error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (!body) return json(400, { error: 'Invalid JSON' });

  const clientId = String(body.clientId || '').trim();
  const loanId   = String(body.loanId   || '').trim();
  if (!clientId) return json(400, { error: 'clientId required' });
  if (!loanId)   return json(400, { error: 'loanId required' });

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const store = getStore({ name: 'loan-contacts', consistency: 'strong' });
  const now = new Date().toISOString();
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';

  let contact;
  if (body.contactId) {
    const key = ownerKey + '/' + keySafe(body.contactId);
    try { contact = await store.get(key, { type: 'json' }); }
    catch (e) { return json(500, { error: 'Failed to read contact: ' + (e.message || 'unknown') }); }
    if (!contact) return json(404, { error: 'Contact not found: ' + body.contactId });
    if (body.role !== undefined) {
      const role = String(body.role || 'other').toLowerCase().trim();
      contact.role = VALID_ROLES.indexOf(role) >= 0 ? role : 'other';
    }
    if (body.roleLabel !== undefined) contact.roleLabel = String(body.roleLabel || '').trim();
    if (body.name !== undefined)      contact.name      = String(body.name || '').trim();
    if (body.company !== undefined)   contact.company   = String(body.company || '').trim();
    if (body.email !== undefined)     contact.email     = String(body.email || '').trim().toLowerCase();
    if (body.phone !== undefined)     contact.phone     = String(body.phone || '').trim();
    if (body.notes !== undefined)     contact.notes     = String(body.notes || '').trim();
    contact.updatedAt = now;
    contact.updatedBy = user.email || '';
  } else {
    const role = String(body.role || 'other').toLowerCase().trim();
    contact = {
      id:         'ctc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      clientId, loanId, ownerKey,
      role:       VALID_ROLES.indexOf(role) >= 0 ? role : 'other',
      roleLabel:  String(body.roleLabel || '').trim(),
      name:       String(body.name      || '').trim(),
      company:    String(body.company   || '').trim(),
      email:      String(body.email     || '').trim().toLowerCase(),
      phone:      String(body.phone     || '').trim(),
      notes:      String(body.notes     || '').trim(),
      createdAt:  now,
      createdBy:  user.email || '',
      createdByName: authorName,
      updatedAt:  now,
      updatedBy:  user.email || '',
    };
    if (!contact.name && !contact.company && !contact.email && !contact.phone) {
      return json(400, { error: 'At least one of name / company / email / phone is required' });
    }
  }

  const key = ownerKey + '/' + keySafe(contact.id);
  try { await store.setJSON(key, contact); }
  catch (e) { return json(500, { error: 'Failed to save contact: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, contact });
}
