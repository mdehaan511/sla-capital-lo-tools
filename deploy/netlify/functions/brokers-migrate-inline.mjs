/**
 * brokers-migrate-inline.mjs — POST /api/brokers-migrate-inline
 *
 * Deploy 236.27 (Brokers Phase 5). One-time migration that walks
 * every loan across every LO, finds inline broker data (loan.brokerName,
 * brokerEmail, brokerPhone, brokerCompany) that pre-dates the Phase 1
 * broker book, dedupes contacts into proper Broker records, and stamps
 * brokerId back on each loan.
 *
 * After this runs, the brokers.html dashboard correctly aggregates
 * historical deal flow per broker — currently those legacy loans
 * count toward "no broker" because they have no brokerId pointer.
 *
 * SAFETY:
 *   - Admin-only (super_admin recommended).
 *   - `?dry=1` returns the same audit without touching any blob.
 *     Always run dry first, eyeball the numbers, then run live.
 *   - Idempotent: loans that already have a brokerId are skipped.
 *   - Per-LO scoped: a broker record is only created under the LO who
 *     owns the loan. We never cross-link across LOs.
 *   - Matching priority within an owner's existing brokers:
 *       1. brokerEmail (lowercased) — strongest signal
 *       2. brokerName + last-4-digits of phone — fallback when no email
 *       3. brokerName alone (only if exact case-insensitive match) —
 *          last resort, surfaces in the audit as `matchedBy: "name"`
 *     so an admin can spot-check.
 *   - We touch ONE thing per loan: stamp loan.brokerId. Inline broker
 *     fields stay in place so old views/exports still see the contact
 *     name. (Future cleanup deploy can null them out — but only after
 *     every read site has been updated to prefer the linked Broker
 *     record over the inline copy.)
 *
 * Response shape (live + dry):
 *   {
 *     dryRun: bool,
 *     ownersScanned: N,
 *     loansScanned: N,
 *     loansAlreadyLinked: N,    // had brokerId already → skipped
 *     loansNoBrokerData: N,     // no inline broker fields → skipped
 *     loansLinked: N,           // brokerId stamped
 *     brokersCreated: N,        // new Broker records written
 *     brokersMatched: N,        // pointed at existing Broker
 *     perOwner: [
 *       { owner: 'lo@x.com', scanned: N, linked: N, created: N, matched: N }
 *     ],
 *     samples: [                // first ~20 actions for spot-check
 *       { ownerKey, loanId, action: 'matched'|'created'|'skipped',
 *         matchedBy?: 'email'|'phone'|'name', brokerId, brokerName }
 *     ]
 *   }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, keySafe,
} from './_shared/auth.mjs';

const MAX_SAMPLES = 20;

function normalizePhone(p) {
  return String(p || '').replace(/\D+/g, '');
}

function phoneTail(p, n) {
  const d = normalizePhone(p);
  return d.length >= n ? d.slice(-n) : d;
}

function hasInlineBroker(loan) {
  return !!(
    String(loan.brokerName || '').trim() ||
    String(loan.brokerEmail || '').trim() ||
    String(loan.brokerPhone || '').trim() ||
    String(loan.brokerCompany || '').trim()
  );
}

function buildBrokerIndex(brokers) {
  // Three lookup tables keyed for the three match modes.
  const byEmail = new Map();         // 'email@x.com' → broker
  const byNamePhoneTail = new Map(); // 'jane smith|1234' → broker
  const byName = new Map();          // 'jane smith' → broker
  (brokers || []).forEach((b) => {
    const e = String(b.email || '').toLowerCase().trim();
    if (e) byEmail.set(e, b);
    const nameKey = String(b.name || '').toLowerCase().trim();
    if (nameKey) {
      const tail = phoneTail(b.phone, 4);
      if (tail) byNamePhoneTail.set(nameKey + '|' + tail, b);
      // Only register name-alone if no duplicate name exists.
      if (!byName.has(nameKey)) {
        byName.set(nameKey, b);
      } else {
        byName.set(nameKey, '__ambiguous__');
      }
    }
  });
  return { byEmail, byNamePhoneTail, byName };
}

function findExistingBroker(loan, idx) {
  const email = String(loan.brokerEmail || '').toLowerCase().trim();
  if (email && idx.byEmail.has(email)) {
    return { broker: idx.byEmail.get(email), matchedBy: 'email' };
  }
  const name = String(loan.brokerName || '').toLowerCase().trim();
  if (!name) return null;
  const tail = phoneTail(loan.brokerPhone, 4);
  if (tail) {
    const hit = idx.byNamePhoneTail.get(name + '|' + tail);
    if (hit) return { broker: hit, matchedBy: 'phone' };
  }
  if (idx.byName.has(name)) {
    const v = idx.byName.get(name);
    if (v !== '__ambiguous__') return { broker: v, matchedBy: 'name' };
  }
  return null;
}

function makeBrokerRecord(loan, ownerEmail, nowIso) {
  const id = 'b_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  return {
    id,
    name:      String(loan.brokerName    || '').trim(),
    company:   String(loan.brokerCompany || '').trim(),
    email:     String(loan.brokerEmail   || '').toLowerCase().trim(),
    phone:     String(loan.brokerPhone   || '').trim(),
    notes:     'Auto-created from inline broker data (Deploy 236.27 migration).',
    createdAt: nowIso,
    updatedAt: nowIso,
    createdBy: ownerEmail,
  };
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const url = new URL(req.url);
  const dryRun = url.searchParams.get('dry') === '1';

  const clientsStore = getStore({ name: 'clients',  consistency: 'strong' });
  const brokersStore = getStore({ name: 'brokers',  consistency: 'strong' });

  // ── 1. Walk every client record across every LO ────────────────
  // The clients store is keyed `ownerKey/clientId`. Listing without a
  // prefix yields every record; we partition by ownerKey on the fly.
  const all = await clientsStore.list();
  const blobs = all.blobs || [];

  // Group keys by owner so we can batch-process each LO's loans
  // against a single brokers cache (avoid re-fetching for every loan).
  const keysByOwner = new Map(); // ownerKey → [fullKey, ...]
  blobs.forEach(({ key }) => {
    const slash = key.indexOf('/');
    if (slash < 0) return;
    const ownerKey = key.slice(0, slash);
    if (!keysByOwner.has(ownerKey)) keysByOwner.set(ownerKey, []);
    keysByOwner.get(ownerKey).push(key);
  });

  const nowIso = new Date().toISOString();
  const audit = {
    dryRun,
    ownersScanned: 0,
    loansScanned: 0,
    loansAlreadyLinked: 0,
    loansNoBrokerData: 0,
    loansLinked: 0,
    brokersCreated: 0,
    brokersMatched: 0,
    perOwner: [],
    samples: [],
  };

  for (const [ownerKey, ownerKeysList] of keysByOwner) {
    // Load this LO's existing brokers once for the whole owner pass.
    const brokerListing = await brokersStore.list({ prefix: ownerKey + '/' });
    const existingBrokers = (await Promise.all(
      (brokerListing.blobs || []).map(({ key }) => brokersStore.get(key, { type: 'json' })),
    )).filter(Boolean);
    const brokerIdx = buildBrokerIndex(existingBrokers);

    const perOwner = { owner: ownerKey, scanned: 0, linked: 0, created: 0, matched: 0, alreadyLinked: 0, noBroker: 0 };

    // Best-effort owner email for createdBy on new brokers. The owner
    // key is keySafe(email) so we can't fully recover the original
    // email — but it's fine for createdBy since we also stamp the
    // record under the owner's blob key, which is the source of truth.
    const ownerEmail = ownerKey;

    for (const clientKey of ownerKeysList) {
      let client;
      try { client = await clientsStore.get(clientKey, { type: 'json' }); }
      catch (_) { continue; }
      if (!client || !Array.isArray(client.loans)) continue;

      let mutated = false;

      for (const loan of client.loans) {
        audit.loansScanned += 1;
        perOwner.scanned += 1;

        // Skip if already linked
        if (loan.brokerId) {
          audit.loansAlreadyLinked += 1;
          perOwner.alreadyLinked += 1;
          continue;
        }
        // Skip if no inline broker data to migrate
        if (!hasInlineBroker(loan)) {
          audit.loansNoBrokerData += 1;
          perOwner.noBroker += 1;
          continue;
        }

        // Try to match existing
        let action, matchedBy, brokerRec;
        const hit = findExistingBroker(loan, brokerIdx);
        if (hit) {
          brokerRec = hit.broker;
          matchedBy = hit.matchedBy;
          action = 'matched';
          audit.brokersMatched += 1;
          perOwner.matched += 1;
        } else {
          brokerRec = makeBrokerRecord(loan, ownerEmail, nowIso);
          action = 'created';
          audit.brokersCreated += 1;
          perOwner.created += 1;
          if (!dryRun) {
            await brokersStore.setJSON(ownerKey + '/' + brokerRec.id, brokerRec);
          }
          // Update the index so subsequent loans in this pass don't
          // double-create the same broker.
          if (brokerRec.email) brokerIdx.byEmail.set(brokerRec.email, brokerRec);
          const nameKey = brokerRec.name.toLowerCase();
          if (nameKey) {
            const tail = phoneTail(brokerRec.phone, 4);
            if (tail) brokerIdx.byNamePhoneTail.set(nameKey + '|' + tail, brokerRec);
            if (!brokerIdx.byName.has(nameKey)) brokerIdx.byName.set(nameKey, brokerRec);
          }
        }

        // Stamp brokerId on the loan
        loan.brokerId = brokerRec.id;
        mutated = true;
        audit.loansLinked += 1;
        perOwner.linked += 1;

        if (audit.samples.length < MAX_SAMPLES) {
          audit.samples.push({
            ownerKey,
            loanId: loan.id || '(no id)',
            action,
            matchedBy,
            brokerId: brokerRec.id,
            brokerName: brokerRec.name,
            brokerEmail: brokerRec.email,
          });
        }
      }

      // Save the client record if any of its loans were updated.
      if (mutated && !dryRun) {
        try {
          await clientsStore.setJSON(clientKey, client);
        } catch (e) {
          console.error('migrate write failed for', clientKey, e);
        }
      }
    }

    audit.ownersScanned += 1;
    audit.perOwner.push(perOwner);
  }

  // ── 4. Write the audit to migrations-log for traceability ──────
  if (!dryRun) {
    try {
      const logStore = getStore({ name: 'migrations-log', consistency: 'eventual' });
      const logKey = 'brokers-inline-migration/' + nowIso.replace(/[:.]/g, '-');
      await logStore.setJSON(logKey, {
        startedBy: user.email,
        startedAt: nowIso,
        audit,
      });
    } catch (e) {
      // Audit write failure shouldn't fail the response — the data
      // mutations have already landed. Log + continue.
      console.error('migrations-log write failed:', e);
    }
  }

  return json(200, audit);
};
