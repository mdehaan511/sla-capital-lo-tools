/**
 * borrower-info-sign-housekeeping-background.mjs -- finishes what a slow signing skipped.
 *
 * Deploy 237.267 (Sara, 2026-09-24: "Hey I didnt get an email today on a completed app" --
 * 10482 Pinehurst, signed at 9:35 AM during the Supabase outage). borrower-info-sign runs under
 * a hard deadline so the borrower never sees a 504: once the budget is spent it SKIPS its
 * follow-up steps (the borrower's signed copy, the co-signer invites, the LO email, the bell,
 * the property sync, the advance to processing) and records them on the borrower_info record
 * as `_housekeepingSkipped`. 25 of 208 signings had done that, and nothing ever came back for
 * them -- the LO simply never heard.
 *
 * Now the handler fires THIS (a Netlify background function: 202 at once, up to 15 minutes to
 * work) with the record key and the skipped list, and each step is done here with the same
 * helpers the handler uses. A step that fails stays on the list; a step that succeeds comes
 * off it, so a second run never sends twice. An admin can also POST to it by hand (bearer
 * token) to catch up a record from before this deploy.
 *
 * POST { recordKey, skipped?: [...] }
 *   header x-sla-internal: internalBgSig(recordKey, 'sign-housekeeping')   -- or an admin JWT
 */
import { getStore } from '@netlify/blobs';
import { handleOptions, json, readJsonBody, requireAuth, isAdmin } from './_shared/auth.mjs';
import { internalBgSig } from './_shared/review-truth.mjs';
import { syncPropertyFieldsToLoan, advanceQuoteToInProcessing } from './_shared/borrower-info-sync.mjs';
import { emailSignedCopy, emailBorrower2AuthLink, notifyLOOfSignedApp } from './borrower-info-sign.mjs';

