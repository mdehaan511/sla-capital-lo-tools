/**
 * _shared/anthropic-doc-review.mjs — Deploy 236.76 (Loan Doc Review
 * Phase 2). Calls Claude Sonnet 4.6 with a PDF + condition rubric,
 * returns a structured verdict (approved | issues), a summary, a
 * list of findings, extracted entities (for the later cross-doc
 * consistency check), and the token usage / cost in cents.
 *
 * Why direct fetch (not the SDK): the existing chatbot at chat.mjs
 * already uses raw fetch — staying consistent so the project has
 * no new npm dependencies to manage.
 *
 * Pricing as of model launch (Claude Sonnet 4.6):
 *   $3 / 1M input tokens   = $0.000003 / token = 0.0003 cents/token
 *   $15 / 1M output tokens = $0.000015 / token = 0.0015 cents/token
 */
import { aiCostCents, logAiUsage } from './ai-usage.mjs'; // Deploy 237.093 -- spend: price + log every call
const MODEL = process.env.DOC_REVIEW_MODEL || 'claude-sonnet-4-6'; // Deploy 237.004: env override
// Deploy 237.221 -- was 2048. With thinking off, this model does its reasoning in the
// VISIBLE answer on a hard document ("I need to analyze this 401(k) statement..."), and
// 2,048 tokens of prose left no room for the JSON: 4.7% of reviews came back
// `malformed_verdict` and lost everything, extracted fields included. Output is billed
// only when generated, so a higher ceiling costs nothing on the reviews that were fine.
const MAX_OUTPUT_TOKENS = 8192;
const INPUT_CENTS_PER_TOKEN          = 0.0003;
// Deploy 236.77 — Anthropic prompt caching pricing. Writes (storing
// content in the cache on the first call) cost 1.25x normal input;
// reads (cache hits) cost 0.10x normal input. With the guidelines
// PDF marked cache_control: ephemeral, the first review on a session
// pays the cache-write premium, every subsequent review on the same
// session reads from cache and pays ~10% of the guidelines cost.
const CACHE_WRITE_CENTS_PER_TOKEN    = 0.000375;
const CACHE_READ_CENTS_PER_TOKEN     = 0.00003;
const OUTPUT_CENTS_PER_TOKEN         = 0.0015;
// Claude PDF input cap is 32 MB; we already cap uploads at 25 MB
// in the upload endpoint so this is informational.
const MAX_PDF_BYTES = 32 * 1024 * 1024;

/**
 * Review a single document against its checklist conditions.
 *
 * @param {Object} opts
 * @param {Buffer} opts.bytes              Raw PDF bytes
 * @param {string} opts.mimeType           Defaults to application/pdf
 * @param {string} opts.docLabel           Human-friendly doc name
 *                                          (e.g. "Articles of Organization")
 * @param {string} opts.docConditions      The conditions text from the
 *                                          checklist (the rubric).
 * @param {Object} opts.loanContext        Snapshot fields the doc must
 *                                          match: { loanAmount, address,
 *                                          borrowerName, entityName, ... }
 * @param {string} opts.investor           'diya' / 'colchis' / etc.
 *
 * @returns {Promise<{
 *   verdict: 'approved' | 'issues',
 *   summary: string,
 *   findings: Array<{ condition: string, status: 'met'|'not_met'|'unclear', detail: string }>,
 *   extractedEntities: { llcName?: string, borrowerName?: string, propertyAddress?: string, loanAmount?: number, [k: string]: any },
 *   inputTokens: number,
 *   outputTokens: number,
 *   costCents: number,
 *   error?: string,
 * }>}
 *
 * On error (API failure, parse failure, etc.) returns a result with
 * verdict='issues', error message, zero cost. The upload endpoint
 * still saves the file — the processor can review manually.
 */
