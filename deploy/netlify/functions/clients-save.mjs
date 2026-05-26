/**
 * clients-save.js — POST /api/clients-save
 *
 * Upsert a single client record. Body: the full client object.
 * Owner is inferred from the authenticated user's email; admins may set
 * `_owner` in the body to save on behalf of another LO.
 *
 * Client shape (unchanged from current frontend code):
 *   { id, email, firstName, lastName, phone, createdAt, createdBy, loans: [...] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { syncClient as brevoSyncClient } from './_shared/brevo.mjs';

/**
 * Look up a profile by email and return a best-effort full name. Never throws.
 */
async function getOwnerName(ownerEmail) {
  try {
    const store = getStore({ name: 'profiles', consistency: 'eventual' });
    const profile = await store.get(keySafe(ownerEmail), { type: 'json' });
    if (!profile) return '';
    const meta = profile.user_metadata || {};
    return meta.full_name || meta.fullName || profile.full_name || profile.fullName || '';
  } catch (_) { return ''; }
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body || !body.id) return json(400, { error: 'client id required' });

  // Owner: default to current user. Admins may override via _owner.
  let owner = normalizeEmail(user.email);
  if (body._owner && isAdmin(user)) {
    owner = normalizeEmail(body._owner);
  }

  const record = { ...body };
  delete record._owner; // never persist

  const now = new Date().toISOString();
  if (!record.createdAt) record.createdAt = now;
  record.updatedAt = now;
  if (!record.createdBy) record.createdBy = owner;

  const ownerKey = keySafe(owner);
  const clientKey = keySafe(record.id);
  if (!ownerKey || !clientKey) return json(400, { error: 'Invalid owner or client id' });

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const key = `${ownerKey}/${clientKey}`;

  try {
    // If an existing record exists under this key owned by someone else,
    // only an admin may overwrite it.
    const existing = await store.get(key, { type: 'json' });
    if (existing && !isAdmin(user) && (existing.createdBy && normalizeEmail(existing.createdBy) !== owner)) {
      return json(403, { error: 'Not authorized to modify this client' });
    }
    // Preserve sensitive/server-only fields the client never sees in API
    // responses (so they aren't accidentally wiped by a UI save).
    if (existing && existing.ssn_enc && !record.ssn_enc) {
      record.ssn_enc = existing.ssn_enc;
    }

    // Deploy 228 — propagate first/last name changes. The Pipeline tile
    // and rate-sheet PDF both read the borrower name from places other
    // than client.firstName/lastName (loan.borrowerName on the client
    // itself; quote.borrower in the separate quotes store). When the
    // LO renames a client to fix a typo, those downstream fields need
    // to update too — otherwise the new name only shows on the Client
    // Details page while everywhere else still shows the old name.
    const oldFirst = existing && existing.firstName || '';
    const oldLast  = existing && existing.lastName  || '';
    const newFirst = record.firstName || '';
    const newLast  = record.lastName  || '';
    const nameChanged = (oldFirst !== newFirst) || (oldLast !== newLast);
    if (nameChanged) {
      const newFull = (newFirst + ' ' + newLast).trim();
      // (a) Loan records on this client — rewrite borrowerName on each.
      if (Array.isArray(record.loans)) {
        for (const l of record.loans) {
          if (l && typeof l === 'object') l.borrowerName = newFull;
        }
      }
      // (b) Quote records in the `quotes` store under this owner — find
      // any whose formData.borrowerEmail matches this client's email
      // and update quote.borrower + quote.formData.borrower. Best-
      // effort; failure is non-fatal (the save itself still goes through).
      (async () => {
        try {
          const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
          const target = String(record.email || '').toLowerCase().trim();
          if (!target) return;
          const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
          for (const { key: qKey } of blobs) {
            const q = await quotesStore.get(qKey, { type: 'json' });
            if (!q) continue;
            const qEmail = String((q.formData && q.formData.borrowerEmail) || q.borrowerEmail || '').toLowerCase().trim();
            if (qEmail !== target) continue;
            q.borrower = newFull;
            if (q.formData) {
              q.formData.borrower     = newFull;
              q.formData.borrowerName = newFull;
            }
            q.updatedAt = new Date().toISOString();
            await quotesStore.setJSON(qKey, q);
          }
        } catch (e) {
          console.warn('clients-save: quote borrower-name propagation failed (non-fatal):', e && e.message);
        }
      })();
    }

    await store.setJSON(key, record);

    // Fire-and-forget Brevo sync. Failures never block the save response.
    // We do await name resolution because it's a quick local blob read,
    // but the actual Brevo call is dispatched without awaiting completion.
    (async () => {
      try {
        const ownerName = await getOwnerName(owner);
        await brevoSyncClient(record, owner, ownerName);
      } catch (e) {
        console.warn('brevo sync (clients-save) failed silently:', e && e.message);
      }
    })();

    return json(200, { ok: true, client: record });
  } catch (e) {
    console.error('clients-save error:', e);
    return json(500, { error: 'Failed to save client' });
  }
};
