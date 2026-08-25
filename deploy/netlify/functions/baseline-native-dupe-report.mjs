/**
 * baseline-native-dupe-report.mjs — POST /api/baseline-native-dupe-report
 *
 * Deploy 236.735 — READ-ONLY report. Finds same-property duplicate loan records
 * created by the Baseline migration that the dashboard Dedupe MISSES: a native
 * SLA loan (id `l_<ts>_<rand>`) alongside a Baseline copy (id `l_baseline_*`) at
 * the same address+amount, but living under a REAL LO account (not the dedicated
 * IMPORT_OWNER_KEY the Dedupe tool keys off). Also catches copy+copy groups.
 *
 * Makes NO changes. Groups every loan portal-wide by normalized address, keeps
 * groups with >1 record where at least one is a Baseline copy, and classifies
 * each so a follow-up cleanup can keep the native / most-complete record and
 * delete the redundant copy. Cross-owner + amount-mismatch groups are flagged
 * for a human decision (never auto-delete those). Admin only.
 *
 * Body: {}  (no options — this is a scan/report)
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, requireAuth, isAdmin } from './_shared/auth.mjs';

function num(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) ? n : 0; }
function loanAmt(l) { return num(l.finalLoanAmount) || num(l.loanAmt) || 0; }
// Normalize an address for collision grouping (street + city + state, unit stripped).
function normAddr(a) {
  return String(a || '').toLowerCase()
    .replace(/[.,#]/g, ' ')
    .replace(/\b(apt|unit|ste|suite|apartment|bldg|building|lot|rm|room)\b[\s\S]*$/, '')
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+(usa|us)$/, '')
    .replace(/\s+/g, ' ').trim();
}
const isBaselineCopy = (l) => /^l_baseline_/i.test(String(l.id || ''));

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-native-dupe-report error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isAdmin(user)) return json(403, { error: 'Admin only' });

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const { blobs } = await clientsStore.list();

  // ── Walk every client blob, collect one entry per loan ────────────
  const byAddr = new Map();   // normAddr -> [entry]
  const CONC = 60;
  let loansSeen = 0;
  for (let i = 0; i < blobs.length; i += CONC) {
    const chunk = blobs.slice(i, i + CONC);
    const recs = await Promise.all(chunk.map(({ key }) =>
      clientsStore.get(key, { type: 'json' }).then((c) => ({ key, c })).catch(() => ({ key, c: null }))));
    for (const { key, c } of recs) {
      const slash = key.indexOf('/'); if (slash < 0) continue;
      const ownerKey = key.slice(0, slash);
      if (!c || !Array.isArray(c.loans)) continue;
      for (const loan of c.loans) {
        if (!loan || !loan.id || !loan.address) continue;
        const na = normAddr(loan.address); if (na.length < 6) continue;
        loansSeen += 1;
        if (!byAddr.has(na)) byAddr.set(na, []);
        byAddr.get(na).push({
          ownerKey, clientId: c.id, loanId: loan.id,
          address: loan.address, slaDisplayId: loan.slaDisplayId || '',
          isCopy: isBaselineCopy(loan),
          amt: loanAmt(loan),
          status: loan.status || '', disposition: loan.disposition || '',
          servicerName: loan.servicerName || '', toolType: loan.toolType || '',
          fundingDate: loan.fundingDate || '', maturityDate: loan.maturityDate || '',
          updatedAt: loan.updatedAt || '', createdAt: loan.createdAt || '',
          soloLoanInClient: c.loans.length === 1,
        });
      }
    }
  }

  // ── Keep address groups with >1 record AND at least one Baseline copy ──
  const groups = [];
  for (const [na, entries] of byAddr) {
    if (entries.length < 2) continue;
    const copies = entries.filter((e) => e.isCopy);
    const natives = entries.filter((e) => !e.isCopy);
    if (!copies.length) continue;  // no Baseline artifact here — not a migration dupe

    const owners = [...new Set(entries.map((e) => e.ownerKey))];
    const amts = entries.map((e) => e.amt).filter((a) => a > 0);
    const amountMismatch = amts.length > 1 && (Math.max(...amts) - Math.min(...amts)) > Math.max(...amts) * 0.02;

    let type, recommend;
    if (natives.length === 1 && copies.length >= 1) {
      type = 'native_plus_copy';
      recommend = 'keep the native record, delete the ' + copies.length + ' Baseline copy(ies)';
    } else if (natives.length === 0) {
      type = 'copies_only';
      recommend = 'all ' + copies.length + ' are Baseline copies — keep the most complete, delete the rest (review)';
    } else {
      type = 'multi_native';
      recommend = natives.length + ' native records — possible real separate loans, REVIEW before deleting';
    }

    const flags = [];
    if (owners.length > 1) flags.push('cross_owner');   // needs Mike to pick the owning LO
    if (amountMismatch) flags.push('amount_mismatch');  // maybe two different loans — do NOT auto-delete
    if (type === 'multi_native') flags.push('multi_native');

    groups.push({
      address: entries[0].address, norm: na, count: entries.length,
      type, recommend, flags,
      owners,
      records: entries.map((e) => ({
        loanId: e.loanId, slaDisplayId: e.slaDisplayId, isBaselineCopy: e.isCopy,
        owner: e.ownerKey, clientId: e.clientId, soloLoanInClient: e.soloLoanInClient,
        amount: e.amt, status: e.status, disposition: e.disposition,
        servicerName: e.servicerName, toolType: e.toolType,
        fundingDate: e.fundingDate, maturityDate: e.maturityDate,
        updatedAt: e.updatedAt,
      })),
    });
  }

  // Actionable (clean, single-owner, amounts match) first.
  const cleanScore = (g) => (g.flags.length ? 1 : 0) + (g.type === 'native_plus_copy' ? 0 : 1);
  groups.sort((a, b) => cleanScore(a) - cleanScore(b) || b.count - a.count);

  const redundant = groups.reduce((s, g) => s + (g.count - 1), 0);
  const cleanAuto = groups.filter((g) => g.type === 'native_plus_copy' && !g.flags.length);
  return json(200, {
    ok: true,
    scanned: { clientBlobs: blobs.length, loans: loansSeen, addresses: byAddr.size },
    summary: {
      duplicateGroups: groups.length,
      redundantRecords: redundant,
      cleanNativePlusCopy: cleanAuto.length,           // safe to auto-delete the copy
      cleanRedundant: cleanAuto.reduce((s, g) => s + (g.count - 1), 0),
      copiesOnly: groups.filter((g) => g.type === 'copies_only').length,
      crossOwner: groups.filter((g) => g.flags.indexOf('cross_owner') >= 0).length,
      amountMismatch: groups.filter((g) => g.flags.indexOf('amount_mismatch') >= 0).length,
      multiNative: groups.filter((g) => g.type === 'multi_native').length,
    },
    groups,
  });
}
