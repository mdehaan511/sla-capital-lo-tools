/**
 * admin-baseline-pii-backfill-background.mjs — POST /api/admin-baseline-pii-backfill
 *
 * Deploy 236.830 — pull borrower STREET ADDRESSES + SSNs from Baseline and
 * save them onto the matching SLA client records (Mike). Runs as a Netlify
 * BACKGROUND function (202 immediately, 15-min budget) because it re-fetches
 * every known borrower from Baseline's API (list-borrower was never widened
 * for our key — GET /borrower/{Id} per id is the only path, ~1-2s each).
 *
 * PII discipline:
 *   - SSNs are encrypted server-side with the existing crypto helper
 *     (ssn_enc + ssnLast4 + hasSSN — same shape the Xactus subject-save and
 *     the long app use). No SSN value ever appears in the report, logs, or
 *     any response — the report carries counts + FIELD NAMES only.
 *   - Gap-fill semantics like baseline-borrowers-materialize: an SSN is only
 *     written when the client has none; homeAddress sub-fields only when
 *     empty. Nothing a person entered in SLA is ever overwritten.
 *
 * Flow:
 *   1. Borrower-id universe = baseline_borrowers_mirror keys ∪ borrower ids
 *      referenced by the loan mirror (Borrower_Id / Guarantor_*_Id).
 *   2. Fresh GET /borrower/{Id} per id (concurrency 6), mirror updated;
 *      fetch failure falls back to the mirrored copy.
 *   3. People only (Is_Company !== true): extract address + discover the SSN
 *      field (direct keys and Custom_Fields scanned by /ssn|social|tax.?id/i;
 *      value must normalize to exactly 9 digits).
 *   4. Match to an SLA client via baseline_borrower_link, falling back to a
 *      PG email lookup. Gap-fill + writeClient (strict discipline).
 *   5. Report (counts only) written to the baseline_pii_backfill store,
 *      key 'latest' — read it via /api/admin-baseline-pii-backfill-status.
 *
 * Body: { dryRun?: bool (default TRUE), refetch?: bool (default TRUE) }
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody, keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { fetchBorrowerDetail, saveMirroredBorrower, getBorrowerLink } from './_shared/baseline-borrowers.mjs';
import { encryptField } from './_shared/crypto.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { db } from './_shared/supabase-db.mjs';

const FETCH_CONCURRENCY = 6;
const TIME_BUDGET_MS = 13 * 60 * 1000; // background fns get ~15 min; keep headroom

const REPORT_STORE = 'baseline_pii_backfill';

function _lower(s) { return String(s || '').trim().toLowerCase(); }
function _isEmpty(v) { return v === undefined || v === null || v === ''; }
function _pick(obj, keys) {
  for (const k of keys) {
    if (obj && obj[k] !== undefined && obj[k] !== null && String(obj[k]).trim() !== '') return String(obj[k]).trim();
  }
  return '';
}

// Discover an SSN on a Baseline PERSON payload. Returns { ssn, fieldName }
// with ssn as 9 digits, or nulls. Direct keys first, then Custom_Fields
// (array of {Name/Label/Field, Value} or a plain object).
const SSN_DIRECT_KEYS = [
  'SSN', 'ssn', 'Ssn', 'Social_Security', 'Social_Security_Number',
  'social_security_number', 'SocialSecurityNumber', 'SSN_TIN', 'Tax_ID',
  'tax_id', 'TaxID', 'TIN', 'Tin',
];
const SSN_NAME_RE = /ssn|social.?sec|tax.?id|\btin\b/i;
function _normSsn(v) {
  const d = String(v == null ? '' : v).replace(/\D/g, '');
  if (d.length !== 9) return '';
  if (/^(\d)\1{8}$/.test(d) || d === '123456789') return ''; // junk placeholders
  return d;
}
function discoverSsn(b) {
  for (const k of SSN_DIRECT_KEYS) {
    if (b && b[k] !== undefined) {
      const ssn = _normSsn(b[k]);
      if (ssn) return { ssn, fieldName: k };
    }
  }
  const cf = b && (b.Custom_Fields || b.custom_fields || b.CustomFields);
  if (Array.isArray(cf)) {
    for (const f of cf) {
      if (!f) continue;
      const name = String(f.Name || f.Label || f.Field || f.name || f.label || '');
      if (!SSN_NAME_RE.test(name)) continue;
      const ssn = _normSsn(f.Value !== undefined ? f.Value : f.value);
      if (ssn) return { ssn, fieldName: 'Custom_Fields:' + name };
    }
  } else if (cf && typeof cf === 'object') {
    for (const name of Object.keys(cf)) {
      if (!SSN_NAME_RE.test(name)) continue;
      const ssn = _normSsn(cf[name]);
      if (ssn) return { ssn, fieldName: 'Custom_Fields:' + name };
    }
  }
  return { ssn: '', fieldName: '' };
}

function extractAddress(b) {
  return {
    street: _pick(b, ['Address_Street1', 'address_street1', 'Address_Line_1', 'address_line_1', 'Street', 'street', 'Home_Street']),
    city:   _pick(b, ['Address_City', 'address_city', 'City', 'city']),
    state:  _pick(b, ['Address_State', 'address_state', 'State', 'state']),
    zip:    _pick(b, ['Address_Zipcode', 'Address_Zip', 'address_zipcode', 'address_zip', 'Zip', 'zip', 'Postal_Code']),
  };
}

async function _collectBorrowerIds() {
  const ids = new Set();
  // Mirror keys are the ids themselves (keySafe'd — Baseline ids are simple).
  try {
    const store = getStore({ name: 'baseline_borrowers_mirror', consistency: 'strong' });
    const { blobs } = await store.list();
    for (const { key } of blobs) if (key) ids.add(String(key));
  } catch (e) { console.warn('[pii-backfill] borrower mirror list failed:', e && e.message); }
  // Plus any borrower ids referenced by the loan mirror.
  try {
    const store = getStore({ name: 'baseline_loans_mirror', consistency: 'strong' });
    const { blobs } = await store.list();
    const READ = 10;
    for (let i = 0; i < blobs.length; i += READ) {
      const chunk = await Promise.all(blobs.slice(i, i + READ).map(({ key }) =>
        store.get(key, { type: 'json' }).catch(() => null)));
      for (const l of chunk) {
        if (!l) continue;
        for (const f of ['Borrower_Id', 'Guarantor_1_Id', 'Guarantor_2_Id', 'Guarantor_3_Id', 'Vesting_Id']) {
          const v = l[f];
          if (typeof v === 'string' && v.trim()) ids.add(v.trim());
          else if (typeof v === 'number') ids.add(String(v));
          else if (v && typeof v === 'object' && v.Id) ids.add(String(v.Id));
        }
      }
    }
  } catch (e) { console.warn('[pii-backfill] loan mirror walk failed:', e && e.message); }
  return Array.from(ids);
}

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-baseline-pii-backfill error:', e);
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
  const dryRun = body.dryRun !== false;      // default TRUE
  const refetch = body.refetch !== false;    // default TRUE
  const started = Date.now();

  const report = {
    startedAt: new Date().toISOString(), startedBy: normalizeEmail(user.email),
    dryRun, refetch, status: 'running',
    idsFound: 0, fetched: 0, fetchFailedUsedMirror: 0, fetchFailedNoData: 0,
    people: 0, entitiesSkipped: 0,
    matchedByLink: 0, matchedByEmail: 0, unmatched: 0, clientReadFailed: 0,
    ssnFound: 0, ssnFieldCounts: {}, ssnFilled: 0, ssnAlreadyOnClient: 0,
    addrFound: 0, addrFilled: 0, addrAlreadyComplete: 0,
    clientsWritten: 0, writeErrors: 0, timedOut: false,
    // Deploy 236.830b — schema inventory: every distinct FIELD NAME seen on
    // person payloads (+ Custom_Fields names), with occurrence counts. Names
    // only, never values — tells us definitively whether Baseline exposes an
    // SSN-bearing field at all (the first dry run found zero SSNs).
    personFieldInventory: {},
    finishedAt: '', tookSeconds: 0,
  };
  const reportStore = getStore({ name: REPORT_STORE, consistency: 'strong' });
  const saveReport = () => reportStore.setJSON('latest', report).catch(() => {});
  await saveReport();

  const mirrorStore = getStore({ name: 'baseline_borrowers_mirror', consistency: 'strong' });
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  const ids = await _collectBorrowerIds();
  report.idsFound = ids.length;

  // ── Fetch (or mirror-read) every borrower ─────────────────────────
  const borrowers = []; // { id, b }
  let cursor = 0;
  async function fetchWorker() {
    for (;;) {
      if (Date.now() - started > TIME_BUDGET_MS * 0.6) { report.timedOut = true; return; }
      const i = cursor++; if (i >= ids.length) return;
      const id = ids[i];
      let b = null;
      if (refetch) {
        const r = await fetchBorrowerDetail(id).catch(() => null);
        if (r && r.ok && r.borrower && typeof r.borrower === 'object') {
          b = r.borrower;
          report.fetched++;
          try { await saveMirroredBorrower(id, b); } catch (_) {}
        }
      }
      if (!b) {
        b = await mirrorStore.get(String(id).replace(/[^a-zA-Z0-9_.-]/g, '_'), { type: 'json' }).catch(() => null);
        if (b) report.fetchFailedUsedMirror++;
        else { report.fetchFailedNoData++; continue; }
      }
      borrowers.push({ id, b });
    }
  }
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, fetchWorker));
  await saveReport();

  // ── Match + gap-fill ──────────────────────────────────────────────
  // Cache client blobs by key so several borrowers mapping to one client
  // mutate ONE object and it's written once.
  const clientCache = {}; // clientKey -> { ownerKey, client, dirty }
  for (const { id, b } of borrowers) {
    if (Date.now() - started > TIME_BUDGET_MS) { report.timedOut = true; break; }
    if (b.Is_Company === true || b.is_company === true) { report.entitiesSkipped++; continue; }
    report.people++;

    // Field-name inventory (names only — see report comment).
    for (const k of Object.keys(b)) {
      report.personFieldInventory[k] = (report.personFieldInventory[k] || 0) + 1;
    }
    const _cf = b.Custom_Fields || b.custom_fields || b.CustomFields;
    if (Array.isArray(_cf)) {
      for (const f of _cf) {
        const nm = f && (f.Name || f.Label || f.Field || f.name || f.label);
        if (nm) report.personFieldInventory['Custom_Fields:' + nm] = (report.personFieldInventory['Custom_Fields:' + nm] || 0) + 1;
      }
    } else if (_cf && typeof _cf === 'object') {
      for (const nm of Object.keys(_cf)) {
        report.personFieldInventory['Custom_Fields:' + nm] = (report.personFieldInventory['Custom_Fields:' + nm] || 0) + 1;
      }
    }

    const { ssn, fieldName } = discoverSsn(b);
    if (ssn) {
      report.ssnFound++;
      report.ssnFieldCounts[fieldName] = (report.ssnFieldCounts[fieldName] || 0) + 1;
    }
    const addr = extractAddress(b);
    const hasAddr = !!(addr.street || addr.city || addr.state || addr.zip);
    if (hasAddr) report.addrFound++;
    if (!ssn && !hasAddr) continue;

    // Resolve the SLA client. Deploy 236.830b — a link can point at a client
    // record that has since MOVED (reassign/merge re-homes the record; the
    // borrower-link store was never updated). Verify the linked blob exists;
    // fall back to a PG email lookup either way.
    async function _emailLookup() {
      const email = _lower(_pick(b, ['Email', 'email', 'Primary_Email', 'primary_email', 'Email_Address', 'email_address']));
      if (!email || !email.includes('@')) return null;
      try {
        const row = await db.first('clients', { select: 'id,owner_email', eq: { email } });
        if (row && row.id && row.owner_email) {
          return { ownerKey: keySafe(_lower(row.owner_email)), clientId: String(row.id) };
        }
      } catch (e) { console.warn('[pii-backfill] email lookup failed for', id, e && e.message); }
      return null;
    }
    let ownerKey = '', clientId = '', entry = null, matchedVia = '';
    const link = await getBorrowerLink(id).catch(() => null);
    async function _tryLoad(ok, cid) {
      const clientKey = ok + '/' + keySafe(cid);
      if (clientCache[clientKey]) return clientCache[clientKey];
      const client = await clientsStore.get(clientKey, { type: 'json' }).catch(() => null);
      if (!client) return null;
      return (clientCache[clientKey] = { ownerKey: ok, client, dirty: false });
    }
    if (link && link.ownerKey && link.clientId) {
      entry = await _tryLoad(keySafe(String(link.ownerKey)), String(link.clientId));
      if (entry) matchedVia = 'link';
    }
    if (!entry) {
      const em = await _emailLookup();
      if (em) {
        entry = await _tryLoad(em.ownerKey, em.clientId);
        if (entry) matchedVia = 'email';
      }
    }
    if (!entry) {
      if (link && link.clientId) report.clientReadFailed++; else report.unmatched++;
      continue;
    }
    if (matchedVia === 'link') report.matchedByLink++; else report.matchedByEmail++;
    ownerKey = entry.ownerKey; clientId = entry.client.id;
    const c = entry.client;

    // SSN — only when the client has none.
    if (ssn) {
      if (c.ssn_enc) report.ssnAlreadyOnClient++;
      else {
        c.ssn_enc = encryptField(ssn);
        c.ssnLast4 = ssn.slice(-4);
        c.hasSSN = true;
        entry.dirty = true;
        report.ssnFilled++;
      }
    }
    // Address — gap-fill sub-fields only.
    if (hasAddr) {
      if (!c.homeAddress || typeof c.homeAddress !== 'object') c.homeAddress = {};
      let addrChanged = false;
      for (const k of ['street', 'city', 'state', 'zip']) {
        if (_isEmpty(c.homeAddress[k]) && !_isEmpty(addr[k])) { c.homeAddress[k] = addr[k]; addrChanged = true; }
      }
      if (addrChanged) { entry.dirty = true; report.addrFilled++; }
      else report.addrAlreadyComplete++;
    }
  }

  // ── Write ─────────────────────────────────────────────────────────
  for (const clientKey of Object.keys(clientCache)) {
    const entry = clientCache[clientKey];
    if (!entry.dirty) continue;
    if (dryRun) { report.clientsWritten++; continue; } // counted as would-write
    try {
      entry.client.updatedAt = new Date().toISOString();
      await writeClient(entry.ownerKey, entry.client, { clientsStore });
      report.clientsWritten++;
    } catch (e) {
      report.writeErrors++;
      console.error('[pii-backfill] write failed for', clientKey, e && e.message);
    }
  }

  report.status = 'done';
  report.finishedAt = new Date().toISOString();
  report.tookSeconds = Math.round((Date.now() - started) / 1000);
  await saveReport();
  console.log('[pii-backfill] done:', JSON.stringify(report));
  return json(200, { ok: true, report });
}