export async function reviewDocument(opts) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return {
      verdict: 'issues',
      summary: 'AI review unavailable — ANTHROPIC_API_KEY not set.',
      findings: [],
      extractedEntities: {},
      inputTokens: 0, outputTokens: 0, costCents: 0,
      error: 'missing_api_key',
    };
  }

  const bytes = opts.bytes;
  if (!bytes || !bytes.length) {
    return {
      verdict: 'issues',
      summary: 'AI review skipped — no document bytes.',
      findings: [], extractedEntities: {},
      inputTokens: 0, outputTokens: 0, costCents: 0,
      error: 'empty_bytes',
    };
  }
  if (bytes.length > MAX_PDF_BYTES) {
    return {
      verdict: 'issues',
      summary: 'AI review skipped — document exceeds 32 MB limit.',
      findings: [], extractedEntities: {},
      inputTokens: 0, outputTokens: 0, costCents: 0,
      error: 'too_large',
    };
  }

  const b64 = bytes.toString('base64');
  const userPrompt = buildPrompt(opts);

  // Deploy 236.77/78 — investor guidelines PDF + signed loan
  // application PDF both attached as cached content blocks when
  // available. The cache_control marker tells Anthropic to keep
  // these blocks in its prompt cache (~5 min TTL) so subsequent
  // reviews on the same loan pay ~10% of normal input cost for
  // the cached portions. The order matters: cached docs go FIRST,
  // then the doc being reviewed. Anthropic caches everything
  // before the LAST cache_control breakpoint, so we put it on the
  // last cacheable block (the loan app, or the guidelines if no
  // loan app).
  const content = [];
  let _gBlock = null; // Deploy 237.093 -- kept so the 1h-TTL fallback below can downgrade it
  if (opts.guidelinesText) {
    // Deploy 237.096 (Mike: spend) -- the guidelines as extracted TEXT (~60% fewer
    // tokens than the PDF, which is tokenised as page images + text). Same 1h
    // breakpoint as the PDF branch below; _shared/guidelines-text.mjs decides which.
    const tblock = {
      type: 'text',
      text: 'INVESTOR UNDERWRITING GUIDELINES' + (opts.guidelinesKey ? ' (' + String(opts.guidelinesKey).toUpperCase() + ' program)' : '') +
        ' -- verbatim transcription of the guidelines document:\n\n' + String(opts.guidelinesText),
      cache_control: { type: 'ephemeral', ttl: '1h' },
    };
    _gBlock = tblock;
    content.push(tblock);
  } else if (opts.guidelinesBytes && opts.guidelinesBytes.length) {
    const block = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: opts.guidelinesBytes.toString('base64') },
    };
    // Deploy 237.093 (Mike: spend) -- the guidelines PDF is the SAME bytes for every
    // loan on the investor, so it gets its OWN breakpoint with a 1-HOUR TTL. Since
    // Sep 1, 96% of reviews came within an hour of the previous one (82% within 5
    // minutes), yet the old single breakpoint (on the per-loan application) meant
    // every new loan and every >5-minute gap re-WROTE this whole PDF at 1.25x --
    // the orange bars on the Console chart. A 1h entry must precede any 5m entry;
    // the loan application below stays 5m (reused only within one loan's burst).
    block.cache_control = { type: 'ephemeral', ttl: '1h' };
    _gBlock = block;
    content.push(block);
  }
  if (opts.loanAppBytes && opts.loanAppBytes.length) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: opts.loanAppBytes.toString('base64') },
      cache_control: { type: 'ephemeral' },
    });
  }
  // Deploy 236.166 — Anthropic's API requires DIFFERENT block types
  // for PDFs vs images. The previous code always wrapped uploads as
  // `document`, which only accepts media_type=application/pdf — any
  // image mime (JPEG / PNG / GIF / WEBP) tripped a 400 from the
  // model endpoint. Now we detect the family and route accordingly:
  //   image/*     -> { type: 'image',    source: { media_type, ... } }
  //   anything    -> { type: 'document', source: { media_type: 'application/pdf', ... } }
  // PDFs continue to use the document block (which preserves the
  // multi-page citation + caching behavior).
  const incomingMime = String(opts.mimeType || 'application/pdf').toLowerCase();
  if (incomingMime.indexOf('image/') === 0) {
    // Normalize to one of the four image types Anthropic supports.
    // Anything else (HEIC, BMP, etc.) gets coerced to JPEG — the
    // browser-side capture flow shouldn't produce those for us
    // but the explicit fallback prevents another 400.
    const supportedImage = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'].indexOf(incomingMime) >= 0
      ? incomingMime : 'image/jpeg';
    content.push({ type: 'image', source: { type: 'base64', media_type: supportedImage, data: b64 } });
  } else {
    content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } });
  }
  content.push({ type: 'text', text: userPrompt });

  // Claude API call. Default 22s — Netlify Pro caps a SYNC function at 26s and we
  // need headroom for post-processing + the blob write. A BACKGROUND function
  // (Deploy 236.754) passes a much longer opts.timeoutMs (it gets 15 min), so a
  // long document (big Operating Agreement, appraisal) can finish there instead
  // of being cut off in the sync upload path.
  const _timeoutMs = (Number(opts && opts.timeoutMs) > 0) ? Number(opts.timeoutMs) : 22000;
  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, _timeoutMs);

  let resp;
  try {
    // Deploy 237.093 -- the request is a function so the TTL fallback can re-send it.
    const _doFetch = function () {
      return fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type':       'application/json',
          'x-api-key':          apiKey,
          'anthropic-version':  '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: MAX_OUTPUT_TOKENS,
          system: buildSystemPrompt(opts),
          messages: [{ role: 'user', content }],
        }),
        signal: controller.signal,
      });
    };
    resp = await _doFetch();
    // If this API version rejects the 1h TTL, drop the guidelines block to 5m once and retry.
    if (resp.status === 400 && _gBlock && _gBlock.cache_control && _gBlock.cache_control.ttl) {
      const _t = await resp.clone().text().catch(function () { return ''; });
      if (/ttl/i.test(_t)) {
        console.warn('reviewDocument: 1h cache TTL rejected by the API -- retrying with the 5m cache');
        delete _gBlock.cache_control.ttl;
        resp = await _doFetch();
      }
    }
  } catch (e) {
    clearTimeout(timeoutId);
    const _isAbort = e.name === 'AbortError';
    const msg = _isAbort ? ('AI review timed out after ' + Math.round(_timeoutMs / 1000) + 's') : ('AI request failed: ' + (e.message || 'unknown'));
    console.error('reviewDocument fetch error:', msg);
    return {
      verdict: 'issues',
      summary: msg,
      findings: [], extractedEntities: {},
      inputTokens: 0, outputTokens: 0, costCents: 0,
      // Deploy 236.754 — distinct 'timeout' so the upload path can hand a long
      // doc off to the background reviewer instead of flagging a false 'issues'.
      error: _isAbort ? 'timeout' : 'fetch_failed',
    };
  }
  clearTimeout(timeoutId);

  if (!resp.ok) {
    const errText = await resp.text().catch(function () { return ''; });
    console.error('Anthropic API error', resp.status, errText.slice(0, 300));
    return {
      verdict: 'issues',
      summary: 'Anthropic API error (' + resp.status + '). Check API key + quota.',
      findings: [], extractedEntities: {},
      inputTokens: 0, outputTokens: 0, costCents: 0,
      error: 'api_error_' + resp.status,
    };
  }

  let data;
  try {
    data = await resp.json();
  } catch (e) {
    return {
      verdict: 'issues',
      summary: 'AI review unparseable response.',
      findings: [], extractedEntities: {},
      inputTokens: 0, outputTokens: 0, costCents: 0,
      error: 'parse_failed',
    };
  }

  // Pull text content + usage from the Anthropic response shape.
  const textBlock = (data.content || []).find(function (c) { return c && c.type === 'text'; });
  const rawText = textBlock ? String(textBlock.text || '') : '';
  // Deploy 237.221 -- nothing read this before, so an answer cut off at max_tokens was
  // indistinguishable from one that was never JSON at all.
  const stopReason = String(data.stop_reason || '');
  const usage = data.usage || {};
  const inputTokens          = Number(usage.input_tokens             || 0);
  const cacheWriteTokens     = Number(usage.cache_creation_input_tokens || 0);
  const cacheReadTokens      = Number(usage.cache_read_input_tokens     || 0);
  const outputTokens         = Number(usage.output_tokens             || 0);
  // Deploy 236.77 — cache-aware cost. Anthropic reports input_tokens
  // for the uncached portion; cache_creation_input_tokens for cache
  // writes (1.25x); cache_read_input_tokens for cache hits (0.10x).
  // Deploy 237.093 -- priced by _shared/ai-usage.mjs (a 1h cache write is 2x, not
  // 1.25x) and logged there so the weekly spend digest sees every review.
  const costCents = aiCostCents(MODEL, usage);
  await logAiUsage({ feature: 'doc-review', model: MODEL, usage, meta: { reviewId: opts.reviewId || '', slug: opts.slug || '', address: opts.address || '', docLabel: opts.docLabel || '', origin: opts.origin || '', stopReason } });

  // Parse the model's JSON. The system prompt asks for clean JSON
  // but defensively strip markdown fences and pull the first
  // JSON object out if there's surrounding chatter.
  const parsed = extractJson(rawText);
  if (!parsed) {
    // Deploy 237.221 -- say WHICH failure it was. Cut off at the ceiling is a different
    // problem (and a different fix) from an answer that was never JSON.
    const truncated = stopReason === 'max_tokens';
    return {
      verdict: 'issues',
      summary: truncated
        ? 'AI review was cut off before it finished (' + outputTokens + ' tokens). Press Retry; if it repeats, this document needs a manual review.'
        : 'AI returned malformed verdict. Raw: ' + rawText.slice(0, 200),
      findings: [], extractedEntities: {},
      inputTokens, outputTokens, costCents, stopReason,
      error: truncated ? 'truncated' : 'malformed_verdict',
    };
  }

  const verdict = parsed.verdict === 'approved' ? 'approved' : 'issues';
  return {
    verdict,
    summary: String(parsed.summary || ''),
    findings: Array.isArray(parsed.findings) ? parsed.findings.map(normalizeFinding).filter(Boolean) : [],
    extractedEntities: (parsed.extracted_entities && typeof parsed.extracted_entities === 'object') ? parsed.extracted_entities : {},
    // Deploy 236.500 — targeted field extraction for the Underwriting /
    // Lightning Docs auto-grab. Present only when opts.extractFields was
    // passed. Shape: { key: { value, found, where } }.
    extractedFields: (parsed.extracted_fields && typeof parsed.extracted_fields === 'object') ? parsed.extracted_fields : {},
    // Deploy 236.669 — AI document-integrity assessment (present only when
    // opts.integrityCheck was set). Shape: { risk, findings:[{level,detail}] }.
    integrity: _normalizeIntegrity(parsed.integrity),
    inputTokens, outputTokens, costCents, cacheWriteTokens, cacheReadTokens, stopReason,
  };
}

