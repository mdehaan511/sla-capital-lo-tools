/**
 * borrower-intake-vendor.mjs — POST /api/borrower-intake-vendor
 *
 * Deploy 236.521 — the borrower enters their Title/Escrow agent and Insurance
 * agent on the intake page. We write each as a Vendor (loan-contacts record)
 * tied to the loan — so it shows up on the loan's Vendors list AND the system-
 * wide directory automatically. Deduped by (loanId, role) so re-submitting
 * updates the same vendor instead of piling up duplicates.
 *
 * Body: { loanId, primaryClientId, ownerKey, role, roleLabel?, name?, company?,
 *         email?, phone? }   role ∈ escrow | insurance
 * Auth: canReadLoan (borrower's loan_access grant).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { canReadLoan } from './_shared/access.mjs';

const ALLOWED_ROLES = ['escrow', 'title', 'insurance'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-intake-vendor error:', e);
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
  const loanId = String(body.loanId || '').trim();
  const primaryClientId = String(body.primaryClientId || '').trim();
  const ownerKey = String(body.ownerKey || '').trim();
  const role = String(body.role || '').toLowerCase().trim();
  if (!loanId || !ownerKey) return json(400, { error: 'loanId and ownerKey required' });
  if (ALLOWED_ROLES.indexOf(role) < 0) return json(400, { error: 'role must be escrow or insurance' });

  const name = String(body.name || '').trim();
  const company = String(body.company || '').trim();
  const email = String(body.email || '').trim().toLowerCase();
  const phone = String(body.phone || '').trim();
  if (!name && !company && !email && !phone) {
    return json(400, { error: 'Enter at least a name, company, email, or phone.' });
  }

  // Access check (borrower grant on this loan; LO/admin short-circuit).
  let loan = null;
  try {
    if (primaryClientId) {
      const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
      const client = await clientsStore.get(ownerKey + '/' + keySafe(primaryClientId), { type: 'json' });
      loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === loanId) || null : null;
    }
  } catch (_) {}
  const perm = await canReadLoan(user, loan || { id: loanId, ownerKey }, { ownerKey, loanId });
  if (!perm.ok) return json(perm.status || 403, { error: perm.reason || 'Not authorized' });

  const store = getStore({ name: 'loan-contacts', consistency: 'strong' });
  const now = new Date().toISOString();
  const roleLabel = String(body.roleLabel || (role === 'insurance' ? 'Insurance Agent' : 'Title / Escrow Agent')).trim();

  // Dedup by (loanId, role) within this owner's contacts.
  let existing = null, existingKey = null;
  try {
    const { blobs } = await store.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const c = await store.get(key, { type: 'json' });
      if (c && c.loanId === loanId && String(c.role || '').toLowerCase() === role) { existing = c; existingKey = key; break; }
    }
  } catch (e) { console.warn('[borrower-intake-vendor] scan failed:', e && e.message); }

  let contact;
  if (existing) {
    contact = Object.assign(existing, {
      role, roleLabel, name, company, email, phone,
      updatedAt: now, updatedBy: normalizeEmail(user.email),
      viaBorrowerIntake: true,
    });
  } else {
    contact = {
      id: 'ctc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      clientId: primaryClientId, loanId, ownerKey,
      role, roleLabel, name, company, email, phone, notes: '',
      createdAt: now, createdBy: normalizeEmail(user.email), createdByName: 'Borrower (intake)',
      updatedAt: now, updatedBy: normalizeEmail(user.email),
      viaBorrowerIntake: true,
    };
  }

  try { await store.setJSON(existingKey || (ownerKey + '/' + keySafe(contact.id)), contact); }
  catch (e) { return json(500, { error: 'Failed to save vendor: ' + (e.message || 'unknown') }); }

  return json(200, { ok: true, role, vendorId: contact.id });
}
