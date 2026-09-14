/**
 * esign-suggest-background.mjs — Deploy 237.028 (Mike)
 *
 * When an E-Sign document completes, work out which loan it belongs to and
 * what kind of document it is, the way the Mail Room does for scanned mail.
 * Runs as a background function (15-minute budget) so the signer's request
 * never waits on the model.
 *
 * Signals, strongest first:
 *   1. A signer's email matches a borrower in Postgres → that borrower's
 *      open loans (+80).
 *   2. The document title + signer names scored against every open loan with
 *      the Mail Room's scoreCandidates (address / entity / borrower / SLA #).
 *   3. Claude reads the executed PDF itself and picks among the candidates,
 *      and names the Doc Review tray (document type) it should be filed as.
 * The result is stored on doc.suggestion; a human confirms every filing.
 *
 * Not user-facing: the request must carry x-esign-job (HMAC of a server-only
 * secret) — the same guard mail-suggest-background uses.
 */
import crypto from 'node:crypto';
import { normalizeEmail } from './_shared/auth.mjs';
import { pgGet, LOAN_PICK_SELECT, loanRowToCandidate, loadCandidateLoans, scoreCandidates } from './_shared/mail-match.mjs';
import { readDoc, writeDoc, docFinalStore, docKey, docTypeOptions } from './_shared/esign-docs.mjs';

const MODEL = process.env.ESIGN_AI_MODEL || process.env.MAIL_AI_MODEL || 'claude-sonnet-4-6';

function expectedSignature() {
  return crypto.createHmac('sha256', process.env.SUPABASE_SERVICE_ROLE_KEY || '').update('esign-suggest-background').digest('hex');
}

function parseJsonLoose(text) {
  const s = String(text || '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

async function loansForSignerEmails(emails) {
  const list = emails.map(normalizeEmail).filter((e) => e && e.indexOf('@') > 0);
  if (!list.length) return [];
  const orClause = '(' + list.map((e) => 'email.ilike.' + e.replace(/[*%(),."\\]/g, '')).join(',') + ')';
  const clients = await pgGet('clients', 'select=id,email&limit=50&or=' + encodeURIComponent(orClause)).catch(() => []);
  if (!clients.length) return [];
  const ids = clients.map((c) => encodeURIComponent(c.id)).join(',');
  const rows = await pgGet('loans', 'select=' + encodeURIComponent(LOAN_PICK_SELECT) +
    '&status=not.in.(cancelled,denied)&order=updated_at.desc&limit=40&client_id=in.(' + ids + ')').catch(() => []);
  return rows.map((r) => Object.assign(loanRowToCandidate(r), { score: 80, why: 'signer email matches borrower' }));
}

async function askClaude({ doc, candidates, pdfB64, docTypes }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const candList = candidates.length
    ? candidates.map((c, i) => '  [' + i + '] ' + c.slaNumber + ' | ' + c.address + ' | borrower: ' + (c.borrower || '—') +
        ' | entity: ' + (c.entity || '—') + ' | status: ' + (c.status || '—') + ' | signals: ' + (c.why || '—')).join('\n')
    : '  (none matched)';
  const typeList = docTypes.map((d) => '  ' + d.slug + ' — ' + d.label + ' (' + d.sectionLabel + ')').join('\n');
  const prompt = [
    'You are the document-filing assistant for SLA Capital, a private real-estate lender.',
    'An electronically signed document just completed in our E-Sign tool. Say which of our loans it concerns and what type of document it is.',
    '',
    'DOCUMENT TITLE: ' + (doc.title || ''),
    'SIGNERS: ' + (doc.signers || []).map((s) => s.name + ' <' + s.email + '> (' + s.kind + ')').join('; '),
    '',
    'CANDIDATE LOANS (pre-matched):',
    candList,
    '',
    'DOCUMENT TYPES (pick exactly one slug, or null if none fits):',
    typeList,
    '',
    'RULES:',
    '- Only choose a loanIndex that is clearly supported by the document (property address, borrower / entity, loan number). If unsure return null — a human confirms every filing and a wrong suggestion is worse than none.',
    '- The last page of the PDF is our own signature certificate; ignore it when judging the document type.',
    '',
    'Respond with ONLY this JSON:',
    '{"loanIndex":<int or null>,"loanConfidence":"high|medium|low","slug":"<slug or null>","slugConfidence":"high|medium|low","reason":"<one short sentence>","extracted":{"documentType":"<string or null>","documentDate":"<YYYY-MM-DD or null>","propertyAddress":"<string or null>"}}',
  ].join('\n');
  const content = [];
  if (pdfB64 && pdfB64.length < 6 * 1024 * 1024) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdfB64 } });
  content.push({ type: 'text', text: prompt });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: controller.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 600, messages: [{ role: 'user', content }] }),
    });
    const d = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error('Anthropic HTTP ' + resp.status + ': ' + ((d && d.error && d.error.message) || ''));
    return parseJsonLoose(((d && d.content) || []).map((b) => (b && b.text) || '').join(''));
  } finally { clearTimeout(timer); }
}

