/**
 * _shared/mail-match.mjs — Deploy 236.995 (Mike, mail room)
 *
 * Suggests WHICH LOAN a piece of mail belongs to and WHAT it is. Suggestion
 * only — the office assistant confirms every assignment (Mike: "mistakes can
 * be costly"), so nothing here writes to a loan.
 *
 * Two stages:
 *   1. Deterministic candidates. Every live loan is scored against the mail's
 *      text (recipient lines, sender, envelope OCR, scan OCR/summary): SLA loan
 *      number (+100), house number + street name (+60/+75), entity name (+40),
 *      borrower full name (+35), ZIP (+10). Top 8 go forward.
 *   2. AI pass (Claude, when ANTHROPIC_API_KEY is set) reads the envelope/scan
 *      images plus the candidates and returns a category, which candidate (if
 *      any) it believes, a confidence and a one-line reason. Without the key —
 *      or if the call fails — keyword rules pick the category and the top
 *      candidate is suggested only when its score is strong.
 */
import { supabaseBaseUrl } from './supabase-db.mjs';
import { normalizeEmail } from './auth.mjs';
import { deriveBaselineLoanId } from './baseline-sync.mjs';
import { MAIL_CATEGORIES, CATEGORY_LABEL } from './mail-store.mjs';

// Same model the doc reviewer runs on; overridable without a deploy.
const MODEL = process.env.MAIL_AI_MODEL || 'claude-sonnet-4-6';

export async function pgGet(table, qs) {
  const url = supabaseBaseUrl();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  const resp = await fetch(url + '/rest/v1/' + table + '?' + qs, {
    headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' },
  });
  const text = await resp.text();
  let data;
  try { data = text ? JSON.parse(text) : []; } catch (_) { data = []; }
  if (!resp.ok) throw new Error('PostgREST ' + table + ' → HTTP ' + resp.status + (data && data.message ? ': ' + data.message : ''));
  return data || [];
}

export const LOAN_PICK_SELECT = 'id,client_id,owner_email,address,status,funding_date,sla_display_id,updated_at,' +
  'loan_entity:extra->>entityName,clients!client_id(first_name,last_name,entity_name,email)';

export function loanRowToCandidate(l) {
  const c = l.clients || {};
  const borrower = ((c.first_name || '') + ' ' + (c.last_name || '')).replace(/\s+/g, ' ').trim();
  return {
    loanId: l.id,
    clientId: l.client_id,
    ownerKey: normalizeEmail(l.owner_email || ''),
    address: l.address || '',
    borrower,
    entity: l.loan_entity || c.entity_name || '',
    status: l.status || '',
    fundingDate: l.funding_date || '',
    slaNumber: (l.sla_display_id && String(l.sla_display_id).trim())
      || deriveBaselineLoanId({ id: l.id, fundingDate: l.funding_date || '' }),
  };
}

/** Every loan that could plausibly receive mail (cancelled/declined excluded). */
export async function loadCandidateLoans() {
  const PAGE = 1000;
  const out = [];
  for (let offset = 0; offset < 50000; offset += PAGE) {
    const qs = 'select=' + encodeURIComponent(LOAN_PICK_SELECT) +
      '&status=not.in.(cancelled,denied)&order=updated_at.desc&limit=' + PAGE + '&offset=' + offset;
    const rows = await pgGet('loans', qs);
    rows.forEach((r) => out.push(loanRowToCandidate(r)));
    if (rows.length < PAGE) break;
  }
  return out;
}

// ── Text normalization ────────────────────────────────────────────────
const STREET_NOISE = {
  st: 1, street: 1, ave: 1, avenue: 1, rd: 1, road: 1, dr: 1, drive: 1, ln: 1, lane: 1, ct: 1, court: 1,
  pl: 1, place: 1, blvd: 1, boulevard: 1, cir: 1, circle: 1, way: 1, ter: 1, terrace: 1, pkwy: 1, hwy: 1,
  n: 1, s: 1, e: 1, w: 1, ne: 1, nw: 1, se: 1, sw: 1, north: 1, south: 1, east: 1, west: 1,
  unit: 1, apt: 1, suite: 1, ste: 1, and: 1, usa: 1, us: 1,
};
const ENTITY_NOISE = { llc: 1, inc: 1, lp: 1, llp: 1, ltd: 1, corp: 1, co: 1, company: 1, the: 1, trust: 1, holdings: 0 };

export function normText(s) {
  return ' ' + String(s || '').toLowerCase()
    .replace(/\b(\d+)(st|nd|rd|th)\b/g, '$1')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ').trim() + ' ';
}

function has(text, phrase) {
  const p = normText(phrase).trim();
  return p.length >= 2 && text.indexOf(' ' + p + ' ') >= 0;
}

