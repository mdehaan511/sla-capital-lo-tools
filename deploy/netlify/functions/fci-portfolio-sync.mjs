/**
 * fci-portfolio-sync.mjs — POST /api/fci-portfolio-sync
 *
 * Deploy 236.802 (Mike) — the live replacement for fci-reconcile-servicing.mjs,
 * which carried FCI's book as a spreadsheet pasted into the source. This reads
 * the same numbers from FCI's API and refreshes the servicing fields on our
 * closed loans. Runs nightly; also callable by hand.
 *
 * ── Matching: by ID first, address only as a fallback ────────────────
 * The 236.720-728 reconcile already stamped `servicerLoanNumber` (FCI's account
 * number) onto 93 loan records, so almost every loan matches on an exact ID with
 * no guessing. That linkage is the durable fix and it lives on OUR side — it
 * does not depend on FCI populating `originatorLoanNumber`, which is set on just
 * 3 of 95 loans today.
 *
 * Only accounts that fail the ID match fall through to an address match, and
 * only those cost the extra getLoanProperties call (FCI's portfolio query
 * returns city/state but no street). Once matched, we stamp servicerLoanNumber
 * so that loan is ID-matched forever after.
 *
 * ── What it will NOT do ──────────────────────────────────────────────
 *  • It never maps FCI's "Assigned" or "CLOSED" statuses to a disposition.
 *    Verified against the live book: all 28 Assigned loans carry a zero balance,
 *    but 17 say closedReason "PAYOFF FULL" and 11 say nothing at all, and none
 *    has a paidOffDate. Guessing would silently mark live deals paid off. They
 *    are reported under `needsReview` for a human to decide.
 *  • It never overwrites investorName / investorId. The old reconcile stamped
 *    every one of these as Colchis; FCI reports 11 distinct note buyers
 *    (Pacific RBLF Funding Trust has 46, FI Mortgage Trust 2022-1 has 15, and so
 *    on). That contradiction is real and is Mike's call, not a sync's — we
 *    record FCI's answer in `fciLenderName` and count the disagreements in
 *    `investorMismatch` so it can be reviewed, not silently rewritten.
 *  • It never demotes a hand-set disposition unless { overwriteManual: true }.
 *
 * Body: { dryRun (default TRUE), limit, offset, overwriteManual, hoursAgo }
 *   hoursAgo: when set, only reconcile accounts FCI touched in that window
 *             (uses getUpdatedLoanList). The nightly run passes 26.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import {
  fciConfigured, fciPortfolio, fciUpdatedAccounts, fciProperties, fciPct, fciDate, fciNum,
} from './_shared/fci-api.mjs';

const SERVICER = 'FCI';

// Address normalization — same rules as fci-reconcile-servicing.mjs so the
// fallback path behaves identically to the reconcile that produced the existing
// links. Kept local rather than shared: the reconcile is a frozen one-off and
// should not start moving when this file changes.
const SUFFIX = { street: 'st', avenue: 'ave', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct',
  place: 'pl', boulevard: 'blvd', circle: 'cir', trail: 'trl', terrace: 'ter', parkway: 'pkwy', highway: 'hwy' };
const DIR = { north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
  n: 'n', s: 's', e: 'e', w: 'w', ne: 'ne', nw: 'nw', se: 'se', sw: 'sw' };
const ORD = { first: '1', second: '2', third: '3', fourth: '4', fifth: '5', sixth: '6',
  seventh: '7', eighth: '8', ninth: '9', tenth: '10', eleventh: '11', twelfth: '12' };

function normFull(s) {
  let x = String(s || '').toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/(\d+)\s*-\s*\d+/, '$1')
    .replace(/\b(apt|unit|ste|suite|apartment|bldg|building|lot|rm|room)\b[\s\S]*$/, '')
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ').trim();
  x = x.split(' ').map((w) => SUFFIX[w] || DIR[w] || ORD[w] || w).join(' ');
  return x.replace(/\s+(usa|us)$/, '').replace(/\s+/g, ' ').trim();
}
function houseNum(s) { const m = /(\d+)/.exec(String(s || '')); return m ? m[1] : ''; }
function stateOf(addr) {
  const m = /,\s*([A-Za-z]{2})\s+\d{5}/.exec(String(addr || ''));
  if (m) return m[1].toUpperCase();
  const m2 = /\b([A-Za-z]{2})\s+\d{5}/.exec(String(addr || ''));
  return m2 ? m2[1].toUpperCase() : '';
}

// FCI loanStatus → our disposition. Only the two unambiguous cases map;
// everything else is reported, never written. See the header.
function dispositionFor(status) {
  const s = String(status || '').toUpperCase().trim();
  if (s === 'PERFORMING') return 'sold';
  if (s === 'PAID OFF') return 'paid_off';
  return '';
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('fci-portfolio-sync error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });
  if (!fciConfigured()) return json(503, { error: 'FCI_API_TOKEN is not set on this site' });

  const body = (await readJsonBody(req)) || {};
  // DRY RUN unless explicitly told otherwise — same discipline as the reconcile.
  const dryRun = body.dryRun !== false;
  const overwriteManual = body.overwriteManual === true;
  const limit = (Number(body.limit) > 0) ? Math.floor(Number(body.limit)) : 60;
  const offset = (Number(body.offset) > 0) ? Math.floor(Number(body.offset)) : 0;
  const selfEmail = normalizeEmail(user.email);

  const result = await runSync({ dryRun, overwriteManual, limit, offset, actor: selfEmail, hoursAgo: body.hoursAgo });
  return json(200, result);
}

/**
 * The sync itself, split out so the nightly cron can call it without an HTTP
 * round trip or a service token.
 */