function _normalizeIntegrity(v) {
  if (!v || typeof v !== 'object') return null;
  const risk = (v.risk === 'high' || v.risk === 'medium') ? v.risk : 'low';
  const findings = Array.isArray(v.findings)
    ? v.findings.map(function (f) {
        if (!f) return null;
        const detail = String((f && f.detail) || '').trim();
        if (!detail) return null;
        return { level: (f.level === 'high' ? 'high' : 'medium'), detail: detail };
      }).filter(Boolean)
    : [];
  return { risk: risk, findings: findings };
}

function buildSystemPrompt(opts) {
  // Deploy 236.78 — system prompt now lists ALL attached docs so the
  // model knows what's available for cross-reference. Also tightened
  // to stop the model from inventing checks (property address on an
  // entity doc, etc.) that aren't in the per-doc rubric.
  // Deploy 236.971 (processor report, 5909 Cates COGS) — the model does NOT
  // know today's date and was assuming its training-data present (~mid-2025),
  // so every 2026-dated certificate read as "future-dated / authenticity
  // concern" and 90-day freshness windows were computed against the wrong
  // "now" (one 143-day-old cert even PASSED under the assumed date). Anchor
  // the real review date in both prompts.
  const _todayStr = new Date().toISOString().slice(0, 10);
  const lines = [
    "You are an expert loan-document underwriter at SLA Capital.",
    "TODAY'S DATE IS " + _todayStr + ". Use it for every date computation — freshness windows, expirations, future-dating. Never infer the current date from your training data.",
    "Given a specific loan document and the conditions it must meet, you read it carefully and decide whether each condition is met.",
    "You always respond with valid JSON matching the schema the user provides — no commentary, no markdown code fences, just the JSON object.",
    "",
    "Documents attached in the user message (in order):",
  ];
  let idx = 1;
  if (opts.guidelinesText || (opts.guidelinesBytes && opts.guidelinesBytes.length)) { // Deploy 237.096 -- text or PDF
    lines.push(`  ${idx}. INVESTOR UNDERWRITING GUIDELINES ${opts.guidelinesText ? '(verbatim text transcription)' : 'PDF'} — authoritative reference for what the investor requires. Cross-check the doc being reviewed against the relevant sections (entity / borrower / appraisal / title / insurance / etc.).`);
    idx += 1;
  }
  if (opts.loanAppBytes && opts.loanAppBytes.length) {
    lines.push(`  ${idx}. LOAN APPLICATION PDF (SLA's signed loan application for this loan) — source of truth for borrower name, property address, loan amount, and other application-level fields. When the per-doc rubric says "match X to the loan application", you MUST cross-reference the loan application PDF directly rather than guessing or claiming the data is unavailable.`);
    idx += 1;
  }
  lines.push(`  ${idx}. THE DOCUMENT BEING REVIEWED — the focus of your review. The conditions in the user prompt apply to THIS document.`);
  lines.push('');
  lines.push("CRITICAL RULES — these prevent the most common AI verdict mistakes:");
  lines.push("• ONLY evaluate the conditions listed in the per-doc rubric. Do NOT invent additional checks.");
  lines.push("• Many borrower/entity/guarantor documents (Articles of Organization, OFAC reports, ID, credit reports, etc.) do NOT contain the property address or loan amount — that's normal. Do NOT flag missing property address or missing loan amount as an issue UNLESS the per-doc rubric explicitly says to verify it.");
  lines.push("• When the rubric says 'matches loan application' or 'matches the loan' — LOOK in the attached Loan Application PDF. Do not claim the data is unavailable when the PDF is right there.");
  // Deploy 237.041 (Dan, via Mike) -- the entity name is governed by the recorded
  // Articles, not the loan application. The Articles tray's extracted name is handed
  // in as the ENTITY NAME OF RECORD line in the user prompt.
  lines.push("• The ENTITY / LLC NAME is governed by the recorded Articles of Organization, NOT the loan application. When a rubric says 'matches the Articles' or 'ENTITY NAME OF RECORD', compare against the ENTITY NAME OF RECORD line in the user prompt (the name extracted from the Articles tray on this loan); ignore letter case and punctuation, but a different word (e.g. 'Drive' vs 'DR', a missing 'LLC', a different word order) is a mismatch. This applies to EVERY entity document (COGS, EIN letter / W-9, OFAC and background reports, operating agreement, foreign registration): if a rubric compares an entity name to the loan application, read it as a comparison to the ENTITY NAME OF RECORD instead - agreeing with the loan application's spelling proves nothing. For a search-type report (OFAC, background check) the name that was SEARCHED must be the name of record; a search run under a different spelling of the entity name is a defect on that report. If that line says the Articles have not been reviewed yet, mark the name-match condition 'unclear' and say so. NEVER claim the Articles do not exist, and NEVER fail a document merely because its entity name differs from the loan application — a loan-application name that differs from the Articles is a defect on the loan application.");
  // Deploy 237.074 (Mike) -- Articles: find the LLC name, never the guarantor. Bank statements:
  // the holder may be the entity OR any guarantor (100% owned; no outside holder).
  lines.push("• ARTICLES OF ORGANIZATION: the item to identify is the LLC / ENTITY NAME as filed. Organizer, member, manager, and registered-agent names on the filing are NOT the entity name. Never compare the Articles to the guarantor or borrower name.");
  lines.push("• BANK STATEMENTS / ACCOUNT OWNERSHIP: when a rubric checks the account holder, ANY name in the ACCEPTABLE ACCOUNT HOLDERS line of the user prompt satisfies it (the borrowing entity or any guarantor). The account must be 100% owned by those parties -- an additional holder who is not on that list (another person or another entity) fails the ownership condition. Only full bank-generated statements or a bank-generated Account Transaction History are acceptable; screenshots and photos of an online-banking page are not.");
  // Deploy 237.075 (Mike) -- guarantor legal names come from the ID; per-guarantor docs state
  // coverage; insurance carries the expected mortgagee; valuations flag a low AIV.
  lines.push("• GUARANTOR LEGAL NAMES: a guarantor's legal name is governed by their government ID (GUARANTOR LEGAL NAMES OF RECORD in the user prompt). The application, credit report, OFAC, background check, PFS, and entity documents must carry that name INCLUDING the middle name. A nickname ('Mike' for 'Michael'), a dropped middle name, or a different surname is a name discrepancy: flag it on the document that departs from the ID (on the loan application when the application used the nickname). If no ID has been reviewed yet, mark legal-name conditions unclear rather than failing them.");
  lines.push("• PER-GUARANTOR DOCUMENTS (ID, credit report, OFAC personal, background check, citizenship, PFS): the loan's guarantors are listed in GUARANTORS ON THIS LOAN. One document may cover one person - never fail it for covering only one guarantor; instead state in the summary exactly which guarantor(s) this document covers, so the underwriter can confirm every guarantor has one.");
  lines.push("• INSURANCE: the mortgagee clause must read the EXPECTED MORTGAGEE CLAUSE in the user prompt (ISAOA/ATIMA); a different lender name is a defect. Named insured is the borrowing entity of record or a guarantor. Report the policy number as policyNumber in extracted_entities.");
  lines.push("• VALUATIONS (BPO / appraisal): report asIsValue and afterRepairValue in extracted_entities, and flag when the as-is value is below the purchase price or below the loan amount.");
  lines.push("• A finding's `condition` field should paraphrase one of the explicit rubric conditions you actually checked — not a check you made up.");
  lines.push("• `verdict: 'approved'` requires every applicable rubric condition to be met. Issues elsewhere in the doc that aren't part of the rubric do NOT downgrade the verdict.");
  return lines.join('\n');
}