/** Score every loan against the mail text; strongest first. */
export function scoreCandidates(rawText, loans, limit) {
  const text = normText(rawText);
  const scored = [];
  for (const l of loans || []) {
    let score = 0;
    const why = [];
    if (l.slaNumber && has(text, l.slaNumber)) { score += 100; why.push('SLA loan number'); }

    const street = String(l.address || '').split(',')[0];
    const toks = normText(street).trim().split(' ').filter(Boolean);
    if (toks.length >= 2 && /^\d+$/.test(toks[0]) && text.indexOf(' ' + toks[0] + ' ') >= 0) {
      const words = toks.slice(1).filter((w) => !STREET_NOISE[w] && w.length > 1);
      if (words.length && text.indexOf(' ' + words[0] + ' ') >= 0) {
        score += 60;
        if (words[1] && text.indexOf(' ' + words[1] + ' ') >= 0) score += 15;
        why.push('property address');
      }
    }
    const zip = /\b(\d{5})(?:-\d{4})?\b/.exec(String(l.address || ''));
    if (zip && text.indexOf(' ' + zip[1] + ' ') >= 0 && score > 0) score += 10;

    if (l.entity) {
      const ent = normText(l.entity).trim().split(' ').filter((w) => w && !ENTITY_NOISE[w]).join(' ');
      if (ent.length >= 4 && text.indexOf(' ' + ent + ' ') >= 0) { score += 40; why.push('entity name'); }
    }
    if (l.borrower && l.borrower.indexOf(' ') > 0 && has(text, l.borrower)) { score += 35; why.push('borrower name'); }

    if (score >= 30) scored.push(Object.assign({}, l, { score, why: why.join(' + ') }));
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit || 8);
}

// ── Category rules (fallback when the AI isn't available) ────────────
export function ruleCategory(rawText, item) {
  const t = normText(rawText);
  const any = (arr) => arr.some((w) => t.indexOf(' ' + w + ' ') >= 0);
  if (item && item.stable && Array.isArray(item.stable.checks) && item.stable.checks.length) return 'check_payment';
  if (any(['deed of trust', 'mortgage', 'recorded', 'recording', 'county recorder', 'register of deeds'])) {
    if (any(['title insurance', 'loan policy', 'owners policy', 'policy of title'])) return 'title_policy';
    return 'recorded_instrument';
  }
  if (any(['title insurance', 'loan policy', 'policy of title insurance'])) return 'title_policy';
  if (any(['promissory note', 'original note', 'closing documents', 'allonge'])) return 'closing_originals';
  if (any(['payoff', 'fci lender', 'servicing', 'loan servicing', 'servicing pros'])) return 'servicer_payoff';
  if (any(['property tax', 'tax bill', 'treasurer', 'assessor', 'insurance', 'declarations', 'premium', 'escrow'])) return 'tax_insurance';
  if (any(['summons', 'court', 'secretary of state', 'irs', 'internal revenue', 'department of revenue', 'notice of default', 'lis pendens'])) return 'legal_notice';
  if (any(['prsrt std', 'presorted', 'current resident', 'or current resident', 'special offer', 'limited time'])) return 'junk';
  return 'general';
}

// ── AI pass ───────────────────────────────────────────────────────────
function mediaBlock(bytes, contentType) {
  if (!bytes || !bytes.length || bytes.length > 4.5 * 1024 * 1024) return null;
  const ct = String(contentType || '').toLowerCase();
  const b64 = bytes.toString('base64');
  if (ct === 'application/pdf') return { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } };
  const img = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(ct) >= 0 ? ct : (ct.indexOf('image/') === 0 ? 'image/jpeg' : '');
  return img ? { type: 'image', source: { type: 'base64', media_type: img, data: b64 } } : null;
}

