/**
 * dscr-sold-backfill.mjs — POST /api/dscr-sold-backfill
 *
 * Deploy 237.014 (Mike) — for DSCR loans marked Sold, set the Sold Date to the
 * loan's close / funding date where it is blank. DSCR ONLY (non-DSCR loans are
 * left alone per Mike). Idempotent: never overwrites a Sold Date already set.
 * DRY RUN by default; { apply: true } writes through the PG-first strict
 * writeClient.
 *
 * Note on the investor: it can NOT be backfilled from Baseline. Baseline's REST
 * API exposes no product/investor field — the "Product: DIYA · DSCR Loan" shown
 * in the Baseline UI is not in GET /loan/{id} (verified: full record, list,
 * every sub-resource, GraphQL 404). When a product/investor export is available
 * this endpoint can be extended to set investorName the same way (accept a
 * { investorByLoan } map and fill blank investorName).
 *
 * Body: { apply?: false }.  Auth: processor or admin (canOverrideOwner).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { console.error('dscr-sold-backfill error:', e); return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') }); }
};

// Normalize a date to YYYY-MM-DD (accepts ISO or M/D/YYYY; passes through blanks).
function ymd(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);
  return s.slice(0, 10);
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.apply !== true;
  const now = new Date().toISOString();

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await clientsStore.list();
  const CONC = 25;
  let scanned = 0, dscrSold = 0, alreadyHad = 0, noFunding = 0;
  const plan = []; // { ownerKey, clientId, loanId, slaId, addr, soldDate }

  for (let i = 0; i < blobs.length; i += CONC) {
    const chunk = blobs.slice(i, i + CONC);
    const recs = await Promise.all(chunk.map(({ key }) =>
      clientsStore.get(key, { type: 'json' }).then((c) => ({ key, c })).catch(() => ({ key, c: null }))));
    for (const { key, c } of recs) {
      const slash = key.indexOf('/'); if (slash < 0) continue;
      const ownerKey = key.slice(0, slash);
      if (!c || !Array.isArray(c.loans)) continue;
      for (const loan of c.loans) {
        scanned += 1;
        if (String(loan.toolType || '').toLowerCase() !== 'dscr') continue;
        if (String(loan.disposition || '').toLowerCase() !== 'sold') continue;
        dscrSold += 1;
        if (String(loan.soldDate || '').trim()) { alreadyHad += 1; continue; }
        const close = ymd(loan.fundingDate);
        if (!close) { noFunding += 1; continue; }
        plan.push({ ownerKey, clientId: c.id, loanId: loan.id, slaId: loan.slaDisplayId || '', addr: (loan.propertyAddress || loan.address || '').slice(0, 40), soldDate: close });
      }
    }
  }
  plan.sort((a, b) => (a.ownerKey + a.clientId + a.loanId).localeCompare(b.ownerKey + b.clientId + b.loanId));

  let applied = 0;
  const errors = [];
  if (!dryRun && plan.length) {
    const byClient = new Map();
    for (const r of plan) { const k = r.ownerKey + '||' + r.clientId; if (!byClient.has(k)) byClient.set(k, []); byClient.get(k).push(r); }
    for (const [k, group] of byClient) {
      const [ownerKey, clientId] = k.split('||');
      try {
        const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
        if (!client || !Array.isArray(client.loans)) { group.forEach((r) => errors.push({ loanId: r.loanId, error: 'client vanished' })); continue; }
        let dirty = false;
        for (const r of group) {
          const loan = client.loans.find((l) => l && l.id === r.loanId);
          if (!loan) { errors.push({ loanId: r.loanId, error: 'loan vanished' }); continue; }
          if (String(loan.soldDate || '').trim()) continue; // idempotent re-check
          loan.soldDate = r.soldDate;
          loan.updatedAt = now;
          dirty = true; applied += 1;
        }
        if (dirty) await writeClient(ownerKey, client, { clientsStore });
      } catch (e) { group.forEach((r) => errors.push({ loanId: r.loanId, error: 'write failed: ' + ((e && e.message) || '') })); }
    }
  }

  return json(200, {
    ok: true, dryRun,
    scanned, dscrSold, alreadyHadSoldDate: alreadyHad, noFundingDate: noFunding,
    toSet: plan.length, applied: dryRun ? 0 : applied,
    errors: errors.slice(0, 10),
    sample: plan.slice(0, 12).map((r) => (r.slaId || r.loanId) + ' | ' + r.addr + ' -> ' + r.soldDate),
  });
}
