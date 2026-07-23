/**
 * loan-broker-borrower-capture.mjs — POST /api/loan-broker-borrower-capture
 *
 * Deploy 236.229 — Broker Phase E. Captures borrower info that a
 * broker deferred at submission time (Phase D). Fires at Advance
 * to Approved as a blocking gate on Loan Details.
 *
 * Body:
 *   {
 *     clientId, loanId, owner?,
 *     guarantors: [                    // 1-4 entries
 *       { firstName, lastName, email, phone?, dob?, ssn?, ownershipPct? },
 *       ...
 *     ],
 *     entityName?, entityEin?          // borrowing LLC (optional)
 *   }
 *
 * For each guarantor:
 *   1. Look for an existing client under the same owner with matching
 *      email. If found → link (adds loan reference).
 *   2. Else create a fresh client with the guarantor's info.
 *   3. Push the guarantor's flat data onto loan.guarantors[].
 *   4. Push guarantor.id onto loan.guarantorClientIds[].
 *
 * Also:
 *   · Clears loan._borrowerInfoPending.
 *   · Optionally sets loan.entityName + creates a companies[] entry
 *     on Guarantor 1's client for the vesting LLC.
 *   · Audit-logs the capture on the loan's notesLog.
 *
 * Auth: LO owns the loan (or admin owner-override).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isAdmin,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs'; // Deploy 236.266
import { appendNoteEntry } from './_shared/notes-log.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-broker-borrower-capture error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });

  const body = (await readJsonBody(req)) || {};
  if (!body.clientId || !body.loanId) return json(400, { error: 'clientId + loanId required' });
  const guarantors = Array.isArray(body.guarantors) ? body.guarantors : [];
  if (!guarantors.length) return json(400, { error: 'At least one guarantor required' });
  if (guarantors.length > 4) return json(400, { error: 'Max 4 guarantors' });
  for (const g of guarantors) {
    if (!g || !String(g.firstName || '').trim() || !String(g.lastName || '').trim()) {
      return json(400, { error: 'Each guarantor needs firstName + lastName' });
    }
    if (!String(g.email || '').trim() || !String(g.email).includes('@')) {
      return json(400, { error: 'Each guarantor needs a valid email' });
    }
  }

  // Owner resolution.
  let owner = normalizeEmail(user.email);
  if (body.owner && body.owner !== owner) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' }); // Deploy 236.266
    owner = normalizeEmail(body.owner);
  }
  const ownerKey = keySafe(owner);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // Load the primary client (the broker for a broker loan) + locate the loan.
  const primaryKey = ownerKey + '/' + keySafe(body.clientId);
  const primary = await clientsStore.get(primaryKey, { type: 'json' }).catch(() => null);
  if (!primary) return json(404, { error: 'Primary client not found' });
  if (!Array.isArray(primary.loans)) return json(400, { error: 'Primary client has no loans[]' });
  const loanIdx = primary.loans.findIndex((l) => l && l.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on primary client' });
  const loan = primary.loans[loanIdx];

  const now = new Date().toISOString();
  loan.guarantors    = Array.isArray(loan.guarantors) ? loan.guarantors : [];
  loan.guarantorClientIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];

  // Preload all clients for this owner once so per-guarantor email
  // matching doesn't do N list() calls.
  const ownerClientsIdx = new Map(); // email -> { client, key }
  try {
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const c = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!c) continue;
      const em = String(c.email || '').toLowerCase().trim();
      if (em) ownerClientsIdx.set(em, { client: c, key });
    }
  } catch (_) { /* non-fatal */ }

  // For each incoming guarantor: match-or-create the client, flatten
  // the data onto loan.guarantors[i], push the id onto guarantorClientIds.
  const createdOrLinked = [];
  for (let i = 0; i < guarantors.length; i++) {
    const g = guarantors[i];
    const email = String(g.email).toLowerCase().trim();
    let matched = ownerClientsIdx.get(email);
    let clientRec;
    let clientKey;
    let mode;
    if (matched) {
      clientRec = matched.client;
      clientKey = matched.key;
      // Gap-fill blanks on the matched contact.
      if (!clientRec.firstName && g.firstName) clientRec.firstName = String(g.firstName).trim();
      if (!clientRec.lastName  && g.lastName)  clientRec.lastName  = String(g.lastName).trim();
      if (!clientRec.phone     && g.phone)     clientRec.phone     = String(g.phone).trim();
      if (!clientRec.dob       && g.dob)       clientRec.dob       = String(g.dob).trim();
      clientRec.updatedAt = now;
      mode = 'linked';
    } else {
      const newId = 'c_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
      clientRec = {
        id:        newId,
        firstName: String(g.firstName).trim(),
        lastName:  String(g.lastName).trim(),
        email,
        phone:     String(g.phone || '').trim(),
        dob:       String(g.dob   || '').trim(),
        ssn_enc:   '', // borrower can add later via long-app; not encrypting client-typed SSN in this pass
        createdAt: now,
        updatedAt: now,
        createdBy: owner,
        loans:     [],
        _createdViaBrokerCapture: true,
      };
      clientKey = ownerKey + '/' + keySafe(newId);
      mode = 'created';
    }

    // Push to loan.guarantors[i] with the flat shape the app-PDF reads.
    loan.guarantors[i] = Object.assign({}, loan.guarantors[i] || {}, {
      firstName:  clientRec.firstName,
      lastName:   clientRec.lastName,
      email:      clientRec.email,
      phone:      clientRec.phone || '',
      dob:        clientRec.dob   || '',
      ssn:        String(g.ssn   || '').trim(),
      clientId:   clientRec.id,
      ownership:  g.ownershipPct != null ? String(g.ownershipPct) : (loan.guarantors[i] && loan.guarantors[i].ownership) || '',
    });

    if (loan.guarantorClientIds.indexOf(clientRec.id) < 0) {
      loan.guarantorClientIds.push(clientRec.id);
    }
    if (g.ownershipPct != null) {
      loan.guarantorOwnership = Object.assign({}, loan.guarantorOwnership || {});
      loan.guarantorOwnership[clientRec.id] = parseFloat(g.ownershipPct);
    }

    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
    try { await writeClient(ownerKey, clientRec, { clientsStore }); }
    catch (e) {
      return json(500, { error: 'Failed to save guarantor client ' + (i + 1) + ': ' + (e && e.message) });
    }
    createdOrLinked.push({ index: i, mode, clientId: clientRec.id, name: clientRec.firstName + ' ' + clientRec.lastName, email });
  }

  // Optional vesting LLC on the primary loan record + companies[] on
  // guarantor 1's client (matches the existing entity model).
  const entityName = String(body.entityName || '').trim();
  if (entityName) {
    loan.entityName = entityName;
    if (body.entityEin) loan.entityEin = String(body.entityEin).trim();
    // Attach on Guarantor 1's client.
    const g1Id = loan.guarantorClientIds[0];
    if (g1Id) {
      const g1Key = ownerKey + '/' + keySafe(g1Id);
      const g1Client = await clientsStore.get(g1Key, { type: 'json' }).catch(() => null);
      if (g1Client) {
        g1Client.companies = Array.isArray(g1Client.companies) ? g1Client.companies : [];
        const norm = entityName.toLowerCase().replace(/\s+/g, ' ').trim();
        const already = g1Client.companies.some((co) => co && String(co.name || '').toLowerCase().replace(/\s+/g, ' ').trim() === norm);
        if (!already) {
          g1Client.companies.push({
            id:   'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
            name: entityName,
            ein:  String(body.entityEin || '').trim(),
            createdAt: now,
          });
          g1Client.updatedAt = now;
          // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
          await writeClient(ownerKey, g1Client, { clientsStore });
        }
      }
    }
  }

  // Clear the pending flag; the loan now has borrower info.
  loan._borrowerInfoPending = false;
  loan._brokerBorrowerCapturedAt = now;
  loan._brokerBorrowerCapturedBy = user.email || '';
  loan.updatedAt = now;

  // Audit note.
  const meta = (user && user.user_metadata) || {};
  const authorName = meta.full_name || meta.fullName || user.email || '';
  appendNoteEntry(loan, {
    kind:  'status',
    text:  'Borrower info captured for broker loan (' + createdOrLinked.length + ' guarantor' + (createdOrLinked.length === 1 ? '' : 's') + ').' +
           (entityName ? ' Vesting: ' + entityName + '.' : ''),
    author: authorName,
    authorEmail: user.email || '',
    meta: { via: 'broker_borrower_capture', guarantors: createdOrLinked, entityName },
  });

  primary.loans[loanIdx] = loan;
  primary.updatedAt = now;

  // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
  try { await writeClient(ownerKey, primary, { clientsStore }); }
  catch (e) { return json(500, { error: 'Failed to write primary client: ' + (e && e.message) }); }

  return json(200, { ok: true, loan, guarantors: createdOrLinked });
}
