/**
 * sizer-save-loan.mjs — POST /api/sizer-save-loan
 *
 * Unified sizer save. Replaces the four-branch decision tree that
 * lived in dscr-sizer.html + rtl-sizer.html:
 *
 *   OLD:
 *     if (hasDirectIds)                → updateLoanDirect
 *     else if (_editingClientId only)  → createLoanOnClient
 *     else if (isBrokerDeal+email)     → Clients.upsert (broker)
 *     else if (borrowerEmail)          → Clients.upsert (borrower)
 *     else                             → silently do nothing (orphan quote)
 *
 * The silent-fallthrough was the source of the "⚠ Loan record
 * missing — open Sizer to fix" orphan quotes that had been
 * accumulating in Pipeline's Quoted column: quote got saved, loan
 * write silently no-op'd, resulting card had no clickable loan.
 *
 * This endpoint resolves the target using ALL available hints in a
 * defined priority order, always ends with a real loan record (or a
 * clear 400 error), and does the pg-mirror + index write-through
 * atomically with the blob write.
 *
 * Body:
 *   {
 *     toolType: 'dscr' | 'rtl',      required (used for prospect-loan match)
 *     loan: { ... },                 required — the loanRecord from
 *                                    ClientBook.buildLoanFromSizer
 *     borrower?: { firstName, lastName, email, phone },
 *     broker?:   { firstName, lastName, email, phone },
 *     prospectId?: 'p_...',          if the quote came from a prospect
 *     editingClientId?: 'c_...',     if the sizer already knows the target
 *     editingLoanId?: 'l_...',       if editing an existing loan
 *     owner?: 'other@lo.com',        admin cross-LO override
 *   }
 *
 * Resolution order (first match wins):
 *   1. editingClientId + editingLoanId → UPDATE in place on that client
 *   2. editingClientId only            → APPEND a fresh loan to that client
 *   3. prospectId                      → read prospect, use its
 *                                        (broker|borrower) email to find
 *                                        the auto-created client + loan,
 *                                        then UPDATE that loan
 *   4. broker.email                    → find broker client by email,
 *                                        create if missing, APPEND loan
 *   5. borrower.email                  → find borrower client by email,
 *                                        create if missing, APPEND loan
 *   6. nothing usable                  → 400 with a clear message
 *
 * Response:
 *   { ok: true, clientId, loanId, targetPath, clientCreated, loanCreated }
 *
 * Never silently produces an orphan quote.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { linkOrCreateBroker } from './_shared/broker-link.mjs';
// Deploy 236.401 (Phase C2): all store writes route through the
// shared writeClient helper — PG-first, atomic RPC, strict on every
// mirror. Sizer save is the highest-traffic write; failures surface
// as 500s (→ LO toast + Slack alert), and a DB rejection leaves NO
// store mutated.
import { writeClient } from './_shared/client-write.mjs';

const CALLER_CANNOT_SET_ON_LOAN = ['id', 'createdAt'];

function _newId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function _newLoanId()   { return _newId('l'); }
function _newClientId() { return _newId('c'); }

function _normEmail(s) { return String(s || '').trim().toLowerCase(); }

function _sanitizedLoan(incoming, existing) {
  const out = Object.assign({}, incoming);
  for (const k of CALLER_CANNOT_SET_ON_LOAN) delete out[k];
  delete out._editingClientId;
  delete out._editingLoanId;
  if (existing && existing.id) out.id = existing.id;
  if (existing && existing.createdAt) out.createdAt = existing.createdAt;
  return out;
}

// Best-effort: find a client under `ownerKey` whose email matches `email`.
// Returns { key, record } or null. Case-insensitive on email.
async function _findClientByEmail(clientsStore, ownerKey, email) {
  if (!email) return null;
  const wanted = _normEmail(email);
  try {
    const { blobs } = await clientsStore.list({ prefix: ownerKey + '/' });
    for (const { key } of blobs) {
      const rec = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!rec) continue;
      if (_normEmail(rec.email) === wanted) return { key, record: rec };
    }
  } catch (_) {}
  return null;
}

// Create a fresh client blob with just the contact info. Used when
// the broker/borrower isn't already in the store.
function _makeNewClient({ firstName, lastName, email, phone, createdBy }) {
  const now = new Date().toISOString();
  return {
    id:         _newClientId(),
    firstName:  String(firstName || '').trim(),
    lastName:   String(lastName || '').trim(),
    email:      _normEmail(email),
    phone:      String(phone || '').trim(),
    companies:  [],
    loans:      [],
    createdAt:  now,
    updatedAt:  now,
    createdBy:  createdBy || '',
  };
}

async function _writeClient(clientsStore, ownerKey, client, opts) {
  // Deploy 236.401 (Phase C2): PG-first via the shared writeClient
  // helper — Postgres is the write authority; a DB rejection (CHECK
  // constraint, demotion trigger, outage) throws before blob/index/
  // quote-store mutate. Order used to be blob-first, which left blob
  // newer than PG whenever PG said no.
  await writeClient(ownerKey, client, {
    clientsStore,
    loanForQuoteSync: opts && opts.loanForQuoteSync,
  });
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('sizer-save-loan error:', e);
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
  if (!body.loan || typeof body.loan !== 'object') return json(400, { error: 'loan required' });
  const toolType = String(body.toolType || '').toLowerCase();
  if (toolType !== 'dscr' && toolType !== 'rtl' && toolType !== 'guc') {
    return json(400, { error: 'toolType must be dscr, rtl, or guc' });
  }

  const selfEmail = normalizeEmail(user.email);
  const selfKey   = keySafe(selfEmail);
  let ownerKey;
  if (body.owner && body.owner !== selfEmail && body.owner !== selfKey) {
    if (!canOverrideOwner(user).ok) return json(403, { error: 'Owner override requires admin or processor' });
    ownerKey = keySafe(normalizeEmail(body.owner));
  } else {
    ownerKey = selfKey;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const now = new Date().toISOString();
  const borrower = body.borrower || {};
  const broker   = body.broker   || null;
  const brokerEmail   = _normEmail(broker && broker.email);
  const borrowerEmail = _normEmail(borrower.email);
  const authorEmail   = user.email || '';
  const authorName    = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.fullName)) || authorEmail;

  let client = null;
  let clientKey = null;
  let existingLoan = null;
  let targetPath = null;
  let clientCreated = false;
  let loanCreated = false;

  // ── 1. Direct-ID UPDATE ─────────────────────────────────────────
  if (body.editingClientId && body.editingLoanId) {
    clientKey = ownerKey + '/' + keySafe(body.editingClientId);
    client = await clientsStore.get(clientKey, { type: 'json' }).catch(() => null);
    if (client && Array.isArray(client.loans)) {
      existingLoan = client.loans.find((l) => l && l.id === body.editingLoanId) || null;
    }
    if (client && existingLoan) targetPath = 'update';
    // Fall through if either miss — the resolver below will try
    // other paths rather than 404. Common case: LO opened a sizer
    // with stale editing IDs; new save flow silently upgrades to
    // append or upsert.
  }

  // ── 2. Direct clientId APPEND ───────────────────────────────────
  if (!client && body.editingClientId) {
    clientKey = ownerKey + '/' + keySafe(body.editingClientId);
    client = await clientsStore.get(clientKey, { type: 'json' }).catch(() => null);
    if (client) targetPath = 'append-to-client';
  }

  // ── 3. Prospect → auto-created loan lookup ──────────────────────
  if (!client && body.prospectId) {
    const prospectsStore = getStore({ name: 'prospects', consistency: 'strong' });
    // Prospects are also owner-scoped. Walk this owner's prospects
    // for the id — cheaper than full store.list().
    let prospect = null;
    try {
      const { blobs } = await prospectsStore.list({ prefix: ownerKey + '/' });
      for (const { key } of blobs) {
        if (!key.endsWith('/' + keySafe(body.prospectId))) continue;
        prospect = await prospectsStore.get(key, { type: 'json' }).catch(() => null);
        if (prospect) break;
      }
    } catch (_) {}
    if (prospect) {
      // Broker submits: match on broker email. Borrower submits: match on borrower email.
      const pIsBroker = String(prospect.submitterType || '').toLowerCase() === 'broker'
        || !!prospect.brokerEmail || !!prospect.brokerName;
      const pLookup = _normEmail(pIsBroker ? prospect.brokerEmail : prospect.email);
      if (pLookup) {
        const hit = await _findClientByEmail(clientsStore, ownerKey, pLookup);
        if (hit) {
          client = hit.record;
          clientKey = hit.key;
          // Priority order for locating the loan on this client:
          //   1. loan.prospectId === body.prospectId — the strongest
          //      signal, unique per prospect. Prevents the "every
          //      save appends a new loan" bug where the LO clicks
          //      Save Quote 5 times and ends up with 5 duplicates
          //      because the fromApplication-only match kept missing.
          //   2. fromApplication + !rate + address match — the
          //      classic auto-created unpriced loan for THIS address.
          //   3. fromApplication + !rate — anywhere on this client.
          //      Weakest signal, kept for old data without prospectId.
          if (Array.isArray(client.loans)) {
            const pAddr = String(prospect.propAddress || '').toLowerCase().trim();
            existingLoan = client.loans.find((l) => l && l.prospectId === body.prospectId)
              || client.loans.find((l) => l && l.fromApplication && !l.rate
                && (!pAddr || String(l.address || '').toLowerCase().trim() === pAddr))
              || client.loans.find((l) => l && l.fromApplication && !l.rate)
              || null;
          }
          targetPath = existingLoan ? 'prospect-update' : 'prospect-append';
        }
      }
    }
  }

  // ── 4. Broker email → find or CREATE broker client ──────────────
  if (!client && brokerEmail) {
    const hit = await _findClientByEmail(clientsStore, ownerKey, brokerEmail);
    if (hit) {
      client = hit.record;
      clientKey = hit.key;
      targetPath = 'broker-append';
    } else {
      client = _makeNewClient({
        firstName: broker.firstName, lastName: broker.lastName,
        email: brokerEmail, phone: broker.phone,
        createdBy: authorEmail,
      });
      client._isBroker = true;
      clientKey = ownerKey + '/' + keySafe(client.id);
      clientCreated = true;
      targetPath = 'broker-create';
    }
  }

  // ── 5. Borrower email → find or CREATE borrower client ──────────
  if (!client && borrowerEmail) {
    const hit = await _findClientByEmail(clientsStore, ownerKey, borrowerEmail);
    if (hit) {
      client = hit.record;
      clientKey = hit.key;
      targetPath = 'borrower-append';
    } else {
      client = _makeNewClient({
        firstName: borrower.firstName, lastName: borrower.lastName,
        email: borrowerEmail, phone: borrower.phone,
        createdBy: authorEmail,
      });
      clientKey = ownerKey + '/' + keySafe(client.id);
      clientCreated = true;
      targetPath = 'borrower-create';
    }
  }

  // ── 6. Nothing to target → clear, actionable error ──────────────
  if (!client) {
    return json(400, {
      error: 'Cannot save loan: no target client. Add borrower email OR broker email OR open the sizer from an existing loan / prospect / client.',
      hint:  'The quote save was refused rather than produce an orphan card on Pipeline.',
    });
  }

  if (!Array.isArray(client.loans)) client.loans = [];

  // ── Merge or append the loan ────────────────────────────────────
  //
  // For status specifically, mirror the preservation rule from
  // loan-update-from-sizer.mjs: never demote a "further along" status
  // (awaiting_app, submitted, approved, denied, closed, cancelled)
  // back to 'active' or 'on_hold' on a sizer re-price. The sizer's
  // buildLoanFromSizer always emits status='active' as its default,
  // so an unguarded merge silently rolls the loan back and Pipeline
  // starts disagreeing with the quote card. Preservation logic:
  //   incoming is 'active' / 'on_hold' → keep prior if further along
  //   incoming is further along → allow the transition
  //   no prior → take incoming (or default to 'active')
  function _resolveStatus(priorStatus, incomingStatus) {
    const isForwarded = (s) => s && s !== 'active' && s !== 'on_hold';
    if (isForwarded(priorStatus) && !isForwarded(incomingStatus)) {
      return priorStatus;
    }
    return incomingStatus || priorStatus || 'active';
  }

  let loanRecord;
  if (existingLoan) {
    // Update in place — merge sanitized incoming onto existing.
    const merged = Object.assign({}, existingLoan, _sanitizedLoan(body.loan, existingLoan));
    merged.status = _resolveStatus(existingLoan.status, body.loan.status);
    merged.updatedAt = now;
    merged.savedAt   = now;
    if (body.prospectId && !merged.prospectId) merged.prospectId = body.prospectId;
    // Replace the loan in the array by id.
    const idx = client.loans.findIndex((l) => l && l.id === existingLoan.id);
    if (idx >= 0) client.loans[idx] = merged;
    else client.loans.push(merged);
    loanRecord = merged;
  } else {
    // Append a fresh loan (backend mints id + createdAt).
    // If a matching quote at the same address already advanced past
    // 'active' (common: apply.html sent → quote.status='awaiting_app'
    // → LO opens sizer to price it → save creates the loan record for
    // the first time), inherit the quote's status so Pipeline stays
    // consistent with Loan Details. Otherwise default to 'active'.
    let inheritedStatus = null;
    try {
      const qStore = getStore({ name: 'quotes', consistency: 'strong' });
      const { blobs: qBlobs } = await qStore.list({ prefix: ownerKey + '/' });
      const wantAddr = String(body.loan.address || '').trim().toLowerCase();
      for (const { key } of qBlobs) {
        const q = await qStore.get(key, { type: 'json' }).catch(() => null);
        if (!q || !q.status) continue;
        const qAddr = String(q.address || (q.formData && q.formData.address) || '').trim().toLowerCase();
        if (qAddr !== wantAddr) continue;
        // Only inherit if the quote's status is "further along" than
        // the sizer's default ('active'). Prevents pulling in an old
        // closed/cancelled quote's status for a brand-new loan.
        if (q.status !== 'active' && q.status !== 'on_hold') {
          inheritedStatus = q.status;
          break;
        }
      }
    } catch (_) { /* non-fatal — fall back to default */ }

    const fresh = Object.assign({}, _sanitizedLoan(body.loan, null), {
      id:        _newLoanId(),
      createdAt: now,
      updatedAt: now,
      savedAt:   now,
      status:    inheritedStatus || body.loan.status || 'active',
    });
    if (body.prospectId) fresh.prospectId = body.prospectId;
    client.loans.push(fresh);
    loanRecord = fresh;
    loanCreated = true;
  }

  client.updatedAt = now;

  // Audit note on the loan.
  try {
    appendNoteEntry(loanRecord, {
      kind:  'status',
      text:  loanCreated
        ? 'Loan created via sizer (' + targetPath + ')'
        : 'Loan updated via sizer (' + targetPath + ')',
      author:      authorName,
      authorEmail,
      meta: { via: 'sizer_save_loan', targetPath, clientId: client.id },
    });
  } catch (_) {}

  // Auto-link broker if inline broker fields are set but no brokerId
  // (same logic loan-update-from-sizer uses).
  try {
    await linkOrCreateBroker(ownerKey, loanRecord);
  } catch (e) {
    console.warn('sizer-save-loan: broker-link non-fatal:', e && e.message);
  }

  try {
    await _writeClient(clientsStore, ownerKey, client, { loanForQuoteSync: loanRecord });
  } catch (e) {
    return json(500, { error: 'Failed to write client record: ' + (e.message || 'unknown') });
  }

  // Response shape includes `client` and `loan` so it's a drop-in
  // replacement for both Clients.upsert (returned resp.client) and
  // updateLoanDirect (returned resp.loan). handleSaveSuccess in the
  // sizers uses both paths; matching the shape means no per-endpoint
  // adapters in the frontend.
  return json(200, {
    ok:            true,
    client,
    loan:          loanRecord,
    clientId:      client.id,
    loanId:        loanRecord.id,
    ownerKey,
    targetPath,
    clientCreated,
    loanCreated,
  });
}
