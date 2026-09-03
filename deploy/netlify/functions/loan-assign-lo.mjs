/**
 * loan-assign-lo.mjs — POST /api/loan-assign-lo
 *
 * Deploy 236.187 — reassign a loan from one Loan Officer's ownership
 * to another. Different from loan-reassign.mjs which moves between
 * two clients under the SAME owner. This moves ACROSS owners.
 *
 * The loan's client record can't just be moved (the source client
 * may have other loans that should stay). We create a new client
 * under the destination owner (copying borrower info) and put the
 * loan there. The source client keeps its other loans.
 *
 * Body:
 *   {
 *     ownerKey,          keySafe of current owner
 *     clientId,          loan's client id
 *     loanId,            the loan to move
 *     newOwnerEmail,     destination LO email
 *   }
 *
 * Behavior:
 *   - Loads source client + finds the loan.
 *   - Creates a new client at <newOwnerKey>/c_lo_<timestamp>_<rand>
 *     with copied borrower info + this loan.
 *   - Removes loan from source client. If source client is now empty
 *     AND was the IMPORT_OWNER_KEY, deletes it.
 *   - Moves supporting data: borrower_info, signed_applications,
 *     quotes, loan_reviews — same as loan-reassign for consistency.
 *   - Writes a native-link for future Baseline Migrates to route to
 *     the new owner if the loan has a Baseline external Id.
 *
 * Returns updated destination info + counts.
 *
 * Auth: admin only.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isAdmin, readJsonBody,
  keySafe, normalizeEmail,
} from './_shared/auth.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { newRecordKey, legacyRecordKey } from './_shared/borrower-info-keys.mjs';
import { IMPORT_OWNER_KEY, setNativeLink } from './_shared/baseline-upsert.mjs';
// Deploy 236.357 — persist the (old → new) location so any URL that
// still references the old (owner, client) tuple redirects in one
// blob read instead of forcing loan-locate to scan the index.
import { record as recordLoanRedirect } from './_shared/loan-redirects.mjs';
import { mirror as pgMirror } from './_shared/pg-mirror.mjs'; // Phase 2 dual-write (kept for deleteClientStrict)
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper (covers blob + clients-index + pg-mirror).
import { writeClient } from './_shared/client-write.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-assign-lo error:', e);
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
  if (!body.ownerKey)      return json(400, { error: 'ownerKey required' });
  if (!body.clientId)      return json(400, { error: 'clientId required' });
  if (!body.loanId)        return json(400, { error: 'loanId required' });
  if (!body.newOwnerEmail) return json(400, { error: 'newOwnerEmail required' });

  const oldOwnerKey = String(body.ownerKey).trim();
  const newOwnerEmail = normalizeEmail(body.newOwnerEmail);
  const newOwnerKey = keySafe(newOwnerEmail);
  if (!newOwnerKey) return json(400, { error: 'newOwnerEmail is invalid' });
  if (oldOwnerKey === newOwnerKey) return json(400, { error: 'Loan is already owned by this LO' });

  const now = new Date().toISOString();
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });

  const srcKey = oldOwnerKey + '/' + keySafe(body.clientId);
  const srcClient = await clientsStore.get(srcKey, { type: 'json' }).catch(() => null);
  if (!srcClient) return json(404, { error: 'Source client not found' });
  if (!Array.isArray(srcClient.loans)) return json(400, { error: 'Source client has no loans[]' });

  const loanIdx = srcClient.loans.findIndex((x) => x && x.id === body.loanId);
  if (loanIdx < 0) return json(404, { error: 'Loan not found on source client' });
  const loan = srcClient.loans[loanIdx];

  // Build the destination client. Fresh id under new owner's namespace.
  const destClientId = 'c_lo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const destKey     = newOwnerKey + '/' + destClientId;
  const destClient  = {
    id: destClientId,
    firstName:  srcClient.firstName  || '',
    lastName:   srcClient.lastName   || '',
    email:      srcClient.email      || '',
    phone:      srcClient.phone      || '',
    entityName: srcClient.entityName || '',
    displayName: srcClient.displayName || '',
    address:    srcClient.address    || '',
    city:       srcClient.city       || '',
    state:      srcClient.state      || '',
    zip:        srcClient.zip        || '',
    createdAt:  now,
    updatedAt:  now,
    _assignedFromClientId: srcClient.id,
    _assignedFromOwnerKey: oldOwnerKey,
    _assignedAt:           now,
    _assignedBy:           user.email || '',
    loans: [],
  };

  // Stamp audit + note on the loan itself.
  loan._assignedAt          = now;
  loan._assignedBy          = user.email || '';
  loan._assignedFromOwnerKey = oldOwnerKey;
  loan._assignedFromClientId = srcClient.id;
  loan.updatedAt            = now;
  {
    const meta = (user && user.user_metadata) || {};
    const author = meta.full_name || meta.fullName || user.email || '';
    appendNoteEntry(loan, {
      kind:  'status',
      text:  'Assigned to LO ' + newOwnerEmail + ' (from owner ' + oldOwnerKey + ')',
      author,
      authorEmail: user.email || '',
      meta: { via: 'loan_assign_lo', fromOwnerKey: oldOwnerKey, toOwnerEmail: newOwnerEmail, toClientId: destClientId },
    });
  }

  destClient.loans.push(loan);
  srcClient.loans.splice(loanIdx, 1);
  srcClient.updatedAt = now;

  // Deploy 236.368 — also delete src when it's a Broker Deal
  // placeholder that just lost its only loan (matches loan-reassign's
  // auto-cleanup). Same rationale: don't accumulate placeholder husks
  // when the LO cycles a broker deal to a real borrower.
  const deleteSrcClient = srcClient.loans.length === 0 && (
    oldOwnerKey === IMPORT_OWNER_KEY || srcClient._isBrokerPlaceholder
  );

  try {
    // Write dest FIRST — if src write fails, at least the loan lives somewhere.
    // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
    await writeClient(newOwnerKey, destClient, { clientsStore });
    if (deleteSrcClient) {
      await clientsStore.delete(srcKey);
      await pgMirror.deleteClientStrict(srcClient.id);
    } else {
      // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
      await writeClient(oldOwnerKey, srcClient, { clientsStore });
    }
  } catch (e) {
    return json(500, { error: 'Failed to persist client records: ' + (e.message || 'unknown') });
  }

  // ── Move supporting cross-store data ─────────────────────────
  let movedBorrowerInfo = false;
  try {
    const biStore   = getStore({ name: 'borrower_info', consistency: 'strong' });
    const oldBiNew  = newRecordKey(oldOwnerKey, body.clientId, body.loanId);
    const oldBiLegacy = legacyRecordKey(oldOwnerKey, body.clientId);
    let biRec = await biStore.get(oldBiNew, { type: 'json' });
    let foundAtNew = !!biRec;
    if (!biRec) biRec = await biStore.get(oldBiLegacy, { type: 'json' });
    if (biRec) {
      const destBiKey = newRecordKey(newOwnerKey, destClientId, body.loanId);
      biRec.clientId = destClientId;
      biRec.loanId   = body.loanId;
      biRec.ownerKey = newOwnerKey;
      await biStore.setJSON(destBiKey, biRec);
      if (foundAtNew) await biStore.delete(oldBiNew);
      else            await biStore.delete(oldBiLegacy);
      movedBorrowerInfo = true;
    }
  } catch (e) {
    console.warn('loan-assign-lo: borrower_info move failed (non-fatal):', e && e.message);
  }

  let movedSignedApp = false;
  try {
    const appStore = getStore({ name: 'signed_applications', consistency: 'strong' });
    const oldAppKey = oldOwnerKey + '/' + keySafe(body.clientId) + '/' + keySafe(body.loanId);
    const newAppKey = newOwnerKey + '/' + destClientId + '/' + keySafe(body.loanId);
    const rec = await appStore.get(oldAppKey, { type: 'json' });
    if (rec) {
      rec.clientId = destClientId;
      rec.ownerKey = newOwnerKey;
      await appStore.setJSON(newAppKey, rec);
      await appStore.delete(oldAppKey);
      movedSignedApp = true;
    }
  } catch (e) {
    console.warn('loan-assign-lo: signed_application move failed (non-fatal):', e && e.message);
  }

  let movedQuotes = 0;
  try {
    const qStore = getStore({ name: 'quotes', consistency: 'strong' });
    const { blobs } = await qStore.list({ prefix: oldOwnerKey + '/' });
    for (const { key } of blobs) {
      const q = await qStore.get(key, { type: 'json' });
      if (!q) continue;
      if (q.loanId !== body.loanId) continue;
      // Delete old-owner-keyed entry, write under new owner's namespace.
      const newQuoteKey = newOwnerKey + '/' + key.slice(oldOwnerKey.length + 1);
      q.clientId  = destClientId;
      q.ownerKey  = newOwnerKey;
      q.updatedAt = now;
      q._reassignedAt = now;
      q._reassignedBy = user.email || '';
      await qStore.setJSON(newQuoteKey, q);
      if (newQuoteKey !== key) await qStore.delete(key);
      movedQuotes += 1;
    }
  } catch (e) {
    console.warn('loan-assign-lo: quote move failed (non-fatal):', e && e.message);
  }

  let movedReviews = 0;
  try {
    const rStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
    const { blobs } = await rStore.list();
    for (const { key } of blobs) {
      const r = await rStore.get(key, { type: 'json' });
      if (!r || !r.source) continue;
      if (r.source.loanId === body.loanId && r.source.clientId === body.clientId && r.source.ownerKey === oldOwnerKey) {
        r.source.clientId = destClientId;
        r.source.ownerKey = newOwnerKey;
        r.updatedAt = now;
        await rStore.setJSON(key, r);
        movedReviews += 1;
      }
    }
  } catch (e) {
    console.warn('loan-assign-lo: review update failed (non-fatal):', e && e.message);
  }

  // Update the native link if this loan has a Baseline extId so
  // future Migrates keep landing on the NEW owner's record.
  const extId = (loan._baselineExternalId
    || (loan._baselineRaw && loan._baselineRaw.Id)
    || ''
  );
  let linkUpdated = false;
  if (extId) {
    try {
      await setNativeLink(String(extId).trim(), {
        ownerKey: newOwnerKey,
        clientId: destClientId,
        loanId:   loan.id,
        source:   'assign_lo',
      });
      linkUpdated = true;
    } catch (e) {
      console.warn('loan-assign-lo: setNativeLink failed (non-fatal):', e && e.message);
    }
  }

  // Deploy 236.357 — write the (old → new) redirect entry BEFORE
  // the notify block so if the email/reminder block throws, the
  // redirect is still on file. Any URL that still points at
  // (oldOwnerKey, body.clientId, loanId) resolves in one blob read.
  await recordLoanRedirect({
    loanId:       loan.id,
    fromOwnerKey: oldOwnerKey,
    fromClientId: body.clientId,
    toOwnerKey:   newOwnerKey,
    toClientId:   destClientId,
    via:          'loan_assign_lo',
  });

  // ── Deploy 236.866 (Mike, Jesse Sells / 2030 Elm Ave) — move the PROSPECT
  // with the loan. Pipeline's New Application column hides a prospect only
  // when the SAME owner holds its priced/quoted loan (_workedProspectIds is
  // keyed per owner), so leaving the prospect under the old LO stranded a
  // permanent "New Application" duplicate after every dropdown reassign.
  // Match by loan.prospectId, falling back to a fromApplication address
  // match for pre-236.22 loans that were never stamped. Best-effort.
  let prospectMoved = false;
  try {
    const pStore = getStore({ name: 'prospects', consistency: 'strong' });
    const { prospectsIndex } = await import('./_shared/prospects-index.mjs');
    const normA = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
    const { blobs } = await pStore.list({ prefix: oldOwnerKey + '/' });
    for (const b of blobs || []) {
      const p = await pStore.get(b.key, { type: 'json' }).catch(() => null);
      if (!p) continue;
      const idMatch = !!(loan.prospectId && p.id === loan.prospectId);
      const addrMatch = !idMatch && !!(loan.fromApplication && p.propAddress &&
        normA(p.propAddress) === normA(loan.address));
      if (!idMatch && !addrMatch) continue;
      p.loSlug = newOwnerEmail;
      p.loEmail = newOwnerEmail;
      p.clientId = destClientId;
      p.loanId = loan.id;
      p.updatedAt = new Date().toISOString();
      const newPKey = newOwnerKey + '/' + keySafe(p.id);
      await pStore.setJSON(newPKey, p);
      if (b.key !== newPKey) {
        try { await pStore.delete(b.key); } catch (_) {}
      }
      try {
        await prospectsIndex.upsertRecord(newOwnerKey, p);
        await prospectsIndex.removeRecord(oldOwnerKey, p.id);
      } catch (e) { console.warn('loan-assign-lo: prospect index sync failed (non-fatal):', e && e.message); }
      prospectMoved = true;
    }
  } catch (e) {
    console.warn('loan-assign-lo: prospect move failed (non-fatal):', e && e.message);
  }

  // ── Notify the new LO: in-app reminder + email ───────────────
  // Deploy 236.351 — dropdown-reassign UX shipped; the new LO
  // needs to know a loan just landed on their desk without the
  // admin having to also send a manual Slack ping. Both channels
  // are best-effort — a failure here NEVER poisons the assign
  // (which has already committed all the blob writes above).
  let reminderCreated = false;
  let emailedAt = null;
  try {
    const profilesStore = getStore({ name: 'profiles', consistency: 'eventual' });

    // New LO profile — for email personalization.
    let newLoName = '';
    try {
      const newProfile = await profilesStore.get(newOwnerKey, { type: 'json' });
      if (newProfile) {
        const meta = newProfile.user_metadata || {};
        newLoName = meta.full_name || meta.fullName
          || newProfile.full_name || newProfile.fullName || '';
      }
    } catch (_) { /* fall through with empty name */ }

    // Admin (the person doing the assign) — for "assigned by" text.
    let adminName = '';
    try {
      const adminMeta = (user && user.user_metadata) || {};
      adminName = adminMeta.full_name || adminMeta.fullName || user.email || '';
    } catch (_) { /* empty */ }

    const borrowerName = ((destClient.firstName || '') + ' ' + (destClient.lastName || '')).trim()
      || destClient.email || 'the borrower';
    const address = loan.address || '';
    const amtNum  = parseFloat(String(loan.loanAmt || '').replace(/[$,]/g, '')) || 0;
    const amtStr  = amtNum > 0 ? '$' + Math.round(amtNum).toLocaleString() : '';

    // ── In-app reminder (fires the bell in the new LO's UI) ────
    // Reminders are per-owner scoped, so writing under newOwnerKey
    // means only the new LO sees it. Reminders-save has a "one
    // active per loan" rule but this loan just moved out of the
    // old owner's namespace — no collision. `_owner` is the
    // reminders-save admin-override channel to write on behalf
    // of another user.
    try {
      const remStore = getStore({ name: 'reminders', consistency: 'strong' });
      const remId = 'r_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
      const remRec = {
        id: remId,
        loanId:   loan.id,
        clientId: destClientId,
        ownerKey: newOwnerKey,
        address,
        borrower: borrowerName,
        note: 'Loan reassigned to you by ' + (adminName || 'an admin') +
          (amtStr ? ' — ' + amtStr : '') +
          (address ? ' — ' + address : ''),
        dueDate: now.slice(0, 10),
        completed: false,
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        createdBy: user.email || '',
        _kind: 'loan_assigned',
      };
      await remStore.setJSON(newOwnerKey + '/' + keySafe(remId), remRec);
      reminderCreated = true;
    } catch (e) {
      console.warn('loan-assign-lo: reminder create failed (non-fatal):', e && e.message);
    }

    // ── Email the new LO via Resend ────────────────────────────
    const apiKey = process.env.RESEND_API_KEY;
    if (apiKey && newOwnerEmail) {
      try {
        const proto = (req.headers.get ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto']) || 'https';
        const host  = (req.headers.get ? req.headers.get('host') : req.headers.host) || '';
        const base  = host ? `${proto}://${host}` : (process.env.URL || 'https://slaloantools.netlify.app');
        const loanLink = base +
          '/loan-details/' + encodeURIComponent(loan.id) +
          '?owner=' + encodeURIComponent(newOwnerEmail);

        const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const greeting = newLoName ? ('Hi ' + newLoName.split(/\s+/)[0] + ',') : 'Hi,';
        const subject = 'Loan assigned to you: ' + (borrowerName || address || 'new loan');
        const bodyLines = [
          greeting,
          '',
          (adminName || 'An admin') + ' has assigned a loan to you at SLA Capital.',
          '',
          'Borrower: ' + borrowerName,
          address ? ('Property: ' + address) : '',
          amtStr  ? ('Loan Amount: ' + amtStr) : '',
          '',
          'Open the loan:',
          loanLink,
          '',
          "You'll also see this in your Pipeline and reminders bell next time you log in.",
          '',
          '— SLA Capital',
        ].filter(Boolean);
        const text = bodyLines.join('\n');
        const html =
          '<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#261A36;line-height:1.55">' +
          bodyLines.map((ln) => {
            if (ln === loanLink) {
              return '<p><a href="' + escH(loanLink) + '" style="color:#C8813A;font-weight:600">Open the loan →</a></p>';
            }
            return '<p style="margin:0 0 8px 0">' + escH(ln) + '</p>';
          }).join('') +
          '</div>';

        const resp = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            from: 'SLA Capital <noreply@leads.slacapital.com>',
            to: [newOwnerEmail],
            subject, text, html,
          }),
        });
        if (resp.ok) emailedAt = new Date().toISOString();
        else {
          const t = await resp.text().catch(() => '');
          console.warn('loan-assign-lo: email failed', resp.status, t.slice(0, 200));
        }
      } catch (e) {
        console.warn('loan-assign-lo: email threw (non-fatal):', e && e.message);
      }
    }
  } catch (e) {
    console.warn('loan-assign-lo: notify block threw (non-fatal):', e && e.message);
  }

  return json(200, {
    ok: true,
    newOwnerKey,
    newOwnerEmail,
    newClientId:      destClientId,
    loanId:           loan.id,
    srcClientDeleted: deleteSrcClient,
    movedBorrowerInfo,
    movedSignedApp,
    movedQuotes,
    movedReviews,
    prospectMoved, // Deploy 236.866

    linkUpdated,
    reminderCreated,
    emailedAt,
  });
}
