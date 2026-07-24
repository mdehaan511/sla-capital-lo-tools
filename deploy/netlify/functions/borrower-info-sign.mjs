/**
 * borrower-info-sign.mjs — POST /api/borrower-info-sign
 *
 * Deploy 179. Final step of the borrower-side loan application flow.
 * Public endpoint (token-based, no LO auth required — the borrower is
 * signing on their own behalf via the token link they received).
 *
 * Body: {
 *   t: TOKEN,                 // the borrower-info access token
 *   signerName: string,       // their typed full legal name
 *   signerEmail?: string,     // optional — they may have updated it
 *   consentAccepted: true,    // explicit acceptance of ESIGN/UETA consent
 *   consentVersion: number,   // must match server's current version
 *   geolocation?: string,     // optional, captured client-side if permitted
 * }
 *
 * Flow:
 *   1. Validate token + look up the borrower-info record
 *   2. Validate consent + signer name + record is complete enough to sign
 *   3. Mark the record `status: complete` (same as existing submitFinal path)
 *   4. Build audit trail: server timestamp, IP, UA, data hash, HMAC seal
 *   5. Render signed PDF
 *   6. Store signed record (PDF binary base64 + audit) in `signed_applications`
 *   7. Email a copy to the borrower (best-effort)
 *   8. Fire the auto-advance to APPROVED (loan moves to In Processing)
 *   9. Return success — frontend shows the "thank you, signed" page
 *
 * If any step fails before step 6 (the signed record store) the
 * borrower's form data is still saved (we only flip status to complete
 * after the signed PDF lands). They'd see an error and could re-sign.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, readJsonBody,
} from './_shared/auth.mjs';
import { resolveByToken } from './_shared/borrower-info-token-index.mjs';
import { syncPropertyFieldsToLoan, advanceQuoteToInProcessing } from './_shared/borrower-info-sync.mjs';
import {
  ESIGN_CONSENT_VERSION, hashFormData, sealAudit, getClientIp, getUserAgent,
  generateBorrower2Token,
} from './_shared/esign.mjs';
import { renderSignedApplicationPDF } from './_shared/loan-application-pdf.mjs';
// Deploy 223 — reply_to = LO who owns the lead.
import { getOwnerReplyTo } from './_shared/email.mjs';
// Deploy 236.402 (C2 slice 2): client persists route through the shared
// PG-first writeClient helper.
import { writeClient } from './_shared/client-write.mjs';

// Which forms each signer signed in their single signing event.
// Borrower 1\u2019s session covers all three forms (their own); borrower 2\u2019s
// session covers only the prequal credit check (they don\u2019t re-sign
// the application acknowledgement — that\u2019s a joint borrower-1 event
// from a UETA perspective, similar to how a paper application is
// signed once at the bottom by the lead borrower).
const B1_SIGNED_AUTHS = ['app_acknowledgement', 'prequal_credit', 'info_release'];
const B2_SIGNED_AUTHS = ['prequal_credit'];

// Borrower-2 token expires in 30 days. Same window as the borrower-info
// link so a stalled deal doesn\u2019t leave an indefinite signing link out
// in the wild.
const B2_TOKEN_TTL_DAYS = 30;

// Deploy 236.413 — step timing. A borrower has been getting a platform
// HTML error page (not our JSON) on every sign attempt, which smells
// like the 10s function timeout. These marks land in the Netlify
// function log; if an invocation dies, the LAST mark printed names the
// slow step. Remove once the incident is closed (Deploy 194 rule).
let _signT0 = 0;
let _marks = [];
function _mark(label) {
  const line = label + ' t+' + (Date.now() - _signT0) + 'ms';
  _marks.push(line);
  console.log('[sign-timing] ' + line);
}
// Deploy 236.415 — self-imposed deadline UNDER the platform's 10s
// kill timer. Instead of dying as a naked 504, the handler:
//   - pre-signature: aborts with its own step timings in the error
//     (diagnosis without Netlify log access), nothing half-committed;
//   - post-signature: SKIPS remaining housekeeping (advance, emails)
//     and returns success — the signature is durable, the borrower is
//     done, skipped steps are flagged on the record for follow-up.
const SIGN_DEADLINE_MS = 7200;
function _pastDeadline() {
  return (Date.now() - _signT0) > SIGN_DEADLINE_MS;
}

export default async (req, context) => {
  _signT0 = Date.now();
  _marks = [];
  try {
    return await handle(req, context);
  } catch (e) {
    console.error('borrower-info-sign error:', e);
    return json(500, { error: 'Server error: ' + (e.message || 'unknown') });
  }
};

// Pre-signature abort: nothing durable has been written yet, so a
// clean retryable error carrying our own timings beats a platform 504.
function _deadlineAbort(where) {
  console.warn('[sign-timing] DEADLINE pre-signature at ' + where + ' — ' + _marks.join(' | '));
  return json(503, {
    error: 'Signing timed out while preparing your documents (at: ' + where + '). ' +
           'Nothing was lost — please try again. Diagnostic: ' + _marks.join(' → '),
  });
}

async function handle(req) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const body = await readJsonBody(req);
  if (body === null) return json(400, { error: 'Invalid JSON' });
  if (!body.t)               return json(400, { error: 'Missing token' });
  if (!body.signerName || !body.signerName.trim())
                             return json(400, { error: 'Signer name is required' });
  if (!body.consentAccepted) return json(400, { error: 'ESIGN/UETA consent must be accepted' });
  if (body.consentVersion !== ESIGN_CONSENT_VERSION) {
    return json(409, {
      error: 'Consent text has been updated. Please review and accept the latest version.',
      currentVersion: ESIGN_CONSENT_VERSION,
    });
  }

  // ── 1. Look up the record by token ─────────────────────────────
  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  let record = null;
  let recordKey = null;

  // Deploy 236.414 — shared bounded resolver (fast index path, budgeted
  // chunked walk, index self-heal). A stale token — e.g. an OLDER email
  // after the LO resent the application, which used to ROTATE the token —
  // now fails fast with an actionable message instead of walking the
  // whole store into a 504.
  const resolved = await resolveByToken(biStore, body.t);
  record = resolved.record;
  recordKey = resolved.recordKey;
  _mark('token-resolved found=' + !!record + ' timedOut=' + resolved.timedOut);
  if (!record) {
    return json(404, {
      error: 'This signing link is no longer active — it may have been replaced by a newer email. ' +
             'Please open the MOST RECENT application email from your loan officer and use that link, ' +
             'or ask them to resend it.',
    });
  }

  if (record.expiresAt && new Date(record.expiresAt) < new Date()) {
    return json(410, { error: 'This link has expired' });
  }
  if (record.signedAt || record.b1SignedAt) {
    return json(409, { error: 'This application has already been signed.' });
  }

  // Deploy 236.415 — steps skipped to protect the signature from the
  // platform timeout. Attached to the record + response for follow-up.
  const _housekeepingSkipped = [];

  // ── 2. Make sure there's actually data to sign ─────────────────
  if (!record.data || Object.keys(record.data).length === 0) {
    return json(400, { error: 'No application data found to sign. Please complete the form first.' });
  }

  // ── 3. Capture audit context for borrower 1 ────────────────────
  const signedAt = new Date().toISOString();
  const dataHash = hashFormData(record.data);
  const auditPre = {
    recordId: `${record.ownerKey}/${record.clientId}/${record.loanId || ''}`,
    signerName: body.signerName.trim().slice(0, 200),
    signerEmail: (body.signerEmail || record.borrowerEmail || '').toLowerCase().trim(),
    dataHash,
    signedAt,
    consentVersion: ESIGN_CONSENT_VERSION,
    ipAddress: getClientIp(req),
    userAgent: getUserAgent(req).slice(0, 500),
    geolocation: typeof body.geolocation === 'string' ? body.geolocation.slice(0, 200) : '',
    signedAuths: B1_SIGNED_AUTHS,
  };
  const seal = sealAudit(auditPre);
  if (!seal) {
    return json(500, {
      error: 'ESIGN_SEAL_SECRET is not configured on the server. ' +
             'Set the environment variable to enable signing.',
    });
  }
  const b1Audit = Object.assign({}, auditPre, { seal });

  // Look up the client for the PDF (entity name fallback, etc.)
  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  let client = null;
  try {
    const ckey = `${record.ownerKey}/${(record.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
    client = await clientsStore.get(ckey, { type: 'json' });
  } catch (_) {}

  // ── 4. Determine which secondary borrowers need to sign ────────
  // Deploy 236.83 — generalized from "1 or 2 borrowers" to up to 4.
  // For each guarantor index 1..3 (guarantor 2, 3, 4 in 1-based
  // labeling) that has an email, build a signing block with its own
  // token. Each gets emailed an individual link to sign their own
  // prequal credit auth — same flow as the original 2-borrower path,
  // just N times.
  const data = record.data || {};
  const guarantors = Array.isArray(data.guarantors) ? data.guarantors : [];
  const numGuarantors = parseInt(String(data.numGuarantors || '1'), 10) || 1;

  const secondaryBlocks = []; // [{ pos:2|3|4, token, block }]
  const tokenExpiresAt = new Date(Date.now() + B2_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
  for (let pos = 2; pos <= 4 && pos <= numGuarantors; pos++) {
    const gIdx = pos - 1; // guarantor array is 0-based
    const g = guarantors[gIdx] || null;
    if (!g || !(g.email || '').trim()) continue;
    const tok = generateBorrower2Token();
    secondaryBlocks.push({
      pos,
      token: tok,
      block: {
        role: 'borrower' + pos,
        name: ((g.firstName || '') + ' ' + (g.lastName || '')).trim() || ('Co-Borrower #' + pos),
        email: (g.email || '').toLowerCase().trim(),
        phone: g.phone || '',
        token: tok,
        tokenExpiresAt,
        invitedAt: signedAt,
        audit: null,         // populated when they sign
        signedAuths: [],
      },
    });
  }
  // Keep the b2-named locals for backwards-compatible code paths
  // below (PDF render, signed record shape, email branch, etc.).
  const hasB2 = secondaryBlocks.length > 0;
  const b2Block = (secondaryBlocks[0] && secondaryBlocks[0].block) || null;
  const b2Token = b2Block ? b2Block.token : null;

  // ── 5. Build the signed PDF ────────────────────────────────────
  // Interim copy if any secondary borrower is still pending — it
  // will be re-rendered when the last secondary signer signs. If
  // single borrower, this is the final copy.
  // Deploy 236.83 — status name kept as 'awaiting_borrower2' for
  // backward compat with existing records and the borrower2-auth
  // page; in practice it now means "awaiting any secondary signer".
  const pdfStatus = hasB2 ? 'awaiting_borrower2' : 'complete';
  let pdfBuffer;
  try {
    if (_pastDeadline()) return _deadlineAbort('before-pdf-render');
    _mark('pdf-render-start');
    pdfBuffer = await renderSignedApplicationPDF({
      record,
      client,
      status: pdfStatus,
      signers: [
        {
          role: 'borrower1',
          name: b1Audit.signerName,
          email: b1Audit.signerEmail,
          audit: b1Audit,
          signedAuths: B1_SIGNED_AUTHS,
        },
        ...secondaryBlocks.map(function (sb) { return {
          role: sb.block.role,
          name: sb.block.name,
          email: sb.block.email,
          audit: null,
          signedAuths: [],
        }; }),
      ],
    });
  } catch (e) {
    console.error('borrower-info-sign: PDF render failed:', e);
    return json(500, { error: 'Failed to generate signed PDF: ' + (e.message || 'unknown') });
  }

  // ── 5.5. Create / reuse client records for each secondary guarantor ─
  // Deploy 236.84 — each additional guarantor (positions 2/3/4) gets
  // a real client record under the same owner. We dedupe by email so
  // a returning guarantor doesn't get N copies. The created or matched
  // client ids land on the loan record as `guarantorClientIds`.
  // Failure here is non-fatal — the signing flow proceeds; missing
  // guarantor clients can be added later if Mike adds a backfill.
  const guarantorClientIds = [];
  const guarantorClientChanges = []; // { id, isNew, client } for downstream writes
  // Deploy 236.128 — additional guarantor ownership % map, flushed
  // into the loan record alongside guarantorClientIds below so the
  // "Check Guarantor Ownership %" banner on Loan Details totals
  // correctly across primary + every additional guarantor.
  let _pendingGuarantorOwnership = {};
  if (secondaryBlocks.length) {
    try {
      const { blobs } = await clientsStore.list({ prefix: record.ownerKey + '/' });
      const existingByEmail = new Map();
      for (const { key } of blobs) {
        const c = await clientsStore.get(key, { type: 'json' });
        if (c && c.email) existingByEmail.set(String(c.email).toLowerCase().trim(), { key, client: c });
      }
      // Deploy 236.85 — copy the FULL guarantor field set onto each
      // client (DOB, FICO, home address, marital status, US citizen,
      // flips, rentals, etc.) so the client record matches what the
      // primary borrower would have populated about themselves.
      // Anything the form captures per guarantor lands here.
      function guarantorToClientFields(g) {
        return {
          firstName:     String(g.firstName     || '').trim(),
          lastName:      String(g.lastName      || '').trim(),
          phone:         String(g.phone         || '').trim(),
          dob:           String(g.dob           || '').trim(),
          fico:          String(g.fico          || '').trim(),
          maritalStatus: String(g.marital       || '').trim(),
          usCitizen:     String(g.usCitizen     || '').trim(),
          flips:         g.flips != null ? String(g.flips) : '',
          rentals:       g.rentals != null ? String(g.rentals) : '',
          homeAddress: {
            street: String(g.address || '').trim(),
            city:   String(g.city    || '').trim(),
            state:  String(g.state   || '').trim(),
            zip:    String(g.zip     || '').trim(),
          },
        };
      }

      // Deploy 236.128 — per-additional-guarantor sub-form token.
      // Generated alongside the client record so the LO has a link
      // to send if the guarantor's full data wasn't collected at
      // application time (the 236.127 light-required flow). Stored
      // on the client (._subFormToken/._subFormStatus) AND in the
      // guarantor-subform-token-idx blob store for token→record
      // lookup by the public sub-form page.
      const subFormIndexEntries = []; // collected, then flushed at the end
      // Deploy 236.128 — per-guarantor ownership map. Same shape
      // the Loan Details "Check Guarantor Ownership %" banner reads.
      const ownershipFromGuarantors = {};
      for (const sb of secondaryBlocks) {
        const guarantorIdx = sb.pos - 1; // 0-based into the array
        const g = (data.guarantors || [])[guarantorIdx] || {};
        const email = String(g.email || sb.block.email || '').toLowerCase().trim();
        if (!email) continue; // can't dedupe or link without one
        const fields = guarantorToClientFields(g);
        const backref = { primaryClientId: record.clientId, loanId: record.loanId };
        // Compute completeness — if the borrower already collected
        // everything, status='completed' and the LO never has to
        // send the link. Otherwise status='pending', LO sends link.
        const _hasFull =
          (fields.dob && fields.fico && fields.usCitizen) &&
          fields.homeAddress && fields.homeAddress.street && fields.homeAddress.city &&
          fields.homeAddress.state && fields.homeAddress.zip;
        const subFormToken = 'gsf_' + Date.now() + '_' + Math.random().toString(36).slice(2, 14);
        let existing = existingByEmail.get(email);
        if (existing) {
          const c = existing.client;
          Object.keys(fields).forEach(function (k) {
            if (k === 'homeAddress') {
              c.homeAddress = c.homeAddress || {};
              Object.keys(fields.homeAddress).forEach(function (h) {
                if (!c.homeAddress[h] && fields.homeAddress[h]) c.homeAddress[h] = fields.homeAddress[h];
              });
            } else if (!c[k] && fields[k]) {
              c[k] = fields[k];
            }
          });
          c._guarantorOnLoans = Array.isArray(c._guarantorOnLoans) ? c._guarantorOnLoans : [];
          const alreadyLinked = c._guarantorOnLoans.some(function (b) {
            return b && b.primaryClientId === backref.primaryClientId && b.loanId === backref.loanId;
          });
          if (!alreadyLinked) c._guarantorOnLoans.push(backref);
          // Only create a sub-form token for THIS loan when one
          // doesn't already exist (a returning guarantor with prior
          // loans keeps their original token; status reset to
          // pending if data is still incomplete).
          c._subFormTokensByLoan = c._subFormTokensByLoan || {};
          if (!c._subFormTokensByLoan[record.loanId]) {
            c._subFormTokensByLoan[record.loanId] = {
              token:        subFormToken,
              createdAt:    signedAt,
              status:       _hasFull ? 'completed_by_primary' : 'pending',
              ownerKey:     record.ownerKey,
              primaryClientId: record.clientId,
              loanId:       record.loanId,
            };
            subFormIndexEntries.push({
              token:    subFormToken,
              ownerKey: record.ownerKey,
              clientId: c.id,
              primaryClientId: record.clientId,
              loanId:   record.loanId,
            });
          }
          c.updatedAt = signedAt;
          guarantorClientChanges.push({ id: c.id, key: existing.key, client: c });
          guarantorClientIds.push(c.id);
        } else {
          const newClient = Object.assign({
            id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            email,
            entityName: '',
            createdAt: signedAt,
            updatedAt: signedAt,
            loans: [],
            _createdViaGuarantorLink: true,
            _guarantorOnLoans: [backref],
          }, fields);
          newClient._subFormTokensByLoan = {};
          newClient._subFormTokensByLoan[record.loanId] = {
            token:        subFormToken,
            createdAt:    signedAt,
            status:       _hasFull ? 'completed_by_primary' : 'pending',
            ownerKey:     record.ownerKey,
            primaryClientId: record.clientId,
            loanId:       record.loanId,
          };
          subFormIndexEntries.push({
            token:    subFormToken,
            ownerKey: record.ownerKey,
            clientId: newClient.id,
            primaryClientId: record.clientId,
            loanId:   record.loanId,
          });
          const newKey = record.ownerKey + '/' + (newClient.id || '').replace(/[^a-zA-Z0-9_-]/g, '_');
          guarantorClientChanges.push({ id: newClient.id, key: newKey, client: newClient });
          guarantorClientIds.push(newClient.id);
          existingByEmail.set(email, { key: newKey, client: newClient });
        }
        // Stamp this guarantor's ownership into the loan map (looked
        // up by the Loan Details banner). The client.id was set
        // either above (existing branch) or just now (new branch),
        // so the latest guarantorClientChanges entry has it.
        const justAddedId = guarantorClientChanges[guarantorClientChanges.length - 1].id;
        const ownPct = parseFloat(g.ownership);
        if (isFinite(ownPct)) ownershipFromGuarantors[justAddedId] = ownPct;
      }
      // Persist every client we touched — new and updated.
      // Deploy 236.415: each write is deadline-guarded — client-record
      // housekeeping must never cost the borrower their signature.
      _mark('guarantor-writes-start n=' + guarantorClientChanges.length);
      for (const ch of guarantorClientChanges) {
        if (_pastDeadline()) { _housekeepingSkipped.push('guarantor-client-writes'); break; }
        // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
        await writeClient(record.ownerKey, ch.client, { clientsStore });
      }
      _mark('guarantor-writes-done');
      // Flush sub-form token index entries to the lookup store.
      if (subFormIndexEntries.length) {
        try {
          const idxStore = getStore({ name: 'guarantor-subform-token-idx', consistency: 'strong' });
          for (const e of subFormIndexEntries) {
            await idxStore.setJSON(e.token, e);
          }
        } catch (e) {
          console.warn('borrower-info-sign: subform token index write failed (non-fatal):', e && e.message);
        }
      }
      // Stash the ownership map on the function-scoped var so the
      // loan-update block below can merge it into the loan record
      // alongside guarantorClientIds.
      _pendingGuarantorOwnership = ownershipFromGuarantors;
    } catch (e) {
      console.warn('borrower-info-sign: guarantor client linkage failed (non-fatal):', e && e.message);
    }
  }

  // Update the primary client's loan record with guarantorClientIds.
  // We re-read the client to avoid clobbering any concurrent edits
  // that landed between the earlier read and now.
  if (guarantorClientIds.length && record.clientId && record.loanId) {
    try {
      const primaryKey = record.ownerKey + '/' + (record.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_');
      const primaryClient = await clientsStore.get(primaryKey, { type: 'json' });
      if (primaryClient && Array.isArray(primaryClient.loans)) {
        const ln = primaryClient.loans.find(function (l) { return l && l.id === record.loanId; });
        if (ln) {
          ln.guarantorClientIds = guarantorClientIds;
          // Deploy 236.128 — merge per-guarantor ownership entries
          // into the same guarantorOwnership map that the long-app
          // sync wrote the primary's % to. MERGE — never replace —
          // so the primary's entry survives.
          if (Object.keys(_pendingGuarantorOwnership).length) {
            ln.guarantorOwnership = Object.assign({}, ln.guarantorOwnership || {}, _pendingGuarantorOwnership);
          }
          ln.updatedAt = signedAt;
          primaryClient.updatedAt = signedAt;
          if (_pastDeadline()) {
            _housekeepingSkipped.push('primary-client-write');
          } else {
            // Deploy 236.402 (C2 slice 2): PG-first via shared writeClient
            await writeClient(record.ownerKey, primaryClient, { clientsStore });
          }
        }
      }
    } catch (e) {
      console.warn('borrower-info-sign: loan.guarantorClientIds write failed (non-fatal):', e && e.message);
    }
  }

  // ── 6. Store the signed record ─────────────────────────────────
  // Deploy 236.83 — signed record now carries borrower2, borrower3,
  // borrower4 as parallel fields. Older code that reads only
  // record.borrower2 keeps working for 1/2-borrower loans. Newer
  // code can iterate borrower2..borrower4.
  const signedStore = getStore({ name: 'signed_applications', consistency: 'strong' });
  const signedKey = `${record.ownerKey}/${(record.clientId || '').replace(/[^a-zA-Z0-9_-]/g, '_')}/${(record.loanId || '_no_loan').replace(/[^a-zA-Z0-9_-]/g, '_')}`;
  const signedRecord = {
    clientId: record.clientId,
    loanId: record.loanId,
    ownerKey: record.ownerKey,
    propertyAddress: (record.prefill && record.prefill.propertyAddress) || (record.data && record.data.propertyAddress) || '',
    status: pdfStatus,
    numBorrowers: 1 + secondaryBlocks.length,
    borrower1: {
      role: 'borrower1',
      name: b1Audit.signerName,
      email: b1Audit.signerEmail,
      audit: b1Audit,
      signedAuths: B1_SIGNED_AUTHS,
    },
    borrower2: getSecondaryBlock(secondaryBlocks, 2),
    borrower3: getSecondaryBlock(secondaryBlocks, 3),
    borrower4: getSecondaryBlock(secondaryBlocks, 4),
    pdfBase64: pdfBuffer.toString('base64'),
    pdfSize: pdfBuffer.length,
    createdAt: signedAt,
    updatedAt: signedAt,
  };
  try {
    await signedStore.setJSON(signedKey, signedRecord);
  } catch (e) {
    console.error('borrower-info-sign: failed to store signed PDF:', e);
    return json(500, { error: 'Failed to save signed application' });
  }

  // Index every secondary token for O(1) lookups in the
  // borrower-secondary-auth endpoints. Keyed by token. Value
  // includes the borrower position (2/3/4) so the auth endpoint
  // knows which borrowerN field to read/write on the record.
  // Deploy 236.83: same store name borrower2_token_idx is kept
  // for back-compat; existing tokens stay readable as a special
  // case of "pos: 2".
  if (secondaryBlocks.length) {
    try {
      const idx = getStore({ name: 'borrower2_token_idx', consistency: 'strong' });
      for (const sb of secondaryBlocks) {
        await idx.setJSON(sb.token, {
          signedKey,
          pos: sb.pos,
          expiresAt: sb.block.tokenExpiresAt,
        });
      }
    } catch (e) {
      console.warn('borrower-info-sign: secondary token index write failed (lookup will fall back to walk):', e);
    }
  }

  // ── 7. Update borrower-info record state ───────────────────────
  // If borrower 2 still needs to sign, DON\u2019T mark the borrower-info
  // record as complete yet — wait until borrower 2 signs. Use a new
  // status \u2018awaiting_b2_signature\u2019 to make the holdup visible.
  //
  // If single-borrower, mark complete as before.
  if (hasB2) {
    record.status = 'awaiting_b2_signature';
    record.b1SignedAt = signedAt;
    record.b1SignedBy = b1Audit.signerName;
    record.b2Token = b2Token;
    record.b2InvitedAt = signedAt;
    // Deploy 236.83 — also stamp b3 / b4 tokens when present so the
    // borrower-info record carries the full set of pending invites.
    record.b3Token = (secondaryBlocks[1] && secondaryBlocks[1].pos === 3) ? secondaryBlocks[1].token
                  : (secondaryBlocks[2] && secondaryBlocks[2].pos === 3) ? secondaryBlocks[2].token : '';
    record.b4Token = (secondaryBlocks[1] && secondaryBlocks[1].pos === 4) ? secondaryBlocks[1].token
                  : (secondaryBlocks[2] && secondaryBlocks[2].pos === 4) ? secondaryBlocks[2].token : '';
    if (record.b3Token) record.b3InvitedAt = signedAt;
    if (record.b4Token) record.b4InvitedAt = signedAt;
  } else {
    record.status = 'complete';
    record.completedAt = signedAt;
    record.signedAt = signedAt;
    record.signedBy = b1Audit.signerName;
  }
  record.signedAuditKey = signedKey;
  record.updatedAt = signedAt;
  try {
    if (_housekeepingSkipped.length) record._housekeepingSkipped = _housekeepingSkipped;
    await biStore.setJSON(recordKey, record);
    _mark('record-signed-durable');
  } catch (e) {
    console.warn('borrower-info-sign: borrower-info record save failed (signed record already stored):', e);
    // The signed PDF is the canonical record. Continue.
  }

  // ── 8. Sync + advance (only if no B2 pending) ──────────────────
  // When borrower 2 is still pending, hold off on the property sync
  // and the auto-advance to In Processing until they sign. The LO
  // should not see the loan move to In Processing while one of the
  // required signatures is still missing.
  let advanceResult = null;
  if (!hasB2) {
    // Deploy 236.415 — signature is durable past this point: every
    // remaining step is best-effort housekeeping and must not cost
    // the borrower a 504.
    if (_pastDeadline()) {
      _housekeepingSkipped.push('property-sync', 'advance');
    } else {
    _mark('property-sync-start');
    try { await syncPropertyFieldsToLoan(record); }
    catch (e) { console.warn('borrower-info-sign: property sync failed:', e); }
    _mark('advance-start');
    try {
      advanceResult = await advanceQuoteToInProcessing(record);
      if (advanceResult && !advanceResult.ok) {
        console.warn('borrower-info-sign: auto-advance bailed:', advanceResult.reason);
      }
    } catch (e) {
      console.warn('borrower-info-sign: advance threw:', e);
      advanceResult = { ok: false, reason: 'exception: ' + (e.message || 'unknown') };
    }
    } // end deadline-guard else (Deploy 236.415)
  }

  // ── 9. Emails ──────────────────────────────────────────────────
  // Two cases:
  //   - Single borrower: email B1 the final signed PDF
  //   - Two borrowers: email B1 the interim signed PDF, AND email B2 a
  //     link to sign their own prequal credit auth
  let emailedB1 = false;
  let emailedB2 = false;
  let emailedSecondaryCount = 0;
  // Deploy 236.415 — deadline guard: skip emails rather than 504.
  if (_pastDeadline()) {
    _housekeepingSkipped.push('emails');
  } else try {
    if (hasB2) {
      // The interim notice to b1 lists every secondary signer they're
      // waiting on so they understand which links are out.
      const coNames = secondaryBlocks.map(function (sb) { return sb.block.name; });
      emailedB1 = await emailSignedCopy({
        toEmail: b1Audit.signerEmail,
        toName: b1Audit.signerName,
        propertyAddress: signedRecord.propertyAddress,
        pdfBuffer,
        isInterim: true,
        coBorrowerName: coNames.length === 1
          ? coNames[0]
          : (coNames.slice(0, -1).join(', ') + (coNames.length >= 3 ? ',' : '') + ' and ' + coNames[coNames.length - 1]),
        ownerKey: record.ownerKey,
      });
      // Send each secondary borrower their own signing link. Same
      // helper as before — works for b2, b3, b4 since the token is
      // the only routing key (the auth endpoints find the right
      // borrowerN field from the token index).
      for (const sb of secondaryBlocks) {
        const sent = await emailBorrower2AuthLink({
          toEmail: sb.block.email,
          toName: sb.block.name,
          b1Name: b1Audit.signerName,
          propertyAddress: signedRecord.propertyAddress,
          token: sb.token,
          req,
          ownerKey: record.ownerKey,
        });
        if (sent) emailedSecondaryCount += 1;
      }
      emailedB2 = emailedSecondaryCount > 0;
    } else {
      emailedB1 = await emailSignedCopy({
        toEmail: b1Audit.signerEmail,
        toName: b1Audit.signerName,
        propertyAddress: signedRecord.propertyAddress,
        pdfBuffer,
        isInterim: false,
        ownerKey: record.ownerKey,
      });
    }
  } catch (e) {
    console.warn('borrower-info-sign: email failed:', e && e.message);
  }

  // ── 10. Notify the LO ─────────────────────────────────────────
  // Sends an email to the LO (requestedBy/ownerEmail on the borrower-
  // info record) with the signed PDF attached. Returns false on
  // failure but doesn\u2019t throw \u2014 a borrower\u2019s signing should never
  // fail because of a downstream LO-side email.
  let loNotified = false;
  if (_pastDeadline()) {
    _housekeepingSkipped.push('lo-notify');
  } else try {
    loNotified = await notifyLOOfSignedApp(record, b1Audit, {
      hasB2,
      b2Name: b2Block && b2Block.name,
      pdfBuffer,
    });
  } catch (e) {
    console.warn('borrower-info-sign: LO notify failed:', e && e.message);
  }

  // Deploy 236.415 — persist any skips recorded after the signed-
  // record write so the LO/repair side can see what needs a follow-up.
  if (_housekeepingSkipped.length && record._housekeepingSkipped !== _housekeepingSkipped) {
    try {
      record._housekeepingSkipped = _housekeepingSkipped;
      await biStore.setJSON(recordKey, record);
    } catch (_) {}
  }

  _mark('handler-complete');
  if (_housekeepingSkipped.length) {
    console.warn('[sign-timing] housekeeping skipped to protect the signature: ' +
      _housekeepingSkipped.join(', ') + ' — ' + _marks.join(' | '));
  }
  return json(200, {
    housekeepingSkipped: _housekeepingSkipped.length ? _housekeepingSkipped : undefined,
    diag: _housekeepingSkipped.length ? _marks.join(' → ') : undefined,
    ok: true,
    signedAt,
    status: pdfStatus,
    emailedBorrower: emailedB1,
    emailedCoBorrower: emailedB2,
    emailedCoBorrowerCount: emailedSecondaryCount,
    secondaryCount: secondaryBlocks.length,
    emailedLO: loNotified,
    awaitingBorrower2: hasB2,
    awaitingSecondaries: hasB2,
    advanceResult,
  });
}

// Deploy 236.83 — pick a secondary block by 1-based borrower position
// (2, 3, or 4). Returns null when that position isn't being used so
// the signed_applications record fields are explicitly null instead
// of undefined.
function getSecondaryBlock(secondaryBlocks, pos) {
  for (let i = 0; i < secondaryBlocks.length; i++) {
    if (secondaryBlocks[i].pos === pos) return secondaryBlocks[i].block;
  }
  return null;
}

async function emailSignedCopy({ toEmail, toName, propertyAddress, pdfBuffer, isInterim, coBorrowerName, ownerKey }) {
  if (!toEmail) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('emailSignedCopy: RESEND_API_KEY not set');
    return false;
  }

  const subject = isInterim
    ? 'Your SLA Capital Loan Application — signed (awaiting co-borrower)'
    : 'Your signed SLA Capital Loan Application';
  const filename = isInterim
    ? 'SLA_Loan_Application_Interim.pdf'
    : 'SLA_Loan_Application_Signed.pdf';
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const interimNote = isInterim
    ? `\n\nWe\u2019ve emailed ${coBorrowerName || 'your co-borrower'} a link to sign their own credit & background check authorization. Once they sign, you\u2019ll both receive the final fully-signed copy.`
    : '';

  const text = [
    `Hi ${toName},`,
    '',
    'Thank you for signing your loan application with SLA Capital. A copy of your signed application is attached for your records.',
    interimNote.trim(),
    '',
    propertyAddress ? `Property: ${propertyAddress}` : '',
    '',
    'Your loan officer has been notified and will be in touch shortly about next steps. If you have any questions, just reply to this email.',
    '',
    'Sir Lends A Lot LLC dba SLA Capital',
  ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Loan Application ' +
          (isInterim ? 'Signed (Interim)' : 'Signed') + '</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Hi ${escH(toName)},</p>` +
        '<p style="font-size:14px;line-height:1.6">Thank you for signing your loan application with SLA Capital. A copy of your signed application is attached to this email for your records.</p>' +
        (isInterim
          ? `<p style="font-size:14px;line-height:1.6;background:#F5E9D8;padding:12px 14px;border-left:3px solid #C8813A;border-radius:4px">We\u2019ve emailed <strong>${escH(coBorrowerName || 'your co-borrower')}</strong> a separate link to sign their own credit &amp; background check authorization. Once they sign, you\u2019ll both receive the final fully-signed copy.</p>`
          : '') +
        (propertyAddress
          ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>`
          : '') +
        '<p style="font-size:14px;line-height:1.6">Your loan officer has been notified and will be in touch shortly about next steps. If you have any questions, just reply to this email.</p>' +
        '<p style="font-size:12px;color:#7A7488;margin-top:24px">Sir Lends A Lot LLC dba SLA Capital. For business-purpose, investment property loans only.</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';

  const replyTo = await getOwnerReplyTo(ownerKey);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject,
      text,
      html,
      attachments: [
        { filename, content: pdfBuffer.toString('base64') },
      ],
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
  return true;
}

// Email borrower 2 a link to sign their own prequal credit auth.
async function emailBorrower2AuthLink({ toEmail, toName, b1Name, propertyAddress, token, req, ownerKey }) {
  if (!toEmail) return false;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return false;

  // Build the signing URL. Prefer the site URL from headers if available
  // (more reliable across preview deploys); fall back to env var.
  const proto = (req && req.headers && (req.headers.get
    ? req.headers.get('x-forwarded-proto') : req.headers['x-forwarded-proto'])) || 'https';
  const host = (req && req.headers && (req.headers.get
    ? req.headers.get('host') : req.headers.host)) || '';
  const base = host
    ? `${proto}://${host}`
    : (process.env.URL || 'https://slaloantools.netlify.app');
  const link = `${base}/borrower2-auth.html?t=${encodeURIComponent(token)}`;

  const subject = 'Action required: Co-borrower authorization for SLA Capital loan application';
  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const text = [
    `Hi ${toName},`,
    '',
    `${b1Name} has submitted a loan application with SLA Capital that lists you as a co-borrower or guarantor.`,
    '',
    'To move the application forward, we need you to electronically sign your own Authorization to Conduct Prequal Credit & Background Checks. This is required by federal law (Fair Credit Reporting Act) — your authorization must come directly from you, not from your co-borrower.',
    '',
    propertyAddress ? `Property: ${propertyAddress}` : '',
    '',
    'Sign here:',
    link,
    '',
    'This link expires in 30 days.',
    '',
    'If you have any questions, reply to this email and we\u2019ll get back to you.',
    '',
    'Sir Lends A Lot LLC dba SLA Capital',
  ].filter((l) => l !== null && l !== undefined && l !== '').join('\n');

  const html =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital — Co-Borrower Authorization Needed</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        `<p style="font-size:14px;line-height:1.6">Hi ${escH(toName)},</p>` +
        `<p style="font-size:14px;line-height:1.6"><strong>${escH(b1Name)}</strong> has submitted a loan application with SLA Capital that lists you as a co-borrower or guarantor.</p>` +
        '<p style="font-size:14px;line-height:1.6">To move the application forward, we need you to electronically sign your own <strong>Authorization to Conduct Prequal Credit &amp; Background Checks</strong>. This is required by federal law (Fair Credit Reporting Act) — your authorization must come directly from you, not from your co-borrower.</p>' +
        (propertyAddress
          ? `<p style="font-size:14px;line-height:1.6"><strong>Property:</strong> ${escH(propertyAddress)}</p>`
          : '') +
        `<p style="margin:24px 0;text-align:center"><a href="${escH(link)}" style="background:#C8813A;color:#fff;padding:12px 28px;text-decoration:none;border-radius:6px;font-weight:600;font-size:14px">Sign your authorization \u2192</a></p>` +
        `<p style="font-size:12px;color:#7A7488">Or copy and paste this link: <a href="${escH(link)}">${escH(link)}</a></p>` +
        '<p style="font-size:12px;color:#7A7488">This link expires in 30 days.</p>' +
        '<p style="font-size:12px;color:#7A7488;margin-top:24px">Sir Lends A Lot LLC dba SLA Capital. For business-purpose, investment property loans only.</p>' +
      '</div>' +
    '</div>' +
    '</body></html>';

  const replyTo = await getOwnerReplyTo(ownerKey);
  const resp = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'SLA Capital <noreply@leads.slacapital.com>',
      to: [toEmail],
      subject,
      text,
      html,
      ...(replyTo ? { reply_to: replyTo } : {}),
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error(`Resend ${resp.status}: ${t.slice(0, 200)}`);
  }
  return true;
}

async function notifyLOOfSignedApp(record, audit, opts) {
  opts = opts || {};
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.warn('notifyLOOfSignedApp: RESEND_API_KEY not configured');
    return false;
  }

  // Resolve the LO email. The record\u2019s `requestedBy` is set when the
  // LO sent a borrower-info link via /api/borrower-info-request, but
  // older or LO-side-created records may only have `ownerEmail`.
  // `ownerKey` is a sanitized version of the email path-safe; not a
  // real email, so it doesn\u2019t serve as a fallback for emailing.
  const loEmail = record.requestedBy || record.ownerEmail || '';
  if (!loEmail) {
    console.warn('notifyLOOfSignedApp: no LO email on record', record.ownerKey);
    return false;
  }

  const propertyAddress = (record.data && record.data.propertyAddress) || '';
  const subject = opts.hasB2
    ? `Loan app signed by Borrower 1 \u2014 awaiting Borrower 2: ${propertyAddress || 'borrower'}`
    : `Loan application signed: ${propertyAddress || 'borrower'}`;

  const signedWhen = new Date(audit.signedAt).toLocaleString('en-US', {
    dateStyle: 'medium', timeStyle: 'short',
  });

  const textBody = opts.hasB2
    ? [
        `Borrower 1 (${audit.signerName}) has signed the loan application.`,
        '',
        `We've emailed Borrower 2 (${opts.b2Name || 'co-borrower'}) a link to sign their own prequal credit & background check authorization.`,
        '',
        `Signed at: ${signedWhen}`,
        `Property: ${propertyAddress || '(not provided)'}`,
        `IP: ${audit.ipAddress || 'unavailable'}`,
        '',
        `The loan will move to "In Processing" once Borrower 2 signs. An interim signed copy is attached.`,
        '',
        'SLA Capital',
      ].join('\n')
    : [
        `Good news \u2014 your borrower just signed their loan application.`,
        '',
        `Borrower: ${audit.signerName} <${audit.signerEmail}>`,
        `Signed at: ${signedWhen}`,
        `Property: ${propertyAddress || '(not provided)'}`,
        `IP: ${audit.ipAddress || 'unavailable'}`,
        '',
        `The loan has been moved to "In Processing" in your pipeline. The signed PDF is attached.`,
        '',
        'SLA Capital',
      ].join('\n');

  const escH = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const htmlBody =
    '<!DOCTYPE html><html><head><meta charset="UTF-8"></head><body>' +
    '<div style="max-width:620px;margin:0 auto;font-family:Georgia,serif">' +
      '<div style="background:#261A36;padding:24px">' +
        '<h1 style="color:#C8813A;margin:0;font-size:18px">SLA Capital \u2014 ' +
          (opts.hasB2 ? 'Borrower 1 Signed (awaiting Co-Borrower)' : 'Loan Application Signed') +
        '</h1>' +
      '</div>' +
      '<div style="padding:24px;color:#1A1520">' +
        (opts.hasB2
          ? `<p style="font-size:14px;line-height:1.6"><strong>${escH(audit.signerName)}</strong> has signed the loan application. We've emailed Borrower 2 (${escH(opts.b2Name || 'co-borrower')}) a link to sign their own authorization.</p>`
          : `<p style="font-size:14px;line-height:1.6">Good news \u2014 your borrower just signed their loan application. The signed PDF is attached.</p>`) +
        '<table style="font-size:13px;line-height:1.7;margin:14px 0">' +
          `<tr><td style="color:#7A7488;padding-right:12px">Borrower</td><td><strong>${escH(audit.signerName)}</strong> &lt;${escH(audit.signerEmail)}&gt;</td></tr>` +
          `<tr><td style="color:#7A7488;padding-right:12px">Signed at</td><td>${escH(signedWhen)}</td></tr>` +
          `<tr><td style="color:#7A7488;padding-right:12px">Property</td><td>${escH(propertyAddress || '(not provided)')}</td></tr>` +
          `<tr><td style="color:#7A7488;padding-right:12px">IP</td><td>${escH(audit.ipAddress || 'unavailable')}</td></tr>` +
        '</table>' +
        (opts.hasB2
          ? `<p style="font-size:13px;color:#7A7488">An interim signed copy is attached. The loan will move to "In Processing" once Borrower 2 signs.</p>`
          : `<p style="font-size:13px;color:#7A7488">The loan has been moved to "In Processing" in your pipeline.</p>`) +
      '</div>' +
    '</div>' +
    '</body></html>';

  // Attach the signed PDF (interim for hasB2, final otherwise).
  const attachments = [];
  if (opts.pdfBuffer) {
    const pdfB64 = Buffer.isBuffer(opts.pdfBuffer)
      ? opts.pdfBuffer.toString('base64')
      : Buffer.from(opts.pdfBuffer).toString('base64');
    const filenameSafe = (propertyAddress || 'SLA_Loan_Application')
      .replace(/[^a-zA-Z0-9 _-]/g, '').replace(/\s+/g, '_').slice(0, 60);
    attachments.push({
      filename: `${filenameSafe}_Signed${opts.hasB2 ? '_Interim' : ''}.pdf`,
      content: pdfB64,
    });
  }

  try {
    const replyTo = await getOwnerReplyTo(record && record.ownerKey);
    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'SLA Capital <noreply@leads.slacapital.com>',
        to: [loEmail],
        subject,
        text: textBody,
        html: htmlBody,
        attachments,
        ...(replyTo ? { reply_to: replyTo } : {}),
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      console.warn(`notifyLOOfSignedApp: Resend ${resp.status}`, t.slice(0, 200));
      return false;
    }
    return true;
  } catch (e) {
    console.warn('notifyLOOfSignedApp: fetch threw:', e && e.message);
    return false;
  }
}