// The steps this job knows how to finish, in the order the handler would have run them.
// (guarantor-client-writes / primary-client-write are inline in the handler and are left as
// they are: they touch client records and are the rarest to be skipped.)
export const HOUSEKEEPING_STEPS = ['property-sync', 'advance', 'emails', 'lo-notify', 'app-signed-bell'];

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('sign-housekeeping error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function _authorized(req, context, recordKey) {
  const hdr = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('x-sla-internal') || '') : '';
  const want = internalBgSig(recordKey, 'sign-housekeeping');
  if (want && hdr && hdr === want) return { ok: true, via: 'internal' };
  try {
    const user = await requireAuth(context, req);
    if (user && isAdmin(user)) return { ok: true, via: 'admin', email: user.email || '' };
  } catch (_) {}
  return { ok: false };
}

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = (await readJsonBody(req)) || {};
  const recordKey = String(body.recordKey || '').trim();
  if (!recordKey) return json(400, { error: 'recordKey required' });
  const auth = await _authorized(req, context, recordKey);
  if (!auth.ok) return json(403, { error: 'Bad internal signature (or not an admin)' });

  const biStore = getStore({ name: 'borrower_info', consistency: 'strong' });
  const record = await biStore.get(recordKey, { type: 'json' }).catch(() => null);
  if (!record) return json(404, { error: 'Application record not found: ' + recordKey });
  const wanted = (Array.isArray(body.skipped) && body.skipped.length ? body.skipped : (record._housekeepingSkipped || []))
    .map((s) => String(s || '').trim()).filter(Boolean);
  const skipped = wanted.filter((s) => HOUSEKEEPING_STEPS.indexOf(s) >= 0);
  const unknown = wanted.filter((s) => HOUSEKEEPING_STEPS.indexOf(s) < 0);
  if (!skipped.length) return json(200, { ok: true, skipped: 'nothing-to-do', remaining: unknown });

  const signedKey = record.signedAuditKey || recordKey;
  const signedStore = getStore({ name: 'signed_applications', consistency: 'strong' });
  const signed = await signedStore.get(signedKey, { type: 'json' }).catch(() => null);
  if (!signed || !signed.pdfBase64) return json(409, { error: 'No signed application on file at ' + signedKey + ' -- nothing to send' });

  const pdfBuffer = Buffer.from(signed.pdfBase64, 'base64');
  const b1 = signed.borrower1 || {};
  const b1Audit = b1.audit || { signerName: b1.name || record.signedBy || '', signerEmail: b1.email || record.borrowerEmail || '', signedAt: record.signedAt || record.b1SignedAt || signed.createdAt || '' };
  const secondaries = [2, 3, 4].map((pos) => ({ pos, block: signed['borrower' + pos], token: record['b' + pos + 'Token'] || '' })).filter((s) => s.block && s.block.email);
  const hasB2 = secondaries.length > 0;
  const propertyAddress = signed.propertyAddress || (record.prefill && record.prefill.propertyAddress) || (record.data && record.data.propertyAddress) || '';
  const origin = process.env.URL || process.env.DEPLOY_PRIME_URL || 'https://portal.slacapital.ai';
  // emailBorrower2AuthLink builds the co-signer link from the request's host / proto headers
  let originHost = ''; try { originHost = new URL(origin).host; } catch (_) {}
  const fakeReq = { url: origin + '/api/borrower-info-sign', headers: { get: (k) => (String(k).toLowerCase() === 'host' ? originHost : (String(k).toLowerCase() === 'x-forwarded-proto' ? 'https' : '')) } };

  const completed = [], failed = [];
  const run = async (step, fn) => {
    if (skipped.indexOf(step) < 0) return;
    try { await fn(); completed.push(step); }
    catch (e) { failed.push({ step, error: (e && e.message) || 'unknown' }); console.warn('sign-housekeeping: ' + step + ' failed:', e && e.message); }
  };

  // ── the loan first: property sync + the advance into processing (single-borrower only) ──
  await run('property-sync', async () => { if (hasB2) return; await syncPropertyFieldsToLoan(record); });
  await run('advance', async () => {
    if (hasB2) return;
    const r = await advanceQuoteToInProcessing(record);
    if (r && r.ok === false && !/already|no loan matched|not found/i.test(String(r.reason || ''))) throw new Error('advance: ' + r.reason);
  });

  // ── the borrower's copy (interim when co-signers are still to sign) + the co-signer invites ──
  await run('emails', async () => {
    if (hasB2) {
      const coNames = secondaries.map((s) => s.block.name).filter(Boolean);
      const okCopy = await emailSignedCopy({
        toEmail: b1Audit.signerEmail, toName: b1Audit.signerName, propertyAddress, pdfBuffer, isInterim: true,
        coBorrowerName: coNames.length === 1 ? coNames[0] : (coNames.slice(0, -1).join(', ') + (coNames.length >= 3 ? ',' : '') + ' and ' + coNames[coNames.length - 1]),
        ownerKey: record.ownerKey,
      });
      let invited = 0;
      for (const s of secondaries) {
        if (!s.token) continue; // a co-signer who already signed has no live token
        const sent = await emailBorrower2AuthLink({ toEmail: s.block.email, toName: s.block.name, b1Name: b1Audit.signerName, propertyAddress, token: s.token, req: fakeReq, ownerKey: record.ownerKey });
        if (sent) invited++;
      }
      if (!okCopy && !invited) throw new Error('no email went out');
    } else {
      const ok = await emailSignedCopy({ toEmail: b1Audit.signerEmail, toName: b1Audit.signerName, propertyAddress, pdfBuffer, isInterim: false, ownerKey: record.ownerKey });
      if (!ok) throw new Error('borrower copy did not send');
    }
  });

  // ── the LO ──
  await run('lo-notify', async () => {
    const ok = await notifyLOOfSignedApp(record, b1Audit, { hasB2, b2Name: hasB2 ? secondaries[0].block.name : '', pdfBuffer });
    if (!ok) throw new Error('LO email did not send');
  });

  // ── the bell (a completed application only; a co-signed one rings when the last signer signs) ──
  await run('app-signed-bell', async () => {
    if (hasB2) return;
    const { notifyDocSignedByIds } = await import('./_shared/loan-event-notify.mjs');
    await notifyDocSignedByIds({ getStore, ownerKey: record.ownerKey, clientId: record.clientId, loanId: record.loanId, address: propertyAddress, docLabel: 'Loan Application', signer: b1Audit.signerName || '' });
  });

  // ── the record remembers: what is done comes off the list, what failed stays for a retry ──
  const remaining = (record._housekeepingSkipped || []).filter((s) => completed.indexOf(s) < 0);
  record._housekeepingSkipped = remaining;
  if (!remaining.length) delete record._housekeepingSkipped;
  record._housekeepingCompleted = (record._housekeepingCompleted || []).concat(completed.map((s) => ({ step: s, at: new Date().toISOString(), via: auth.via })));
  record.updatedAt = new Date().toISOString();
  try { await biStore.setJSON(recordKey, record); } catch (e) { console.warn('sign-housekeeping: record write failed:', e && e.message); }

  return json(200, { ok: failed.length === 0, completed, failed, remaining, via: auth.via });
}
