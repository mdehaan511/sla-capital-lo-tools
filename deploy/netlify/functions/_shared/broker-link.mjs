/**
 * broker-link.mjs — server-side broker entity find-or-create.
 *
 * Deploy 236.5 (Brokers Phase 3b) — removes the "LO has to remember to
 * use the picker" failure mode: any save endpoint processing a loan
 * calls linkOrCreateBroker() to resolve/create a brokerId whenever
 * there's enough broker info.
 *
 * Deploy 236.450 (THE permanent broker-FK fix) — brokers are now
 * created/looked up as broker-flagged CLIENTS (the `clients` store,
 * PG-mirrored via writeClient), NOT the legacy `brokers` blob store.
 * WHY: Broker Phase A (Deploy 236.224) unified brokers into `clients`
 * (`_isBroker: true`) and Postgres enforces `loans.broker_id references
 * clients(id)`. broker-link was the ONE writer never migrated — it kept
 * minting `b_...` ids in the legacy `brokers` store, which are NOT
 * clients, so every new broker deal's loan write hit
 * loans_broker_id_fkey (500 for the LO; self-healed-to-null by 236.449).
 * Creating the broker as a client makes loan.brokerId resolve, the link
 * persist, and the broker show in the book (brokers-list/brokers-find
 * already read `clients WHERE is_broker`). Same `b_...` id shape as
 * before, so existing loan.brokerId references keep resolving once their
 * broker is a client.
 *
 * Resolution order (all against `clients`):
 *   1. incoming brokerId → live client under this owner (flag it broker
 *      if it's a plain contact stamped on a broker deal).
 *   2. brokerEmail → an existing client (broker or contact) under owner;
 *      gap-fill the broker flag.
 *   3. brokerName + brokerPhone → the owner's broker-flagged clients.
 *   4. else, with a brokerName → create a fresh broker-flagged client.
 *   5. otherwise null (not enough data; loan keeps inline-only broker).
 *
 * Never throws — returns null on any internal error so the save flow
 * stays unblocked (auto-linking is a convenience, not a correctness
 * requirement). The broker-client write is awaited BEFORE the caller
 * writes the borrower loan, so the FK resolves.
 *
 * Called from: loan-update-from-sizer, sizer-save-loan,
 * loan-create-on-client, clients-save, prospects-save.
 */
import { getStore } from '@netlify/blobs';
import { keySafe, normalizeEmail } from './auth.mjs';
import { writeClient } from './client-write.mjs';
import { findClientByEmail } from './client-lookup.mjs';
import { clientAsBroker } from './broker-client.mjs';
import { db } from './supabase-db.mjs';

function phoneDigits(s) { return String(s || '').replace(/\D/g, ''); }

// Same convention as broker-client.splitBrokerName: last token is the
// last name, the rest is the first name.
function splitName(fullName) {
  const s = String(fullName || '').trim().replace(/\s+/g, ' ');
  if (!s) return { firstName: '', lastName: '' };
  const parts = s.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

// Stamp the broker flag on a client that isn't flagged yet (a plain
// contact used on a broker deal). Non-destructive; best-effort write.
async function _ensureFlagged(ownerKey, client, incomingComp, clientsStore) {
  if (client._isBroker) return client;
  client._isBroker = true;
  if (!client._brokerCompany && incomingComp) client._brokerCompany = incomingComp;
  client.updatedAt = new Date().toISOString();
  try { await writeClient(ownerKey, client, { clientsStore }); } catch (_) { /* best-effort */ }
  return client;
}

/**
 * @param {string} ownerKey   keySafe(loEmail) — the clients store namespace
 * @param {object} loan       loan-shaped object with broker fields:
 *                            { brokerId?, brokerName?, brokerCompany?,
 *                              brokerEmail?, brokerPhone? }
 * @returns {Promise<{ id, created, broker } | null>}  broker is the
 *          legacy broker shape ({ name, company, email, phone, ... }) so
 *          callers can backfill the loan's inline broker fields.
 */
export async function linkOrCreateBroker(ownerKey, loan) {
  if (!ownerKey || !loan) return null;
  const incomingId    = String(loan.brokerId      || '').trim();
  const incomingName  = String(loan.brokerName     || '').trim();
  const incomingComp  = String(loan.brokerCompany  || '').trim();
  const incomingEmail = String(loan.brokerEmail    || '').toLowerCase().trim();
  const incomingPhone = phoneDigits(loan.brokerPhone || '');

  // No broker data at all → nothing to do.
  if (!incomingId && !incomingName && !incomingEmail) return null;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  try {
    // 1. Fast path: incoming brokerId → live client under this owner.
    if (incomingId) {
      const rec = await clientsStore.get(ownerKey + '/' + keySafe(incomingId), { type: 'json' }).catch(() => null);
      if (rec && rec.id === incomingId) {
        await _ensureFlagged(ownerKey, rec, incomingComp, clientsStore);
        return { id: rec.id, created: false, broker: clientAsBroker(rec) };
      }
      // dangling id → fall through to search
    }

    // 2. Email match → an existing client (broker or contact) under owner.
    if (incomingEmail) {
      const hit = await findClientByEmail(ownerKey, incomingEmail, clientsStore);
      if (hit && hit.client) {
        await _ensureFlagged(ownerKey, hit.client, incomingComp, clientsStore);
        return { id: hit.client.id, created: false, broker: clientAsBroker(hit.client) };
      }
    }

    // 3. Name + phone fallback → the owner's broker-flagged clients.
    //    Query the small broker set (id + match fields) from PG and match
    //    in JS; fetch only the one matched blob for the authoritative
    //    record. Name alone is too lossy (require phone to agree too).
    if (incomingName && incomingPhone) {
      const rows = await db.select('clients', {
        select: 'id,first_name,last_name,display_name,phone',
        eq: { owner_email: normalizeEmail(ownerKey), is_broker: true },
        limit: 500,
      }).catch(() => null);
      const match = (rows || []).find((r) => {
        const nm = String(r.display_name || ((r.first_name || '') + ' ' + (r.last_name || '')).trim())
          .trim().toLowerCase();
        return nm === incomingName.toLowerCase() && phoneDigits(r.phone) === incomingPhone;
      });
      if (match) {
        const full = await clientsStore.get(ownerKey + '/' + keySafe(match.id), { type: 'json' }).catch(() => null);
        return { id: match.id, created: false, broker: clientAsBroker(full || { id: match.id, displayName: incomingName }) };
      }
    }

    // 4. Create a fresh broker-flagged CLIENT (so loan.broker_id resolves
    //    against the clients FK). Awaited PG-first write completes before
    //    the caller writes the borrower loan.
    if (!incomingName) return null;
    const now = new Date().toISOString();
    const newId = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const { firstName, lastName } = splitName(incomingName);
    const brokerClient = {
      id:            newId,
      firstName,
      lastName,
      email:         incomingEmail,
      phone:         loan.brokerPhone ? String(loan.brokerPhone).trim() : '',
      entityName:    incomingComp,
      displayName:   incomingName,
      notes:         '',
      _isBroker:     true,
      _brokerCompany: incomingComp,
      createdAt:     now,
      updatedAt:     now,
      createdBy:     ownerKey,
      loans:         [],
      companies:     [],
    };
    await writeClient(ownerKey, brokerClient, { clientsStore });
    return { id: newId, created: true, broker: clientAsBroker(brokerClient) };
  } catch (e) {
    console.warn('broker-link: link/create failed (continuing without link):', e && e.message);
    return null;
  }
}
