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
import { findClientByEmail } from './_shared/client-lookup.mjs'; // Deploy 236.418

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
// Deploy 236.418 — was a sequential walk of the owner's entire client
// book; now the shared indexed PG lookup (see _shared/client-lookup.mjs).
async function _findClientByEmail(clientsStore, ownerKey, email) {
  const hit = await findClientByEmail(ownerKey, email, clientsStore);
  return hit ? { key: hit.key, record: hit.client } : null;
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

async function _writeClient(clientsStore, ownerKey, client) {
  // Deploy 236.401 (Phase C2): PG-first via the shared writeClient
  // helper — Postgres is the write authority; a DB rejection (CHECK
  // constraint, demotion trigger, outage) throws before blob/index/
  // quote-store mutate. Order used to be blob-first, which left blob
  // newer than PG whenever PG said no.
  // Deploy 236.426 (D3): quote sweep retired — /api/quotes renders from
  // loans (D2), so store copies no longer need freshening. The
  // loanForQuoteSync option is gone with it.
  await writeClient(ownerKey, client, { clientsStore });
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

  const user = await requireAuth(context, req);
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
    // Deploy 236.761 — preservation on THIS path (the live one). The 236.759
    // preservation landed only in loan-update-from-sizer.mjs, which the
    // sizers now use solely as a legacy fallback — so every real sizer save
    // still wiped application-sourced fields the posting sizer has no
    // inputs for (buildLoanFromSizer emits '' for them): the MF sizer has
    // no taxes/insurance/hoa/rentalType/fundingDate/usCitizen inputs, the
    // DSCR sizer no purchasePrice/fundingDate, etc. Empty-in keeps prior.
    // Trade-off (accepted, mirrors Deploy 228/192 semantics): a sizer
    // can't CLEAR these fields to blank — clear them from Loan Details.
    const PRESERVE_ON_EMPTY = [
      'bedrooms', 'bathrooms', 'sqft', 'notes', 'projectDescription',
      'fundingDate', 'purchasePrice', 'rentalType', 'usCitizen', 'creditScore',
    ];
    // Monthly T/I/HOA: the 1-4 DSCR sizer HAS these inputs (a blank there
    // is a legitimate clear); the MF sizer doesn't (its save always posts
    // '' — the values live in the annual opex set). Preserve only for MF.
    if (body.loan && body.loan.mfProgram) PRESERVE_ON_EMPTY.push('taxes', 'insurance', 'hoa');
    for (const k of PRESERVE_ON_EMPTY) {
      if ((merged[k] === '' || merged[k] == null) && existingLoan[k]) merged[k] = existingLoan[k];
    }
    // MF program marker + NCF operating-statement fields: a save from a
    // sizer that doesn't collect them must not strip them.
    if (!merged.mfProgram && existingLoan.mfProgram) merged.mfProgram = existingLoan.mfProgram;
    const MF_PRESERVE = ['numUnits', 'unitsOccupied', 'otherIncomeMo', 'vacancyPct',
      'opexTaxes', 'opexInsurance', 'opexFlood', 'opexUtilities', 'opexRepairs',
      'opexMgmt', 'opexHOA', 'opexLandscaping'];
    for (const k of MF_PRESERVE) {
      if ((merged[k] === '' || merged[k] == null) && existingLoan[k] != null && existingLoan[k] !== '') {
        merged[k] = existingLoan[k];
      }
    }
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
    // Deploy 236.425 (D3) — the quote-status inherit walk is gone. It
    // existed for the era when a deal's status could live on a QUOTE
    // record that predated its loan (apply-flow quotes). Post-D1/D2
    // the loan IS the record: apply-flow deals get their loan (with
    // status) created by upsertClientFromProspect before any sizer
    // save, so a genuinely brand-new loan here has no prior status to
    // inherit. The walk was also the last owner-book scan in the save
    // path (the 504 family).
    let inheritedStatus = null;

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

  // Auto-link broker if inline broker fields are set.
  // Deploy 236.451 — STAMP the resolved brokerId back onto the loan
  // (this endpoint previously ignored the return, so the loan never got
  // the link — and a dangling incoming brokerId survived to violate the
  // FK). broker-link now returns a live broker-CLIENT id (236.450), so
  // stamping it makes loan.broker_id resolve and the link persist.
  // Mirrors loan-update-from-sizer's pattern.
  try {
    if (loanRecord && (loanRecord.brokerName || loanRecord.brokerEmail || loanRecord.brokerId)) {
      // Deploy 236.452 — when the loan's PARENT client IS the broker (a
      // broker-submitted deal: the client resolution above matches/
      // creates from the broker email FIRST and flags it _isBroker), the
      // broker already IS the client holding the loan. Point brokerId at
      // that client and DON'T create a SECOND broker record — that
      // duplicate (an empty broker-client alongside the loan-bearing
      // client, same email, both is_broker) is exactly what Mike saw.
      if (client && client._isBroker && brokerEmail && _normEmail(client.email) === brokerEmail) {
        loanRecord.brokerId = client.id;
      } else {
        const linked = await linkOrCreateBroker(ownerKey, loanRecord);
        if (linked && linked.id) {
          loanRecord.brokerId = linked.id;
          const b = linked.broker || {};
          if (b.name)    loanRecord.brokerName    = b.name;
          if (b.company) loanRecord.brokerCompany = b.company;
          if (b.email)   loanRecord.brokerEmail   = b.email;
          if (b.phone)   loanRecord.brokerPhone   = b.phone;
        } else {
          // No broker resolved/created (e.g. name-only, or a transient
          // failure). Drop any incoming brokerId so a stale/dangling
          // pointer can't reach the FK. Inline broker fields are kept.
          loanRecord.brokerId = '';
        }
      }
    }
  } catch (e) {
    console.warn('sizer-save-loan: broker-link non-fatal:', e && e.message);
  }

  // Deploy 236.431 — sizerHistory[] append, ported from
  // loan-update-from-sizer.mjs (236.255-257). The unified endpoint
  // (7/21) consolidated every sizer save path but never inherited the
  // history append, so the Sizer History panel silently stopped
  // recording — AND the raw _sizerFormData payload (meant to be
  // consumed into the snapshot then stripped) was persisting whole on
  // every loan record. Snapshot from loanRecord AFTER all merge +
  // broker-link logic so history reflects what actually persisted.
  // Capped at 50 entries (~1KB each) per the original design.
  const PREPAY_LABEL = {
    '5y6m':  '5Yr/6Mo', '54321': '5-Year', '321': '3-Year',
    '320':   '2-Year',  '300':   '1-Year', 'none': 'None',
  };
  const priorHistory = Array.isArray(loanRecord.sizerHistory) ? loanRecord.sizerHistory : [];
  const rawFormData = (loanRecord._sizerFormData && typeof loanRecord._sizerFormData === 'object')
    ? loanRecord._sizerFormData
    : null;
  const snapshotFormData = rawFormData || {
    loanAmt:          loanRecord.loanAmt          || '',
    propValue:        loanRecord.propValue        || '',
    loanType:         loanRecord.loanType         || '',
    fico:             loanRecord.fico             || '',
    rent:             loanRecord.rent             || '',
    taxes:            loanRecord.taxes            || '',
    insurance:        loanRecord.insurance        || '',
    hoa:              loanRecord.hoa              || '',
    prepay:           loanRecord.prepay           || '',
    buydown:          loanRecord.buydown          || '',
    isIO:             loanRecord.isIO             || '',
    loanPurpose:      loanRecord.loanPurpose      || '',
    propType:         loanRecord.propType         || '',
    currentLoanAmt:   loanRecord.currentLoanAmt   || '',
    brokerFee:        loanRecord.brokerFee        || '',
    _rateOverride:    loanRecord._rateOverride    || '',
    _ltvOverride:     loanRecord._ltvOverride     || '',
    _pointsOverride:  loanRecord._pointsOverride  || '',
    _finalRate:       loanRecord._finalRate       || '',
    _points:          loanRecord._points          || '',
  };
  loanRecord.sizerHistory = [{
    savedAt:     now,
    savedBy:     authorEmail,
    loanAmt:     loanRecord.loanAmt     || '',
    rate:        loanRecord.rate        || '',
    points:      loanRecord.points      || '',
    prepay:      loanRecord.prepay      || '',
    prepayLabel: PREPAY_LABEL[String(loanRecord.prepay || '').toLowerCase()] || '',
    formData:    snapshotFormData,
  }].concat(priorHistory).slice(0, 50);
  // Strip the raw payload — the snapshot inside sizerHistory is its
  // persistent home; leaving it inline bloats every record load.
  if (loanRecord._sizerFormData) delete loanRecord._sizerFormData;

  try {
    await _writeClient(clientsStore, ownerKey, client);
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
