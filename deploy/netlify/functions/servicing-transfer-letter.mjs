/**
 * servicing-transfer-letter.mjs — POST /api/servicing-transfer-letter
 *
 * Deploy 237.211 (Mike): the NOTICE OF TRANSFER OF LOAN SERVICING, sent from a loan's
 * Servicing tab. "Auto fills the appropriate items and asks for input on the items that it
 * can't grab from the loan itself." The letter itself, and the rules about what is grabbed
 * and what is asked, live in _shared/servicing-transfer-letter.mjs — this file is the I/O.
 *
 * Body: { owner, clientId, loanId, action, ... }
 *
 *   action: 'prefill'   → { fields, asked, dueDay, recipients, servicers, remembered, lastSent }
 *                         What the loan could fill, what it could not, the Note Servicers
 *                         directory (for both name pickers), and the contact block last
 *                         used for each new servicer — so the SECOND loan moving to the
 *                         same servicer does not need its address typed again.
 *   action: 'pdf'       + fields           → the PDF. Writes nothing.
 *   action: 'send'      + fields, to[, cc] → emails the notice (PDF attached), copies
 *                         boarding@, keeps the PDF exactly as sent, remembers the new
 *                         servicer's block, and logs it to the loan's Notes & Activity.
 *   action: 'download'  + letterId         → a letter exactly as it was sent.
 *
 * A letter with a hole in it is refused with 422 + { problems } on BOTH pdf and send.
 *
 * Auth: processor / admin — this emails a borrower a notice about where to send money.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, readJsonBody, isProcessor, normalizeEmail, keySafe,
} from './_shared/auth.mjs';
import { deriveBaselineLoanId } from './_shared/baseline-sync.mjs';
import { writeClient } from './_shared/client-write.mjs';
import { appendNoteEntry } from './_shared/notes-log.mjs';
import { contentDisposition } from './_shared/content-disposition.mjs';
import {
  resolveLetterFields, normalizeLetterFields, validateLetter, buildTransferLetterPdf,
  buildCoverEmail, letterFilename, isEmail, fmtLongDate, SLA_BLOCK, LETTER_FIELDS,
} from './_shared/servicing-transfer-letter.mjs';

const FROM = 'SLA Capital <noreply@leads.slacapital.com>';
const MAX_RECIPIENTS = 6;

const lettersStore = () => getStore({ name: 'servicing-transfer-letters', consistency: 'strong' });
const rememberStore = () => getStore({ name: 'servicing-transfer-servicers', consistency: 'strong' });
const slug = (name) => String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 80);

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('servicing-transfer-letter error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = await requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = await readJsonBody(req);
  if (!body || !body.clientId || !body.loanId) return json(400, { error: 'clientId + loanId required' });
  const action = String(body.action || 'prefill');
  const ownerKey = keySafe(normalizeEmail(String(body.owner || user.email || '')));

  const clientsStore = getStore({ name: 'clients', consistency: 'strong' });
  const client = await clientsStore.get(ownerKey + '/' + keySafe(String(body.clientId)), { type: 'json' });
  const loan = client && Array.isArray(client.loans)
    ? client.loans.find((l) => l && l.id === body.loanId) : null;
  if (!loan) return json(404, { error: 'Loan not found' });
  const loanKey = ownerKey + '/' + keySafe(String(loan.id));

  // ── a letter exactly as it was sent ─────────────────────────────────────
  if (action === 'download') {
    const id = keySafe(String(body.letterId || ''));
    if (!id) return json(400, { error: 'letterId required' });
    const rec = await lettersStore().get(loanKey + '/' + id, { type: 'json' }).catch(() => null);
    if (!rec || !rec.pdfB64) return json(404, { error: 'That letter is not on file' });
    return pdfResponse(Buffer.from(rec.pdfB64, 'base64'), rec.filename || 'Notice of Servicing Transfer.pdf');
  }

  // ── what the loan can fill, and what it cannot ──────────────────────────
  if (action === 'prefill') {
    const guarantors = [];
    for (const gid of (loan.guarantorClientIds || []).slice(0, 4)) {
      const gc = await clientsStore.get(ownerKey + '/' + keySafe(gid), { type: 'json' }).catch(() => null);
      if (gc) guarantors.push(gc);
    }
    const servicers = await listNoteServicers();
    const out = resolveLetterFields({
      loan, client, guarantors, servicers, fallbackLoanNumber: deriveBaselineLoanId(loan),
    });
    return json(200, {
      ok: true,
      defs: LETTER_FIELDS,   // the form is DRAWN from this list — one definition of every blank
      fields: out.fields, asked: out.asked, dueDay: out.dueDay, recipients: out.recipients,
      servicers: servicers.map((s) => ({ name: (s.company || s.name || '').trim(), phone: s.phone || '', email: s.email || '' }))
        .filter((s) => s.name),
      remembered: await listRemembered(),
      lastSent: await lastSentFor(loanKey),
      alwaysCc: SLA_BLOCK.email,
    });
  }

  if (action !== 'pdf' && action !== 'send') return json(400, { error: 'Unknown action: ' + action });

  // ── the hole check, for preview and send alike ──────────────────────────
  const fields = normalizeLetterFields(body.fields);
  const problems = validateLetter(fields);
  if (problems.length) return json(422, { error: 'The letter is not complete yet', problems });

  const pdf = await buildTransferLetterPdf(fields);
  const filename = letterFilename(fields);

  if (action === 'pdf') return pdfResponse(pdf, filename);

  // ── send ────────────────────────────────────────────────────────────────
  const to = emailList(body.to);
  if (!to.length) return json(422, { error: 'Who should this go to?', problems: ['Enter at least one recipient email address'] });
  if (to.length > MAX_RECIPIENTS) return json(422, { error: 'Too many recipients', problems: ['At most ' + MAX_RECIPIENTS + ' recipients'] });
  const bad = rawList(body.to).concat(rawList(body.cc)).filter((e) => !isEmail(e));
  if (bad.length) return json(422, { error: 'Check the email addresses', problems: bad.map((e) => '"' + e + '" does not look like an email address') });
  // boarding@ is ALWAYS copied: the lender keeps a copy of every notice it sends, and
  // the borrower can see who else has it. Extra CCs ride alongside.
  const cc = [SLA_BLOCK.email].concat(emailList(body.cc)).filter((e, i, a) => a.indexOf(e) === i && to.indexOf(e) < 0);

  const cover = buildCoverEmail(fields);
  const emailId = await sendWithAttachment({
    to, cc, subject: cover.subject, text: cover.text, html: cover.html,
    replyTo: SLA_BLOCK.email,
    attachments: [{ filename, content: pdf.toString('base64') }],
  });

  // Everything below is the RECORD of a send that has already happened, so none of it
  // may fail the response: the borrower has the letter whether or not the note saves.
  const now = new Date().toISOString();
  const meta = (user && user.user_metadata) || {};
  const author = meta.full_name || meta.fullName || user.email || '';
  const letterId = 'stl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const warnings = [];
  let entry = null;   // Deploy 237.212 — returned so the page can show the download at once

  try {
    await lettersStore().setJSON(loanKey + '/' + letterId, {
      id: letterId, at: now, by: normalizeEmail(user.email || ''), byName: author,
      to, cc, emailId: emailId || '', filename, fields, pdfB64: pdf.toString('base64'),
    });
  } catch (e) { warnings.push('The PDF copy could not be filed'); console.warn('stl: letter store failed:', e && e.message); }

  try {
    await rememberStore().setJSON(slug(fields.newServicer), {
      name: fields.newServicer, address: fields.newServicerAddress, phone: fields.newServicerPhone,
      email: fields.newServicerEmail, portal: fields.newServicerPortal,
      updatedAt: now, by: normalizeEmail(user.email || ''),
    });
  } catch (e) { console.warn('stl: remember servicer failed:', e && e.message); }

  try {
    entry = appendNoteEntry(loan, {
      kind: 'servicing_transfer_notice',
      text: 'Sent the Notice of Transfer of Loan Servicing to ' + to.join(', ') +
        ' — servicing moves from ' + fields.currentServicer + ' to ' + fields.newServicer +
        ' effective ' + fmtLongDate(fields.transferDate) + '; first payment to the new servicer due ' +
        fmtLongDate(fields.nextPaymentDue) + '. (' + SLA_BLOCK.email + ' copied.)',
      author, authorEmail: user.email || '',
      meta: { letterId, to, cc, emailId: emailId || '', newServicer: fields.newServicer, transferDate: fields.transferDate },
    });
    loan.updatedAt = now;
    await writeClient(ownerKey, client, { clientsStore });
  } catch (e) { warnings.push('The send was not logged to Notes & Activity'); console.warn('stl: note append failed:', e && e.message); }

  return json(200, { ok: true, letterId, sentTo: to, cc, emailId: emailId || null, filename, warnings, entry });
}

// ── helpers ─────────────────────────────────────────────────────────────────

function pdfResponse(buf, filename) {
  return new Response(buf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(buf.length),
      'Content-Disposition': contentDisposition('attachment', filename),
      'Cache-Control': 'private, no-store',
    },
  });
}

const rawList = (v) => (Array.isArray(v) ? v : String(v || '').split(/[,;\s]+/)).map((e) => String(e || '').trim()).filter(Boolean);
const emailList = (v) => rawList(v).map((e) => e.toLowerCase()).filter(isEmail).filter((e, i, a) => a.indexOf(e) === i);

/** The Note Servicers directory — Vendors whose role is note_servicer (see
 *  note-servicers-list.mjs, which serves the same list to the Servicer Name pickers). */