function parseJsonLoose(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

async function aiSuggest({ text, envelope, scan, candidates }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;
  const today = new Date().toISOString().slice(0, 10);
  const catList = MAIL_CATEGORIES.map((c) => '  ' + c[0] + ' — ' + c[1]).join('\n');
  const candList = candidates.length
    ? candidates.map((c, i) => '  [' + i + '] ' + c.slaNumber + ' | ' + c.address + ' | borrower: ' + (c.borrower || '—') +
        ' | entity: ' + (c.entity || '—') + ' | match signals: ' + (c.why || '—')).join('\n')
    : '  (none — no loan in the system matched the text on this mail)';
  const prompt = [
    "TODAY'S DATE: " + today,
    'You are the mail-room assistant for SLA Capital, a private real-estate lender.',
    'A piece of physical mail arrived at our virtual mailbox. Classify it and say which of our loans (if any) it concerns.',
    '',
    'CATEGORIES (pick exactly one key):',
    catList,
    '',
    'CANDIDATE LOANS (pre-matched from the text on the mail):',
    candList,
    '',
    'TEXT READ FROM THE MAIL (OCR, may be noisy):',
    String(text || '').slice(0, 7000) || '(no OCR text available)',
    '',
    'RULES:',
    '- Only choose a loanIndex that is clearly supported by the mail (property address, borrower/entity, or loan number). If unsure, return null — a human confirms every assignment and a wrong suggestion is worse than none.',
    '- Mail addressed to SLA Capital about a borrower\'s property (recorded deed of trust, title policy, tax bill, insurance notice) belongs to that property\'s loan.',
    '- extracted.recordingDate / documentDate as YYYY-MM-DD only when printed on the mail; otherwise null.',
    '',
    'Respond with ONLY this JSON:',
    '{"category":"<key>","categoryConfidence":"high|medium|low","loanIndex":<int or null>,"loanConfidence":"high|medium|low","reason":"<one short sentence>","extracted":{"documentType":"<string or null>","recordingDate":"<YYYY-MM-DD or null>","instrumentNumber":"<string or null>","documentDate":"<YYYY-MM-DD or null>"}}',
  ].join('\n');

  const content = [];
  const eb = envelope && mediaBlock(envelope.bytes, envelope.contentType);
  if (eb) content.push(eb);
  const sb = scan && mediaBlock(scan.bytes, scan.contentType);
  if (sb) content.push(sb);
  content.push({ type: 'text', text: prompt });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 18000);
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, messages: [{ role: 'user', content }] }),
    });
    const d = await resp.json().catch(() => null);
    if (!resp.ok) throw new Error('Anthropic HTTP ' + resp.status + ': ' + ((d && d.error && d.error.message) || ''));
    const txt = ((d && d.content) || []).map((b) => b && b.text || '').join('');
    return parseJsonLoose(txt);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build item.suggestion. media = { envelope:{bytes,contentType}, scan:{…} }.
 * Never throws — a failed AI call degrades to the rule-based suggestion.
 */
export async function suggestForItem(item, media, loans) {
  const text = [
    item.recipientName, item.recipientLine1, item.recipientLine2, item.from,
    item.scanSummary, item.ocrText, item.scanOcrText,
  ].filter(Boolean).join('\n');
  const candidates = scoreCandidates(text, loans, 8);
  const slim = (c) => ({
    loanId: c.loanId, clientId: c.clientId, ownerKey: c.ownerKey, address: c.address,
    borrower: c.borrower || c.entity || '', slaNumber: c.slaNumber, score: c.score, why: c.why,
  });

  let ai = null, aiError = '';
  try { ai = await aiSuggest({ text, envelope: media && media.envelope, scan: media && media.scan, candidates }); }
  catch (e) { aiError = (e && e.message) || 'AI call failed'; }

  const out = {
    at: new Date().toISOString(),
    candidates: candidates.map(slim),
    source: ai ? 'ai' : 'rules',
    model: ai ? MODEL : '',
    aiError,
  };
  if (ai && CATEGORY_LABEL[ai.category]) {
    out.category = ai.category;
    out.categoryConfidence = ai.categoryConfidence || 'medium';
  } else {
    out.category = ruleCategory(text, item);
    out.categoryConfidence = 'low';
  }
  let pick = null;
  if (ai && Number.isInteger(ai.loanIndex) && candidates[ai.loanIndex]) {
    pick = candidates[ai.loanIndex];
    out.confidence = ai.loanConfidence || 'medium';
    out.reason = String(ai.reason || '').slice(0, 300);
  } else if (!ai && candidates[0] && candidates[0].score >= 60 &&
             (!candidates[1] || candidates[0].score - candidates[1].score >= 25)) {
    pick = candidates[0];
    out.confidence = candidates[0].score >= 100 ? 'high' : 'medium';
    out.reason = 'Matched on ' + candidates[0].why + '.';
  } else if (ai) {
    out.reason = String(ai.reason || '').slice(0, 300);
  }
  if (pick) Object.assign(out, slim(pick));
  if (ai && ai.extracted && typeof ai.extracted === 'object') {
    const ex = ai.extracted;
    const ymd = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : '';
    out.extracted = {
      documentType: ex.documentType ? String(ex.documentType).slice(0, 120) : '',
      recordingDate: ymd(ex.recordingDate),
      instrumentNumber: ex.instrumentNumber ? String(ex.instrumentNumber).slice(0, 60) : '',
      documentDate: ymd(ex.documentDate),
    };
  }
  return out;
}
