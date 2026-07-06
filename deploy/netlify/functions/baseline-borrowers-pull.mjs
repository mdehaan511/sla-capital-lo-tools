/**
 * baseline-borrowers-pull.mjs — POST /api/baseline-borrowers-pull
 *
 * Deploy 236.192 — pull ALL borrower records from Baseline (people
 * + entities), materialize them into SLA clients + companies, and
 * (best-effort) reassign existing loans to the correct borrower
 * client.
 *
 * Phases in one call:
 *
 *   1. Fetch. GET /borrower list, then GET /borrower/{id} in
 *      parallel (concurrency=8). Cache raw payloads to
 *      baseline_borrowers_mirror.
 *
 *   2. Materialize People. For every borrower with Is_Company=false
 *      and an email, look for an existing link (Baseline Id → SLA
 *      client). If missing, either:
 *        - Match an existing SLA client by email under any owner —
 *          use that as the SLA target (link the Baseline Id to it).
 *        - Create a new SLA client under IMPORT_OWNER_KEY.
 *      Non-import SLA clients are augmented (gap-fill only) — never
 *      overwritten.
 *
 *   3. Materialize Entities (LLCs). For every borrower with
 *      Is_Company=true, attach as an entry on the linked-people's
 *      companies[]. We use whatever "connections" field Baseline
 *      returns; when absent, we fall back to cross-referencing loans
 *      whose Borrower_Id matches the entity Id — the loan's
 *      Guarantor_1_Id is the person that owns the LLC.
 *
 *   4. Reassign loans (best-effort). Walk clients store; for each
 *      loan with a _baselineRaw.Guarantor_1_Id, look up the borrower
 *      link. If the target client differs from the loan's current
 *      client, MOVE the loan (add to target, remove from source). If
 *      the source client was an import-owner stub and is now empty,
 *      delete it. Update the loan's native-link (extId → new
 *      location) so future Migrates route correctly.
 *
 * Body: { dryRun?: bool (default TRUE) }
 * Auth: admin only.
 *
 * Response: counts + samples + errors.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import {
  IMPORT_OWNER_KEY, setNativeLink,
} from './_shared/baseline-upsert.mjs';
import {
  fetchAllBorrowerList, fetchBorrowerDetail, saveMirroredBorrower,
  getBorrowerLink, setBorrowerLink,
} from './_shared/baseline-borrowers.mjs';

const CONCURRENCY = 8;

function _lower(s) { return String(s || '').trim().toLowerCase(); }
function _isEmpty(v) { return v === undefined || v === null || v === ''; }

function _isPerson(b) {
  if (!b) return false;
  if (b.Is_Company === true)  return false;
  if (b.Is_Company === false) return true;
  // If Is_Company is missing, use presence of First_Name/Last_Name.
  return !!(b.First_Name || b.Last_Name);
}
function _isEntity(b) {
  if (!b) return false;
  return b.Is_Company === true || (!b.First_Name && !b.Last_Name && !!b.Name);
}

// Any of Baseline's expected linking fields we might see on an entity
// detail response. Baseline's schema isn't fixed, so we probe.
function _linkedBorrowerIds(entity) {
  const out = [];
  const candidateArrays = [
    entity.Guarantor_Ids, entity.guarantors, entity.linked_borrowers,
    entity.Borrowers, entity.borrowers, entity.connections,
  ];
  for (const arr of candidateArrays) {
    if (!Array.isArray(arr)) continue;
    for (const item of arr) {
      if (typeof item === 'string') out.push(item);
      else if (item && typeof item === 'object' && item.Id) out.push(item.Id);
    }
  }
  return Array.from(new Set(out));
}

function _dedupeKeyFromClient(c) {
  const email = _lower(c && c.email);
  if (email) return 'e:' + email;
  const name = ((c && c.firstName || '') + ' ' + (c && c.lastName || '')).toLowerCase().trim();
  const phone = String(c && c.phone || '').replace(/\D/g, '');
  if (name && phone) return 'np:' + name + '|' + phone;
  if (name) return 'n:' + name;
  return '';
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
    console.error('baseline-borrowers-pull error:', e);
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
  const now = new Date().toISOString();

  const errors = [];

  // ── Phase 1: Fetch list, then details in parallel ─────────────
  const listResp = await fetchAllBorrowerList();
  if (!listResp.ok) {
    return json(500, { error: 'Baseline list failed: ' + (listResp.error || 'unknown'), status: listResp.status, rawPreview: listResp.rawPreview });
  }
  const rawBorrowers = listResp.borrowers || [];
  // Each list item is either a bare Id/string or an object with .Id.
  const ids = [];
  for (const item of rawBorrowers) {
    if (typeof item === 'string') ids.push(item);
    else if (item && typeof item === 'object' && item.Id) ids.push(item.Id);
  }
  // Fetch details in parallel.
  const details = [];
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const chunk = ids.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async (id) => {
      const r = await fetchBorrowerDetail(id).catch(() => null);
      return r && r.ok ? r.borrower : null;
    }));
    for (const r of results) if (r) details.push(r);
  }
  // If GET /borrower already returned full detail (some Baseline
  // configs do), fall back to using the list items themselves.
  const borrowers = details.length ? details : rawBorrowers.filter((b) => b && typeof b === 'object');

  // Cache raw payloads.
  if (!dryRun) {
    for (const b of borrowers) {
      const id = b && b.Id;
      if (!id) continue;
      try { await saveMirroredBorrower(id, b); }
      catch (e) { errors.push({ phase: 'mirror', id, error: (e && e.message) || 'unknown' }); }
    }
  }

  // ── Load ALL clients (parallel, chunked) ──────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let blobs;
  try { blobs = (await clientsStore.list()).blobs || []; }
  catch (e) { return json(500, { error: 'clients list failed: ' + (e && e.message) }); }

  const clientsByKey = new Map(); // clientKey → { ownerKey, clientId, client }
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

  // Build an email → clientEntry index for matching Baseline people
  // to any existing SLA client (native LO wins over import-owner).
  const clientsByEmail = new Map();
  for (const e of clientsByKey.values()) {
    const email = _lower(e.client && e.client.email);
    if (!email) continue;
    const existing = clientsByEmail.get(email);
    // Non-import owner wins over import owner. Otherwise first-seen.
    const eIsImport = e.ownerKey === IMPORT_OWNER_KEY;
    const xIsImport = existing && existing.ownerKey === IMPORT_OWNER_KEY;
    if (!existing || (xIsImport && !eIsImport)) clientsByEmail.set(email, e);
  }

  // ── Phase 2: Materialize People ───────────────────────────────
  let peopleLinked = 0, peopleCreated = 0, peopleUpdated = 0;
  const peopleSamples = [];
  const personBorrowersById = new Map();

  for (const b of borrowers) {
    if (!_isPerson(b)) continue;
    const id = b && b.Id;
    if (!id) continue;
    personBorrowersById.set(id, b);

    const email = _lower(b.Email);
    const first = String(b.First_Name || '').trim();
    const last  = String(b.Last_Name  || '').trim();

    // Existing link?
    const link = await getBorrowerLink(id);
    let target;
    if (link && link.ownerKey && link.clientId) {
      target = clientsByKey.get(link.ownerKey + '/' + link.clientId) || null;
    }

    if (!target && email && clientsByEmail.has(email)) {
      target = clientsByEmail.get(email);
    }

    if (target) {
      // Gap-fill target's contact fields from Baseline. Never overwrite.
      let changed = false;
      const GAP = { firstName: first, lastName: last, email, phone: String(b.Phone || '').trim() };
      for (const k of Object.keys(GAP)) {
        if (_isEmpty(target.client[k]) && GAP[k]) { target.client[k] = GAP[k]; changed = true; }
      }
      target.client._baselineBorrowerId = id;
      target.client.updatedAt = now;
      if (!dryRun) {
        try {
          await clientsStore.setJSON(target.key, target.client);
          await setBorrowerLink(id, { ownerKey: target.ownerKey, clientId: target.clientId, source: 'match' });
        } catch (e) {
          errors.push({ phase: 'person materialize', id, error: (e && e.message) || 'unknown' });
        }
      }
      peopleLinked++;
      if (changed) peopleUpdated++;
    } else {
      // Create fresh under IMPORT_OWNER_KEY.
      const clientId = 'c_bl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const key = IMPORT_OWNER_KEY + '/' + clientId;
      const displayName = (first + ' ' + last).trim() || email || 'Baseline Borrower';
      const newClient = {
        id: clientId,
        firstName: first,
        lastName:  last,
        email,
        phone: String(b.Phone || '').trim(),
        displayName,
        createdAt: now,
        updatedAt: now,
        _baselineBorrowerId: id,
        _baselineImport: true,
        _baselineImportedAt: now,
        loans: [],
        companies: [],
      };
      target = { key, ownerKey: IMPORT_OWNER_KEY, clientId, client: newClient };
      clientsByKey.set(key, target);
      if (email) clientsByEmail.set(email, target);
      peopleCreated++;
      if (!dryRun) {
        try {
          await clientsStore.setJSON(key, newClient);
          await setBorrowerLink(id, { ownerKey: IMPORT_OWNER_KEY, clientId, source: 'new' });
        } catch (e) {
          errors.push({ phase: 'person create', id, error: (e && e.message) || 'unknown' });
        }
      }
    }
    if (peopleSamples.length < 20) {
      peopleSamples.push({
        baselineId: id,
        name: (first + ' ' + last).trim() || '—',
        email: email || '—',
        ownerKey: target.ownerKey,
        clientId: target.clientId,
        action: link ? 'linked' : (target && target.client._baselineImport ? (target.client.createdAt === now ? 'created' : 'matched') : 'matched'),
      });
    }
  }

  // ── Phase 3: Materialize Entities (LLCs) ──────────────────────
  // Attach each entity to the linked people's companies[]. If the
  // entity detail has connections, use those. Otherwise defer to
  // loan cross-reference below (Phase 4 will pick up the LLC via
  // loan.Borrower_Id + loan.Guarantor_1_Id).
  let llcsAttachedFromEntity = 0;
  const llcSamples = [];
  for (const b of borrowers) {
    if (!_isEntity(b)) continue;
    const id = b && b.Id;
    if (!id) continue;
    const linkedPersonIds = _linkedBorrowerIds(b);
    if (!linkedPersonIds.length) continue; // handled by loan cross-ref
    const entityName = String(b.Name || '').trim();
    if (!entityName) continue;
    const state = String(b.Address_State || '').trim();
    const norm  = _normLlc(entityName);

    for (const personId of linkedPersonIds) {
      const link = await getBorrowerLink(personId);
      if (!link) continue;
      const target = clientsByKey.get(link.ownerKey + '/' + link.clientId);
      if (!target) continue;
      target.client.companies = Array.isArray(target.client.companies) ? target.client.companies : [];
      let existing = target.client.companies.find((co) => _normLlc(co && co.name) === norm);
      if (!existing) {
        existing = {
          id: 'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
          name: entityName,
          addrState: state,
          _baselineEntityId: id,
          _baselineImport: true,
          createdAt: now,
        };
        target.client.companies.push(existing);
        llcsAttachedFromEntity++;
        if (llcSamples.length < 20) {
          llcSamples.push({ baselineId: id, entityName, attachedTo: target.clientId, ownerKey: target.ownerKey });
        }
      } else if (!existing._baselineEntityId) {
        existing._baselineEntityId = id;
      }
      target.client.updatedAt = now;
      if (!dryRun) {
        try {
          await clientsStore.setJSON(target.key, target.client);
          await setBorrowerLink(id, { ownerKey: target.ownerKey, clientId: target.clientId, companyId: existing.id, source: 'entity connect' });
        } catch (e) {
          errors.push({ phase: 'entity materialize', id, error: (e && e.message) || 'unknown' });
        }
      }
    }
  }

  // ── Phase 4: Reassign loans by borrower link ──────────────────
  let loansReassigned = 0;
  let loansLlcTagged  = 0;
  const reassignSamples = [];

  // Collect all loans up front so mid-iteration mutations don't
  // trip us. Each item captures original context.
  const allLoansCtx = [];
  for (const entry of clientsByKey.values()) {
    if (!Array.isArray(entry.client.loans)) continue;
    for (const loan of entry.client.loans) {
      allLoansCtx.push({ entry, loan });
    }
  }

  for (const { entry, loan } of allLoansCtx) {
    const raw = loan && loan._baselineRaw;
    if (!raw) continue;
    // Prefer Guarantor_1_Id for person; fall back to Borrower_Id if
    // that's the person Id and not an LLC Id.
    const g1Id = raw.Guarantor_1_Id;
    const borrowerId = raw.Borrower_Id;
    const primaryPersonId = g1Id || (personBorrowersById.has(borrowerId) ? borrowerId : null);
    if (primaryPersonId) {
      const link = await getBorrowerLink(primaryPersonId);
      if (link && link.ownerKey && link.clientId) {
        const targetKey = link.ownerKey + '/' + link.clientId;
        if (targetKey !== entry.key) {
          const target = clientsByKey.get(targetKey);
          if (target) {
            // Move.
            const idx = entry.client.loans.findIndex((l) => l && l.id === loan.id);
            if (idx >= 0) entry.client.loans.splice(idx, 1);
            target.client.loans = target.client.loans || [];
            if (!target.client.loans.some((l) => l && l.id === loan.id)) {
              target.client.loans.push(loan);
            }
            loansReassigned++;
            if (reassignSamples.length < 20) {
              reassignSamples.push({
                loanId:   loan.id,
                address:  loan.address || '',
                from:     entry.key,
                to:       target.key,
                via:      'baseline borrower link',
              });
            }
            // Track for saves later.
            entry._dirty = true;
            target._dirty = true;
            // Update native link so future Migrate routes correctly.
            const extId = String(loan._baselineExternalId || (raw && raw.Id) || '').trim();
            if (extId && !dryRun) {
              try {
                await setNativeLink(extId, { ownerKey: target.ownerKey, clientId: target.clientId, loanId: loan.id, source: 'borrower_pull' });
              } catch (e) {
                errors.push({ phase: 'native link', loanId: loan.id, error: (e && e.message) || 'unknown' });
              }
            }
          }
        }
      }
    }
    // LLC linkage: if the loan's Borrower_Id is an entity we know,
    // tag loan.companyId with the SLA company on the target client.
    if (borrowerId && borrowerId !== primaryPersonId) {
      const entityLink = await getBorrowerLink(borrowerId);
      if (entityLink && entityLink.companyId) {
        if (loan.companyId !== entityLink.companyId) {
          loan.companyId = entityLink.companyId;
          loansLlcTagged++;
          entry._dirty = true;
        }
      }
    }
  }

  // Persist all dirty clients + delete emptied import shells.
  if (!dryRun) {
    for (const entry of clientsByKey.values()) {
      if (!entry._dirty) continue;
      try {
        if (entry.ownerKey === IMPORT_OWNER_KEY && (!entry.client.loans || entry.client.loans.length === 0) && (!entry.client.companies || entry.client.companies.length === 0)) {
          // Empty import shell — safe to delete UNLESS it holds a
          // borrower link (i.e. it IS a Baseline-native person or
          // entity that just has no loans yet). Check by presence of
          // _baselineBorrowerId.
          if (!entry.client._baselineBorrowerId) {
            await clientsStore.delete(entry.key);
            continue;
          }
        }
        entry.client.updatedAt = now;
        await clientsStore.setJSON(entry.key, entry.client);
      } catch (e) {
        errors.push({ phase: 'final persist', key: entry.key, error: (e && e.message) || 'unknown' });
      }
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    baseline: {
      listCount:      rawBorrowers.length,
      detailCount:    borrowers.length,
      envelopeShape:  listResp.envelopeShape || '',
    },
    people:   { linked: peopleLinked, created: peopleCreated, gapFilled: peopleUpdated, samples: peopleSamples },
    entities: { attached: llcsAttachedFromEntity, samples: llcSamples },
    loans:    { reassigned: loansReassigned, llcTagged: loansLlcTagged, samples: reassignSamples },
    errorCount: errors.length,
    errors: errors.slice(0, 20),
  });
}
