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

    let type;
    if (natives.length === 1 && copies.length >= 1) type = 'native_plus_copy';
    else if (natives.length === 0) type = 'copies_only';
    else type = 'multi_native';

    const flags = [];
    if (owners.length > 1) flags.push('cross_owner');   // needs Mike to pick the owning LO
    if (amountMismatch) flags.push('amount_mismatch');  // maybe two different loans — do NOT auto-delete
    if (type === 'multi_native') flags.push('multi_native');

    // Sub-classify by how safe a collapse is:
    //   safe_exact  — the group is one loan re-copied (a single distinct display id,
    //                 same amount + funding date) → deleting the extras loses nothing.
    //   likely_safe — one loan under >1 Baseline id FORMAT (e.g. SLA-YYYYMMDD-NNNN +
    //                 SLA-NNNN), same amount + funding date → collapse, keep newest.
    //   review      — differing amount / funding date / owner / a native in the mix →
    //                 could be TWO real loans (a payoff + a new loan) — never auto-delete.
    const distinctIds = new Set(entries.map((e) => e.slaDisplayId || e.loanId)).size;
    const distinctAmts = new Set(entries.filter((e) => e.amt > 0).map((e) => Math.round(e.amt / 500))).size;
    const distinctFunding = new Set(entries.map((e) => e.fundingDate).filter(Boolean)).size;
    let safety;
    if (flags.length || type !== 'copies_only') safety = 'review';
    else if (distinctAmts > 1 || distinctFunding > 1) safety = 'review';
    else if (distinctIds <= 1) safety = 'safe_exact';
    else safety = 'likely_safe';

    // Record identity is (clientId, loanId) — exact dups SHARE a loanId across two
    // DIFFERENT clients (a solo c_baseline_<id> client + a grouped c_bl_* client),
    // so keep/delete must key on the CLIENT, not the loan id. Proposed keeper:
    // prefer the grouped (multi-loan) client, then one carrying servicing data,
    // then the SLA-YYYYMMDD-NNNN id format, then most-recently-updated.
    const isNewFmt = (e) => /^SLA-\d{8}-\d+$/.test(e.slaDisplayId || '');
    const ranked = entries.slice().sort((a, b) =>
      (a.soloLoanInClient ? 1 : 0) - (b.soloLoanInClient ? 1 : 0) ||
      (b.servicerName ? 1 : 0) - (a.servicerName ? 1 : 0) ||
      (isNewFmt(b) ? 1 : 0) - (isNewFmt(a) ? 1 : 0) ||
      String(b.updatedAt).localeCompare(String(a.updatedAt)) ||
      String(a.clientId).localeCompare(String(b.clientId)));
    const keeper = ranked[0];
    const sameRec = (e) => e.clientId === keeper.clientId && e.loanId === keeper.loanId;

    groups.push({
      address: entries[0].address, norm: na, count: entries.length,
      type, safety, flags, owners,
      keeper: { ownerKey: keeper.ownerKey, clientId: keeper.clientId, loanId: keeper.loanId, soloLoanInClient: keeper.soloLoanInClient },
      deleteCandidates: (safety === 'review') ? []
        : ranked.slice(1).filter((e) => !sameRec(e)).map((e) => ({ ownerKey: e.ownerKey, clientId: e.clientId, loanId: e.loanId, soloLoanInClient: e.soloLoanInClient })),
      records: entries.map((e) => ({
        loanId: e.loanId, slaDisplayId: e.slaDisplayId, isBaselineCopy: e.isCopy,
        keep: sameRec(e),
        owner: e.ownerKey, clientId: e.clientId, soloLoanInClient: e.soloLoanInClient,
        amount: e.amt, status: e.status, disposition: e.disposition,
        servicerName: e.servicerName, toolType: e.toolType,
        fundingDate: e.fundingDate, maturityDate: e.maturityDate,
        updatedAt: e.updatedAt,
      })),
    });
  }

  // Order: safe_exact → likely_safe → review, then biggest groups first.
  const rank = { safe_exact: 0, likely_safe: 1, review: 2 };
  groups.sort((a, b) => (rank[a.safety] - rank[b.safety]) || (b.count - a.count));

  const bySafety = (s) => groups.filter((g) => g.safety === s);
  const delCount = (arr) => arr.reduce((s, g) => s + g.deleteCandidates.length, 0);
  const safeExact = bySafety('safe_exact'), likely = bySafety('likely_safe'), review = bySafety('review');
  return json(200, {
    ok: true,
    scanned: { clientBlobs: blobs.length, loans: loansSeen, addresses: byAddr.size },
    summary: {
      duplicateGroups: groups.length,
      redundantRecords: groups.reduce((s, g) => s + (g.count - 1), 0),
      safeExactGroups: safeExact.length, safeExactDeletes: delCount(safeExact),
      likelySafeGroups: likely.length, likelySafeDeletes: delCount(likely),
      reviewGroups: review.length,
      byType: {
        native_plus_copy: groups.filter((g) => g.type === 'native_plus_copy').length,
        copies_only: groups.filter((g) => g.type === 'copies_only').length,
        multi_native: groups.filter((g) => g.type === 'multi_native').length,
      },
      flags: {
        cross_owner: groups.filter((g) => g.flags.indexOf('cross_owner') >= 0).length,
        amount_mismatch: groups.filter((g) => g.flags.indexOf('amount_mismatch') >= 0).length,
      },
    },
    groups,
  });
}