async function listNoteServicers() {
  try {
    const store = getStore({ name: 'loan-contacts', consistency: 'strong' });
    const { blobs } = await store.list();
    const out = [];
    await Promise.all(blobs.map(async ({ key }) => {
      const c = await store.get(key, { type: 'json' }).catch(() => null);
      if (!c || String(c.role || '').toLowerCase() !== 'note_servicer') return;
      out.push({ name: c.name || '', company: c.company || '', email: c.email || '', phone: c.phone || '' });
    }));
    return out;
  } catch (e) { console.warn('stl: servicer directory unavailable:', e && e.message); return []; }
}

/** Contact blocks used on earlier notices, one per new servicer. */
async function listRemembered() {
  try {
    const store = rememberStore();
    const { blobs } = await store.list();
    const out = [];
    await Promise.all(blobs.map(async ({ key }) => {
      const r = await store.get(key, { type: 'json' }).catch(() => null);
      if (r && r.name) out.push({ name: r.name, address: r.address || '', phone: r.phone || '', email: r.email || '', portal: r.portal || '' });
    }));
    return out;
  } catch (e) { return []; }
}

/** The most recent notice sent on this loan, without its PDF bytes. */
async function lastSentFor(loanKey) {
  try {
    const store = lettersStore();
    const { blobs } = await store.list({ prefix: loanKey + '/' });
    if (!blobs.length) return null;
    const newest = blobs.map((b) => b.key).sort().pop();          // ids start with a timestamp
    const r = await store.get(newest, { type: 'json' }).catch(() => null);
    if (!r) return null;
    return { letterId: r.id, at: r.at, byName: r.byName || r.by || '', to: r.to || [],
             newServicer: (r.fields && r.fields.newServicer) || '', transferDate: (r.fields && r.fields.transferDate) || '' };
  } catch (e) { return null; }
}

async function sendWithAttachment({ to, cc, subject, text, html, replyTo, attachments }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) throw new Error('RESEND_API_KEY not configured');
  const resp = await fetch('https://api.resend.com/emails', {
    signal: AbortSignal.timeout(15000),
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: FROM, to, subject, text, html,
      ...(cc && cc.length ? { cc } : {}),
      ...(replyTo ? { reply_to: replyTo } : {}),
      attachments,
    }),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    throw new Error('Email was not sent (Resend ' + resp.status + '): ' + t.slice(0, 200));
  }
  const data = await resp.json().catch(() => null);
  return (data && data.id) || null;
}