function buildPrompt(opts) {
  // Deploy 236.78 — replaced the LOAN CONTEXT text block with a
  // pointer to the attached Loan Application PDF for any
  // cross-reference. Also dropped from the rules the "mismatches
  // with the loan context" clause that was causing the model to
  // flag missing property address on documents (Articles of Org,
  // etc.) where the field doesn't normally appear.
  const ctx = opts.loanContext || {};
  const investor = opts.investor ? String(opts.investor).toUpperCase() : 'investor';
  // Keep a compact text snapshot of the key loan fields as a
  // FALLBACK for cases where the loan app PDF isn't attached
  // (stub-source reviews). When the PDF IS attached, prefer it.
  const ctxLines = [];
  if (ctx.loanAmount)    ctxLines.push('- Loan amount: $' + Number(ctx.loanAmount).toLocaleString());
  if (ctx.borrowerName)  ctxLines.push('- Borrower name: ' + ctx.borrowerName);
  if (ctx.entityName)    ctxLines.push('- Vesting Entity per the loan record (reference only — the recorded Articles govern the name): ' + ctx.entityName);
  if (ctx.address)       ctxLines.push('- Property address: ' + ctx.address);
  const hasLoanApp = !!(opts.loanAppBytes && opts.loanAppBytes.length);
  // Deploy 237.041 (Dan, via Mike) -- the recorded Articles of Organization are the
  // source of truth for the ENTITY NAME. The Articles tray's extracted llcName is
  // handed in as ctx.articlesEntityName; COGS / EIN / loan-application rubrics
  // compare against it (never the loan app). Always present -- even when the loan
  // application PDF is attached -- so 'matches the Articles' is actually checkable
  // (3528 Park: the EIN review said no Articles existed because none were handed in).
  const _articlesName = String(ctx.articlesEntityName || '').trim();
  // Deploy 237.074 (Mike) -- who may own a bank / payment account: the entity of record
  // (or the loan-record entity until the Articles are reviewed) and EVERY guarantor.
  const _holders = [];
  (_articlesName ? [_articlesName] : []).concat(ctx.entityName && !_articlesName ? [String(ctx.entityName).trim()] : [])
    .concat(Array.isArray(ctx.guarantorNames) ? ctx.guarantorNames : []).concat(ctx.borrowerName ? [String(ctx.borrowerName).trim()] : [])
    .forEach(function (n) { n = String(n || '').replace(/\s+/g, ' ').trim(); if (n && !_holders.some(function (h) { return h.toLowerCase() === n.toLowerCase(); })) _holders.push(n); });
  // Deploy 237.075 (Mike) -- guarantor roster, legal names per the IDs on file, expected mortgagee.
  const _q = function (h) { return '"' + String(h).replace(/"/g, '') + '"'; };
  const _gNames = (Array.isArray(ctx.guarantorNames) ? ctx.guarantorNames : []).filter(Boolean);
  const _guarantorsBlock = _gNames.length ? 'GUARANTORS ON THIS LOAN (' + _gNames.length + '): ' + _gNames.map(_q).join(', ') + '. A per-guarantor document must exist for every one of them.' : '';
  const _idNames = (Array.isArray(ctx.idNames) ? ctx.idNames : []).filter(Boolean);
  const _idBlock = _idNames.length
    ? 'GUARANTOR LEGAL NAMES OF RECORD (from the government IDs on file): ' + _idNames.map(_q).join(', ') + '. These govern each guarantor\'s legal name, including the middle name; nicknames on any other document are a discrepancy on that document.'
    : 'GUARANTOR LEGAL NAMES OF RECORD: no guarantor ID has been reviewed yet for this loan. For any "matches the ID" / legal-name condition, mark it unclear rather than failing it.';
  const _mortgageeBlock = ctx.mortgagee ? 'EXPECTED MORTGAGEE CLAUSE: ' + _q(ctx.mortgagee) + '.' : '';
  // Loan terms of record (from the loan snapshot) -- PSA / assignment / SOW / valuation rubrics compare to these.
  const _money = function (v) { var n = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(n) && n > 0 ? '$' + Math.round(n).toLocaleString('en-US') : ''; };
  const _terms = [];
  if (_money(ctx.loanAmount)) _terms.push('loan amount ' + _money(ctx.loanAmount));
  if (_money(ctx.purchasePrice)) _terms.push('purchase price ' + _money(ctx.purchasePrice) + ' (an assignment fee may be at most 15% of it: ' + _money(Number(String(ctx.purchasePrice).replace(/[^0-9.]/g, '')) * 0.15) + ')');
  if (_money(ctx.rehabBudget)) _terms.push('rehab budget per the term sheet ' + _money(ctx.rehabBudget));
  if (_money(ctx.arv)) _terms.push('ARV ' + _money(ctx.arv));
  if (ctx.fundingDate) _terms.push('expected close date ' + String(ctx.fundingDate).slice(0, 10));
  // Deploy 237.078 (Mike) -- spell out the RTL liquidity requirement so the bank-statement
  // review checks a NUMBER, not a formula it has to assemble from the snapshot.
  (function () {
    const n = function (v) { const x = Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')); return isFinite(x) ? x : 0; };
    const loan = n(ctx.loanAmount), pp = n(ctx.purchasePrice), rehab = n(ctx.rehabBudget);
    let rate = n(ctx.rate); if (rate > 1) rate = rate / 100;
    const isDscr = String(ctx.loanType || '').toLowerCase() === 'dscr';
    if (isDscr || !loan) return;
    const initial = (rehab && loan > rehab) ? loan - rehab : loan;
    const down = (pp && pp > initial) ? pp - initial : 0;
    const twenty = rehab * 0.2;
    const interest6 = rate ? loan * rate / 12 * 6 : 0;
    const total = down + twenty + interest6;
    if (!total) return;
    _terms.push('LIQUIDITY REQUIRED ' + _money(total) + ' = down payment ' + _money(down) + ' (purchase price minus the initial advance of ' + _money(initial) + ') + 20% of rehab ' + (_money(twenty) || '$0') + ' + 6 months interest ' + (_money(interest6) || '(rate unknown)'));
  })();
  const _termsBlock = _terms.length ? 'LOAN TERMS OF RECORD: ' + _terms.join('; ') + '.' : '';
  const _holdersBlock = _holders.length
    ? 'ACCEPTABLE ACCOUNT HOLDERS (any ONE of these names satisfies an account-holder / account-ownership condition; the account must be 100% owned by these parties): ' + _holders.map(function (h) { return '"' + h + '"'; }).join(', ') + '.'
    : '';
  const _articlesBlock = _articlesName
    ? 'ENTITY NAME OF RECORD (from the recorded Articles of Organization on file for this loan): "' + _articlesName + '". This — not the loan application — governs the borrowing entity name.'
    : 'ENTITY NAME OF RECORD: the Articles of Organization have NOT been reviewed yet for this loan, so no name of record is available. For any "matches the Articles" condition, mark it "unclear" and say the Articles are not yet reviewed. Do NOT say the Articles do not exist, and do NOT fail this document for a name that differs from the loan application.';

  // Deploy 236.500 — targeted field extraction (UW / Lightning auto-grab).
  // Builds an `extracted_fields` schema block from opts.extractFields so the
  // SAME review call also pulls the specific values this doc type holds.
  let _extractSchema = '';
  let _extractRule = '';
  if (Array.isArray(opts.extractFields) && opts.extractFields.length) {
    const fl = opts.extractFields.map(function (f) {
      return '    "' + f.key + '": {"value": <' + f.label + '>, "found": true|false, "where": "<short locator, or null>"}';
    }).join(',\n');
    _extractSchema = '  "extracted_fields": {\n' + fl + '\n  }';
    // Deploy 237.233 (Mike: "keep the subtext to very simple 1 or 2 lines and avoid the
    // paragraphs") -- "where" is printed verbatim under the number on the Key Metrics
    // panel, and it had started coming back as the whole derivation: every title line
    // item on a HUD added up, plus a caveat about the owner's policy. It is a locator.
    // Anything a human should double-check belongs in the findings, which the page
    // already surfaces as its own ⚠ marker.
    _extractRule = '- extracted_fields: pull EACH listed field ONLY if it literally appears on THIS document. Set found:false and value:null when it is absent — NEVER guess or infer. Numbers as plain numbers (no $, no commas). Dates as YYYY-MM-DD. "where" is a SHORT locator — page and section, under 60 characters, e.g. "Page 2, Title Charges section". Never put arithmetic, a list of line items, or a caveat in "where"; if the value needed judgement or something about it should be double-checked, say so in the findings instead.';
  }

  // Deploy 236.669 — document-integrity / tampering assessment (advisory). Only
  // requested for financial docs + IDs. Adds an "integrity" object to the schema
  // and a set of conservative, evidence-first instructions.
  let _integritySchema = '';
  let _integrityRule = '';
  if (opts.integrityCheck) {
    _integritySchema = '  "integrity": {\n' +
      '    "risk": "low" | "medium" | "high",\n' +
      '    "findings": [ { "level": "medium" | "high", "detail": "<specific, pointable evidence of possible alteration>" } ]\n' +
      '  }';
    _integrityRule = [
      '',
      'DOCUMENT INTEGRITY / TAMPERING CHECK (advisory — a human makes the final call; report in the "integrity" object):',
      'Separately from the rubric, assess whether THIS document shows signs of alteration or forgery.',
      (opts.docCategory === 'financial'
        ? '- FINANCIAL doc — RECONCILE THE MATH: do the listed transactions add up to the stated balances? Does (beginning balance +/- the activity) equal the ending balance? Do subtotals/totals match their line items? Arithmetic that does NOT reconcile is a HIGH-risk sign of editing. Also confirm dates are sequential and the statement period is internally consistent.'
        : '- ID doc — check name / DOB / ID numbers are internally consistent, the layout matches a genuine issuer template, and there are no obvious signs of a pasted photo or altered fields.'),
      '- Look for VISUAL signs of editing: a figure/word in a different font, weight, size, alignment, or color than the text around it; misaligned rows; halos/smudges around specific numbers; inconsistent decimal alignment.',
      '- Be CONSERVATIVE and concrete. Raise medium/high ONLY with specific evidence you can point to (e.g. "ending balance shown as $12,431 but transactions sum to $9,204"). If nothing is off, return risk:"low" with an empty findings array. Do NOT guess "AI-generated" from vibes.',
    ].join('\n');
  }

  return [
    'You are reviewing a loan document for SLA Capital.',
    '',
    // Deploy 236.971 — real review date, restated here where the rubric
    // lives so "within the last N days" checks compute against it.
    "TODAY'S DATE: " + new Date().toISOString().slice(0, 10),
    "Every \"within the last N days\" / freshness / expiration condition is measured against TODAY'S DATE above. A document is future-dated ONLY if its date is after that date. Do not assume the current date from training data.",
    '',
    'DOCUMENT TYPE: ' + (opts.docLabel || '(unspecified)'),
    'INVESTOR: ' + investor,
    '',
    'REQUIRED CONDITIONS for approval (per-doc rubric):',
    opts.docConditions || '(no conditions specified)',
    '',
    _articlesBlock,
    _holdersBlock,
    _guarantorsBlock,
    _idBlock,
    _mortgageeBlock,
    _termsBlock,
    '',
    hasLoanApp
      ? 'CROSS-REFERENCE: when the rubric says "match X to the loan application" or similar, look it up directly in the attached Loan Application PDF. That PDF is the source of truth for borrower name, property address, and loan amount — but NOT the entity / LLC name, which is governed by the ENTITY NAME OF RECORD above (from the Articles).'
      : (ctxLines.length
          ? 'LOAN APPLICATION NOT ATTACHED — fall back to this text snapshot for cross-references:\n' + ctxLines.join('\n')
          : 'LOAN APPLICATION NOT ATTACHED — limit your review to the per-doc rubric.'),
    '',
    'Reminders:',
    '- Only flag findings that come from the per-doc rubric above. Do not invent extra checks.',
    '- This document is "' + (opts.docLabel || 'unknown') + '" — it may not contain every loan field. That is normal. Do not flag missing property address / missing loan amount unless the rubric for THIS document explicitly says to verify it.',
    '',
    'Respond ONLY with valid JSON in this exact schema (no markdown, no commentary):',
    '{',
    '  "verdict": "approved" | "issues",',
    '  "summary": "<one-sentence overall conclusion>",',
    '  "findings": [',
    '    {',
    '      "condition": "<paraphrase of one rubric condition you actually checked>",',
    '      "status":    "met" | "not_met" | "unclear",',
    '      "detail":    "<what you found in the doc, with page or section reference if possible>"',
    '    }',
    '  ],',
    '  "extracted_entities": {',
    '    "llcName":         "<entity / LLC name on this doc, or null>",',
    '    "borrowerName":    "<personal borrower name on this doc, or null>",',
    // Deploy 237.075 -- insurance policy number + valuation values ride the same extraction.
    '    "policyNumber":    "<insurance policy number on this doc, or null>",',
    '    "asIsValue":       <as-is / current value concluded on this valuation doc as a number, or null>,',
    '    "afterRepairValue": <after-repair value on this valuation doc as a number, or null>,',
    '    "buyerName":       "<buyer / assignee named on a purchase contract or assignment, or null>",',
    '    "sellerName":      "<seller / assignor named on a purchase contract or assignment, or null>",',
    '    "contractPrice":   <contract / purchase price on a purchase contract or assignment as a number, or null>,',
    '    "assignmentFee":   <assignment fee on an assignment agreement as a number, or null>,',
    '    "closingDate":     "<YYYY-MM-DD closing date on a purchase contract or assignment, or null>",',
    '    "propertyAddress": "<full property address on this doc, or null>",',
    '    "loanAmount":      <numeric loan amount on this doc, or null>,',
    // Deploy 236.165 — expiration extraction. Two date fields:
    //   documentDate  — the date the doc was printed / issued /
    //                   covers (e.g. statement date on a bank
    //                   statement, print date on a Certificate of
    //                   Good Standing). Used by the frontend to
    //                   compute a per-doc-type "stale by" date.
    //   expirationDate — an explicit expiration printed on the doc
    //                   (insurance, drivers license, passport).
    //                   Use null if no explicit date appears.
    // Both should be ISO YYYY-MM-DD. The frontend will show them
    // on the tray and warn when stale / expired.
    '    "documentDate":    "<YYYY-MM-DD of the doc\'s print / statement / issue date, or null>",',
    '    "expirationDate":  "<YYYY-MM-DD of an explicit expiration printed on the doc, or null>",',
    '    "dateNotes":       "<one-line explanation of where you found the date(s), or null>"',
    '  }' + ((_extractSchema || _integritySchema) ? ',' : ''),
    _extractSchema ? (_extractSchema + (_integritySchema ? ',' : '')) : '',
    _integritySchema,
    '}',
    '',
    'Verdict rules:',
    '- "approved" only when every applicable rubric condition is fully met.',
    '- If a rubric condition is "not_met" with material concern, verdict MUST be "issues".',
    '- Extracted entities are used downstream to cross-check consistency. Use null if the field is not naturally present on this doc — that is normal and not an issue on its own.',
    '- For documentDate / expirationDate: only fill these in if the date is LITERALLY visible on the doc. Do not infer. Bank statements have a statement period (use the statement end date). Certificates of Good Standing typically have a "printed on" or "as of" date. Insurance / drivers licenses / passports have explicit expirations. If you cannot see a date, return null — that is not a finding by itself.',
    _extractRule,
    _integrityRule,
    // Deploy 237.221 -- the LAST line, on purpose. "Respond ONLY with valid JSON" is
    // already said twice above and the model still opened 4.7% of answers with a paragraph
    // of analysis. (Assistant prefill would force it, but current models reject prefill
    // with a 400, so it is not an option.)
    '',
    'Your ENTIRE reply must be that one JSON object. The first character you write must be { and the last must be }. Do all of your checking silently: no analysis, reasoning, preamble or explanation before or after the JSON.',
  ].join('\n');
}

export function extractJson(text) {
  if (!text) return null;
  // Strip markdown code fences if present.
  let t = String(text).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Try direct parse first.
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  // Deploy 237.221 -- was one greedy regex, first "{" to LAST "}", which is wrong the
  // moment the prose around the answer contains a brace of its own ("the {entity} name...")
  // or the model appends a note after the object. Walk the text instead: every balanced
  // top-level {...} (strings and escapes respected) is a candidate, and the verdict is
  // the first one that parses AND looks like a verdict.
  const candidates = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { if (depth > 0) inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth++; }
    else if (c === '}' && depth > 0) {
      depth--;
      if (depth === 0 && start >= 0) { candidates.push(t.slice(start, i + 1)); start = -1; }
    }
  }
  let firstObject = null;
  for (const cand of candidates) {
    let obj = null;
    try { obj = JSON.parse(cand); } catch (e) { continue; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) continue;
    if ('verdict' in obj || 'findings' in obj) return obj;
    if (!firstObject) firstObject = obj;
  }
  return firstObject;
}

function normalizeFinding(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    condition: String(f.condition || ''),
    status:    f.status === 'met' || f.status === 'not_met' ? f.status : 'unclear',
    detail:    String(f.detail || ''),
  };
}
