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
// Deploy 236.5 (Brokers Phase 3b) — auto-link any loan on this client
// that has broker inline fields but no brokerId. Safe to run even on
// loans that already have a brokerId (no-op fast path in the helper).
import { linkOrCreateBroker } from './_shared/broker-link.mjs';
import { encryptField } from './_shared/crypto.mjs';
// Deploy 236.341 (Tier 2 scaling) — write-through the materialized
// clients-index blob so cross-owner list reads stay in sync.
import { upsertClient } from './_shared/clients-index.mjs';

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

    // Deploy 236.348 — per-loan field preservation. Deploy 236.346
    // flipped SLA.Clients.list() to return SUMMARY-projected records
    // by default. Any caller that fetches via .list() then round-trips
    // through .save() (client-details.html name edit, pipeline drag,
    // etc.) sends back a loan object with only the summary fields.
    // Without merging, the full-blob overwrite here wipes every
    // field NOT in LOAN_SUMMARY_FIELDS — including rehabBudget, arv,
    // bedrooms/bathrooms/sqft, notesLog, formData snapshots, and
    // anything else the summary doesn't project.
    //
    // Merge rule: for each incoming loan matched by id to an existing
    // loan, copy any key present on existing but absent from incoming.
    // A caller who genuinely wants to clear a field sends it as
    // '' / null / 0 — those are present-on-incoming and win. Only
    // omission preserves.
    if (existing && Array.isArray(existing.loans) && Array.isArray(record.loans)) {
      const existingById = new Map();
      for (const el of existing.loans) {
        if (el && el.id) existingById.set(el.id, el);
      }
      record.loans = record.loans.map((incoming) => {
        if (!incoming || !incoming.id) return incoming;
        const prior = existingById.get(incoming.id);
        if (!prior) return incoming;
        const merged = { ...incoming };
        for (const key of Object.keys(prior)) {
          if (!(key in incoming)) merged[key] = prior[key];
        }
        return merged;
      });
    }

    // Deploy 236.150 — accept a freshly-typed SSN under
    // record.ssn (raw digits from the Client Details page).
    // Strip mask, encrypt with SSN_ENCRYPTION_KEY-derived key
    // via _shared/crypto.mjs, store as ssn_enc. Always strip
    // the plaintext field before persisting so it never lands
    // in the blob.
    if (record.ssn != null) {
      const digits = String(record.ssn).replace(/\D/g, '');
      if (digits.length === 9) {
        const enc = encryptField(digits);
        if (enc) {
          record.ssn_enc = enc;
          record.ssnLast4 = digits.slice(-4);
        }
      } else if (digits.length === 0 && record.ssn === '') {
        // Explicit clear (user blanked the field intentionally).
        delete record.ssn_enc;
        delete record.ssnLast4;
      }
      // Partial digit counts (typo) are silently ignored — the
      // existing ssn_enc carried forward above is preserved.
      delete record.ssn;
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
      // (b) Quote records in the `quotes` store under this owner. Match
      // by EITHER formData.borrowerEmail (preferred, set by the sizer at
      // save) OR by quote.address being one of this client's loan
      // addresses (fallback for legacy quotes saved before the sizer
      // started persisting borrowerEmail on the formData). Update quote.
      // borrower + quote.formData.borrower so Pipeline tiles + rate
      // sheet PDF show the fresh name.
      //
      // Deploy 228.1 — switched from fire-and-forget IIFE to await
      // before responding, so the client save call doesn't return until
      // every matching quote is updated. Was non-deterministic before;
      // Mike saw stale Pipeline tiles because the quote update was
      // still in flight when the page refreshed.
      try {
        const quotesStore = getStore({ name: 'quotes', consistency: 'strong' });
        const target = String(record.email || '').toLowerCase().trim();
        // Build a Set of normalized loan addresses for fallback matching.
        const normAddr = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
        const loanAddrs = new Set();
        if (Array.isArray(record.loans)) {
          record.loans.forEach((l) => { if (l && l.address) loanAddrs.add(normAddr(l.address)); });
        }
        const { blobs } = await quotesStore.list({ prefix: ownerKey + '/' });
        let touched = 0;
        for (const { key: qKey } of blobs) {
          const q = await quotesStore.get(qKey, { type: 'json' });
          if (!q) continue;
          const qEmail = String((q.formData && q.formData.borrowerEmail) || q.borrowerEmail || '').toLowerCase().trim();
          const qAddr  = normAddr(q.address || (q.formData && q.formData.address) || '');
          const emailMatch = target && qEmail === target;
          const addrMatch  = qAddr && loanAddrs.has(qAddr);
          if (!emailMatch && !addrMatch) continue;
          q.borrower = newFull;
          if (q.formData) {
            q.formData.borrower     = newFull;
            q.formData.borrowerName = newFull;
          }
          q.updatedAt = new Date().toISOString();
          await quotesStore.setJSON(qKey, q);
          touched += 1;
        }
        if (touched > 0) console.log(`clients-save: propagated rename to ${touched} quote(s) for client ${record.id}`);
      } catch (e) {
        console.warn('clients-save: quote borrower-name propagation failed (non-fatal):', e && e.message);
      }
    }

    // Deploy 236.5 — broker entity auto-link across all loans on this
    // client. Runs sequentially (not parallel) to keep a single broker
    // book read per loan and to avoid create-create races on the same
    // email coming in on two new loans at once. Per-loan failure is
    // logged but never blocks the save.
    if (Array.isArray(record.loans) && record.loans.length) {
      for (const l of record.loans) {
        if (!l || typeof l !== 'object') continue;
        if (!l.brokerName && !l.brokerEmail && !l.brokerId) continue;
        try {
          const linked = await linkOrCreateBroker(ownerKey, l);
          if (linked && linked.id) {
            l.brokerId = linked.id;
            const b = linked.broker || {};
            if (b.name)    l.brokerName    = b.name;
            if (b.company) l.brokerCompany = b.company;
            if (b.email)   l.brokerEmail   = b.email;
            if (b.phone)   l.brokerPhone   = b.phone;
          }
        } catch (e) {
          console.warn('clients-save: broker auto-link failed for loan ' + (l.id || '?') + ':', e && e.message);
        }
      }
    }

    await store.setJSON(key, record);
    // Deploy 236.341 — write-through the materialized clients-index
    // so cross-owner list reads stay in-sync. upsertClient never
    // throws (index write failure logged, primary save unaffected).
    upsertClient(ownerKey, record).catch(() => {});

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
