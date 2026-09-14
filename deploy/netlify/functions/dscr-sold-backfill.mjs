/**
 * dscr-sold-backfill.mjs — POST /api/dscr-sold-backfill
 *
 * Deploy 237.014/237.017 (Mike) — backfill servicing fields on DSCR loans marked
 * Sold. DSCR ONLY (non-DSCR left alone). Two independent, idempotent fills; each
 * only ever fills a BLANK value, never overwrites:
 *
 *   1. Sold Date  (soldDate flag, default ON) = the loan close/funding date.
 *   2. Investor   (investor flag, default OFF) inferred from address lists Mike
 *      supplies: a loan whose address is in `corrFirst` -> CorrFirst, else in
 *      `deepHaven` -> DeepHaven, else `defaultInvestor` (DIYA). CorrFirst wins
 *      the two addresses that are in both lists (its own export is authoritative).
 *      Sets investorName (+ investorId from `investorIds`). Existing tags kept.
 *
 * DRY RUN by default; { apply: true } writes through the PG-first strict
 * writeClient. Investor could NOT come from Baseline — its API exposes no
 * product/investor field (verified), so the lists come from Mike.
 *
 * Body: {
 *   apply?: false,
 *   soldDate?: true,
 *   investor?: false,
 *   deepHaven?: [["street","ST"], ...],
 *   corrFirst?: [["street","ST"], ...],
 *   defaultInvestor?: "DIYA",
 *   investorIds?: { DeepHaven:"inv_...", CorrFirst:"inv_...", DIYA:"inv_..." }
 * }
 * Auth: processor or admin (canOverrideOwner).
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe } from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) { console.error('dscr-sold-backfill error:', e); return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') }); }
};

function ymd(s) {
  s = String(s == null ? '' : s).trim();
  if (!s) return '';
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1];
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(s);
  if (us) return us[3] + '-' + ('0' + us[1]).slice(-2) + '-' + ('0' + us[2]).slice(-2);
  return s.slice(0, 10);
}

// House number + street-name core (suffix + direction folded) + state. Matches
// the two curated investor address lists to the SLA loan addresses despite
// spelling drift ("616 S Napa" vs "616 S Napa St").
const DIRS = { n: 1, s: 1, e: 1, w: 1, ne: 1, nw: 1, se: 1, sw: 1 };
const DMAP = { north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw' };
const SUFS = { st: 1, street: 1, ave: 1, avenue: 1, av: 1, rd: 1, road: 1, dr: 1, drive: 1, blvd: 1, boulevard: 1, ln: 1, lane: 1, ct: 1, court: 1, cir: 1, circle: 1, pl: 1, place: 1, ter: 1, terrace: 1, pkwy: 1, parkway: 1, way: 1, trl: 1, trail: 1, sq: 1, square: 1, hwy: 1, highway: 1, plz: 1, plaza: 1 };
function keyOf(street, state) {
  let s = String(street || '').toLowerCase().replace(/[.,#]/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\b(condo|unit|apt|apartment|ste|suite).*$/, '').trim();
  const toks = s.split(' ');
  const house = toks.shift() || '';
  const rest = toks.map((w) => DMAP[w] || w).filter((w) => !SUFS[w] && !DIRS[w]);
  return house + ' ' + rest.join(' ') + '|' + String(state || '').toLowerCase().trim();
}
function slaKey(addr) {
  const up = String(addr || '').toUpperCase();
  const m = up.match(/\b([A-Z]{2})\b\s*\d{5}/);
  const st = m ? m[1] : ((up.match(/,\s*([A-Z]{2})\s*(,|$)/) || [])[1] || '');
  return keyOf(String(addr || '').split(',')[0], st);
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.apply !== true;
  const doSold = body.soldDate !== false;      // default ON
  const doInv = body.investor === true;        // default OFF
  const now = new Date().toISOString();

  const deepSet = {}, corrSet = {};
  (Array.isArray(body.deepHaven) ? body.deepHaven : []).forEach((a) => { deepSet[keyOf(a[0], a[1])] = 1; });
  (Array.isArray(body.corrFirst) ? body.corrFirst : []).forEach((a) => { corrSet[keyOf(a[0], a[1])] = 1; });
  const defInv = String(body.defaultInvestor || 'DIYA');
  const invIds = (body.investorIds && typeof body.investorIds === 'object') ? body.investorIds : {};
  function investorFor(addr) {
    const k = slaKey(addr);
    if (corrSet[k]) return 'CorrFirst';
    if (deepSet[k]) return 'DeepHaven';
    return defInv;
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await clientsStore.list();
  const CONC = 25;
  let scanned = 0, dscrSold = 0;
  const soldCount = { alreadyHad: 0, noFunding: 0, toSet: 0 };
  const invCount = { alreadyHad: 0, DeepHaven: 0, CorrFirst: 0, DIYA: 0, other: 0 };
  const plan = new Map(); // ownerKey||clientId -> [ { loanId, soldDate?, investorName?, investorId? } ]
  const dhMatches = [], cfMatches = [];

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
        const change = {};
        if (doSold) {
          if (String(loan.soldDate || '').trim()) soldCount.alreadyHad += 1;
          else { const close = ymd(loan.fundingDate); if (!close) soldCount.noFunding += 1; else { change.soldDate = close; soldCount.toSet += 1; } }
        }
        if (doInv) {
          if (String(loan.investorName || '').trim()) invCount.alreadyHad += 1;
          else {
            const inv = investorFor(loan.propertyAddress || loan.address || '');
            change.investorName = inv;
            if (invIds[inv]) change.investorId = invIds[inv];
            if (inv === 'DeepHaven') { invCount.DeepHaven += 1; dhMatches.push((loan.slaDisplayId || loan.id) + ' | ' + (loan.propertyAddress || loan.address || '').slice(0, 40)); }
            else if (inv === 'CorrFirst') { invCount.CorrFirst += 1; cfMatches.push((loan.slaDisplayId || loan.id) + ' | ' + (loan.propertyAddress || loan.address || '').slice(0, 40)); }
            else if (inv === 'DIYA') invCount.DIYA += 1;
            else invCount.other += 1;
          }
        }
        if (Object.keys(change).length) {
          const gk = ownerKey + '||' + c.id;
          if (!plan.has(gk)) plan.set(gk, []);
          plan.get(gk).push(Object.assign({ loanId: loan.id }, change));
        }
      }
    }
  }

  let applied = 0;
  const errors = [];
  if (!dryRun && plan.size) {
    for (const [gk, group] of plan) {
      const [ownerKey, clientId] = gk.split('||');
      try {
        const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
        if (!client || !Array.isArray(client.loans)) { group.forEach((r) => errors.push({ loanId: r.loanId, error: 'client vanished' })); continue; }
        let dirty = false;
        for (const r of group) {
          const loan = client.loans.find((l) => l && l.id === r.loanId);
          if (!loan) { errors.push({ loanId: r.loanId, error: 'loan vanished' }); continue; }
          let changed = false;
          if (r.soldDate && !String(loan.soldDate || '').trim()) { loan.soldDate = r.soldDate; changed = true; }
          if (r.investorName && !String(loan.investorName || '').trim()) {
            loan.investorName = r.investorName;
            if (r.investorId && !String(loan.investorId || '').trim()) loan.investorId = r.investorId;
            changed = true;
          }
          if (changed) { loan.updatedAt = now; dirty = true; applied += 1; }
        }
        if (dirty) await writeClient(ownerKey, client, { clientsStore });
      } catch (e) { group.forEach((r) => errors.push({ loanId: r.loanId, error: 'write failed: ' + ((e && e.message) || '') })); }
    }
  }

  return json(200, {
    ok: true, dryRun, scanned, dscrSold,
    soldDate: doSold ? soldCount : 'skipped',
    investor: doInv ? invCount : 'skipped',
    plannedWrites: [...plan.values()].reduce((n, g) => n + g.length, 0),
    applied: dryRun ? 0 : applied,
    errors: errors.slice(0, 10),
    deepHavenMatches: dhMatches, corrFirstMatches: cfMatches,
  });
}
