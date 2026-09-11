/**
 * servicingpros-portfolio-sync.mjs — POST /api/servicingpros-portfolio-sync
 *
 * Deploy 236.983 (Mike: "Lets make it so it syncs up similar to the FCI stuff.")
 * The live replacement for servicing-pros-reconcile.mjs (236.734), which carried
 * the two Servicing Pros exports as spreadsheets pasted into the source. This
 * reads the same numbers from their API — both lender accounts (SLA and
 * SLA-KAF, one key each) — and refreshes the servicing fields on our loans.
 * Runs nightly (servicingpros-portfolio-sync-cron); also callable by hand.
 *
 * ── Matching: by servicer loan number ONLY ─────────────────────────────
 * Their LoanAccount ("26-0079-SL") is exactly what the reconcile stamped into
 * loan.servicerLoanNumber on the Servicing Pros loans, so it is an exact-ID
 * match. There is NO address fallback: their feed carries the borrower's
 * mailing address, not the property (5715 W Excell Ave is where the 2517 E
 * Girard borrower gets mail). A loan on their side with no portal link is
 * reported under `unmatched` with enough to tag it by hand; a portal loan
 * tagged Servicing Pros whose number is in neither feed is reported under
 * `taggedNotInFeed` (typo, or a third account).
 *
 * ── What it writes (mirrors fci-portfolio-sync) ──────────────────────
 *   servicerName 'Servicing Pros' (also fixes the "Servicing Pro's" spelling),
 *   investorName/investorId for the book the loan sits in (SLA vs KAF) — set
 *   when blank, otherwise counted in `investorMismatch` and recorded in
 *   spInvestorName, never promoted over a hand-set investor — soldRate/buyRate
 *   = their note rate (lender rate == note rate), maturityDate, and:
 *     active   → disposition 'sold', toolType 'rtl', paymentAmount,
 *                currentBalance (their principal balance), nextDueDate,
 *                paidToDate, daysLate
 *     paid off → disposition 'paid_off' (their PaidOffDate is explicit — no
 *                FCI-style guessing), payoffDate, payoffAmount (original
 *                balance), currentBalance 0, daysLate 0
 *   plus sp* bookkeeping: spAccount, spLoanRecId, spServiceStatus,
 *   spLastPaymentDate, spUnpaidLateCharges, spCategories, spSyncedAt.
 *
 * ── What it will NOT do ────────────────────────────────────────────
 *  • Never demotes a hand-set disposition that DIFFERS unless
 *    { overwriteManual: true } — same rule as FCI.
 *  • Never rewrites client contact details from their borrower fields.
 *  • Never guesses a link by address.
 *
 * Body: { dryRun (default TRUE), limit, offset, overwriteManual, accounts:['SLA','SLA_KAF'] }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import {
  SERVICER, ACCOUNTS, spConfiguredAccounts, spLoans, spProfile, spKeyClaimsFor, normalizeServicerNumber,
  dispositionForSp, pickLoanForSpRow, bookForLenderName, isOurLoan,
} from './_shared/servicingpros-api.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('servicingpros-portfolio-sync error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

function num(v) { const n = Number(String(v == null ? '' : v).replace(/[$,]/g, '')); return isFinite(n) ? n : null; }
function isSpName(s) { return /servicing\s*pro'?s/i.test(String(s || '')); }

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!canOverrideOwner(user).ok) return json(403, { error: 'Processor or admin only' });
  const accounts = spConfiguredAccounts();
  if (!accounts.length) return json(503, { error: 'No Servicing Pros key is set (SERVICINGPROS_API_KEY_SLA / _SLA_KAF)' });

  const body = (await readJsonBody(req)) || {};
  const dryRun = body.dryRun !== false;          // DRY RUN unless told otherwise
  const overwriteManual = body.overwriteManual === true;
  const limit = (Number(body.limit) > 0) ? Math.floor(Number(body.limit)) : 100;
  const offset = (Number(body.offset) > 0) ? Math.floor(Number(body.offset)) : 0;
  const only = Array.isArray(body.accounts) && body.accounts.length ? body.accounts.map((k) => String(k).toUpperCase().replace('-', '_')) : null;
  const selfEmail = normalizeEmail(user.email);

  const result = await runSync({ dryRun, overwriteManual, limit, offset, actor: selfEmail, only });
  return json(200, result);
}

/** The sync itself — the nightly cron imports this directly. */
export async function runSync({ dryRun, overwriteManual, limit, offset, actor, only }) {
  const accounts = spConfiguredAccounts().filter((a) => !only || only.includes(a.key));
  const errors = [];
  const perAccount = {};
  let rows = [];
  const seenRec = new Map();   // LoanRecID → book that delivered it first
  let duplicateAcrossBooks = 0;
  for (const a of accounts) {
    const claims = spKeyClaimsFor(a) || {};
    try {
      // Deploy 236.984 — say which lender account the key really opens. The
      // first dry run had both keys answering with the same 9 loans: the SLA
      // env var held the SLA-KAF key. The JWT claim + the profile make that
      // visible instead of silently doubling every match.
      let profile = null;
      try { profile = await spProfile(a); } catch (_) { profile = null; }
      const loans = await spLoans(a);
      // Deploy 236.985 — the book a loan belongs to is the account the KEY was
      // issued for (JWT claim, confirmed by the profile), not the env slot it
      // was pasted into: the SLA slot held the KAF key and its 6 matched loans
      // were about to be stamped SLA / Sir Lends A Lot LLC.
      const realAcct = String(claims.account || (profile && profile.Account) || a.label).toUpperCase().replace(/-/g, '_');
      const keyBook = ACCOUNTS[realAcct] || a;
      // Deploy 236.990 — the SLA key returned the WHOLE platform (1,366 loans of
      // many lenders). Rows not originated by SLA are dropped here, before
      // anything looks at them, and are only ever counted. Each kept row is
      // filed under the book its lender of record names (KAF vs SLA), falling
      // back to the key's own account.
      let fresh = 0, foreign = 0;
      for (const l of loans) {
        if (!isOurLoan(l)) { foreign += 1; continue; }
        const book = bookForLenderName(l.lenderName) || keyBook;
        l.book = book.key;
        const id = l.recId || (l.account + '|' + l.origBalance);
        if (seenRec.has(id)) { duplicateAcrossBooks += 1; continue; }
        seenRec.set(id, book.key); rows.push(l); fresh += 1;
      }
      if (foreign > 0) {
        errors.push({ account: a.label, error: 'the key in ' + a.envVar + ' returns loans from other lenders (' + foreign + ' of ' + loans.length + ' dropped unread) — Servicing Pros should scope that account\'s API access' });
      }
      perAccount[a.key] = {
        label: a.label, keyAccount: claims.account || '', keyEmail: claims.email || '', keyExpires: claims.exp || '',
        lenderAccount: profile ? String(profile.Account || '') : '', lenderName: profile ? String(profile.FullName || profile.SortName || '') : '',
        keyMatchesBook: claims.account ? claims.account.toUpperCase().replace('_', '-') === a.label.toUpperCase() : null,
        bookUsed: keyBook.label,   // 236.985 — the key's own book (rows may still file under the other by lender name)
        feedRows: loans.length, foreignRowsDropped: foreign, ours: loans.length - foreign,
        loans: loans.length - foreign, duplicatesSkipped: loans.length - foreign - fresh, paidOff: loans.filter((l) => isOurLoan(l) && l.paidOff).length,
        principal: loans.filter((l) => isOurLoan(l) && !l.paidOff).reduce((s, l) => s + (l.principalBalance || 0), 0),
        byLender: loans.filter(isOurLoan).reduce((m, l) => { const k = l.lenderName || '(blank)'; m[k] = (m[k] || 0) + 1; return m; }, {}),
      };
      if (perAccount[a.key].keyMatchesBook === false) {
        errors.push({ account: a.label, error: 'the key in ' + a.envVar + ' was issued for lender account ' + claims.account + ', not ' + a.label });
      }
    } catch (e) {
      perAccount[a.key] = { label: a.label, keyAccount: claims.account || '', error: (e && e.message) || 'fetch failed' };
      errors.push({ account: a.label, error: 'feed: ' + ((e && e.message) || '') });
    }
  }
  const feedAccounts = new Set(rows.map((r) => r.account).filter(Boolean));

  // ── Index our loans by servicer loan number ─────────────────────────
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const byServicerNum = new Map();
  const taggedNotInFeed = [];
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
        const sn = normalizeServicerNumber(loan.servicerLoanNumber);   // 236.984 — "26-0239-SL AND" → 26-0239-SL
        const tagged = isSpName(loan.servicerName);
        if (!sn) continue;
        const ref = {
          ownerKey, clientId: c.id, loanId: loan.id,
          address: loan.address || '',
          investorName: loan.investorName || '',
          disposition: String(loan.disposition || '').toLowerCase(),
          loanAmt: num(loan.finalLoanAmount) != null ? num(loan.finalLoanAmount) : num(loan.loanAmt),
          servicerName: loan.servicerName || '',
        };
        if (!byServicerNum.has(sn)) byServicerNum.set(sn, []);
        byServicerNum.get(sn).push(ref);
        if (tagged && !feedAccounts.has(sn)) {
          // Deploy 236.988 (Mike) — their API only returns ACTIVE loans (no
          // parameter brings back paid-off ones — probed), so a paid-off loan
          // missing from the feed is expected. An ACTIVE loan missing from the
          // feed has most likely not been boarded with them yet.
          taggedNotInFeed.push({ servicerLoanNumber: sn, raw: String(loan.servicerLoanNumber || ''), address: ref.address, disposition: ref.disposition, loanId: loan.id,
            reason: ref.disposition === 'paid_off' ? 'paid off — their feed only carries active loans' : 'likely not boarded with Servicing Pros yet' });
        }
      }
    }
  }

  // ── Resolve each Servicing Pros loan to ours ────────────────────────
  const plan = [], unmatched = [], crossStamped = [];
  let matchedById = 0, investorMismatch = 0;
  const now = new Date().toISOString();

  for (const row of rows) {
    const acct = String(row.account || '').toUpperCase();
    if (!acct) continue;
    const book = ACCOUNTS[row.book] || null;
    let matches = byServicerNum.get(acct) || [];
    if (matches.length > 1) {
      const p = pickLoanForSpRow(matches, row);
      if (!p.pick) {
        crossStamped.push({ account: acct, reason: p.reason, loans: matches.map((h) => ({ loanId: h.loanId, address: h.address, loanAmt: h.loanAmt })) });
        continue;
      }
      crossStamped.push({ account: acct, resolved: true, reason: p.reason, keeping: p.pick.loanId,
        clearing: matches.filter((h) => h.loanId !== p.pick.loanId).map((h) => h.loanId) });
      matches = [p.pick];
    }
    if (!matches.length) {
      unmatched.push({
        account: acct, book: book ? book.label : row.book,
        origBalance: row.origBalance, principalBalance: row.principalBalance, noteRate: row.noteRate,
        closingDate: row.closingDate, maturityDate: row.maturityDate, paidOff: row.paidOff,
        borrower: row.borrowerName, borrowerCity: row.borrowerCity, borrowerState: row.borrowerState,
        hint: 'Set Servicer = Servicing Pros and Servicer Loan # = ' + acct + ' on the matching closed loan.',
      });
      continue;
    }
    matchedById += 1;

    const disp = dispositionForSp(row);
    const fields = {
      servicerName: SERVICER,
      servicerLoanNumber: acct,
      soldRate: row.noteRate,
      buyRate: row.noteRate,
      maturityDate: row.maturityDate,
      spAccount: book ? book.label : row.book,
      spLoanRecId: row.recId,
      spServiceStatus: row.serviceStatus != null ? String(row.serviceStatus) : '',
      spLastPaymentDate: row.lastPaymentDate,
      spUnpaidLateCharges: row.unpaidLateCharges != null ? String(row.unpaidLateCharges) : '',
      spCategories: row.categories,
      spInvestorName: book ? book.investorName : '',
      spSyncedAt: now,
    };
    if (disp === 'sold') {
      fields.toolType = 'rtl';
      fields.paymentAmount = row.regularPayment != null ? String(row.regularPayment) : '';
      if (row.principalBalance != null) fields.currentBalance = String(row.principalBalance);
      fields.nextDueDate = row.nextDueDate;
      fields.paidToDate = row.paidToDate;
      if (row.daysLate != null) fields.daysLate = String(row.daysLate);
    } else {
      fields.payoffDate = row.paidOffDate || row.lastPaymentDate;
      fields.payoffAmount = row.origBalance != null ? String(row.origBalance) : '';
      fields.currentBalance = '0';
      fields.daysLate = '0';
    }

    for (const h of matches) {
      const investor = { name: '', id: '' };
      if (book) {
        if (!h.investorName) { investor.name = book.investorName; investor.id = book.investorId; }
        else if (h.investorName !== book.investorName) investorMismatch += 1;
      }
      plan.push({ account: acct, book: fields.spAccount, disposition: disp,
        address: h.address, ownerKey: h.ownerKey, clientId: h.clientId, loanId: h.loanId,
        fields: investor.name ? Object.assign({ investorName: investor.name, investorId: investor.id }, fields) : fields });
    }
  }

  plan.sort((a, b) => (a.ownerKey + '|' + a.clientId + '|' + a.loanId)
    .localeCompare(b.ownerKey + '|' + b.clientId + '|' + b.loanId));

  // ── Apply ────────────────────────────────────────────────────────────
  const batch = dryRun ? [] : plan.slice(offset, offset + limit);
  let applied = 0, unchanged = 0, dispositionSkipped = 0;
  if (batch.length) {
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
            dispositionSkipped += 1;
          } else if (cur !== r.disposition) {
            loan.disposition = r.disposition;
            loan.dispositionAt = now;
            loan.dispositionBy = actor;
            changed = true;
          }
          for (const f of Object.keys(r.fields)) {
            const nv = r.fields[f];
            if (f === 'spSyncedAt') continue;
            if (nv !== '' && String(loan[f] == null ? '' : loan[f]) !== String(nv)) { loan[f] = nv; changed = true; }
          }
          if (changed) {
            loan.spSyncedAt = now;
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
    servicingPros: {
      accounts: perAccount,
      duplicateAcrossBooks,             // the same loan delivered by two keys (same account behind both)
      totalLoans: rows.length,
      activeUpb: rows.filter((r) => !r.paidOff).reduce((s, r) => s + (r.principalBalance || 0), 0),
    },
    matching: { byId: matchedById, loanTargets: plan.length },
    write: {
      offset, nextOffset, batch: batch.length, applied, unchanged,
      remaining: dryRun ? plan.length : Math.max(0, plan.length - nextOffset),
      dispositionSkipped,
    },
    review: {
      unmatched: unmatched.length,           // on their side, no portal link — tag by hand
      taggedNotInFeed: taggedNotInFeed.length, // tagged Servicing Pros here, in neither feed
      paidOffNotInFeed: taggedNotInFeed.filter((t) => t.disposition === 'paid_off').length,   // expected — their API drops inactive loans
      likelyNotBoarded: taggedNotInFeed.filter((t) => t.disposition !== 'paid_off').length,   // active here, absent there
      crossStamped: crossStamped.length,
      crossStampedUnresolved: crossStamped.filter((c) => !c.resolved).length,
      investorMismatch,
      errors: errors.length,
    },
    unmatched, taggedNotInFeed: taggedNotInFeed.slice(0, 60), crossStamped: crossStamped.slice(0, 40), errors,
    sample: plan.slice(0, 10).map((r) =>
      r.account + ' [' + r.book + '] ' + r.disposition + ' | ' + r.address.slice(0, 44) +
      ' | rate ' + r.fields.soldRate + ' | bal ' + (r.fields.currentBalance || '') + ' | next due ' + (r.fields.nextDueDate || '')),
  };
}
