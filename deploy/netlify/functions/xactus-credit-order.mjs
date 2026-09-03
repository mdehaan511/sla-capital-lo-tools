/**
 * xactus-credit-order.mjs — POST /api/xactus-credit-order
 *
 * Deploy 236.779 — pull a credit report through Xactus360 (MISMO 2,
 * synchronous). Subject PII comes from, in priority order:
 *   1. the loan's borrower_info record (data.guarantors[gIndex] —
 *      SSN ssn_enc decrypted in-memory, address from the sub-fields), or
 *   2. the CLIENT record's own ssn_enc + address (guarantor sub-form
 *      onboarding stores these) — the Client-page path with no loan.
 *
 * On success:
 *   - verification record written to the `verifications` store
 *     (ownerKey/v_id): scores per bureau, mid score, 120-day expiry.
 *   - report PDF stored in `verification-docs` (ownerKey/v_id).
 *   - loan context: PDF auto-attached to the loan review's
 *     credit_report tray (staleByDate = +120d) and, for the PRIMARY
 *     borrower (gIndex 0), loan.creditMidScore/creditPulledAt stamped —
 *     drives the "sizer FICO differs from credit report" flag.
 *
 * Body: { clientId, loanId?, gIndex?, owner?, reportType?: 'Merge'|'SoftCheck' }
 * Auth: processor/admin ONLY (FCRA permissible-purpose control — LOs
 * request pulls through processing).
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { decryptField, encryptField, maskSSN } from './_shared/crypto.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { loadRecord } from './_shared/borrower-info-keys.mjs';
import { attachPdfToReviewSlug } from './_shared/loan-review-auto-attach.mjs';
import {
  xactusConfigured, xactusMissingVars, xactusSoftConfigured, xactusSoftMissingVars,
  buildCreditRequestXml, postXactus, parseCreditResponse, ficoBucketForScore,
} from './_shared/xactus.mjs';

const CREDIT_VALID_DAYS = 120;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('xactus-credit-order error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });
  if (!xactusConfigured()) return json(503, { error: 'Xactus credentials not configured — missing env var(s): ' + xactusMissingVars().join(', ') + '. Check names + that the "Functions" scope is enabled on each in Netlify.' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId) return json(400, { error: 'clientId required' });
  const gIndex = Math.max(0, parseInt(body.gIndex, 10) || 0);
  const reportType = body.reportType === 'SoftCheck' ? 'SoftCheck' : 'Merge';
  // Deploy 236.835 — SoftCheck runs on its own Xactus account. Fail loud with
  // the missing var NAMES so a Netlify-dashboard typo is diagnosable.
  if (reportType === 'SoftCheck' && !xactusSoftConfigured()) {
    // Deploy 236.835c — self-diagnosing: list the XACTUS* var NAMES this
    // function can actually see (names only, never values) so an invisible
    // typo / wrong-site / stale-deploy cause is readable from the error.
    const visible = Object.keys(process.env).filter((k) => k.toUpperCase().includes('XACTUS'))
      .map((k) => JSON.stringify(k)).join(', ') || '(none)';
    return json(503, { error: 'Soft-pull credentials not configured — missing env var(s): ' + xactusSoftMissingVars().join(', ') + '. XACTUS* vars visible to this function: ' + visible + '.' });
  }

  const selfEmail = normalizeEmail(user.email);
  const ownerKey = body.owner ? keySafe(normalizeEmail(body.owner)) : keySafe(selfEmail);

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(body.clientId), { type: 'json' });
  if (!client) return json(404, { error: 'Client not found' });
  const loan = body.loanId && Array.isArray(client.loans)
    ? client.loans.find((l) => l && l.id === body.loanId) : null;
  if (body.loanId && !loan) return json(404, { error: 'Loan not found on client' });

  // ── Resolve subject PII ─────────────────────────────────────────
  // Deploy 236.780 — an explicit staff-entered subjectOverride (from the
  // "we're missing info" modal) takes priority, is used for the pull, and
  // is SAVED to the client profile (gIndex 0) so it's on file next time.
  let subject = null;
  const ov = (body.subjectOverride && typeof body.subjectOverride === 'object') ? body.subjectOverride : null;
  if (ov && ov.ssn) {
    subject = {
      firstName: String(ov.firstName || (gIndex === 0 ? client.firstName : '') || '').trim(),
      lastName:  String(ov.lastName  || (gIndex === 0 ? client.lastName  : '') || '').trim(),
      ssn: String(ov.ssn || '').replace(/[^0-9]/g, ''),
      street: String(ov.street || '').trim(), city: String(ov.city || '').trim(),
      state: String(ov.state || '').trim().toUpperCase(), zip: String(ov.zip || '').trim(),
    };
    if (subject.ssn.length !== 9) return json(400, { error: 'SSN must be 9 digits' });
    if (!subject.street || !subject.city || !subject.state || !subject.zip) {
      return json(400, { error: 'A complete current address (street, city, state, zip) is required' });
    }
  }
  if (!subject && loan) {
    try {
      const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
      const rec = await loadRecord(biStore, ownerKey, body.clientId, body.loanId, client);
      const g = rec && rec.data && Array.isArray(rec.data.guarantors) ? rec.data.guarantors[gIndex] : null;
      if (g && (g.ssn_enc || g.ssn)) {
        let ssn = '';
        try { ssn = g.ssn || decryptField(g.ssn_enc); } catch (_) {}
        subject = {
          firstName: g.firstName || (gIndex === 0 ? client.firstName : ''),
          lastName:  g.lastName  || (gIndex === 0 ? client.lastName  : ''),
          ssn: String(ssn || '').replace(/[^0-9]/g, ''),
          street: g.address || '', city: g.city || '', state: g.state || '', zip: g.zip || '',
        };
      }
    } catch (e) { console.warn('xactus-credit-order: borrower_info read failed:', e && e.message); }
  }
  if ((!subject || !subject.ssn) && gIndex === 0 && client.ssn_enc) {
    // Client-page path / fallback: PII on the client record itself.
    // Deploy 236.780 — the client's address lives in client.homeAddress
    // (guarantor onboarding / the missing-info modal write it there).
    let ssn = '';
    try { ssn = decryptField(client.ssn_enc); } catch (_) {}
    const ha = (client.homeAddress && typeof client.homeAddress === 'object') ? client.homeAddress : {};
    subject = {
      firstName: client.firstName || '', lastName: client.lastName || '',
      ssn: String(ssn || '').replace(/[^0-9]/g, ''),
      street: ha.street || client.address || '', city: ha.city || client.city || '',
      state: ha.state || client.state || '', zip: ha.zip || client.zip || '',
    };
  }
  if (!subject || subject.ssn.length !== 9 || !subject.street || !subject.city || !subject.state || !subject.zip) {
    // Structured signal — the UI opens the collect-info modal on this code.
    return json(400, {
      error: 'Missing SSN and/or current address for this ' + (gIndex === 0 ? 'borrower' : 'guarantor') + ' — enter it to run the report.',
      code: 'missing_subject_info',
      prefill: {
        firstName: (subject && subject.firstName) || (gIndex === 0 ? client.firstName : '') || '',
        lastName:  (subject && subject.lastName)  || (gIndex === 0 ? client.lastName  : '') || '',
        hasSsn: !!(subject && subject.ssn.length === 9),
        street: (subject && subject.street) || '', city: (subject && subject.city) || '',
        state: (subject && subject.state) || '', zip: (subject && subject.zip) || '',
      },
    });
  }
  if (!subject.firstName || !subject.lastName) return json(400, { error: 'Borrower name missing' });

  // ── Order ───────────────────────────────────────────────────────
  const lenderCaseId = (loan && (loan.slaDisplayId || loan.id)) || client.id;
  const xml = buildCreditRequestXml(subject, { reportType, lenderCaseId });
  let resp;
  // Deploy 236.835 — SoftCheck orders go out on the soft-pull credentials.
  try { resp = await postXactus(xml, undefined, reportType === 'SoftCheck' ? { cred: 'soft' } : undefined); }
  catch (e) { return json(502, { error: 'Xactus request failed: ' + ((e && e.message) || 'network') }); }
  const parsed = parseCreditResponse(resp.text || '');
  if (!parsed.mid && parsed.errors.length) {
    return json(422, { error: 'Credit order failed: ' + parsed.errors.join(' · ') });
  }
  if (!parsed.mid) return json(422, { error: 'Credit order returned no scores (HTTP ' + resp.httpStatus + ')' });

  // ── Persist ─────────────────────────────────────────────────────
  const now = new Date();
  const nowIso = now.toISOString();
  const expiresIso = new Date(now.getTime() + CREDIT_VALID_DAYS * 86400000).toISOString();
  const vId = 'v_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const subjectName = (subject.firstName + ' ' + subject.lastName).trim();
  const verification = {
    id: vId, kind: 'credit', status: 'complete',
    orderedAt: nowIso, orderedBy: selfEmail,
    expiresAt: expiresIso,
    subject: { clientId: body.clientId, gIndex, name: subjectName, ssnLast4: subject.ssn.slice(-4) },
    loanId: body.loanId || '', address: (loan && loan.address) || '',
    reportType,
    xactusReportId: parsed.reportId,
    scores: parsed.scores, models: parsed.models, mid: parsed.mid,
    hasPdf: !!parsed.pdfBase64,
  };
  const vStore = getStore({ name: 'verifications', consistency: 'strong' });
  await vStore.setJSON(ownerKey + '/' + vId, verification);
  if (parsed.pdfBase64) {
    try {
      const dStore = getStore({ name: 'verification-docs', consistency: 'strong' });
      await dStore.set(ownerKey + '/' + vId, Buffer.from(parsed.pdfBase64, 'base64'), {
        metadata: { kind: 'credit', filename: subjectName + ' - Credit Report - ' + (reportType === 'SoftCheck' ? 'Soft' : 'Hard') + ' - ' + nowIso.slice(0, 10) + '.pdf', mimeType: 'application/pdf' },
      });
    } catch (e) { console.warn('xactus-credit-order: pdf store failed:', e && e.message); }
  }

  // Loan context: attach PDF to the review + stamp the loan.
  let attachedToReview = false;
  let clientDirty = false;
  if (loan) {
    if (parsed.pdfBase64) {
      const r = await attachPdfToReviewSlug({
        ownerKey, clientId: body.clientId, loanId: body.loanId, address: loan.address,
        slug: 'credit_report', bytes: Buffer.from(parsed.pdfBase64, 'base64'),
        // Deploy 236.862 (Mike) — "[Name] - Credit Report - Soft|Hard - [date]".
        filename: subjectName + ' - Credit Report - ' + (reportType === 'SoftCheck' ? 'Soft' : 'Hard') + ' - ' + nowIso.slice(0, 10) + '.pdf',
        sourceNote: 'xactus:' + parsed.reportId, actorEmail: selfEmail,
        documentDate: nowIso.slice(0, 10), staleByDate: expiresIso.slice(0, 10),
      });
      attachedToReview = !!(r && r.attached);
    }
    if (gIndex === 0) {
      loan.creditMidScore = parsed.mid;
      loan.creditPulledAt = nowIso;
      loan.creditReportId = parsed.reportId;
    }
    appendNoteEntry(loan, {
      kind: 'system',
      text: 'Credit report pulled (' + (reportType === 'SoftCheck' ? 'soft pull' : 'tri-merge') + ') for ' + subjectName +
        ' — TU ' + (parsed.scores.transunion || '—') + ' / EXP ' + (parsed.scores.experian || '—') +
        ' / EQ ' + (parsed.scores.equifax || '—') + ' (mid ' + parsed.mid + '). Valid ' + CREDIT_VALID_DAYS + ' days.',
      author: selfEmail, authorEmail: selfEmail,
      meta: { verificationId: vId, reportId: parsed.reportId },
    });
    loan.updatedAt = nowIso;
    clientDirty = true;
  }

  // Deploy 236.780 — the SUBJECT's client profile learns from the pull:
  //   - Middle Credit stamped on the client (Contacts pane + Clients page).
  //   - A staff-entered subjectOverride is saved to the profile (SSN
  //     encrypted, address into homeAddress) so it's on file next time.
  // Both only for the PRIMARY (gIndex 0) — additional guarantors' PII
  // lives on the loan application, not this client record.
  if (gIndex === 0) {
    client.creditMidScore = parsed.mid;
    client.creditPulledAt = nowIso;
    if (ov) {
      client.ssn_enc = encryptField(subject.ssn);
      client.ssnLast4 = subject.ssn.slice(-4);
      client.hasSSN = true;
      client.homeAddress = { street: subject.street, city: subject.city, state: subject.state, zip: subject.zip };
      if (!client.firstName && subject.firstName) client.firstName = subject.firstName;
      if (!client.lastName && subject.lastName) client.lastName = subject.lastName;
    }
    client.updatedAt = nowIso;
    clientDirty = true;
  }
  if (clientDirty) {
    try { await writeClient(ownerKey, client, { clientsStore }); }
    catch (e) { console.warn('xactus-credit-order: client/loan stamp save failed:', e && e.message); }
  }

  // FICO mismatch signal for the caller (computed here so the UI can toast).
  const sizerFico = String((loan && loan.fico) || '');
  const scoreBucket = ficoBucketForScore(parsed.mid, (loan && loan.toolType) || 'dscr');
  const ficoMismatch = !!(loan && sizerFico && scoreBucket && sizerFico !== scoreBucket);

  return json(200, {
    ok: true, verification,
    ficoMismatch, sizerFico, scoreBucket,
    attachedToReview,
    subjectMasked: subjectName + ' (' + maskSSN(subject.ssn) + ')',
  });
}
