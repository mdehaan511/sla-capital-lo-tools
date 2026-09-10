/**
 * borrower-profile.mjs — GET/POST /api/borrower-profile
 *
 * Deploy 236.545 — borrower self-service profile editing. Lets a signed-in
 * borrower view and update THEIR OWN personal info (phone, mailing address,
 * SSN, business entities) on the client record their loan(s) hang off of.
 *
 * Authorization is provider-agnostic and keyed on the SAME email->loan_access
 * grant the rest of the portal uses (listAccessibleLoans). A borrower can only
 * touch the client(s) that their granted loans point at (primaryClientId), and
 * the WRITE target ownerKey is resolved from the grant — NEVER from anything the
 * borrower sends — so there is no way to redirect a write onto someone else's
 * record. Only a whitelist of borrower-editable fields is touched; loans, LO
 * notes, status, commissions, etc. pass through untouched.
 *
 * SSN is write-only from the borrower side: raw digits in -> encryptField ->
 * ssn_enc + ssnLast4 (same contract as clients-save.mjs); the raw SSN is never
 * persisted and is NEVER returned. GET exposes only { hasSSN, ssnLast4 }.
 *
 *   GET  [?clientId=]  -> { profile }
 *   POST { clientId?, phone?, homeAddress?, ssn?, companies? } -> { ok, profile }
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { listAccessibleLoans } from './_shared/loan-access-store.mjs';
import { encryptField } from './_shared/crypto.mjs';
import { writeClient } from './_shared/client-write.mjs';
// Deploy 236.895 — admin "view as a borrower" (read-only).
import { resolveViewAs, denyWrite } from './_shared/portal-view-as.mjs';
// Deploy 236.961 — email-change requests actively notify the owning LO.
import { resolveOwnerEmail } from './_shared/email.mjs';

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('borrower-profile error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  const method = req.method;
  if (method !== 'GET' && method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  // Deploy 236.895 — an admin viewing a borrower's portal reads their
  // profile; saving it is refused (make the edit on Loan Details, where it
  // is recorded under the admin's own name).
  const view = resolveViewAs(req, user);
  if (view.error) return view.error;
  if (method === 'POST') { const no = denyWrite(view); if (no) return no; }
  const email = view.email;

  // Which client(s) may this borrower edit? Strictly the ones their live
  // loan_access grants point at. Map primaryClientId -> ownerKey (the grant's
  // owner — the authoritative write target).
  const grants = await listAccessibleLoans(email);
  const clientMap = {};
  for (const g of (grants || [])) {
    if (g && g.primaryClientId && g.ownerKey) clientMap[g.primaryClientId] = g.ownerKey;
  }
  const clientIds = Object.keys(clientMap);
  if (!clientIds.length) return json(403, { error: 'No profile is linked to this account yet.' });

  // Resolve the target client. A supplied clientId MUST be one of the
  // borrower's granted clients; otherwise default to the (usually only) one.
  let body = null, wantClientId = '';
  if (method === 'GET') {
    wantClientId = String(new URL(req.url).searchParams.get('clientId') || '').trim();
  } else {
    body = await readJsonBody(req);
    wantClientId = body && body.clientId ? String(body.clientId).trim() : '';
  }
  let clientId = wantClientId || clientIds[0];
  const ownerKey = clientMap[clientId];
  if (!ownerKey) return json(403, { error: 'You do not have access to that profile.' });

  const store = getStore({ name: 'clients', consistency: 'strong' });
  const client = await store.get(ownerKey + '/' + keySafe(clientId), { type: 'json' });
  if (!client) return json(404, { error: 'Profile not found.' });

  if (method === 'GET') {
    return json(200, { profile: _sanitize(client, clientId, clientIds) });
  }

  // ── POST: update ONLY the whitelisted borrower-editable fields ──
  if (body.phone !== undefined) client.phone = String(body.phone || '').trim();

  if (body.homeAddress && typeof body.homeAddress === 'object') {
    const h = body.homeAddress;
    client.homeAddress = {
      street: String(h.street || '').trim(),
      city:   String(h.city   || '').trim(),
      state:  String(h.state  || '').trim(),
      zip:    String(h.zip    || '').trim(),
    };
  }

  // Deploy 236.959 (Mike) — mailing address, same object shape. Writes to
  // the client record like everything here, so the SLA client page and the
  // borrower portal always agree.
  if (body.mailingAddress && typeof body.mailingAddress === 'object') {
    const m = body.mailingAddress;
    client.mailingAddress = {
      street: String(m.street || '').trim(),
      city:   String(m.city   || '').trim(),
      state:  String(m.state  || '').trim(),
      zip:    String(m.zip    || '').trim(),
    };
  }

  // Deploy 236.959 (Mike) — "request to change my email". The LOGIN email is
  // identity (Supabase + loan grants key off it), so the borrower can't flip
  // it self-service: this stamps a request on EVERY granted client record +
  // drops a notesLog entry so the LO/admin sees it, performs the change on
  // the admin side, and the borrower re-confirms by signing in at the new
  // address (magic link = inherent confirmation).
  if (body.requestEmailChange !== undefined) {
    const newEmail = normalizeEmail(String(body.requestEmailChange || ''));
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(newEmail)) {
      return json(400, { error: 'Enter a valid email address.' });
    }
    const stamp = { requested: newEmail, from: email, at: new Date().toISOString() };
    for (const cid of clientIds) {
      try {
        const ok2 = clientMap[cid];
        const c2 = (cid === clientId) ? client : await store.get(ok2 + '/' + keySafe(cid), { type: 'json' });
        if (!c2) continue;
        c2._emailChangeRequest = stamp;
        c2.notesLog = Array.isArray(c2.notesLog) ? c2.notesLog : [];
        c2.notesLog.push({
          id: 'n_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          at: stamp.at, kind: 'status', author: 'Borrower Portal', authorEmail: email,
          text: 'Borrower requested a LOGIN EMAIL change: ' + email + ' -> ' + newEmail +
            '. Update their login on the admin side; they will confirm by signing in at the new address.',
        });
        if (cid !== clientId) await writeClient(ok2, c2, { clientsStore: store });
      } catch (_) { /* best-effort per client */ }
    }

    // Deploy 236.961 (Mike) — the banner/notes alone were PASSIVE (seen only
    // when someone opened the client page). Now each owning LO also gets:
    //   1. an email (Resend) with the old -> new addresses + a client link,
    //   2. a task assigned to them, due today, which the notification bell
    //      surfaces. The task id is DETERMINISTIC per client so a repeat
    //      click updates/re-opens the same task instead of stacking dupes.
    // Best-effort — a notify failure never fails the request itself.
    const borrowerName = (((client.firstName || '') + ' ' + (client.lastName || '')).trim()) || email;
    const tasksStore = getStore({ name: 'tasks', consistency: 'strong' });
    const today = stamp.at.slice(0, 10);
    const notified = {};
    for (const g of (grants || [])) {
      if (!g || !g.ownerKey || !g.primaryClientId || notified[g.ownerKey]) continue;
      notified[g.ownerKey] = true;
      try {
        const loEmail = await resolveOwnerEmail({ ownerKey: g.ownerKey });
        const detailLine = borrowerName + ' asked to change their portal login email: ' +
          email + ' -> ' + newEmail + '. Update their login on the admin side; ' +
          'they will confirm by signing in at the new address.';

        // Task — written straight to the tasks store, same record shape as
        // tasks-save.mjs creates (kept in sync by hand; there is no shared
        // task-create helper). Re-request flips a completed task back open.
        const taskId = 't_emailchg_' + keySafe(g.primaryClientId);
        const task = {
          id: taskId, clientId: g.primaryClientId, loanId: g.loanId || '',
          ownerKey: g.ownerKey,
          title: 'Borrower requested a login email change',
          dueDate: today,
          assignedTo: loEmail, assignedToName: '',
          description: detailLine,
          completed: false, completedAt: '', completedBy: '', completedByName: '',
          createdAt: stamp.at, createdBy: email, createdByName: 'Borrower Portal',
          updatedAt: stamp.at, updatedBy: email,
          autoKind: 'email_change_request',
        };
        await tasksStore.setJSON(g.ownerKey + '/' + keySafe(taskId), task);

        // Email the LO. reply_to is the borrower's CURRENT address so the LO
        // can hit Reply to verify the request with them directly.
        const apiKey = process.env.RESEND_API_KEY;
        if (apiKey && loEmail) {
          const clientUrl = 'https://portal.slacapital.ai/client-details.html?clientId=' +
            encodeURIComponent(g.primaryClientId);
          const escH = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          const resp = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'SLA Capital <noreply@leads.slacapital.com>',
              to: [loEmail],
              subject: 'Email change request — ' + borrowerName,
              text: detailLine + '\n\nClient page: ' + clientUrl + '\n\nSLA Capital',
              html: '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
                '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
                  '<div style="background:#261A36;padding:20px">' +
                    '<h1 style="color:#C8813A;margin:0;font-size:17px">Borrower Email Change Request</h1>' +
                  '</div>' +
                  '<div style="padding:22px;color:#1A1520">' +
                    '<p style="font-size:15px;line-height:1.6"><strong>' + escH(borrowerName) + '</strong> asked to change their portal login email:</p>' +
                    '<p style="font-size:15px;line-height:1.6"><code>' + escH(email) + '</code> &rarr; <code>' + escH(newEmail) + '</code></p>' +
                    '<p style="font-size:14px;line-height:1.6;color:#7A7488">Update their login on the admin side; they will confirm by signing in at the new address. There is a banner with a &ldquo;Mark handled&rdquo; link on their client page.</p>' +
                    '<p style="font-size:14px"><a href="' + escH(clientUrl) + '" style="color:#B5712D">Open their client page &rarr;</a></p>' +
                  '</div>' +
                '</div>' +
                '</body></html>',
              reply_to: email,
            }),
          });
          if (!resp.ok) {
            const t = await resp.text().catch(() => '');
            console.warn('borrower-profile: email-change notify Resend ' + resp.status, t.slice(0, 200));
          }
        }
      } catch (e) {
        console.warn('borrower-profile: email-change notify failed for ' + g.ownerKey + ':', e && e.message);
      }
    }
  }

  // SSN — write-only. Only a full 9-digit value replaces what's on file; a
  // blank/partial value leaves the existing ssn_enc untouched (a borrower can
  // never accidentally WIPE their SSN from here). Raw digits are never stored.
  if (body.ssn !== undefined) {
    const digits = String(body.ssn).replace(/\D/g, '');
    if (digits.length === 9) {
      const enc = encryptField(digits);
      if (enc) { client.ssn_enc = enc; client.ssnLast4 = digits.slice(-4); }
    }
  }
  delete client.ssn; // never persist a raw SSN

  if (Array.isArray(body.companies)) {
    client.companies = body.companies.map(function (c) {
      c = c || {};
      return {
        name:    String(c.name    || '').trim(),
        ein:     String(c.ein     || '').trim(),
        address: String(c.address || '').trim(),
        city:    String(c.city    || '').trim(),
        state:   String(c.state   || '').trim(),
        zip:     String(c.zip     || '').trim(),
      };
    }).filter(function (c) { return c.name || c.ein; });
  }

  client.updatedAt = new Date().toISOString();
  // Audit crumb so the LO can see the borrower self-edited (and when).
  client._lastBorrowerEdit = { at: client.updatedAt, by: email };

  // Strict PG-first write (blob + clients-index + pg-mirror), same path as
  // clients-save. Await it — fire-and-forget reintroduces the drift bug class.
  await writeClient(ownerKey, client, { clientsStore: store });

  return json(200, { ok: true, profile: _sanitize(client, clientId, clientIds) });
}

// Borrower-safe projection. NEVER includes ssn_enc or any LO-side context —
// only what the borrower needs to see/edit their own info.
function _sanitize(c, clientId, clientIds) {
  const h = (c && c.homeAddress) || {};
  const m = (c && c.mailingAddress) || {}; // 236.959
  return {
    mailingAddress: {
      street: m.street || '', city: m.city || '', state: m.state || '', zip: m.zip || '',
    },
    emailChangeRequest: (c && c._emailChangeRequest) || null,
    clientId: clientId,
    clientIds: clientIds,                 // all profiles this borrower can edit (usually 1)
    firstName: c.firstName || '',
    lastName:  c.lastName  || '',
    email:     c.email     || '',
    phone:     c.phone     || '',
    homeAddress: {
      street: h.street || '', city: h.city || '', state: h.state || '', zip: h.zip || '',
    },
    hasSSN:   !!c.ssn_enc,                 // presence only — never the value
    ssnLast4: c.ssnLast4 || '',
    companies: Array.isArray(c.companies) ? c.companies.map(function (x) {
      x = x || {};
      return {
        name: x.name || '', ein: x.ein || '', address: x.address || '',
        city: x.city || '', state: x.state || '', zip: x.zip || '',
      };
    }) : [],
  };
}
