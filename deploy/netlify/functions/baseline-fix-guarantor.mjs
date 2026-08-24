/**
 * baseline-fix-guarantor.mjs — POST /api/baseline-fix-guarantor
 *
 * Deploy 236.664 — cleanup after the Baseline migration. Entity loans imported as
 * a NAMELESS primary husk (`c_baseline_<extId>`, LLC in `loan.vestingLLCs`), with the
 * individual either (A) added as a SEPARATE guarantor client (guarantorClientIds) or
 * (B) missing because the enrich migration's mapPeople required BOTH a name AND an
 * email. Mike wants the INDIVIDUAL to be the primary borrower ("Guarantor 1") and the
 * LLC kept only as the vesting entity.
 *
 * For each nameless c_baseline_ primary that holds an l_baseline_ loan, this resolves
 * the person from (A) the single linked guarantor client, else (B) re-reads the
 * Baseline mirror's Guarantor_Name/Email/Phone, then PROMOTES that identity onto the
 * primary client (keeping vestingLLCs), unlinks + deletes the now-orphaned guarantor
 * client (only when it guarantees just this loan and holds no loans of its own).
 *
 * Body: { dryRun (default TRUE), onlyOwner (default chance@slacapital.com),
 *         only?: [primaryClientId...], offset?, limit? }
 * Admin only. Scan lists just `ownerKey/c_baseline*` blobs (keySafe preserves the
 * prefix), so it never pages the whole owner. Real-LO imports: call per onlyOwner.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs';
import { loadMirroredLoan, fetchLoanDetail } from './_shared/baseline-mirror.mjs';

const DEFAULT_OWNER = 'chance@slacapital.com';
const DEFAULT_LIMIT = 50;

function _str(v) { return v == null ? '' : String(v).trim(); }
function _splitName(full) {
  const parts = _str(full).split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  return {
    firstName: parts.length > 1 ? parts.slice(0, -1).join(' ') : parts[0],
    lastName:  parts.length > 1 ? parts[parts.length - 1] : '',
  };
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('baseline-fix-guarantor error:', e);
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

  // Deploy 236.666 — diagnostic: dump the LIVE partner-API /loan/{extId} response
  // key structure (not the cached mirror) to see whether the individual/guarantor
  // is in a field the mapping never read (e.g. a nested contacts/parties array).
  if (body.mode === 'dumpLoan' && body.extId) {
    const dl = await fetchLoanDetail(String(body.extId));
    if (!dl.ok || !dl.loan) return json(200, { ok: true, mode: 'dumpLoan', fetch: { ok: dl.ok, status: dl.status, error: dl.error } });
    const loan = dl.loan;
    const keys = Object.keys(loan);
    const guarKeys = keys.filter((k) => /guarant|contact|borrower|owner|part(y|ies)|signer|principal|member/i.test(k));
    const guarVals = {};
    guarKeys.forEach((k) => { const v = loan[k]; guarVals[k] = (v && typeof v === 'object') ? JSON.stringify(v).slice(0, 400) : v; });
    const arrayKeys = keys.filter((k) => Array.isArray(loan[k]) && loan[k].length).map((k) => ({ key: k, len: loan[k].length, firstKeys: (loan[k][0] && typeof loan[k][0] === 'object') ? Object.keys(loan[k][0]).slice(0, 20) : typeof loan[k][0] }));
    // Deploy 236.676 (diag) — surface LIVE TPO-ish fields (and any body.fields[])
    // so we can tell whether a DSCR that migrated with a blank TPO genuinely has
    // no TPO in Baseline, or the CACHED mirror was just stale when we migrated.
    const tpoKeys = keys.filter((k) => /tpo|premium|spread|buy.?rate/i.test(k));
    const tpoVals = {}; tpoKeys.forEach((k) => { tpoVals[k] = loan[k]; });
    const wantFields = Array.isArray(body.fields) ? body.fields : null;
    const fieldVals = {}; if (wantFields) wantFields.forEach((f) => { fieldVals[f] = loan[f]; });
    return json(200, { ok: true, mode: 'dumpLoan', extId: body.extId, keyCount: keys.length, guarKeys, guarVals, arrayKeys, tpoKeys, tpoVals, fieldVals });
  }

  const dryRun = body.dryRun !== false && body.dryRun !== 'false' && body.dryRun !== 0;
  const ownerEmail = normalizeEmail(body.onlyOwner || DEFAULT_OWNER);
  const ownerKey = keySafe(ownerEmail);
  const offset = Math.max(0, parseInt(body.offset || 0, 10) || 0);
  const limit = Math.max(1, Math.min(100, parseInt(body.limit || DEFAULT_LIMIT, 10) || DEFAULT_LIMIT));
  const only = Array.isArray(body.only) ? body.only.map((s) => String(s).trim()).filter(Boolean) : null;

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  let keys = [];
  if (only) {
    keys = only.map((cid) => ownerKey + '/' + keySafe(cid));
  } else {
    try {
      const listed = await clientsStore.list({ prefix: ownerKey + '/c_baseline' });
      keys = (listed && listed.blobs ? listed.blobs : []).map((b) => b.key);
    } catch (e) { return json(500, { error: 'list failed: ' + (e.message || 'unknown') }); }
  }
  const total = keys.length;
  const slice = only ? keys : keys.slice(offset, offset + limit);

  const counts = {
    scanned: 0, promoted: 0, fromGuarantorClient: 0, fromMirror: 0, guarantorDeleted: 0,
    skipped_named: 0, skipped_noLoan: 0, skipped_noPerson: 0, skipped_multiGuar: 0, errors: 0,
  };
  const samples = [];

  for (const key of slice) {
    counts.scanned++;
    let client;
    try { client = await clientsStore.get(key, { type: 'json' }); } catch (e) { counts.errors++; continue; }
    if (!client) continue;
    const nm = ((client.firstName || '') + ' ' + (client.lastName || '')).trim();
    if (nm) { counts.skipped_named++; continue; }
    const loans = Array.isArray(client.loans) ? client.loans : [];
    const loan = loans.find((l) => l && String(l.id || '').indexOf('l_baseline_') === 0) || loans[0];
    if (!loan) { counts.skipped_noLoan++; continue; }

    const gIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
    if (gIds.length > 1) {
      counts.skipped_multiGuar++;
      if (samples.length < 40) samples.push({ clientId: client.id, loanId: loan.id, action: 'skip', reason: 'multiple guarantors — resolve by hand' });
      continue;
    }

    let person = null, source = '', guarantorClientToDelete = null;

    // Case A — a single linked guarantor client is the individual.
    if (gIds.length === 1) {
      let gc = null;
      try { gc = await clientsStore.get(ownerKey + '/' + keySafe(gIds[0]), { type: 'json' }); } catch (e) {}
      if (gc && (gc.firstName || gc.lastName || gc.email)) {
        person = { firstName: _str(gc.firstName), lastName: _str(gc.lastName), email: _str(gc.email).toLowerCase(), phone: _str(gc.phone) };
        source = 'guarantorClient';
        const gOn = Array.isArray(gc._guarantorOnLoans) ? gc._guarantorOnLoans.filter((b) => b && b.loanId) : [];
        const gLoans = Array.isArray(gc.loans) ? gc.loans : [];
        // Safe to delete only when it holds no loans of its own and guarantees just this loan.
        if (gLoans.length === 0 && gOn.length <= 1) guarantorClientToDelete = { id: gc.id, key: ownerKey + '/' + keySafe(gc.id) };
      }
    }

    // Case B — resolve the individual from Baseline. Reads the LIVE partner-API
    // /loan (full 129-field response) so it sees Borrower_First/Last/Email that
    // the cached mirror may not carry; falls back to the mirror if the live fetch
    // fails. Resolution order: explicit Guarantor → explicit Borrower_First/Last →
    // an individual-type Borrower whose Borrower_Name IS the person. Entity loans
    // with no individual in the API stay skipped (owner is a Baseline contact).
    if (!person) {
      const _lid = String(loan.id || '');
      const extId = loan.slaDisplayId || (_lid.indexOf('l_baseline_') === 0 ? _lid.slice('l_baseline_'.length) : '');
      if (extId) {
        let m = null;
        try { const dl = await fetchLoanDetail(extId); if (dl && dl.ok && dl.loan) m = dl.loan; } catch (e) {}
        if (!m) { try { m = await loadMirroredLoan(extId); } catch (e) {} }
        if (m) {
          let sp = _splitName(m.Guarantor_Name);
          let email = _str(m.Guarantor_Email), phone = _str(m.Guarantor_Phone);
          if (!sp) {
            const bFirst = _str(m.Borrower_First_Name), bLast = _str(m.Borrower_Last_Name);
            const bType = String(m.Borrower_Type || '').toLowerCase();
            if (bFirst || bLast) {
              sp = { firstName: bFirst, lastName: bLast };
              email = email || _str(m.Borrower_Email); phone = phone || _str(m.Borrower_Phone);
            } else if (bType === 'individual' && _str(m.Borrower_Name)) {
              const s2 = _splitName(m.Borrower_Name);
              if (s2) { sp = s2; email = email || _str(m.Borrower_Email); phone = phone || _str(m.Borrower_Phone); }
            }
          }
          if (sp) { person = { firstName: sp.firstName, lastName: sp.lastName, email: String(email || '').toLowerCase(), phone: phone }; source = 'mirror'; }
        }
      }
    }

    if (!person || (!person.firstName && !person.lastName)) {
      counts.skipped_noPerson++;
      if (samples.length < 40) samples.push({
        clientId: client.id, loanId: loan.id, addr: loan.address,
        vestingLLC: (loan.vestingLLCs && loan.vestingLLCs[0] && loan.vestingLLCs[0].name) || '',
        action: 'skip', reason: 'no individual in guarantor link or Baseline mirror',
      });
      continue;
    }

    if (dryRun) {
      counts.promoted++;
      if (source === 'guarantorClient') counts.fromGuarantorClient++; else counts.fromMirror++;
      if (guarantorClientToDelete) counts.guarantorDeleted++;
      if (samples.length < 40) samples.push({
        clientId: client.id, loanId: loan.id, addr: loan.address, source,
        willPromote: person.firstName + ' ' + person.lastName + (person.email ? (' <' + person.email + '>') : ' (no email)'),
        vestingLLC: (loan.vestingLLCs && loan.vestingLLCs[0] && loan.vestingLLCs[0].name) || '',
        willDeleteGuarantorClient: guarantorClientToDelete ? guarantorClientToDelete.id : null,
      });
      continue;
    }

    // ── real write ──
    try {
      const now = new Date().toISOString();
      client.firstName = person.firstName;
      client.lastName  = person.lastName;
      if (person.email && !_str(client.email)) client.email = person.email;   // don't clobber an existing primary email
      if (person.phone && !_str(client.phone)) client.phone = person.phone;
      client.updatedAt = now;
      client._guarantorPromotedFromBaseline = { at: now, by: normalizeEmail(user.email), source };
      // Unlink the promoted individual from this loan's guarantors (they're the primary now).
      if (source === 'guarantorClient') {
        const gid = gIds[0];
        loan.guarantorClientIds = gIds.filter((id) => id !== gid);
        if (loan.guarantorOwnership) delete loan.guarantorOwnership[gid];
      }
      loan.updatedAt = now;
      await writeClient(ownerKey, client, { clientsStore });
      if (guarantorClientToDelete) {
        try { await pgMirror.deleteClientStrict(guarantorClientToDelete.id); } catch (e) {}
        try { await clientsStore.delete(guarantorClientToDelete.key); } catch (e) {}
        counts.guarantorDeleted++;
      }
      counts.promoted++;
      if (source === 'guarantorClient') counts.fromGuarantorClient++; else counts.fromMirror++;
      if (samples.length < 40) samples.push({ clientId: client.id, loanId: loan.id, promoted: person.firstName + ' ' + person.lastName, source, deletedGuarantorClient: guarantorClientToDelete ? guarantorClientToDelete.id : null });
    } catch (e) {
      counts.errors++;
      if (samples.length < 40) samples.push({ clientId: client.id, loanId: loan.id, action: 'error', error: (e && e.message) || 'unknown' });
    }
  }

  const nextOffset = only ? total : (offset + slice.length);
  const done = only ? true : (nextOffset >= total);
  return json(200, { ok: true, dryRun, owner: ownerEmail, total, processedThisCall: slice.length, offset, limit, nextOffset, done, counts, samples });
}
