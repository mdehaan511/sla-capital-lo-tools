/**
 * baseline-reconcile-dispositions.mjs — POST /api/baseline-reconcile-dispositions
 *
 * Deploy 236.711 — one-off reconciliation: read the CURRENT status of every loan
 * in Baseline (live GET /loan), find the ones marked Sold / Paid Off / Liquidated,
 * match each to its SLA loan, and set that loan's Closed-Loans disposition to
 * match (`sold` / `paid_off`).
 *
 * DRY RUN BY DEFAULT. Pass { apply: true } to actually write. Even then it never
 * overwrites a disposition a staff member set by hand (those surface as
 * `conflicts` for review unless { overwriteManual: true }).
 *
 * Body: {
 *   apply?: false,             // false = dry run (report only)
 *   overwriteManual?: false,   // apply even where staff set a different disposition
 * }
 *
 * Auth: admin OR processor (canOverrideOwner) — same gate as loan-set-disposition.
 * Writes go through the PG-first strict writeClient. Long-running (live Baseline
 * fetch + per-loan lookups) → runs on the 26s budget (see netlify.toml).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { canOverrideOwner } from './_shared/access.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { fetchAllLoanList } from './_shared/baseline-mirror.mjs';
import { getNativeLink } from './_shared/baseline-upsert.mjs';

const IMPORT_OWNER_KEY = 'baseline-migration@sla-import.local';
const ENRICH_OWNER_KEY = 'chance@slacapital.com';

// Normalize a Baseline Status string the same way the rest of the code does:
// lowercase + collapse whitespace/underscores.
function normStatus(s) { return String(s == null ? '' : s).toLowerCase().replace(/[_\s]+/g, ' ').trim(); }

// Baseline terminal Status → SLA disposition.
function targetDisposition(status) {
  const n = normStatus(status);
  if (n === 'sold') return 'sold';
  if (n === 'paid off' || n === 'paidoff' || n === 'liquidated') return 'paid_off';
  return null;
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-reconcile-dispositions error:', e);
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
  // Deploy 236.712 — cap writes per call so a big apply can't blow the 26s
  // budget. The client loops (apply is idempotent — a re-run skips the ones it
  // already wrote) until `remaining` hits 0.
  const limit = (Number(body.limit) > 0) ? Math.floor(Number(body.limit)) : 60;
  const selfEmail = normalizeEmail(user.email);

  // ── 1. Live-read Baseline's loan roster (Status per loan) ──────────
  const list = await fetchAllLoanList();
  if (!list.ok) {
    return json(502, { error: 'Baseline fetch failed: ' + (list.error || ('HTTP ' + list.status)) });
  }

  // ── 2. Filter to Sold / Paid Off / Liquidated ─────────────────────
  const targets = [];
  for (const b of list.loans) {
    const extId = String((b && (b.Id || b.id)) || '').trim();
    const disp = targetDisposition(b && b.Status);
    if (extId && disp) {
      targets.push({ extId, status: String(b.Status || ''), disp, name: String((b && b.Name) || '') });
    }
  }

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  // Resolve a Baseline external id → { ownerKey, client, loan } SLA record.
  // Priority: native-link store → import copy under either import owner.
  async function resolveSlaLoan(extId) {
    // (a) authoritative native link (dedupe-merged natives)
    const link = await getNativeLink(extId).catch(() => null);
    if (link && link.ownerKey && link.clientId && link.loanId) {
      const ck = link.ownerKey + '/' + keySafe(link.clientId);
      const client = await clientsStore.get(ck, { type: 'json' }).catch(() => null);
      const loan = client && Array.isArray(client.loans) ? client.loans.find((l) => l && l.id === link.loanId) : null;
      if (client && loan) return { ownerKey: link.ownerKey, clientId: link.clientId, client, loan, via: 'native_link' };
    }
    // (b) import copy: c_baseline_<extId> / l_baseline_<extId> under either owner
    const cid = 'c_baseline_' + extId;
    const lid = 'l_baseline_' + extId;
    for (const ownerKey of [ENRICH_OWNER_KEY, IMPORT_OWNER_KEY]) {
      const ck = ownerKey + '/' + keySafe(cid);
      const client = await clientsStore.get(ck, { type: 'json' }).catch(() => null);
      if (!client || !Array.isArray(client.loans)) continue;
      const loan = client.loans.find((l) => l && (l.id === lid || l.slaDisplayId === extId || l._baselineLoanId === extId));
      if (loan) return { ownerKey, clientId: client.id || cid, client, loan, via: 'import_copy' };
    }
    return null;
  }

  const toSet = [];       // will be changed
  const alreadySet = [];  // disposition already === target
  const conflicts = [];   // staff set a DIFFERENT disposition by hand
  const unmatched = [];   // no SLA loan found
  const errors = [];

  // Deploy 236.712 — resolve targets in parallel chunks (sequential blob gets
  // for ~172 loans was ~24s and blew the dry-run past the CDP eval window).
  const CONC = 15;
  for (let i = 0; i < targets.length; i += CONC) {
    const chunk = targets.slice(i, i + CONC);
    const results = await Promise.all(chunk.map(async (t) => {
      try { return { t, hit: await resolveSlaLoan(t.extId) }; }
      catch (e) { return { t, err: (e && e.message) || 'resolve failed' }; }
    }));
    for (const { t, hit, err } of results) {
      if (err) { errors.push({ extId: t.extId, error: 'resolve failed: ' + err }); continue; }
      if (!hit) { unmatched.push({ extId: t.extId, status: t.status, name: t.name }); continue; }
      const cur = String((hit.loan.disposition || '')).toLowerCase().trim();
      const row = {
        extId: t.extId, name: t.name, baselineStatus: t.status, target: t.disp,
        ownerKey: hit.ownerKey, clientId: hit.clientId, loanId: hit.loan.id,
        address: hit.loan.address || t.name, currentDisposition: cur || null, via: hit.via,
      };
      if (cur === t.disp) { alreadySet.push(row); continue; }
      if (cur && !overwriteManual) { conflicts.push(row); continue; }
      toSet.push(row);
    }
  }

  // ── 4. Apply (or report) ──────────────────────────────────────────
  // Only write up to `limit` this call; the client loops until remaining === 0.
  const applyBatch = apply ? toSet.slice(0, limit) : [];
  let applied = 0;
  if (applyBatch.length) {
    // Group by (ownerKey, clientId) so a client with multiple reconciled loans
    // is read + written once.
    const now = new Date().toISOString();
    const byClient = new Map();
    for (const r of applyBatch) {
      const k = r.ownerKey + '||' + r.clientId;
      if (!byClient.has(k)) byClient.set(k, []);
      byClient.get(k).push(r);
    }
    for (const [k, rows] of byClient) {
      const [ownerKey, clientId] = k.split('||');
      try {
        const ck = ownerKey + '/' + keySafe(clientId);
        const client = await clientsStore.get(ck, { type: 'json' }).catch(() => null);
        if (!client || !Array.isArray(client.loans)) { rows.forEach((r) => errors.push({ extId: r.extId, error: 'client vanished on apply' })); continue; }
        let dirty = false;
        for (const r of rows) {
          const loan = client.loans.find((l) => l && l.id === r.loanId);
          if (!loan) { errors.push({ extId: r.extId, error: 'loan vanished on apply' }); continue; }
          loan.disposition = r.target;
          loan.dispositionAt = now;
          loan.dispositionBy = selfEmail;
          loan._dispositionSource = 'baseline_reconcile';
          loan.updatedAt = now;
          dirty = true;
          applied += 1;
        }
        if (dirty) await writeClient(ownerKey, client, { clientsStore });
      } catch (e) {
        rows.forEach((r) => errors.push({ extId: r.extId, error: 'write failed: ' + (e && e.message) }));
      }
    }
  }

  return json(200, {
    ok: true,
    apply,
    overwriteManual,
    baselineLoansScanned: list.loans.length,
    terminalFound: targets.length,
    summary: {
      wouldChange: toSet.length,
      applied: apply ? applied : 0,
      // How many still need writing after this call — client loops apply until 0.
      remaining: apply ? Math.max(0, toSet.length - applied) : toSet.length,
      alreadyCorrect: alreadySet.length,
      conflicts: conflicts.length,
      unmatched: unmatched.length,
      errors: errors.length,
    },
    // Full detail so the dry-run can be eyeballed before applying.
    toSet, conflicts, unmatched, errors,
    // alreadySet is usually large + uninteresting — return just a count + ids.
    alreadySetIds: alreadySet.map((r) => r.extId),
  });
}
