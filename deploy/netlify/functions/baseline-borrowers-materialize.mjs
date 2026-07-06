/**
 * baseline-borrowers-materialize.mjs — POST /api/baseline-borrowers-materialize
 *
 * Deploy 236.193 — the materialize phase. Reads borrowers cached by
 * baseline-borrowers-fetch (baseline_borrowers_mirror), creates or
 * links SLA clients + attaches LLCs, then reassigns existing loans
 * to the correct borrower record. Should be fast enough for a single
 * call because there's no external I/O — everything is local blobs.
 *
 * Body: { dryRun?: bool (default TRUE) }
 * Auth: admin only.
 *
 * Response: counts + samples + errors (same shape as 236.192).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe,
} from './_shared/auth.mjs';
import { IMPORT_OWNER_KEY, setNativeLink } from './_shared/baseline-upsert.mjs';
import {
  getBorrowerLink, setBorrowerLink,
} from './_shared/baseline-borrowers.mjs';

// Deploy 236.197 — parallel mirror walk. The shared
// listMirroredBorrowers() is serial (~25s for a 250-borrower
// mirror). Same trick used elsewhere: read blobs in parallel with a
// small concurrency ceiling.
const MIRROR_READ_CONCURRENCY = 10;
const WRITE_CONCURRENCY = 10;

async function _walkBorrowerMirrorParallel() {
  const store = getStore({ name: 'baseline_borrowers_mirror', consistency: 'strong' });
  let blobs;
  try { blobs = (await store.list()).blobs || []; }
  catch (_) { return []; }
  const out = [];
  for (let i = 0; i < blobs.length; i += MIRROR_READ_CONCURRENCY) {
    const chunk = blobs.slice(i, i + MIRROR_READ_CONCURRENCY);
    const recs = await Promise.all(chunk.map(({ key }) =>
      store.get(key, { type: 'json' }).catch(() => null),
    ));
    for (const r of recs) if (r) out.push(r);
  }
  return out;
}

function _lower(s) { return String(s || '').trim().toLowerCase(); }
function _isEmpty(v) { return v === undefined || v === null || v === ''; }

// Deploy 236.199 — reverse of baseline-sync's mapMaritalStatus /
// mapCitizenship. Baseline stores title-case display strings ("US
// Citizen"); SLA uses the enum values the profile select expects.
function _reverseCitizenship(v) {
  if (!v) return '';
  const s = String(v).trim().toLowerCase();
  if (s === 'us citizen' || s === 'us_citizen' || s === 'us' || s === 'yes') return 'yes';
  if (s === 'non-us citizen' || s === 'non_us_citizen' || s === 'foreign' || s === 'no') return 'no';
  return '';
}
function _reverseMaritalStatus(v) {
  if (!v) return '';
  const s = String(v).trim().toLowerCase();
  if (s === 'married') return 'married';
  if (s === 'single' || s === 'not married' || s === 'divorced' || s === 'widowed') return 'single';
  return '';
}
function _cleanDob(v) {
  if (!v) return '';
  // Baseline dates come as ISO 8601 or "YYYY-MM-DD". Trim time.
  const m = String(v).match(/(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}
function _cleanFico(v) {
  if (_isEmpty(v)) return '';
  const n = parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : '';
}

// Deploy 236.199 — full field mapping. Returns an object of SLA
// client fields (only the ones we have data for). Callers gap-fill
// or overwrite from this depending on whether the target is a
// native SLA client (gap-fill) or a fresh import stub (overwrite).
function _mapBorrowerToClientFields(b) {
  if (!b) return {};
  return {
    firstName:      String(b.First_Name || '').trim(),
    lastName:       String(b.Last_Name  || '').trim(),
    email:          _lower(b.Email),
    otherEmail:     _lower(b.Other_Email),
    phone:          String(b.Phone || '').trim(),
    phoneSecondary: String(b.Phone_Secondary || '').trim(),
    dob:            _cleanDob(b.Date_Birth || b.DOB),
    fico:           _cleanFico(b.Credit_Score),
    flips:          _isEmpty(b.Num_Flipped) ? '' : String(parseInt(b.Num_Flipped, 10) || ''),
    maritalStatus:  _reverseMaritalStatus(b.Marital_Status),
    usCitizen:      _reverseCitizenship(b.Citizenship),
    homeAddress: {
      street: String(b.Address_Street1 || '').trim(),
      city:   String(b.Address_City    || '').trim(),
      state:  String(b.Address_State   || '').trim(),
      zip:    String(b.Address_Zipcode || b.Address_Zip || '').trim(),
    },
  };
}

// Merge one field-mapping bundle into a target client object.
// Gap-fill semantics: only writes into a target field when the target
// is empty. homeAddress is a nested object — merge each sub-field
// independently so a partial existing address isn't clobbered.
function _gapFillClient(target, mapped) {
  let changed = false;
  const scalars = ['firstName', 'lastName', 'email', 'otherEmail', 'phone', 'phoneSecondary',
                    'dob', 'fico', 'flips', 'maritalStatus', 'usCitizen'];
  for (const k of scalars) {
    if (_isEmpty(target[k]) && !_isEmpty(mapped[k])) { target[k] = mapped[k]; changed = true; }
  }
  if (mapped.homeAddress) {
    if (!target.homeAddress || typeof target.homeAddress !== 'object') target.homeAddress = {};
    for (const k of ['street', 'city', 'state', 'zip']) {
      if (_isEmpty(target.homeAddress[k]) && !_isEmpty(mapped.homeAddress[k])) {
        target.homeAddress[k] = mapped.homeAddress[k];
        changed = true;
      }
    }
  }
  return changed;
}
function _isPerson(b) {
  if (!b) return false;
  if (b.Is_Company === true)  return false;
  if (b.Is_Company === false) return true;
  return !!(b.First_Name || b.Last_Name);
}
function _isEntity(b) {
  if (!b) return false;
  return b.Is_Company === true || (!b.First_Name && !b.Last_Name && !!b.Name);
}
function _linkedBorrowerIds(entity) {
  const out = [];
  const arrays = [entity.Guarantor_Ids, entity.guarantors, entity.linked_borrowers,
                  entity.Borrowers, entity.borrowers, entity.connections];
  for (const arr of arrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object' && item.Id) out.push(item.Id);
    }
  }
  return Array.from(new Set(out));
}
function _normLlc(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(llc|l\.l\.c\.|inc|incorporated|corporation|corp|ltd|limited|co)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-borrowers-materialize error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;
  // Deploy 236.202 — Mike's ask: focus on getting borrowers into
  // SLA as clients with full field mapping; he'll handle loan
  // assignment manually. Phase 4 (loan reassignment) is opt-in from
  // now on. The default flow is Phase 1-3: fetch → people → LLCs.
  const linkLoans = body.linkLoans === true;
  const now = new Date().toISOString();
  const errors = [];

  // ── Load Baseline mirror + all clients + all borrower links ──
  const borrowers = await _walkBorrowerMirrorParallel();

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let blobs;
  try { blobs = (await clientsStore.list()).blobs || []; }
  catch (e) { return json(500, { error: 'clients list failed: ' + (e && e.message) }); }

  const clientsByKey = new Map();
  for (let i = 0; i < blobs.length; i += 10) {
    const chunk = blobs.slice(i, i + 10);
    const results = await Promise.all(chunk.map(async ({ key }) => {
      const slash = key.indexOf('/');
      if (slash < 0) return null;
      const ownerKey = key.slice(0, slash);
      const clientId = key.slice(slash + 1);
      const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
      if (!client) return null;
      return { key, ownerKey, clientId, client };
    }));
    for (const r of results) if (r) clientsByKey.set(r.key, r);
  }

  // Preload all borrower links into memory so per-loan lookups
  // don't hit the store.
  const linkStore = getStore({ name: 'baseline_borrower_link', consistency: 'strong' });
  const linkMap = new Map(); // baselineId -> { ownerKey, clientId, companyId? }
  try {
    const listed = (await linkStore.list()).blobs || [];
    for (let i = 0; i < listed.length; i += 10) {
      const chunk = listed.slice(i, i + 10);
      const results = await Promise.all(chunk.map(async ({ key }) => ({
        key, value: await linkStore.get(key, { type: 'json' }).catch(() => null),
      })));
      for (const { key, value } of results) if (value) linkMap.set(key, value);
    }
  } catch (_) {}

  // Email index for matching Baseline people to existing SLA clients.
  const clientsByEmail = new Map();
  for (const e of clientsByKey.values()) {
    const email = _lower(e.client && e.client.email);
    if (!email) continue;
    const existing = clientsByEmail.get(email);
    const eIsImport = e.ownerKey === IMPORT_OWNER_KEY;
    const xIsImport = existing && existing.ownerKey === IMPORT_OWNER_KEY;
    if (!existing || (xIsImport && !eIsImport)) clientsByEmail.set(email, e);
  }

  // Queue of (borrowerId, link) writes deferred to the end so we
  // can fan them out in parallel batches instead of one-at-a-time.
  const linkWrites = [];

  // ── Phase 2: Materialize People ──────────────────────────────
  let peopleLinked = 0, peopleCreated = 0, peopleGapFilled = 0;
  const peopleSamples = [];
  const personBorrowersById = new Map();

  for (const b of borrowers) {
    if (!_isPerson(b)) continue;
    const id = b && b.Id;
    if (!id) continue;
    personBorrowersById.set(String(id), b);

    const email = _lower(b.Email);
    const first = String(b.First_Name || '').trim();
    const last  = String(b.Last_Name  || '').trim();

    const existingLink = linkMap.get(String(id));
    let target = null;
    if (existingLink && existingLink.ownerKey && existingLink.clientId) {
      target = clientsByKey.get(existingLink.ownerKey + '/' + existingLink.clientId) || null;
    }
    if (!target && email && clientsByEmail.has(email)) {
      target = clientsByEmail.get(email);
    }

    // Deploy 236.199 — full field mapping (not just email + phone).
    const mapped = _mapBorrowerToClientFields(b);

    if (target) {
      const changed = _gapFillClient(target.client, mapped);
      target.client._baselineBorrowerId = id;
      target.client.updatedAt = now;
      target._dirty = true;
      const linkVal = { ownerKey: target.ownerKey, clientId: target.clientId, source: 'match' };
      linkMap.set(String(id), linkVal);
      if (!dryRun) linkWrites.push({ id, link: linkVal });
      peopleLinked++;
      if (changed) peopleGapFilled++;
    } else {
      const clientId = 'c_bl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const key = IMPORT_OWNER_KEY + '/' + clientId;
      const displayName = (first + ' ' + last).trim() || email || 'Baseline Borrower';
      const newClient = Object.assign({
        id: clientId,
        displayName,
        createdAt: now, updatedAt: now,
        _baselineBorrowerId: id, _baselineImport: true, _baselineImportedAt: now,
        loans: [], companies: [],
      }, mapped);
      target = { key, ownerKey: IMPORT_OWNER_KEY, clientId, client: newClient, _dirty: true };
      clientsByKey.set(key, target);
      if (email) clientsByEmail.set(email, target);
      peopleCreated++;
      const linkVal = { ownerKey: IMPORT_OWNER_KEY, clientId, source: 'new' };
      linkMap.set(String(id), linkVal);
      if (!dryRun) linkWrites.push({ id, link: linkVal });
    }
    if (peopleSamples.length < 20) {
      peopleSamples.push({
        baselineId: id,
        name: (first + ' ' + last).trim() || '—',
        email: email || '—',
        ownerKey: target.ownerKey,
        clientId: target.clientId,
        action: existingLink ? 'linked' : (target.client.createdAt === now ? 'created' : 'matched'),
      });
    }
  }

  // ── Phase 3: Materialize Entities ────────────────────────────
  let llcsAttached = 0;
  const llcSamples = [];
  for (const b of borrowers) {
    if (!_isEntity(b)) continue;
    const id = b && b.Id;
    if (!id) continue;
    const linkedPersonIds = _linkedBorrowerIds(b);
    if (!linkedPersonIds.length) continue;
    const entityName = String(b.Name || '').trim();
    if (!entityName) continue;
    const state = String(b.Address_State || '').trim();
    const norm  = _normLlc(entityName);

    for (const personId of linkedPersonIds) {
      const link = linkMap.get(String(personId));
      if (!link) continue;
      const target = clientsByKey.get(link.ownerKey + '/' + link.clientId);
      if (!target) continue;
      target.client.companies = Array.isArray(target.client.companies) ? target.client.companies : [];
      let existing = target.client.companies.find((co) => _normLlc(co && co.name) === norm);
      // Deploy 236.199 — pull every entity field Baseline gives us
      // (name, formation state, address, EIN via Custom_Fields.Tax_ID).
      const entityFields = {
        name:      entityName,
        state:     state, // formation/jurisdiction (also used as fallback for addrState)
        ein:       String((b.Tax_ID || (b.Custom_Fields && b.Custom_Fields.Tax_ID) || '')).trim(),
        address:   String(b.Address_Street1 || '').trim(),
        city:      String(b.Address_City    || '').trim(),
        addrState: String(b.Address_State   || state || '').trim(),
        zip:       String(b.Address_Zipcode || b.Address_Zip || '').trim(),
      };
      if (!existing) {
        existing = Object.assign({
          id: 'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
          _baselineEntityId: id, _baselineImport: true, createdAt: now,
        }, entityFields);
        target.client.companies.push(existing);
        llcsAttached++;
        if (llcSamples.length < 20) {
          llcSamples.push({ baselineId: id, entityName, attachedTo: target.clientId, ownerKey: target.ownerKey });
        }
      } else {
        // Gap-fill any missing fields on the existing company entry.
        if (!existing._baselineEntityId) existing._baselineEntityId = id;
        for (const k of ['state', 'ein', 'address', 'city', 'addrState', 'zip']) {
          if (_isEmpty(existing[k]) && !_isEmpty(entityFields[k])) existing[k] = entityFields[k];
        }
      }
      target.client.updatedAt = now;
      target._dirty = true;
      const linkVal = { ownerKey: target.ownerKey, clientId: target.clientId, companyId: existing.id, source: 'entity connect' };
      linkMap.set(String(id), linkVal);
      if (!dryRun) linkWrites.push({ id, link: linkVal });
    }
  }

  // ── Phase 4: Reassign existing loans (opt-in) ────────────────
  let loansReassigned = 0, loansLlcTagged = 0;
  const reassignSamples = [];
  const nativeLinkWrites = []; // deferred; flushed in parallel below

  if (linkLoans) {
  const allLoansCtx = [];
  for (const entry of clientsByKey.values()) {
    if (!Array.isArray(entry.client.loans)) continue;
    for (const loan of entry.client.loans) allLoansCtx.push({ entry, loan });
  }

  for (const { entry, loan } of allLoansCtx) {
    const raw = loan && loan._baselineRaw;
    if (!raw) continue;
    // Deploy 236.198 — Baseline loan records carry Guarantor_Id
    // (singular — primary person) and Borrower_Id (usually the LLC).
    // Guarantor_1_Id doesn't exist; only Guarantor_1_First_Name/etc.
    // are on the loan, as denormalized display fields.
    const guarantorId = raw.Guarantor_Id || raw.Guarantor_1_Id;
    const borrowerId = raw.Borrower_Id;
    const primaryPersonId = guarantorId
      || (personBorrowersById.has(String(borrowerId)) ? borrowerId : null);
    if (primaryPersonId) {
      const link = linkMap.get(String(primaryPersonId));
      if (link && link.ownerKey && link.clientId) {
        const targetKey = link.ownerKey + '/' + link.clientId;
        if (targetKey !== entry.key) {
          const target = clientsByKey.get(targetKey);
          if (target) {
            const idx = entry.client.loans.findIndex((l) => l && l.id === loan.id);
            if (idx >= 0) entry.client.loans.splice(idx, 1);
            target.client.loans = target.client.loans || [];
            if (!target.client.loans.some((l) => l && l.id === loan.id)) target.client.loans.push(loan);
            loansReassigned++;
            if (reassignSamples.length < 20) {
              reassignSamples.push({ loanId: loan.id, address: loan.address || '', from: entry.key, to: target.key });
            }
            entry._dirty = true;
            target._dirty = true;
            const extId = String(loan._baselineExternalId || (raw && raw.Id) || '').trim();
            if (extId && !dryRun) {
              nativeLinkWrites.push({
                extId,
                link: { ownerKey: target.ownerKey, clientId: target.clientId, loanId: loan.id, source: 'borrower_pull' },
              });
            }
          }
        }
      }
    }
    if (borrowerId && borrowerId !== primaryPersonId) {
      const el = linkMap.get(String(borrowerId));
      if (el && el.companyId && loan.companyId !== el.companyId) {
        loan.companyId = el.companyId;
        loansLlcTagged++;
        entry._dirty = true;
      }
    }
  }
  } // end if (linkLoans)

  if (!dryRun) {
    // Deploy 236.197 — parallelize the final persist. Serial writes
    // of ~100+ dirty clients pushed us past the timeout even after
    // the mirror walk got fast.
    // First, flush deferred borrower-link writes in parallel batches.
    for (let i = 0; i < linkWrites.length; i += WRITE_CONCURRENCY) {
      const chunk = linkWrites.slice(i, i + WRITE_CONCURRENCY);
      await Promise.all(chunk.map((w) =>
        setBorrowerLink(w.id, w.link).catch((e) =>
          errors.push({ phase: 'link write', id: w.id, error: (e && e.message) || 'unknown' })),
      ));
    }
    // Then native-link writes for reassigned loans.
    for (let i = 0; i < nativeLinkWrites.length; i += WRITE_CONCURRENCY) {
      const chunk = nativeLinkWrites.slice(i, i + WRITE_CONCURRENCY);
      await Promise.all(chunk.map((w) =>
        setNativeLink(w.extId, w.link).catch((e) =>
          errors.push({ phase: 'native link', extId: w.extId, error: (e && e.message) || 'unknown' })),
      ));
    }
    // Then the dirty client writes.
    const dirty = [];
    for (const entry of clientsByKey.values()) if (entry._dirty) dirty.push(entry);
    for (let i = 0; i < dirty.length; i += WRITE_CONCURRENCY) {
      const chunk = dirty.slice(i, i + WRITE_CONCURRENCY);
      await Promise.all(chunk.map(async (entry) => {
        try {
          if (entry.ownerKey === IMPORT_OWNER_KEY &&
              (!entry.client.loans || entry.client.loans.length === 0) &&
              (!entry.client.companies || entry.client.companies.length === 0) &&
              !entry.client._baselineBorrowerId) {
            await clientsStore.delete(entry.key);
            return;
          }
          entry.client.updatedAt = now;
          await clientsStore.setJSON(entry.key, entry.client);
        } catch (e) {
          errors.push({ phase: 'final persist', key: entry.key, error: (e && e.message) || 'unknown' });
        }
      }));
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    linkLoans,
    mirrorCount: borrowers.length,
    people:   { linked: peopleLinked, created: peopleCreated, gapFilled: peopleGapFilled, samples: peopleSamples },
    entities: { attached: llcsAttached, samples: llcSamples },
    loans:    { reassigned: loansReassigned, llcTagged: loansLlcTagged, samples: reassignSamples, skipped: !linkLoans },
    errorCount: errors.length,
    errors: errors.slice(0, 20),
  });
}
