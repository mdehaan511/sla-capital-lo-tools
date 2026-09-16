/**
 * loan-review-guidelines-extract-background.mjs — Deploy 237.096 (Mike: spend)
 *
 * One-time transcription of an investor / program guidelines PDF to text, so
 * document reviews attach the TEXT (~60% fewer tokens than the PDF) instead of
 * the PDF. Netlify background function (15-minute budget; returns 202 at once).
 *
 * Body: { key }  — the loan-review-guidelines store key ('rtl', 'colchis', …).
 * Auth: the internal HMAC header (x-sla-internal = internalBgSig('guidelines',
 * key)) set by _shared/guidelines-text.mjs, OR a super-admin JWT (manual
 * re-extract via /api/loan-review-guidelines-extract).
 *
 * Method: pdf-lib splits the PDF into 6-page chunks; each chunk goes to Claude
 * with a verbatim-transcription instruction (Markdown, tables kept, page
 * markers); the pieces are joined and stored as
 * loan-review-guidelines-text/<key> = { text, pages, chunks, extractedAt,
 * model, sourceSize }. Any chunk failure aborts WITHOUT saving (the 30-minute
 * "extracting" marker stops a retry storm; reviews keep sending the PDF).
 * Every chunk call is priced + logged (feature 'guidelines-extract').
 */
import { getStore } from '@netlify/blobs';
import { PDFDocument } from 'pdf-lib';
import { handleOptions, json, requireAuth, readJsonBody, isSuperAdmin } from './_shared/auth.mjs';
import { internalBgSig } from './_shared/review-truth.mjs';
import { logAiUsage } from './_shared/ai-usage.mjs';
import { GUIDELINES_TEXT_STORE } from './_shared/guidelines-text.mjs';

const MODEL = process.env.GUIDELINES_EXTRACT_MODEL || process.env.DOC_REVIEW_MODEL || 'claude-sonnet-4-6';
const PAGES_PER_CHUNK = 6;
const MAX_OUTPUT_TOKENS = 16000;
const CHUNK_TIMEOUT_MS = 240000;

const SYSTEM = 'You transcribe lending underwriting guideline documents. You output the document text verbatim as Markdown — every heading, sentence, number, threshold, footnote and table — without summarising, paraphrasing, reordering or adding commentary. Tables become Markdown tables. Output only the transcription.';

async function _transcribeChunk(apiKey, chunkBytes, firstPage, lastPage) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHUNK_TIMEOUT_MS);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: SYSTEM,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: chunkBytes.toString('base64') } },
          { type: 'text', text: 'These are pages ' + firstPage + ' to ' + lastPage + ' of the investor\'s underwriting guidelines. Transcribe them verbatim as Markdown. Start each page with a line "--- Page N ---" using the original page number (the first page here is page ' + firstPage + '). Keep every number, percentage, dollar amount, date and footnote exactly. Render tables as Markdown tables. Do not summarise or skip anything; do not add commentary.' },
        ] }],
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => '');
      throw new Error('Anthropic ' + resp.status + ': ' + t.slice(0, 200));
    }
    const data = await resp.json();
    const text = (data.content || []).filter((c) => c && c.type === 'text').map((c) => c.text).join('\n');
    await logAiUsage({ feature: 'guidelines-extract', model: MODEL, usage: data.usage || {}, meta: { pages: firstPage + '-' + lastPage } });
    if (!text.trim()) throw new Error('empty transcription for pages ' + firstPage + '-' + lastPage);
    return text.trim();
  } finally {
    clearTimeout(timer);
  }
}

export default async (req, context) => {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });
  const body = await readJsonBody(req);
  const key = String((body && body.key) || '').toLowerCase().trim();
  if (!key) return json(400, { error: 'key required' });

  const hdrSig = (req.headers && typeof req.headers.get === 'function') ? (req.headers.get('x-sla-internal') || '') : '';
  const wantSig = internalBgSig('guidelines', key);
  if (!(wantSig && hdrSig && hdrSig === wantSig)) {
    const user = await requireAuth(context, req);
    if (!user) return json(401, { error: 'Not authenticated' });
    if (!isSuperAdmin(user)) return json(403, { error: 'Super-admin only' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const textStore = getStore({ name: GUIDELINES_TEXT_STORE, consistency: 'strong' });
  const started = Date.now();
  try {
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured');
    const pdfStore = getStore({ name: 'loan-review-guidelines', consistency: 'strong' });
    const raw = await pdfStore.get(key, { type: 'arrayBuffer' });
    if (!raw) throw new Error('no guidelines PDF stored under ' + key);
    const bytes = Buffer.from(raw);
    const src = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const n = src.getPageCount();
    const parts = [];
    let chunks = 0;
    for (let start = 0; start < n; start += PAGES_PER_CHUNK) {
      const idxs = [];
      for (let i = start; i < Math.min(n, start + PAGES_PER_CHUNK); i++) idxs.push(i);
      const out = await PDFDocument.create();
      const pages = await out.copyPages(src, idxs);
      pages.forEach((p) => out.addPage(p));
      const chunkBytes = Buffer.from(await out.save());
      parts.push(await _transcribeChunk(apiKey, chunkBytes, start + 1, start + idxs.length));
      chunks++;
    }
    const text = parts.join('\n\n');
    await textStore.setJSON(key, {
      key, text, pages: n, chunks, chars: text.length,
      extractedAt: new Date().toISOString(), model: MODEL, sourceSize: bytes.length,
    });
    await textStore.delete(key + '.extracting').catch(() => {});
    console.log('[guidelines-extract] ' + key + ': ' + n + ' pages, ' + chunks + ' chunks, ' + text.length + ' chars in ' + Math.round((Date.now() - started) / 1000) + 's');
    return json(200, { ok: true, key, pages: n, chunks, chars: text.length });
  } catch (e) {
    console.error('[guidelines-extract] ' + key + ' failed:', e && e.message);
    return json(500, { error: 'Extraction failed: ' + ((e && e.message) || 'unknown') });
  }
};