export async function runSync({ dryRun, overwriteManual, limit, offset, actor, hoursAgo }) {
  let rows = await fciPortfolio();
  const totalFromFci = rows.length;

  // Incremental mode: narrow to what FCI actually touched. Falls back to the
  // full book if the delta call fails — a stale sync beats no sync.
  let deltaAccounts = null;
  if (hoursAgo) {
    try {
      const touched = new Set(await fciUpdatedAccounts(hoursAgo));
      deltaAccounts = touched.size;
      rows = rows.filter((r) => touched.has(r.loanAccount));
    } catch (e) {
      console.warn('[fci-sync] delta query failed, syncing full book:', e && e.message);
    }
  }

  // ── Index our loans: by FCI account (exact) and by house number (fallback) ──
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const byServicerNum = new Map();  // fci account -> [loanRef]
  const byHouseNum = new Map();     // house number -> [loanRef]
  const { blobs } = await clientsStore.list();
  const CONC = 40;
  for (let i = 0; i < blobs.length; i += CONC) {
    const chunk = blobs.slice(i, i + CONC);
    const recs = await Promise.all(chunk.map(({ key }) =>
      clientsStore.get(key, { type: 'json' }).then((c) => ({ key, c })).catch(() => ({ key, c: null }))));
    for (const { key, c } of recs) {
      const slash = key.indexOf('/'); if (slash < 0) continue;
      const ownerKey = key.slice(0, slash);
      if (!c || !Array.isArray(c.loans)) continue;
      for (const loan of c.loans) {
        if (!loan || !loan.id) continue;
        const ref = {
          ownerKey, clientId: c.id, loanId: loan.id,
          address: loan.address || '', nf: normFull(loan.address), state: stateOf(loan.address),
          toolType: String(loan.toolType || '').toLowerCase(),
          investorName: loan.investorName || '',
          disposition: String(loan.disposition || '').toLowerCase(),
        };
        const sn = String(loan.servicerLoanNumber || '').trim();
        if (sn) {
          if (!byServicerNum.has(sn)) byServicerNum.set(sn, []);
          byServicerNum.get(sn).push(ref);
        }
        const hn = houseNum(loan.address);
        if (hn) {
          if (!byHouseNum.has(hn)) byHouseNum.set(hn, []);
          byHouseNum.get(hn).push(ref);
        }
      }
    }
  }

  // ── Resolve each FCI row to our loan(s) ──────────────────────────────
  const plan = [], unmatched = [], ambiguous = [], needsReview = [], errors = [];
  let matchedById = 0, matchedByAddress = 0, investorMismatch = 0;

  for (const row of rows) {
    const acct = String(row.loanAccount || '');
    if (!acct) continue;

    const disp = dispositionFor(row.loanStatus);
    if (!disp) {
      // "Assigned" (28) and "CLOSED" (1) — deliberately not auto-mapped.
      needsReview.push({
        account: acct, status: row.loanStatus, closedReason: row.closedReason || '',
        closedDate: fciDate(row.closedDate), currentBalance: fciNum(row.currentBalance),
        borrower: String(row.name || '').split('\n')[0], city: row.city, state: row.state,
        linked: byServicerNum.has(acct),
      });
      continue;
    }

    let matches = byServicerNum.get(acct) || [];
    let via = 'servicerLoanNumber';

    if (!matches.length) {
      // Fallback: one extra FCI call for the street address, then the same
      // house-number + prefix match the reconcile used.
      let street = '';
      try {
        const props = await fciProperties(acct);
        const primary = props.find((p) => p && p.isPrimary) || props[0];
        street = (primary && primary.street) || '';
      } catch (e) {
        errors.push({ account: acct, error: 'property lookup failed: ' + ((e && e.message) || '') });
        continue;
      }
      if (!street) { unmatched.push({ account: acct, reason: 'no street address from FCI', city: row.city, state: row.state }); continue; }

      const fciNf = normFull(street);
      const st = String(row.state || '').toUpperCase();
      const cands = byHouseNum.get(houseNum(street)) || [];
      matches = cands.filter((h) => h.nf === fciNf || h.nf.startsWith(fciNf + ' '));
      const seen = new Set();
      matches = matches.filter((h) => { const k = h.ownerKey + '|' + h.clientId + '|' + h.loanId; if (seen.has(k)) return false; seen.add(k); return true; });

      let distinct = new Set(matches.map((h) => h.nf));
      if (distinct.size > 1 && st) {
        const byState = matches.filter((h) => !h.state || h.state === st);
        if (byState.length && new Set(byState.map((h) => h.nf)).size === 1) { matches = byState; distinct = new Set(matches.map((h) => h.nf)); }
      }
      if (distinct.size > 1) {
        // FCI notes are RTL/bridge — same tiebreaker that resolved 708 E Kiernan.
        const rtl = matches.filter((h) => h.toolType === 'rtl');
        if (rtl.length && new Set(rtl.map((h) => h.nf)).size === 1) { matches = rtl; distinct = new Set(matches.map((h) => h.nf)); }
      }
      if (!matches.length) { unmatched.push({ account: acct, street, city: row.city, state: row.state, nearMatches: cands.slice(0, 4).map((h) => h.address) }); continue; }
      if (distinct.size > 1) { ambiguous.push({ account: acct, street, matches: [...new Set(matches.map((h) => h.address))] }); continue; }
      via = 'address';
    }

    if (via === 'servicerLoanNumber') matchedById += 1; else matchedByAddress += 1;

    // ── Field mapping ────────────────────────────────────────────────
    const fields = {
      servicerName: SERVICER,
      servicerLoanNumber: acct,     // stamps the link so address matching is a one-time cost
      soldRate: fciPct(row.investorRate),
      buyRate: fciPct(row.investorRate),
      maturityDate: fciDate(row.maturityDate),
      // FCI's answer for who owns the note. Recorded, never promoted over
      // investorName/investorId — see the header.
      fciLenderName: String(row.lenderName || '').trim(),
      fciLoanStatus: String(row.loanStatus || '').trim(),
      // Deploy 236.808 — servicer-side borrower contact. Kept in fci* fields
      // rather than written onto client.email, because this is FCI's copy and
      // the client record is ours; a sync should not quietly rewrite a borrower's
      // contact details. Read as a FALLBACK by the maturity notice, which had
      // nobody to write to on the Baseline-imported loans (their client records
      // carry no name, email or company at all, while FCI has all 41).
      fciBorrowerEmail: String(row.borrowerEmail || '').trim().toLowerCase(),
      fciBorrowerName: String(row.borrowerFullName || '').replace(/\s*\n\s*/g, ' / ').trim(),
      fciSyncedAt: new Date().toISOString(),
    };

    if (disp === 'sold') {
      fields.toolType = 'rtl';
      fields.paymentAmount = row.totalPayment != null ? String(row.totalPayment) : '';
      // Live servicing numbers — none of this existed before the API.
      const bal = fciNum(row.currentBalance);
      if (bal != null) fields.currentBalance = String(bal);
      fields.nextDueDate = fciDate(row.nextDueDate);
      fields.paidToDate = fciDate(row.paidToDate);
      const dl = fciNum(row.daysLate);
      if (dl != null) fields.daysLate = String(dl);
    } else {
      // PAID OFF: all 25 carry both paidOffDate and closedDate; prefer the
      // explicit payoff date and fall back to the close date.
      fields.payoffDate = fciDate(row.paidOffDate) || fciDate(row.closedDate);
      fields.payoffAmount = row.originalBalance != null ? String(row.originalBalance) : '';
      // A paid-off loan has no live balance or delinquency — clear the noise.
      fields.currentBalance = '0';
      fields.daysLate = '0';
    }

    for (const h of matches) {
      if (fields.fciLenderName && h.investorName && h.investorName !== fields.fciLenderName) investorMismatch += 1;
      plan.push({
        account: acct, via, disposition: disp,
        address: h.address, ownerKey: h.ownerKey, clientId: h.clientId, loanId: h.loanId,
        fields,
      });
    }
  }

  // Stable order so an offset window advances instead of rewriting the same
  // first N every call — the bug that made the 236.725 apply loop forever.
  plan.sort((a, b) => (a.ownerKey + '|' + a.clientId + '|' + a.loanId)
    .localeCompare(b.ownerKey + '|' + b.clientId + '|' + b.loanId));

  // ── Apply ────────────────────────────────────────────────────────────
  const batch = dryRun ? [] : plan.slice(offset, offset + limit);
  let applied = 0, unchanged = 0, dispositionSkipped = 0;
  if (batch.length) {
    const now = new Date().toISOString();
    const byClient = new Map();
    for (const r of batch) {
      const k = r.ownerKey + '||' + r.clientId;
      if (!byClient.has(k)) byClient.set(k, []);
      byClient.get(k).push(r);
    }
    for (const [k, group] of byClient) {
      const [ownerKey, clientId] = k.split('||');
      try {
        const client = await clientsStore.get(ownerKey + '/' + keySafe(clientId), { type: 'json' }).catch(() => null);
        if (!client || !Array.isArray(client.loans)) { group.forEach((r) => errors.push({ account: r.account, error: 'client vanished' })); continue; }
        let dirty = false;
        for (const r of group) {
          const loan = client.loans.find((l) => l && l.id === r.loanId);
          if (!loan) { errors.push({ account: r.account, error: 'loan vanished' }); continue; }
          let changed = false;
          const cur = String(loan.disposition || '').toLowerCase();
          if (cur && cur !== r.disposition && !overwriteManual) {
            dispositionSkipped += 1;   // hand-set and disagrees — leave it alone
          } else if (cur !== r.disposition) {
            loan.disposition = r.disposition;
            loan.dispositionAt = now;
            loan.dispositionBy = actor;
            changed = true;
          }
          for (const f of Object.keys(r.fields)) {
            const nv = r.fields[f];
            if (f === 'fciSyncedAt') continue;   // bookkeeping only; never counts as a change
            if (nv !== '' && String(loan[f] == null ? '' : loan[f]) !== String(nv)) { loan[f] = nv; changed = true; }
          }
          if (changed) {
            loan.fciSyncedAt = now;
            loan.updatedAt = now;
            dirty = true;
            applied += 1;
          } else unchanged += 1;
        }
        if (dirty) await writeClient(ownerKey, client, { clientsStore });
      } catch (e) {
        group.forEach((r) => errors.push({ account: r.account, error: 'write failed: ' + ((e && e.message) || '') }));
      }
    }
  }

  const nextOffset = offset + batch.length;
  return {
    ok: true,
    dryRun,
    fci: {
      totalLoans: totalFromFci,
      considered: rows.length,
      deltaAccounts,                    // null unless hoursAgo was passed
      performingUpb: rows.filter((r) => String(r.loanStatus).toUpperCase() === 'PERFORMING')
        .reduce((a, r) => a + (fciNum(r.currentBalance) || 0), 0),
    },
    matching: { byId: matchedById, byAddress: matchedByAddress, loanTargets: plan.length },
    write: {
      offset, nextOffset, batch: batch.length,
      applied, unchanged,
      remaining: dryRun ? plan.length : Math.max(0, plan.length - nextOffset),
      dispositionSkipped,               // hand-set dispositions we refused to clobber
    },
    review: {
      needsReview: needsReview.length,  // FCI "Assigned" / "CLOSED" — decide by hand
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      investorMismatch,                 // loan.investorName disagrees with FCI's lenderName
      errors: errors.length,
    },
    needsReview: needsReview.slice(0, 40),
    unmatched, ambiguous, errors,
    sample: plan.slice(0, 8).map((r) =>
      r.account + ' [' + r.via + '] ' + r.disposition + ' | ' + r.address.slice(0, 44) +
      ' | buyRate ' + r.fields.buyRate + ' | ' + (r.fields.fciLenderName || '')),
  };
}
