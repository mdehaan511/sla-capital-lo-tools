/**
 * borrower-profile.mjs — GET/POST /api/borrower-profile
 *
 * Deploy 236.545 — borrower self-service profile editing. Lets a signed-in
 * borrower view and update THEIR OWN personal info (phone, mailing address,
 * SSN, business entities) on the client record their loan(s) hang off of.
 *
 * Authorization is provider-agnostic and keyed on the SAME email->loan_access
 * grant the rest of the portal uses (listAccessibleLoans). A borrower can only
 * touch the client(s) that their granted loans point at (primaryClientId), and
 * the WRITE target ownerKey is resolved from the grant — NEVER from anything the
 * borrower sends — so there is no way to redirect a write onto someone else's
 * record. Only a whitelist of borrower-editable fields is touched; loans, LO
 * notes, status, commissions, etc. pass through untouched.
 *
 * SSN is write-only from the borrower side: raw digits in -> encryptField ->
 * ssn_enc + ssnLast4 (same contract as clients-save.mjs); the raw SSN is never
 * persisted and is NEVER returned. GET exposes only { hasSSN, ssnLast4 }.
 *
 *   GET  [?clientId=]  -> { profile }
 *   POST { clientId?, phone?, homeAddress?, ssn?, companies? } -> { ok, profile }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';
import { encryptField } from './_shared/crypto.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-profile error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  const method = req.method;
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  const email = normalizeEmail(user.email);

  // Which client(s) may this borrower edit? Strictly the ones their live
  // loan_access grants point at. Map primaryClientId -> ownerKey (the grant's
  // owner — the authoritative write target).
  const grants = await listAccessibleLoans(email);
  const clientMap = {};
  for (const g of (grants || [])) {
    if (g && g.primaryClientId && g.ownerKey) clientMap[g.primaryClientId] = g.ownerKey;
  }
  const clientIds = Object.keys(clientMap);
  if (!clientIds.length) return json(403, { error: 'No profile is linked to this account yet.' });

  // Resolve the target client. A supplied clientId MUST be one of the
  // borrower's granted clients; otherwise default to the (usually only) one.
  let body = null, wantClientId = '';
  if (method === 'GET') {
    wantClientId = String(new URL(req.url).searchParams.get('clientId') || '').trim();
  } else {
    body = await readJsonBody(req);
    wantClientId = body && body.clientId ? String(body.clientId).trim() : '';
  }
  let clientId = wantClientId || clientIds[0];
  const ownerKey = clientMap[clientId];
  if (!ownerKey) return json(403, { error: 'You do not have access to that profile.' });

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const client = await store.get(ownerKey + '/' + keySafe(clientId), { type: 'json' });
  if (!client) return json(404, { error: 'Profile not found.' });

  if (method === 'GET') {
    return json(200, { profile: _sanitize(client, clientId, clientIds) });
  }

  // ── POST: update ONLY the whitelisted borrower-editable fields ──
  if (body.phone !== undefined) client.phone = String(body.phone || '').trim();

  if (body.homeAddress && typeof body.homeAddress === 'object') {
    const h = body.homeAddress;
    client.homeAddress = {
      street: String(h.street || '').trim(),
      city:   String(h.city   || '').trim(),
      state:  String(h.state  || '').trim(),
      zip:    String(h.zip    || '').trim(),
    };
  }

  // SSN — write-only. Only a full 9-digit value replaces what's on file; a
  // blank/partial value leaves the existing ssn_enc untouched (a borrower can
  // never accidentally WIPE their SSN from here). Raw digits are never stored.
  if (body.ssn !== undefined) {
    const digits = String(body.ssn).replace(/\D/g, '');
    if (digits.length === 9) {
      const enc = encryptField(digits);
      if (enc) { client.ssn_enc = enc; client.ssnLast4 = digits.slice(-4); }
    }
  }
  delete client.ssn; // never persist a raw SSN

  if (Array.isArray(body.companies)) {
    client.companies = body.companies.map(function (c) {
      c = c || {};
      return {
        name:    String(c.name    || '').trim(),
        ein:     String(c.ein     || '').trim(),
        address: String(c.address || '').trim(),
        city:    String(c.city    || '').trim(),
        state:   String(c.state   || '').trim(),
        zip:     String(c.zip     || '').trim(),
      };
    }).filter(function (c) { return c.name || c.ein; });
  }

  client.updatedAt = new Date().toISOString();
  // Audit crumb so the LO can see the borrower self-edited (and when).
  client._lastBorrowerEdit = { at: client.updatedAt, by: email };

  // Strict PG-first write (blob + clients-index + pg-mirror), same path as
  // clients-save. Await it — fire-and-forget reintroduces the drift bug class.
  await writeClient(ownerKey, client, { clientsStore: store });

  return json(200, { ok: true, profile: _sanitize(client, clientId, clientIds) });
}

// Borrower-safe projection. NEVER includes ssn_enc or any LO-side context —
// only what the borrower needs to see/edit their own info.
function _sanitize(c, clientId, clientIds) {
  const h = (c && c.homeAddress) || {};
  return {
    clientId: clientId,
    clientIds: clientIds,                 // all profiles this borrower can edit (usually 1)
    firstName: c.firstName || '',
    lastName:  c.lastName  || '',
    email:     c.email     || '',
    phone:     c.phone     || '',
    homeAddress: {
      street: h.street || '', city: h.city || '', state: h.state || '', zip: h.zip || '',
    },
    hasSSN:   !!c.ssn_enc,                 // presence only — never the value
    ssnLast4: c.ssnLast4 || '',
    companies: Array.isArray(c.companies) ? c.companies.map(function (x) {
      x = x || {};
      return {
        name: x.name || '', ein: x.ein || '', address: x.address || '',
        city: x.city || '', state: x.state || '', zip: x.zip || '',
      };
    }) : [],
  };
}