export default async (req) => {
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  const got = Buffer.from(String(req.headers.get('x-esign-job') || ''));
  const want = Buffer.from(expectedSignature());
  if (!secret || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
    console.warn('[esign-suggest-background] missing/invalid job signature — ignoring');
    return new Response('', { status: 202 });
  }
  let body = null;
  try { body = await req.json(); } catch (_) {}
  if (!body || !body.ownerKey || !body.id) return new Response('', { status: 202 });

  const doc = await readDoc(body.ownerKey, body.id);
  if (!doc) return new Response('', { status: 202 });
  const started = Date.now();
  const suggestion = { at: new Date().toISOString(), candidates: [], source: 'rules', model: MODEL, aiError: '' };
  try {
    const byEmail = await loansForSignerEmails((doc.signers || []).map((s) => s.email));
    let allLoans = [];
    try { allLoans = await loadCandidateLoans(); } catch (e) { suggestion.aiError = 'candidate load: ' + (e && e.message); }
    const text = [doc.title, (doc.signers || []).map((s) => s.name).join(' '), (doc.fields || []).filter((f) => f.type === 'text' && typeof f.value === 'string').map((f) => f.value).join(' ')].join(' ');
    const scored = scoreCandidates(text, allLoans, 8);
    const merged = [];
    const seen = new Set();
    byEmail.concat(scored).forEach((c) => {
      if (!c || !c.loanId) return;
      if (seen.has(c.loanId)) {
        const prev = merged.find((m) => m.loanId === c.loanId);
        if (prev && c.score) { prev.score += c.score; prev.why = [prev.why, c.why].filter(Boolean).join(' + '); }
        return;
      }
      seen.add(c.loanId); merged.push(Object.assign({}, c));
    });
    merged.sort((a, b) => (b.score || 0) - (a.score || 0));
    const candidates = merged.slice(0, 10);
    suggestion.candidates = candidates.map((c) => ({ loanId: c.loanId, clientId: c.clientId, ownerKey: c.ownerKey, address: c.address, borrower: c.borrower, entity: c.entity, slaNumber: c.slaNumber, status: c.status, score: c.score, why: c.why }));

    const docTypes = docTypeOptions();
    let ai = null;
    try {
      const pdfB64 = await docFinalStore().get(docKey(doc.ownerKey, doc.id), { type: 'text' }).catch(() => null);
      ai = await askClaude({ doc, candidates, pdfB64, docTypes });
    } catch (e) { suggestion.aiError = (e && e.message) || 'AI call failed'; }

    if (ai) {
      suggestion.source = 'ai';
      const idx = (typeof ai.loanIndex === 'number' && candidates[ai.loanIndex]) ? ai.loanIndex : null;
      if (idx !== null) Object.assign(suggestion, suggestion.candidates[idx], { confidence: ai.loanConfidence || 'low' });
      const slug = ai.slug && docTypes.find((d) => d.slug === ai.slug) ? ai.slug : null;
      if (slug) { suggestion.slug = slug; suggestion.slugLabel = docTypes.find((d) => d.slug === slug).label; suggestion.slugConfidence = ai.slugConfidence || 'low'; }
      suggestion.reason = String(ai.reason || '').slice(0, 300);
      suggestion.extracted = ai.extracted || null;
    } else if (candidates.length && (candidates[0].score || 0) >= 60 && (candidates.length === 1 || (candidates[0].score - (candidates[1].score || 0)) >= 25)) {
      Object.assign(suggestion, suggestion.candidates[0], { confidence: 'medium', reason: 'Matched by ' + candidates[0].why });
    }
    doc.suggestion = suggestion;
    doc.suggestionState = 'done';
  } catch (e) {
    console.error('[esign-suggest-background] failed:', e && e.message);
    doc.suggestion = Object.assign(suggestion, { aiError: (e && e.message) || 'failed' });
    doc.suggestionState = 'failed';
  }
  try { await writeDoc(doc); } catch (e) { console.error('[esign-suggest-background] write failed:', e && e.message); }
  console.log('[esign-suggest-background]', JSON.stringify({ id: doc.id, ms: Date.now() - started, loan: doc.suggestion && doc.suggestion.loanId, slug: doc.suggestion && doc.suggestion.slug, source: doc.suggestion && doc.suggestion.source, err: doc.suggestion && doc.suggestion.aiError }));
  return new Response('', { status: 202 });
};
