/**
 * broker-link.mjs — server-side broker entity find-or-create
 *
 * Deploy 236.5 (Brokers Phase 3b). Removes the "user has to remember
 * to use the picker" failure mode. Any save endpoint that processes
 * a loan record can call linkOrCreateBroker() to ensure a brokerId
 * is set whenever there's enough broker info to resolve to an entity.
 *
 * Resolution order:
 *   1. If incoming brokerId is set AND points to an existing record
 *      in this owner's book, return it. (No-op fast path.)
 *   2. If incoming brokerId is set but DANGLING (no matching record),
 *      treat as if it weren't set — fall through to email search.
 *   3. If brokerEmail is set, find the first record with a matching
 *      email (case-insensitive). Return it.
 *   4. If brokerName is set AND brokerPhone is set, find a record
 *      with matching name + phone digits. (Name-only is too lossy.)
 *   5. If no match found AND we have a brokerName, create a fresh
 *      record using the same id/key shape as brokers-save.mjs.
 *   6. Otherwise return null (no enough data — leave the loan as
 *      a pre-Phase-2-style inline-only broker reference).
 *
 * Called from:
 *   - loan-update-from-sizer.mjs (direct-update path)
 *   - clients-save.mjs (legacy upsert path; walks all loans)
 *   - prospects-save.mjs (Phase 3c — when broker mode is selected on
 *     apply.html the prospect carries broker fields, and on claim we
 *     materialize them into the broker book)
 *
 * Never throws — returns null on any internal error so the surrounding
 * save flow stays unblocked. Auto-linking is a convenience, not a
 * correctness requirement.
 */
import { getStore } from '@netlify/blobs';
import { keySafe } from './auth.mjs';

// Digits-only phone normalize for fallback matching
function phoneDigits(s) {
  return String(s || '').replace(/\D/g, '');
}

/**
 * @param {string} ownerKey   keySafe(loEmail) — the brokers store namespace
 * @param {object} loan       loan record-shaped object with broker fields:
 *                            { brokerId?, brokerName?, brokerCompany?,
 *                              brokerEmail?, brokerPhone? }
 * @returns {Promise<{ id, created, broker } | null>}
 */
export async function linkOrCreateBroker(ownerKey, loan) {
  if (!ownerKey || !loan) return null;
  const incomingId    = String(loan.brokerId    || '').trim();
  const incomingName  = String(loan.brokerName  || '').trim();
  const incomingComp  = String(loan.brokerCompany || '').trim();
  const incomingEmail = String(loan.brokerEmail || '').toLowerCase().trim();
  const incomingPhone = phoneDigits(loan.brokerPhone || '');

  // No broker data at all → nothing to do.
  if (!incomingId && !incomingName && !incomingEmail) return null;

  const store = getStore({ name: 'brokers', consistency: 'strong' });
  const prefix = ownerKey + '/';

  // Fast path: existing brokerId, verify it resolves in this owner's book.
  if (incomingId) {
    try {
      const direct = await store.get(prefix + keySafe(incomingId), { type: 'json' });
      if (direct && direct.id === incomingId) {
        return { id: direct.id, created: false, broker: direct };
      }
    } catch (_) { /* fall through to search */ }
  }

  // List the owner's broker book once for the search paths below.
  let allBrokers = [];
  try {
    const { blobs } = await store.list({ prefix });
    allBrokers = (await Promise.all(
      blobs.map(({ key }) => store.get(key, { type: 'json' }).catch(() => null)),
    )).filter(Boolean);
  } catch (e) {
    console.warn('broker-link: list failed (continuing without auto-link):', e && e.message);
    return null;
  }

  // Email match (case-insensitive). Strongest signal so it wins outright.
  if (incomingEmail) {
    const byEmail = allBrokers.find((b) =>
      String(b.email || '').toLowerCase().trim() === incomingEmail,
    );
    if (byEmail) return { id: byEmail.id, created: false, broker: byEmail };
  }

  // Name + phone fallback. Useful when an LO typed in a broker without
  // an email (some brokers only share phone). Name alone is too lossy
  // (collisions on common names) — require phone digits to agree too.
  if (incomingName && incomingPhone) {
    const byNamePhone = allBrokers.find((b) =>
      String(b.name || '').trim().toLowerCase() === incomingName.toLowerCase() &&
      phoneDigits(b.phone) === incomingPhone,
    );
    if (byNamePhone) return { id: byNamePhone.id, created: false, broker: byNamePhone };
  }

  // No existing match — create one if we have a name to put on it.
  if (!incomingName) return null;
  const now = new Date().toISOString();
  const newId = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const record = {
    id:        newId,
    name:      incomingName,
    company:   incomingComp,
    email:     incomingEmail,
    phone:     loan.brokerPhone ? String(loan.brokerPhone).trim() : '',
    notes:     '',
    createdAt: now,
    updatedAt: now,
    createdBy: ownerKey,   // owner key, not raw email, but readable enough
  };
  try {
    await store.setJSON(prefix + keySafe(newId), record);
    return { id: newId, created: true, broker: record };
  } catch (e) {
    console.warn('broker-link: auto-create failed (continuing without link):', e && e.message);
    return null;
  }
}
