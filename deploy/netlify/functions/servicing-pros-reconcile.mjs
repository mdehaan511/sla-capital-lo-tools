/**
 * servicing-pros-reconcile.mjs — POST /api/servicing-pros-reconcile
 *
 * Deploy 236.734 — one-off: take the two Servicing Pros exports (SLA-KAF +
 * SLA.Loans), match each row to its SLA closed loan by address, and stamp the
 * servicing/sold fields — same idea as the FCI reconcile:
 *   • Servicer = Servicing Pros, Servicer Loan # = the sheet's Account
 *   • Investor = King Arthur Fund 1 LLC (KAF sheet) / Sir Lends A Lot LLC (SLA
 *     sheet); investorName + investorId (for the Funding Plan dropdown)
 *   • Sold Rate = Buy Rate = the sheet's InterestRate (Lender rate == note rate,
 *     so no spread) → soldRate + buyRate
 *   • Sold Date = the loan's own SLA funding date (no origination col in sheet)
 *   • Maturity = MaturityDate
 *   • status "Paid Off" → disposition 'paid_off' + Payoff Amount (Original
 *     Balance = principal) + Payoff Date (LastPaymentDate)
 *   • else (Performing/active) → disposition 'sold' + toolType 'rtl' (Sold-RTL
 *     shows in BOTH the Sold-RTL AND Servicing tabs) + Payment (RegularPayment)
 *
 * DRY RUN by default. { apply:true } to write (idempotent, stable offset window
 * + no-op skip). Never blindly overwrites a hand-set disposition that DIFFERS
 * unless { overwriteManual:true }. Admin/processor only; strict writeClient.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';

// ── Embedded dataset (from the two Servicing Pros spreadsheets) ──────
const SP_ROWS = JSON.parse(`[{"book":"kaf","account":"26-0012-SL","status":"Paid Off","address":"4011 N Calispel St","city":"Spokane","state":"WA","zip":"99205","maturity":"1/1/2027","originalBalance":"180000.0","currentBalance":"","payment":"1800.0","rate":"12.0","lastPayment":"3/10/2026","nextDue":"4/1/2026"},{"book":"kaf","account":"26-0085-SL","status":"Paid Off","address":"589 Diamond Loop","city":"Middletown","state":"OH","zip":"45044","maturity":"4/1/2027","originalBalance":"175000.0","currentBalance":"","payment":"1750.0","rate":"12.0","lastPayment":"5/6/2026","nextDue":"6/1/2026"},{"book":"kaf","account":"26-0079-SL","status":"Performing","address":"2517 East Girard Place","city":"Spokane","state":"WA","zip":"99223","maturity":"4/1/2027","originalBalance":"335000.0","currentBalance":"335000.0","payment":"3070.82999999999993","rate":"11.0","lastPayment":"8/3/2026","nextDue":"9/1/2026"},{"book":"kaf","account":"26-0072-SL","status":"Paid Off","address":"8 Orange Blossom Cir","city":"Little Rock","state":"AR","zip":"72210","maturity":"3/1/2027","originalBalance":"175500.0","currentBalance":"","payment":"1608.75","rate":"11.0","lastPayment":"6/1/2026","nextDue":"7/1/2026"},{"book":"kaf","account":"26-0188-SL","status":"Performing","address":"218 Pleasant Street","city":"Covington","state":"KY","zip":"41011","maturity":"7/1/2027","originalBalance":"77000.0","currentBalance":"77000.0","payment":"770.0","rate":"12.0","lastPayment":"8/3/2026","nextDue":"9/1/2026"},{"book":"kaf","account":"26-0052-SL","status":"Paid Off","address":"720 Highland Ave","city":"Fort Wright","state":"KY","zip":"41011","maturity":"4/1/2027","originalBalance":"150000.0","currentBalance":"","payment":"1500.0","rate":"12.0","lastPayment":"5/4/2026","nextDue":"5/1/2026"},{"book":"kaf","account":"26-0091-SL","status":"Paid Off","address":"311 E Ross Ave","city":"Cincinnati","state":"OH","zip":"45217","maturity":"4/1/2027","originalBalance":"170825.0","currentBalance":"","payment":"1708.25","rate":"12.0","lastPayment":"8/3/2026","nextDue":"9/1/2026"},{"book":"kaf","account":"26-0146-SL","status":"Paid Off","address":"1517 E 9th Avenue","city":"Spokane","state":"WA","zip":"99202","maturity":"6/1/2027","originalBalance":"238832.64000000001397","currentBalance":"","payment":"1855.75","rate":"10.99","lastPayment":"8/3/2026","nextDue":"9/1/2026"},{"book":"kaf","account":"26-0222-SL","status":"Performing","address":"23205 N Madison Road","city":"Mead","state":"WA","zip":"99021","maturity":"8/1/2027","originalBalance":"330000.0","currentBalance":"330000.0","payment":"3025.0","rate":"11.0","lastPayment":"","nextDue":"9/1/2026"},{"book":"kaf","account":"26-0068-SL","status":"Paid Off","address":"102 Hazen Ave","city":"Morrow","state":"OH","zip":"45152","maturity":"4/1/2027","originalBalance":"150000.0","currentBalance":"","payment":"1500.0","rate":"12.0","lastPayment":"7/6/2026","nextDue":"8/1/2026"},{"book":"kaf","account":"26-0174-SL","status":"Performing","address":"105-107 Coral Street","city":"Paterson","state":"NJ","zip":"07522","maturity":"7/1/2027","originalBalance":"552850.0","currentBalance":"502850.0","payment":"4605.27000000000044","rate":"10.99","lastPayment":"8/10/2026","nextDue":"9/1/2026"},{"book":"kaf","account":"26-0049-SL","status":"Paid Off","address":"8253 Brownsway Ln","city":"Cincinnati","state":"OH","zip":"45239","maturity":"3/1/2027","originalBalance":"175000.0","currentBalance":"","payment":"1750.0","rate":"12.0","lastPayment":"","nextDue":"4/1/2026"},{"book":"kaf","account":"26-0145-SL","status":"Performing","address":"2504 N Stagecoach Drive","city":"Post Falls","state":"ID","zip":"83854","maturity":"6/1/2027","originalBalance":"425000.0","currentBalance":"425000.0","payment":"4250.0","rate":"12.0","lastPayment":"8/3/2026","nextDue":"9/1/2026"},{"book":"kaf","account":"26-0041-SL","status":"Paid Off","address":"1410 Russell Street","city":"Covington","state":"KY","zip":"41011","maturity":"6/1/2026","originalBalance":"180000.0","currentBalance":"","payment":"1800.0","rate":"12.0","lastPayment":"5/4/2026","nextDue":"5/1/2026"},{"book":"kaf","account":"26-0050-SL","status":"Paid Off","address":"2324 Langdon Farm Rd","city":"Cincinnati","state":"OH","zip":"45237","maturity":"3/1/2027","originalBalance":"160000.0","currentBalance":"","payment":"1600.0","rate":"12.0","lastPayment":"","nextDue":"4/1/2026"},{"book":"sla","account":"26-0189-SL","status":"Performing","address":"6900 W Tallmadge Place","city":"Milwaukee","state":"WI","zip":"53218","maturity":"7/1/2027","originalBalance":"118000.0","currentBalance":"118000.0","payment":"1180.0","rate":"12.0","lastPayment":"7/31/2026","nextDue":"9/1/2026"},{"book":"sla","account":"26-0166-SL","status":"Performing","address":"949 Philadelphia Street","city":"Covington","state":"KY","zip":"41011","maturity":"6/1/2027","originalBalance":"245125.0","currentBalance":"165125.0","payment":"1376.039999999999964","rate":"10.0","lastPayment":"8/3/2026","nextDue":"9/1/2026"}]`);

const SERVICER = 'Servicing Pros';
// Investor per source sheet — name (servicing view) + id (Funding Plan dropdown).
const INVESTORS = {
  kaf: { name: 'King Arthur Fund 1 LLC', id: 'inv_1785352851496_76w1' },
  sla: { name: 'Sir Lends A Lot LLC',    id: 'inv_1787696616415_nqc9' },
};

// Parse "M/D/YYYY" (these sheets) or an Excel serial → YYYY-MM-DD.
function toISO(v) {
  if (v == null) return '';
  const s = String(v).trim();
  if (!s) return '';
  let m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    let y = +m[3]; if (y < 100) y += 2000;
    return y + '-' + String(+m[1]).padStart(2, '0') + '-' + String(+m[2]).padStart(2, '0');
  }
  m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  const n = parseFloat(s);
  if (isFinite(n) && n > 20000 && n < 90000) {
    const d = new Date((Math.floor(n) - 25569) * 86400 * 1000);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  return '';
}

const SUFFIX = { street:'st', avenue:'ave', drive:'dr', road:'rd', lane:'ln', court:'ct',
  place:'pl', boulevard:'blvd', circle:'cir', trail:'trl', terrace:'ter', parkway:'pkwy', highway:'hwy' };
const DIR = { north:'n', south:'s', east:'e', west:'w',
  northeast:'ne', northwest:'nw', southeast:'se', southwest:'sw',
  n:'n', s:'s', e:'e', w:'w', ne:'ne', nw:'nw', se:'se', sw:'sw' };
const ORD = { first:'1', second:'2', third:'3', fourth:'4', fifth:'5', sixth:'6',
  seventh:'7', eighth:'8', ninth:'9', tenth:'10', eleventh:'11', twelfth:'12' };
// Normalize a FULL address so the sheet's street can be prefix-matched against a
// (comma or no-comma) SLA address. Mirrors the FCI reconcile normalizer.
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

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('servicing-pros-reconcile error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });

  const body = (await readJsonBody(req)) || {};
  const apply = body.apply === true;
  const overwriteManual = body.overwriteManual === true;
  const limit = (Number(body.limit) > 0) ? Math.floor(Number(body.limit)) : 40;
  const selfEmail = normalizeEmail(user.email);

  // ── Index every SLA loan by house-number, storing its normalized full address
  //    (+ state, toolType, fundingDate) for prefix matching. ──────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const hnIndex = new Map();
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
        if (!loan || !loan.address) continue;
        const hn = houseNum(loan.address); if (!hn) continue;
        if (!hnIndex.has(hn)) hnIndex.set(hn, []);
        hnIndex.get(hn).push({
          ownerKey, clientId: c.id, loanId: loan.id, address: loan.address,
          nf: normFull(loan.address), state: stateOf(loan.address),
          toolType: String(loan.toolType || '').toLowerCase(),
          fundingDate: loan.fundingDate || '',
        });
      }
    }
  }

  // ── Match each sheet row ──────────────────────────────────────────
  const toSet = [], unmatched = [], ambiguous = [], errors = [];
  let matchedRows = 0;
  for (const row of SP_ROWS) {
    const fciNf = normFull(row.address);
    const st = String(row.state || '').toUpperCase();
    const candidates = hnIndex.get(houseNum(row.address)) || [];
    let matches = candidates.filter((h) => h.nf === fciNf || h.nf.startsWith(fciNf + ' '));
    const seen = new Set();
    matches = matches.filter((h) => { const kk = h.ownerKey + '|' + h.clientId + '|' + h.loanId; if (seen.has(kk)) return false; seen.add(kk); return true; });

    if (matches.length === 0) {
      unmatched.push({ address: row.address, city: row.city, state: row.state, book: row.book, account: row.account, nearMatches: candidates.map((h) => h.address).slice(0, 4) });
      continue;
    }
    let distinctAddrs = new Set(matches.map((h) => h.nf));
    if (distinctAddrs.size > 1 && st) {
      const byState = matches.filter((h) => !h.state || h.state === st);
      if (byState.length && new Set(byState.map((h) => h.nf)).size === 1) matches = byState;
      distinctAddrs = new Set(matches.map((h) => h.nf));
    }
    // These are RTL/bridge funds — prefer the RTL record if still ambiguous.
    if (distinctAddrs.size > 1) {
      const rtlOnly = matches.filter((h) => h.toolType === 'rtl');
      if (rtlOnly.length && new Set(rtlOnly.map((h) => h.nf)).size === 1) {
        matches = rtlOnly; distinctAddrs = new Set(matches.map((h) => h.nf));
      }
    }
    if (distinctAddrs.size > 1) {
      ambiguous.push({ address: row.address, state: row.state, book: row.book, matches: [...new Set(matches.map((h) => h.address))] });
      continue;
    }

    matchedRows += 1;
    const paidOff = /paid/i.test(row.status);
    const inv = INVESTORS[row.book] || { name: '', id: '' };
    const base = {
      servicerName: SERVICER,
      servicerLoanNumber: String(row.account || ''),
      investorName: inv.name,
      investorId: inv.id,
      soldRate: String(row.rate || ''),
      buyRate: String(row.rate || ''),
      maturityDate: toISO(row.maturity),
    };
    if (paidOff) {
      base.payoffAmount = String(row.originalBalance || '');
      base.payoffDate = toISO(row.lastPayment);
    } else {
      base.paymentAmount = String(row.payment || '');
      base.toolType = 'rtl';
    }
    for (const h of matches) {
      // Sold Date = the matched loan's own SLA funding date (per Mike — par sale
      // to the affiliated fund at funding; no origination column in the sheet).
      const fields = Object.assign({}, base, { soldDate: toISO(h.fundingDate) });
      toSet.push({
        book: row.book, status: row.status, address: row.address, matchedAddress: h.address,
        ownerKey: h.ownerKey, clientId: h.clientId, loanId: h.loanId,
        disposition: paidOff ? 'paid_off' : 'sold', fields,
      });
    }
  }

  // Deterministic order so the offset window is stable across calls.
  toSet.sort((a, b) =>
    (a.ownerKey + '|' + a.clientId + '|' + a.loanId).localeCompare(
      b.ownerKey + '|' + b.clientId + '|' + b.loanId));

  // ── Apply (stable offset window, grouped by client; skip no-op writes) ──
  const offset = (Number(body.offset) > 0) ? Math.floor(Number(body.offset)) : 0;
  const applyBatch = apply ? toSet.slice(offset, offset + limit) : [];
  let applied = 0, unchanged = 0;
  if (applyBatch.length) {
    const now = new Date().toISOString();
    const byClient = new Map();
    for (const r of applyBatch) {
      const kk = r.ownerKey + '||' + r.clientId;
      if (!byClient.has(kk)) byClient.set(kk, []);
      byClient.get(kk).push(r);
    }
    for (const [kk, rows] of byClient) {
      const [ownerKey, clientId] = kk.split('||');
      try {
        const ck = ownerKey + '/' + keySafe(clientId);
        const client = await clientsStore.get(ck, { type: 'json' }).catch(() => null);
        if (!client || !Array.isArray(client.loans)) { rows.forEach((r) => errors.push({ address: r.address, error: 'client vanished' })); continue; }
        let dirty = false;
        for (const r of rows) {
          const loan = client.loans.find((l) => l && l.id === r.loanId);
          if (!loan) { errors.push({ address: r.address, error: 'loan vanished' }); continue; }
          let changed = false;
          const cur = String(loan.disposition || '').toLowerCase();
          if (!(cur && cur !== r.disposition && !overwriteManual)) {
            if (cur !== r.disposition) {
              loan.disposition = r.disposition;
              loan.dispositionAt = now; loan.dispositionBy = selfEmail;
              changed = true;
            }
          }
          Object.keys(r.fields).forEach((f) => {
            const nv = r.fields[f];
            if (nv !== '' && String(loan[f] == null ? '' : loan[f]) !== String(nv)) { loan[f] = nv; changed = true; }
          });
          if (changed) { loan._spReconciledAt = now; loan.updatedAt = now; dirty = true; applied += 1; }
          else unchanged += 1;
        }
        if (dirty) await writeClient(ownerKey, client, { clientsStore });
      } catch (e) {
        rows.forEach((r) => errors.push({ address: r.address, error: 'write failed: ' + (e && e.message) }));
      }
    }
  }

  const nextOffset = offset + applyBatch.length;
  return json(200, {
    ok: true, apply, overwriteManual,
    sheetRows: SP_ROWS.length,
    summary: {
      matchedRows: matchedRows,
      loanTargets: toSet.length,
      offset: offset, nextOffset: nextOffset, batch: applyBatch.length,
      applied: apply ? applied : 0,
      unchanged: apply ? unchanged : 0,
      remaining: apply ? Math.max(0, toSet.length - nextOffset) : toSet.length,
      unmatched: unmatched.length,
      ambiguous: ambiguous.length,
      errors: errors.length,
      soldMatched: toSet.filter((r) => r.disposition === 'sold').length,
      paidOffMatched: toSet.filter((r) => r.disposition === 'paid_off').length,
    },
    unmatched, ambiguous, errors,
    sample: toSet.slice(0, 8).map((r) => r.book + '/' + r.status + ' | ' + r.address + ' → ' + r.matchedAddress + ' | ' + r.disposition + ' | rate ' + r.fields.soldRate + ' soldDate ' + r.fields.soldDate + (r.fields.payoffDate ? ' payoff ' + r.fields.payoffDate + ' / ' + r.fields.payoffAmount : '')),
  });
}
