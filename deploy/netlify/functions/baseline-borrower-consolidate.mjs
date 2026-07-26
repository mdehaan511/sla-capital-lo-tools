/**
 * baseline-borrower-consolidate.mjs — POST /api/baseline-borrower-consolidate
 *
 * Deploy 236.191 — one borrower with 5 Baseline loans should become
 * ONE SLA client with 5 loans on it, not 5 stub clients. This
 * endpoint walks the clients store, groups loans by borrower
 * (Guarantor_1_Email, or name+phone as a fallback), picks a
 * canonical client per group, moves the other loans onto it, and
 * deletes the emptied stub clients when they were owned by the
 * baseline-migration pseudo-owner.
 *
 * Also does two related jobs in the same pass:
 *   - LLCs (Entity_Name / Borrower_Entity_Name from each Baseline
 *     record) get attached to the canonical client's companies[]
 *     array. Loan.companyId points at the entry. Dedup within a
 *     client is by normalized name.
 *   - Guarantor_2 (co-borrower) becomes their own client under the
 *     same owner, cross-linked from the loan as
 *     loan.coGuarantorClientId. Same dedup key as Guarantor_1.
 *
 * Scope: SAME-owner consolidation only in this endpoint. Cross-owner
 * duplicates (e.g. an LO's native client that matches a
 * baseline-migration stub by email) get REPORTED as candidates so
 * Mike can decide per-pair via the Loans-page Merge Selected UI.
 * Auto-merging across owners has too many failure modes (supporting
 * data moves, ownership audits, per-LO permissions) to do blindly.
 *
 * Body: { dryRun?: bool (default TRUE) }
 * Auth: admin only.
 *
 * Response:
 *   {
 *     ok, dryRun,
 *     clientsScanned, loansScanned,
 *     borrowerGroups,
 *     duplicateClientsMerged,
 *     loansReassigned,
 *     llcsAttached,
 *     guarantor2ClientsCreated,
 *     crossOwnerCandidates: [{dedupeKey, entries: [{ownerKey, clientId, name, email}]}, ...],
 *     samples, errors,
 *   }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe,
} from './_shared/auth.mjs';
import { IMPORT_OWNER_KEY, setNativeLink } from './_shared/baseline-upsert.mjs';

const CONCURRENCY = 10;

// ─── Normalization helpers ──────────────────────────────────────
function _lower(s) { return String(s || '').trim().toLowerCase(); }
function _normEmail(s) { return _lower(s); }
function _normName(f, l) {
  return (String(f || '').trim() + ' ' + String(l || '').trim())
    .toLowerCase().replace(/\s+/g, ' ').trim();
}
function _normPhone(s) { return String(s || '').replace(/\D/g, ''); }
function _normLlc(s) {
  return String(s || '').trim().toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\b(llc|l\.l\.c\.|inc|incorporated|corporation|corp|ltd|limited|co)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}
function _dedupeKey(rec) {
  // rec = { email, firstName, lastName, phone }
  const email = _normEmail(rec.email);
  if (email) return 'e:' + email;
  const name = _normName(rec.firstName, rec.lastName);
  const phone = _normPhone(rec.phone);
  if (name && phone) return 'np:' + name + '|' + phone;
  if (name) return 'n:' + name;
  return ''; // no signal → don't group
}

// ─── Signal extraction from a loan record ────────────────────────
function _guarantor1(loan) {
  const raw = loan && loan._baselineRaw || {};
  return {
    firstName: raw.Guarantor_1_First_Name || '',
    lastName:  raw.Guarantor_1_Last_Name  || '',
    email:     raw.Guarantor_1_Email      || '',
    phone:     raw.Guarantor_1_Phone      || '',
    fico:      raw.Guarantor_1_Credit_Score,
    flips:     raw.Guarantor_1_Num_Flipped,
  };
}
function _guarantor2(loan) {
  const raw = loan && loan._baselineRaw || {};
  const first = raw.Guarantor_2_First_Name || '';
  const last  = raw.Guarantor_2_Last_Name  || '';
  const email = raw.Guarantor_2_Email      || '';
  const phone = raw.Guarantor_2_Phone      || '';
  if (!first && !last && !email && !phone) return null;
  return { firstName: first, lastName: last, email, phone };
}
function _llc(loan) {
  const raw = loan && loan._baselineRaw || {};
  const name = raw.Entity_Name || raw.Borrower_Entity_Name || loan.entityName || '';
  if (!name) return null;
  return {
    name:  String(name).trim(),
    state: raw.Borrower_Jurisdiction || raw.Address_State || '',
    type:  raw.Borrower_Entity_Type || '',
    _baselineFromLoanId: loan.id,
  };
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-borrower-consolidate error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;

  const store = getStore({ name: 'clients', consistency: 'strong' });

  // ─── 1. Parallel walk of clients store ───────────────────────
  let blobs;
  try { blobs = (await store.list()).blobs || []; }
  catch (e) { return json(500, { error: 'clients list failed: ' + (e && e.message) }); }

  // key -> {ownerKey, clientId, client}
  const clientsByKey = new Map();
  for (let i = 0; i < blobs.length; i += CONCURRENCY) {
    const chunk = blobs.slice(i, i + CONCURRENCY);
    const results = await Promise.all(chunk.map(async ({ key }) => {
      const slash = key.indexOf('/');
      if (slash < 0) return null;
      const ownerKey = key.slice(0, slash);
      const clientId = key.slice(slash + 1);
      const client   = await store.get(key, { type: 'json' }).catch(() => null);
      if (!client) return null;
      return { key, ownerKey, clientId, client };
    }));
    for (const r of results) if (r) clientsByKey.set(r.key, r);
  }

  // ─── 2. Build dedupe groups per owner ────────────────────────
  // Map<ownerKey, Map<dedupeKey, [{clientEntry, loan}, ...]>>
  const groupsPerOwner = new Map();
  // Also track a global (cross-owner) index for candidates report.
  const globalGroups = new Map();
  let loansScanned = 0;

  for (const entry of clientsByKey.values()) {
    if (!Array.isArray(entry.client.loans)) continue;
    for (const loan of entry.client.loans) {
      loansScanned++;
      const g1 = _guarantor1(loan);
      // Fall back to the client's own top-level fields when the loan
      // doesn't carry _baselineRaw (native LO client with no Baseline
      // import history).
      if (!g1.email && !g1.firstName && !g1.lastName) {
        const c = entry.client;
        g1.firstName = c.firstName || '';
        g1.lastName  = c.lastName  || '';
        g1.email     = c.email     || '';
        g1.phone     = c.phone     || '';
      }
      const dk = _dedupeKey(g1);
      if (!dk) continue;

      if (!groupsPerOwner.has(entry.ownerKey)) groupsPerOwner.set(entry.ownerKey, new Map());
      const perOwner = groupsPerOwner.get(entry.ownerKey);
      if (!perOwner.has(dk)) perOwner.set(dk, []);
      perOwner.get(dk).push({ clientEntry: entry, loan, g1 });

      if (!globalGroups.has(dk)) globalGroups.set(dk, []);
      globalGroups.get(dk).push({ ownerKey: entry.ownerKey, clientId: entry.clientId, loan, g1 });
    }
  }

  // ─── 3. Per-owner consolidation plan ─────────────────────────
  // Within each (owner, dedupeKey) group of >1 CLIENTS, pick canonical
  // and merge others into it. Groups that resolve to a single client
  // (even with many loans) don't need consolidation.
  let borrowerGroups = 0;
  let duplicateClientsMerged = 0;
  let loansReassigned = 0;
  const consolidationSamples = [];
  const errors = [];

  for (const [ownerKey, perOwner] of groupsPerOwner.entries()) {
    for (const [dk, hits] of perOwner.entries()) {
      // Which distinct clients are in this group?
      const uniqueClients = new Map(); // clientKey -> clientEntry
      for (const h of hits) uniqueClients.set(h.clientEntry.key, h.clientEntry);
      if (uniqueClients.size <= 1) continue; // only one client anyway; nothing to consolidate

      borrowerGroups++;

      // Pick canonical: prefer non-import owner, then oldest createdAt,
      // then most-loans, then earliest client key.
      const clientsArr = Array.from(uniqueClients.values());
      clientsArr.sort((a, b) => {
        const aImport = a.ownerKey === IMPORT_OWNER_KEY ? 1 : 0;
        const bImport = b.ownerKey === IMPORT_OWNER_KEY ? 1 : 0;
        if (aImport !== bImport) return aImport - bImport;
        const aCreated = a.client.createdAt || '';
        const bCreated = b.client.createdAt || '';
        if (aCreated !== bCreated) return aCreated < bCreated ? -1 : 1;
        const al = (a.client.loans || []).length;
        const bl = (b.client.loans || []).length;
        if (al !== bl) return bl - al;
        return a.key < b.key ? -1 : 1;
      });
      const canonical = clientsArr[0];
      const losers    = clientsArr.slice(1);

      // Merge losers into canonical.
      const movedLoans = []; // refs to loan objects moved onto canonical
      for (const loser of losers) {
        // 3a. Gap-fill canonical's contact fields from loser.
        const CLIENT_FIELDS = ['firstName', 'lastName', 'email', 'phone', 'displayName',
                                'address', 'city', 'state', 'zip', 'entityName'];
        for (const f of CLIENT_FIELDS) {
          if (!canonical.client[f] && loser.client[f]) canonical.client[f] = loser.client[f];
        }
        // 3b. Move loans.
        const loserLoans = Array.isArray(loser.client.loans) ? loser.client.loans.slice() : [];
        for (const l of loserLoans) {
          if ((canonical.client.loans || []).some((x) => x && x.id === l.id)) continue;
          canonical.client.loans = canonical.client.loans || [];
          canonical.client.loans.push(l);
          movedLoans.push(l);
          loansReassigned++;
        }
        loser.client.loans = [];
      }
      canonical.client.updatedAt = new Date().toISOString();
      duplicateClientsMerged += losers.length;

      // Sample capture.
      if (consolidationSamples.length < 30) {
        consolidationSamples.push({
          ownerKey,
          dedupeKey: dk,
          canonical: { clientId: canonical.clientId, name: (canonical.client.firstName || '') + ' ' + (canonical.client.lastName || ''), email: canonical.client.email || '', loanCount: (canonical.client.loans || []).length },
          losers:    losers.map((l) => ({ clientId: l.clientId, email: l.client.email || '' })),
          loanIdsMoved: movedLoans.map((l) => l.id),
        });
      }

      // 3c. Persist canonical + delete/save losers, then update
      //     native links so future Migrates route to the new location.
      if (!dryRun) {
        try {
          await store.setJSON(canonical.key, canonical.client);
          for (const loser of losers) {
            if (loser.ownerKey === IMPORT_OWNER_KEY) {
              await store.delete(loser.key);
            } else {
              await store.setJSON(loser.key, loser.client);
            }
          }
          for (const l of movedLoans) {
            const extId = String(
              l._baselineExternalId
              || (l._baselineRaw && l._baselineRaw.Id)
              || ''
            ).trim();
            if (extId) {
              await setNativeLink(extId, {
                ownerKey: canonical.ownerKey,
                clientId: canonical.clientId,
                loanId:   l.id,
                source:   'borrower_consolidate',
              });
            }
          }
        } catch (e) {
          errors.push({ ownerKey, dedupeKey: dk, error: (e && e.message) || 'unknown' });
        }
      }
    }
  }

  // ─── 4. LLC attachment + Guarantor_2 client creation ─────────
  // Re-walk canonicals (all clients after consolidation, so we can
  // handle post-merge state). For each loan that has entity data,
  // ensure the canonical client's companies[] has an entry + point
  // the loan at it via companyId.
  let llcsAttached = 0;
  let guarantor2ClientsCreated = 0;
  const g2Samples = [];
  const llcSamples = [];

  // Iterate a snapshot of clients (in memory — the mutations above
  // already reflect on the same object refs).
  const clientList = Array.from(clientsByKey.values());
  for (const entry of clientList) {
    if (!Array.isArray(entry.client.loans) || entry.client.loans.length === 0) continue;
    entry.client.companies = Array.isArray(entry.client.companies) ? entry.client.companies : [];
    let clientChanged = false;

    for (const loan of entry.client.loans) {
      // ── LLC ──
      const llc = _llc(loan);
      if (llc && llc.name) {
        const norm = _normLlc(llc.name);
        let existing = entry.client.companies.find((co) => _normLlc(co && co.name) === norm);
        if (!existing) {
          existing = {
            id:      'co_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8),
            name:    llc.name,
            addrState: llc.state || '',
            entityType: llc.type || '',
            _baselineImport: true,
            createdAt: new Date().toISOString(),
          };
          entry.client.companies.push(existing);
          llcsAttached++;
          clientChanged = true;
          if (llcSamples.length < 30) {
            llcSamples.push({ ownerKey: entry.ownerKey, clientId: entry.clientId, companyName: llc.name, companyId: existing.id });
          }
        }
        if (loan.companyId !== existing.id) {
          loan.companyId = existing.id;
          clientChanged = true;
        }
      }

      // ── Guarantor_2 ──
      const g2 = _guarantor2(loan);
      if (g2) {
        const g2Key = _dedupeKey(g2);
        if (g2Key) {
          // Find existing client under SAME owner with this dedupe key
          let g2Client = null;
          const ownerMap = groupsPerOwner.get(entry.ownerKey);
          // Search the full clientList (not just groups) since some
          // clients have no loans and thus don't appear in groups.
          for (const cand of clientList) {
            if (cand.ownerKey !== entry.ownerKey) continue;
            if (cand.clientId === entry.clientId) continue;
            const candKey = _dedupeKey({
              firstName: cand.client.firstName,
              lastName:  cand.client.lastName,
              email:     cand.client.email,
              phone:     cand.client.phone,
            });
            if (candKey === g2Key) { g2Client = cand; break; }
          }
          if (!g2Client) {
            // Create a new client for Guarantor_2 under same owner.
            const newId = 'c_g2_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
            const newKey = entry.ownerKey + '/' + newId;
            const now = new Date().toISOString();
            const newClient = {
              id: newId,
              firstName:  g2.firstName || '',
              lastName:   g2.lastName  || '',
              email:      g2.email     || '',
              phone:      g2.phone     || '',
              displayName: ((g2.firstName || '') + ' ' + (g2.lastName || '')).trim() || (g2.email || 'Co-Guarantor'),
              createdAt:  now,
              updatedAt:  now,
              _baselineImport: true,
              _coGuarantorOf: [{ loanId: loan.id, primaryClientId: entry.clientId }],
              loans: [],
            };
            g2Client = { key: newKey, ownerKey: entry.ownerKey, clientId: newId, client: newClient };
            clientsByKey.set(newKey, g2Client);
            clientList.push(g2Client);
            guarantor2ClientsCreated++;
            if (!dryRun) {
              try { await store.setJSON(newKey, newClient); }
              catch (e) { errors.push({ where: 'g2 create', error: (e && e.message) || 'unknown' }); }
            }
            if (g2Samples.length < 30) {
              g2Samples.push({ ownerKey: entry.ownerKey, primaryClientId: entry.clientId, coClientId: newId, name: newClient.displayName, email: newClient.email });
            }
          } else {
            g2Client.client._coGuarantorOf = Array.isArray(g2Client.client._coGuarantorOf) ? g2Client.client._coGuarantorOf : [];
            if (!g2Client.client._coGuarantorOf.some((r) => r.loanId === loan.id)) {
              g2Client.client._coGuarantorOf.push({ loanId: loan.id, primaryClientId: entry.clientId });
              if (!dryRun) {
                try { await store.setJSON(g2Client.key, g2Client.client); }
                catch (e) { errors.push({ where: 'g2 append', error: (e && e.message) || 'unknown' }); }
              }
            }
          }
          if (loan.coGuarantorClientId !== g2Client.clientId) {
            loan.coGuarantorClientId = g2Client.clientId;
            clientChanged = true;
          }
        }
      }
    }

    if (clientChanged && !dryRun) {
      try { await store.setJSON(entry.key, entry.client); }
      catch (e) { errors.push({ ownerKey: entry.ownerKey, clientId: entry.clientId, where: 'llc/g2 persist', error: (e && e.message) || 'unknown' }); }
    }
  }

  // ─── 5. Cross-owner candidates (report only) ─────────────────
  // A dedupe key that maps to clients under 2+ different owners is a
  // candidate for manual merge via the Loans page. We don't
  // auto-merge these — that path handles cross-owner data movement
  // safely (supporting stores, audit) which the bulk here doesn't.
  const crossOwnerCandidates = [];
  for (const [dk, hits] of globalGroups.entries()) {
    const owners = new Set(hits.map((h) => h.ownerKey));
    if (owners.size < 2) continue;
    // Sample one hit per owner so the report is compact.
    const perOwner = new Map();
    for (const h of hits) {
      if (!perOwner.has(h.ownerKey)) perOwner.set(h.ownerKey, h);
    }
    if (crossOwnerCandidates.length < 30) {
      crossOwnerCandidates.push({
        dedupeKey: dk,
        entries: Array.from(perOwner.values()).map((h) => ({
          ownerKey: h.ownerKey,
          clientId: h.clientId,
          email:    h.g1.email || '',
          name:     (h.g1.firstName + ' ' + h.g1.lastName).trim(),
          loanId:   h.loan.id,
          address:  h.loan.address || '',
        })),
      });
    }
  }

  return json(200, {
    ok: true,
    dryRun,
    clientsScanned: clientsByKey.size,
    loansScanned,
    borrowerGroups,
    duplicateClientsMerged,
    loansReassigned,
    llcsAttached,
    guarantor2ClientsCreated,
    crossOwnerCandidateCount: crossOwnerCandidates.length,
    crossOwnerCandidates,
    consolidationSamples,
    llcSamples,
    g2Samples,
    errorCount: errors.length,
    errors: errors.slice(0, 20),
  });
}

