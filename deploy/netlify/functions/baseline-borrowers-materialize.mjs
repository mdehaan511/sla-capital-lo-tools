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
  listMirroredBorrowers, getBorrowerLink, setBorrowerLink,
} from './_shared/baseline-borrowers.mjs';

function _lower(s) { return String(s || '').trim().toLowerCase(); }
function _isEmpty(v) { return v === undefined || v === null || v === ''; }
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
  const now = new Date().toISOString();
  const errors = [];

  // ── Load Baseline mirror + all clients + all borrower links ──
  const borrowers = await listMirroredBorrowers();

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

    if (target) {
      let changed = false;
      const gap = { firstName: first, lastName: last, email, phone: String(b.Phone || '').trim() };
      for (const k of Object.keys(gap)) {
        if (_isEmpty(target.client[k]) && gap[k]) { target.client[k] = gap[k]; changed = true; }
      }
      target.client._baselineBorrowerId = id;
      target.client.updatedAt = now;
      if (!dryRun) {
        try {
          await clientsStore.setJSON(target.key, target.client);
          await setBorrowerLink(id, { ownerKey: target.ownerKey, clientId: target.clientId, source: 'match' });
          linkMap.set(String(id), { ownerKey: target.ownerKey, clientId: target.clientId, source: 'match' });
        } catch (e) { errors.push({ phase: 'person materialize', id, error: (e && e.message) || 'unknown' }); }
      } else if (!existingLink) {
        linkMap.set(String(id), { ownerKey: target.ownerKey, clientId: target.clientId, source: 'match' });
      }
      peopleLinked++;
      if (changed) peopleGapFilled++;
    } else {
      const clientId = 'c_bl_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const key = IMPORT_OWNER_KEY + '/' + clientId;
      const displayName = (first + ' ' + last).trim() || email || 'Baseline Borrower';
      const newClient = {
        id: clientId, firstName: first, lastName: last, email,
        phone: String(b.Phone || '').trim(), displayName,
        createdAt: now, updatedAt: now,
        _baselineBorrowerId: id, _baselineImport: true, _baselineImportedAt: now,
        loans: [], companies: [],
      };
      target = { key, ownerKey: IMPORT_OWNER_KEY, clientId, client: newClient };
      clientsByKey.set(key, target);
      if (email) clientsByEmail.set(email, target);
      peopleCreated++;
      if (!dryRun) {
        try {
          await clientsStore.setJSON(key, newClient);
          await setBorrowerLink(id, { ownerKey: IMPORT_OWNER_KEY, clientId, source: 'new' });
          linkMap.set(String(id), { ownerKey: IMPORT_OWNER_KEY, clientId, source: 'new' });
        } catch (e) { errors.push({ phase: 'person create', id, error: (e && e.message) || 'unknown' }); }
      } else {
        linkMap.set(String(id), { ownerKey: IMPORT_OWNER_KEY, clientId, source: 'new' });
      }
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
      if (!existing) {
        existing = {
          id: 'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
          name: entityName, addrState: state,
          _baselineEntityId: id, _baselineImport: true, createdAt: now,
        };
        target.client.companies.push(existing);
        llcsAttached++;
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
          linkMap.set(String(id), { ownerKey: target.ownerKey, clientId: target.clientId, companyId: existing.id });
        } catch (e) { errors.push({ phase: 'entity materialize', id, error: (e && e.message) || 'unknown' }); }
      }
    }
  }

  // ── Phase 4: Reassign existing loans ─────────────────────────
  let loansReassigned = 0, loansLlcTagged = 0;
  const reassignSamples = [];
  const allLoansCtx = [];
  for (const entry of clientsByKey.values()) {
    if (!Array.isArray(entry.client.loans)) continue;
    for (const loan of entry.client.loans) allLoansCtx.push({ entry, loan });
  }

  for (const { entry, loan } of allLoansCtx) {
    const raw = loan && loan._baselineRaw;
    if (!raw) continue;
    const g1Id = raw.Guarantor_1_Id;
    const borrowerId = raw.Borrower_Id;
    const primaryPersonId = g1Id || (personBorrowersById.has(String(borrowerId)) ? borrowerId : null);
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
              try { await setNativeLink(extId, { ownerKey: target.ownerKey, clientId: target.clientId, loanId: loan.id, source: 'borrower_pull' }); }
              catch (e) { errors.push({ phase: 'native link', loanId: loan.id, error: (e && e.message) || 'unknown' }); }
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

  if (!dryRun) {
    for (const entry of clientsByKey.values()) {
      if (!entry._dirty) continue;
      try {
        if (entry.ownerKey === IMPORT_OWNER_KEY &&
            (!entry.client.loans || entry.client.loans.length === 0) &&
            (!entry.client.companies || entry.client.companies.length === 0) &&
            !entry.client._baselineBorrowerId) {
          await clientsStore.delete(entry.key);
          continue;
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
    mirrorCount: borrowers.length,
    people:   { linked: peopleLinked, created: peopleCreated, gapFilled: peopleGapFilled, samples: peopleSamples },
    entities: { attached: llcsAttached, samples: llcSamples },
    loans:    { reassigned: loansReassigned, llcTagged: loansLlcTagged, samples: reassignSamples },
    errorCount: errors.length,
    errors: errors.slice(0, 20),
  });
}
