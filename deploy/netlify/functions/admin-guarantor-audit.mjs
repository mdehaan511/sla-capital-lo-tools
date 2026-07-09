/**
 * admin-guarantor-audit.mjs — GET /api/admin-guarantor-audit
 *
 * Deploy 236.271 — three-path forensic scan for loans whose
 * guarantorClientIds / guarantorOwnership got silently wiped by the
 * pre-236.269 sizer-upsert fallback bug.
 *
 * DETECTION PATHS
 *
 *   A. signed_applications comparison (236.270)
 *      For each signed_applications record with numBorrowers >= 2,
 *      compare secondaries (borrower2/3/4) to loan.guarantorClientIds.
 *      Catches long-app-signed loans that lost guarantors.
 *
 *   B. Orphaned ownership entries (236.271 addition)
 *      Any loan where guarantorOwnership has a key that's NOT in
 *      guarantorClientIds. Smoking gun that a guarantor's ownership %
 *      was recorded but their client-id reference got wiped. Catches
 *      loans regardless of how the guarantor was originally added
 *      (long-app sign OR the loan-add-guarantor "Add Guarantor" flow).
 *
 *   C. Guarantor backref mismatch (236.271 addition)
 *      Every client created as a guarantor carries
 *      _guarantorOnLoans: [{ primaryClientId, loanId }]. If a client
 *      says "I'm on loan X" but loan X's guarantorClientIds doesn't
 *      include this client's id, that's a wipe. Catches cases where
 *      BOTH arrays got fully cleared (no orphaned ownership signal).
 *
 * Every affected entry carries `reasons: ['signed', 'orphaned', 'backref']`
 * showing which path(s) flagged it. A loan flagged by multiple paths
 * is deduped into one entry.
 *
 * Response:
 *   {
 *     scanned: { signed: N, loans: M, clients: K },
 *     affectedCount: <int>,
 *     affected: [
 *       {
 *         ownerKey, clientId, loanId, address, status,
 *         reasons: ['signed', ...],
 *         expected: N|null, actual: M,
 *         missingSecondaryEmails: [...],
 *         orphanedOwnershipEntries: [{ clientId, pct }],
 *         backrefClientIds: [ids of clients whose _guarantorOnLoans points here],
 *         lastReprice: '…' | null,
 *         signedAt: '…' | null,
 *       },
 *       ...
 *     ],
 *   }
 *
 * Auth: super_admin only. Read-only; makes no writes.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isSuperAdmin,
} from './_shared/auth.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('admin-guarantor-audit error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'GET') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isSuperAdmin(user)) return json(403, { error: 'super_admin only' });

  const signedStore  = getStore({ name: 'signed_applications', consistency: 'strong' });
  const clientsStore = getStore({ name: 'clients',             consistency: 'strong' });

  function _lastRepriceAt(loan) {
    const log = (loan && Array.isArray(loan.notesLog)) ? loan.notesLog : [];
    for (let i = log.length - 1; i >= 0; i--) {
      const n = log[i];
      if (n && n.kind === 'reprice') return n.at || n.ts || null;
    }
    return null;
  }

  // Load every client record ONCE. Everything downstream indexes off
  // this in-memory map.
  //   loansByKey:      "ownerKey|loanId" → { loan, primary }
  //   clientsByKey:    "ownerKey|clientId" → client
  //   clientById:      just clientId → { client, ownerKey }  (dedup collisions OK; guarantors are unique per owner)
  const loansByKey   = new Map();
  const clientsByKey = new Map();
  const clientById   = new Map();

  const { blobs: clientBlobs } = await clientsStore.list();
  let scannedClients = 0;
  let scannedLoans   = 0;

  for (const { key } of clientBlobs) {
    scannedClients++;
    const slash = key.indexOf('/');
    if (slash < 0) continue;
    const ownerKey = key.slice(0, slash);
    const client = await clientsStore.get(key, { type: 'json' }).catch(() => null);
    if (!client) continue;
    clientsByKey.set(ownerKey + '|' + client.id, client);
    clientById.set(client.id, { client, ownerKey });
    if (Array.isArray(client.loans)) {
      for (const loan of client.loans) {
        if (!loan || !loan.id) continue;
        scannedLoans++;
        loansByKey.set(ownerKey + '|' + loan.id, { loan, primary: client, ownerKey });
      }
    }
  }

  // Reason accumulator, keyed by ownerKey|loanId so a loan flagged by
  // multiple paths dedups to one row with reasons: ['signed','orphaned','backref'].
  const flagged = new Map();
  function _flag(ownerKey, loanId, reason, patch) {
    const key = ownerKey + '|' + loanId;
    let row = flagged.get(key);
    if (!row) {
      const rec = loansByKey.get(key) || {};
      const loan = rec.loan || {};
      row = {
        ownerKey,
        clientId: rec.primary ? rec.primary.id : (patch && patch.clientId) || '',
        loanId,
        address: loan.address || '',
        status:  loan.status  || '',
        reasons: [],
        expected: null,
        actual: Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds.length : 0,
        missingSecondaryEmails: [],
        orphanedOwnershipEntries: [],
        backrefClientIds: [],
        lastReprice: _lastRepriceAt(loan),
        signedAt: null,
      };
      flagged.set(key, row);
    }
    if (!row.reasons.includes(reason)) row.reasons.push(reason);
    if (patch) {
      if (patch.expected != null) row.expected = Math.max(row.expected || 0, patch.expected);
      if (patch.signedAt) row.signedAt = patch.signedAt;
      if (Array.isArray(patch.missingSecondaryEmails)) {
        for (const em of patch.missingSecondaryEmails) if (em && !row.missingSecondaryEmails.includes(em)) row.missingSecondaryEmails.push(em);
      }
      if (Array.isArray(patch.orphanedOwnershipEntries)) {
        for (const oe of patch.orphanedOwnershipEntries) row.orphanedOwnershipEntries.push(oe);
      }
      if (Array.isArray(patch.backrefClientIds)) {
        for (const bid of patch.backrefClientIds) if (bid && !row.backrefClientIds.includes(bid)) row.backrefClientIds.push(bid);
      }
    }
  }

  // ── Path A: signed_applications comparison ────────────────
  let scannedSigned = 0;
  const { blobs: signedBlobs } = await signedStore.list();
  for (const { key } of signedBlobs) {
    scannedSigned++;
    const rec = await signedStore.get(key, { type: 'json' }).catch(() => null);
    if (!rec) continue;
    const numBorrowers = Number(rec.numBorrowers || 0);
    if (numBorrowers < 2) continue;
    const secondaries = [rec.borrower2, rec.borrower3, rec.borrower4].filter(function (b) {
      return b && (b.email || (b.audit && b.audit.signerEmail));
    });
    if (!secondaries.length) continue;
    const ownerKey = rec.ownerKey || '';
    const clientId = rec.clientId || '';
    const loanId   = rec.loanId   || '';
    if (!ownerKey || !clientId || !loanId) continue;
    const rec2 = loansByKey.get(ownerKey + '|' + loanId);
    if (!rec2 || !rec2.loan) continue;
    const loan = rec2.loan;
    const gClientIds = Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : [];
    if (gClientIds.length >= secondaries.length) continue;
    const emails = secondaries
      .map(function (s) { return String((s && (s.email || (s.audit && s.audit.signerEmail))) || '').toLowerCase().trim(); })
      .filter(Boolean);
    _flag(ownerKey, loanId, 'signed', {
      clientId,
      expected: secondaries.length,
      missingSecondaryEmails: emails,
      signedAt: rec.signedAt || null,
    });
  }

  // ── Path B: orphaned ownership entries ────────────────────
  // For every loan whose guarantorOwnership has a key that isn't in
  // guarantorClientIds — that key is the wiped guarantor's client id.
  // Look up the client record (if it still exists) to attach the
  // email for the recovery script.
  for (const [key, { loan, ownerKey, primary }] of loansByKey.entries()) {
    const own = (loan && loan.guarantorOwnership && typeof loan.guarantorOwnership === 'object') ? loan.guarantorOwnership : null;
    if (!own) continue;
    const attached = new Set(Array.isArray(loan.guarantorClientIds) ? loan.guarantorClientIds : []);
    const orphaned = [];
    const emails   = [];
    for (const gcid of Object.keys(own)) {
      if (attached.has(gcid)) continue;
      const pct = own[gcid];
      const gRec = clientById.get(gcid);
      const gClient = gRec ? gRec.client : null;
      orphaned.push({
        clientId: gcid,
        pct: pct,
        email: gClient ? (gClient.email || '') : '',
        name: gClient ? ((gClient.firstName || '') + ' ' + (gClient.lastName || '')).trim() : '',
      });
      if (gClient && gClient.email) emails.push(String(gClient.email).toLowerCase().trim());
    }
    if (!orphaned.length) continue;
    _flag(ownerKey, loan.id, 'orphaned', {
      clientId: primary.id,
      orphanedOwnershipEntries: orphaned,
      missingSecondaryEmails: emails,
    });
  }

  // ── Path C: guarantor backref mismatch ────────────────────
  // Every client created via loan-add-guarantor or borrower-info-sign
  // carries _guarantorOnLoans: [{primaryClientId, loanId}]. If a
  // client says "I'm on loan X" but loan X's guarantorClientIds
  // doesn't include this client's id, that's a wipe. Catches loans
  // where BOTH the ownership map AND the client id array were fully
  // cleared (no orphaned ownership signal).
  for (const [ckey, client] of clientsByKey.entries()) {
    const backrefs = Array.isArray(client._guarantorOnLoans) ? client._guarantorOnLoans : [];
    if (!backrefs.length) continue;
    const ownerKey = ckey.split('|')[0];
    for (const bref of backrefs) {
      if (!bref || !bref.loanId) continue;
      const rec = loansByKey.get(ownerKey + '|' + bref.loanId);
      if (!rec || !rec.loan) continue;
      const attached = new Set(Array.isArray(rec.loan.guarantorClientIds) ? rec.loan.guarantorClientIds : []);
      if (attached.has(client.id)) continue; // fine, still attached
      const em = client.email ? [String(client.email).toLowerCase().trim()] : [];
      _flag(ownerKey, bref.loanId, 'backref', {
        clientId: bref.primaryClientId || rec.primary.id,
        backrefClientIds: [client.id],
        missingSecondaryEmails: em,
      });
    }
  }

  const affected = Array.from(flagged.values());
  affected.sort(function (a, b) {
    return String(b.lastReprice || '').localeCompare(String(a.lastReprice || ''));
  });

  return json(200, {
    scanned: { signed: scannedSigned, loans: scannedLoans, clients: scannedClients },
    affectedCount: affected.length,
    affected: affected,
  });
}
