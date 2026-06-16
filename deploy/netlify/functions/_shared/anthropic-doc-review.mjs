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
const MODEL = 'claude-sonnet-4-6';
const MAX_OUTPUT_TOKENS = 2048;
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

  // Deploy 236.77 — investor guidelines PDF attached as a cached
  // content block when present. The cache_control marker tells
  // Anthropic to keep this block in its prompt cache (~5 min TTL)
  // so subsequent reviews on the same loan pay ~10% of normal
  // input cost for the guidelines portion. The order matters: the
  // guidelines doc goes FIRST so it appears before the doc being
  // reviewed (cache_control breakpoints are positional).
  const content = [];
  if (opts.guidelinesBytes && opts.guidelinesBytes.length) {
    content.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: opts.guidelinesBytes.toString('base64') },
      cache_control: { type: 'ephemeral' },
    });
  }
  content.push({ type: 'document', source: { type: 'base64', media_type: opts.mimeType || 'application/pdf', data: b64 } });
  content.push({ type: 'text', text: userPrompt });

  // Claude API call. 22s timeout — Netlify Pro caps at 26s and we
  // need headroom for the response post-processing + blob write.
  const controller = new AbortController();
  const timeoutId = setTimeout(function () { controller.abort(); }, 22000);

  let resp;
  try {
    resp = await fetch('https://api.anthropic.com/v1/messages', {
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
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e.name === 'AbortError' ? 'AI review timed out after 22s' : ('AI request failed: ' + (e.message || 'unknown'));
    console.error('reviewDocument fetch error:', msg);
    return {
      verdict: 'issues',
      summary: msg,
      findings: [], extractedEntities: {},
      inputTokens: 0, outputTokens: 0, costCents: 0,
      error: 'fetch_failed',
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
  const usage = data.usage || {};
  const inputTokens          = Number(usage.input_tokens             || 0);
  const cacheWriteTokens     = Number(usage.cache_creation_input_tokens || 0);
  const cacheReadTokens      = Number(usage.cache_read_input_tokens     || 0);
  const outputTokens         = Number(usage.output_tokens             || 0);
  // Deploy 236.77 — cache-aware cost. Anthropic reports input_tokens
  // for the uncached portion; cache_creation_input_tokens for cache
  // writes (1.25x); cache_read_input_tokens for cache hits (0.10x).
  const costCents =
      inputTokens      * INPUT_CENTS_PER_TOKEN
    + cacheWriteTokens * CACHE_WRITE_CENTS_PER_TOKEN
    + cacheReadTokens  * CACHE_READ_CENTS_PER_TOKEN
    + outputTokens     * OUTPUT_CENTS_PER_TOKEN;

  // Parse the model's JSON. The system prompt asks for clean JSON
  // but defensively strip markdown fences and pull the first
  // JSON object out if there's surrounding chatter.
  const parsed = extractJson(rawText);
  if (!parsed) {
    return {
      verdict: 'issues',
      summary: 'AI returned malformed verdict. Raw: ' + rawText.slice(0, 200),
      findings: [], extractedEntities: {},
      inputTokens, outputTokens, costCents,
      error: 'malformed_verdict',
    };
  }

  const verdict = parsed.verdict === 'approved' ? 'approved' : 'issues';
  return {
    verdict,
    summary: String(parsed.summary || ''),
    findings: Array.isArray(parsed.findings) ? parsed.findings.map(normalizeFinding).filter(Boolean) : [],
    extractedEntities: (parsed.extracted_entities && typeof parsed.extracted_entities === 'object') ? parsed.extracted_entities : {},
    inputTokens, outputTokens, costCents,
  };
}

function buildSystemPrompt(opts) {
  // Deploy 236.77 — system prompt notes whether investor guidelines
  // are attached so the model knows to consult them.
  const base =
    "You are an expert loan-document underwriter at SLA Capital. " +
    "Given a document and a list of conditions it must meet, you read the document carefully and decide whether each condition is met. " +
    "You always respond with valid JSON matching the schema the user provides — no commentary, no markdown code fences, just the JSON object.";
  if (opts.guidelinesBytes && opts.guidelinesBytes.length) {
    return base +
      " The user message will include TWO documents: (1) the investor's underwriting guidelines PDF (treat as authoritative reference — the document being reviewed must comply with these), and (2) the specific loan document being reviewed. " +
      "Cross-check the doc against BOTH the per-doc conditions listed in the prompt AND the relevant sections of the investor guidelines.";
  }
  return base;
}

function buildPrompt(opts) {
  const ctx = opts.loanContext || {};
  const ctxLines = [];
  if (ctx.loanAmount)       ctxLines.push('- Loan amount: $' + Number(ctx.loanAmount).toLocaleString());
  if (ctx.borrowerName)     ctxLines.push('- Borrower name: ' + ctx.borrowerName);
  if (ctx.entityName)       ctxLines.push('- Borrowing entity / LLC: ' + ctx.entityName);
  if (ctx.address)          ctxLines.push('- Property address: ' + ctx.address);
  if (ctx.borrowerEmail)    ctxLines.push('- Borrower email: ' + ctx.borrowerEmail);
  const investor = opts.investor ? String(opts.investor).toUpperCase() : 'investor';

  return [
    'You are reviewing a loan document for SLA Capital.',
    '',
    'DOCUMENT TYPE: ' + (opts.docLabel || '(unspecified)'),
    'INVESTOR: ' + investor,
    (opts.guidelinesBytes && opts.guidelinesBytes.length)
      ? '(The investor\'s underwriting guidelines PDF is attached as the FIRST document. The doc being reviewed is the SECOND document.)'
      : '',
    '',
    'REQUIRED CONDITIONS for approval (per-doc rubric):',
    opts.docConditions || '(no conditions specified)',
    '',
    ctxLines.length
      ? 'LOAN CONTEXT (the document must match these where applicable):\n' + ctxLines.join('\n')
      : 'LOAN CONTEXT: not provided.',
    '',
    'Carefully read the document and assess whether it meets every required condition.',
    (opts.guidelinesBytes && opts.guidelinesBytes.length)
      ? 'Also cross-check against the investor guidelines PDF — flag any guideline violations as additional findings.'
      : '',
    '',
    'Respond ONLY with valid JSON in this exact schema (no markdown, no commentary):',
    '{',
    '  "verdict": "approved" | "issues",',
    '  "summary": "<one-sentence overall conclusion>",',
    '  "findings": [',
    '    {',
    '      "condition": "<the specific condition you checked, paraphrased>",',
    '      "status":    "met" | "not_met" | "unclear",',
    '      "detail":    "<what you found in the doc, with page or section reference if possible>"',
    '    }',
    '  ],',
    '  "extracted_entities": {',
    '    "llcName":         "<entity / LLC name on this doc, or null>",',
    '    "borrowerName":    "<personal borrower name on this doc, or null>",',
    '    "propertyAddress": "<full property address on this doc, or null>",',
    '    "loanAmount":      <numeric loan amount on this doc, or null>',
    '  }',
    '}',
    '',
    'Rules:',
    '- "verdict" MUST be "approved" only when every required condition is fully met.',
    '- If ANY condition is "not_met" or "unclear" with material concern, verdict MUST be "issues".',
    '- For mismatches with the loan context (e.g. LLC name on doc does not match the entity above), include a finding with status "not_met" and the mismatch in the detail.',
    '- Extracted entities are used downstream to cross-check consistency across documents. Be precise — strings exactly as written.',
  ].join('\n');
}

function extractJson(text) {
  if (!text) return null;
  // Strip markdown code fences if present.
  let t = String(text).trim();
  if (t.startsWith('```')) {
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  }
  // Try direct parse first.
  try { return JSON.parse(t); } catch (e) { /* fall through */ }
  // Pull the first {...} block.
  const m = t.match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch (e) { /* fall through */ }
  }
  return null;
}

function normalizeFinding(f) {
  if (!f || typeof f !== 'object') return null;
  return {
    condition: String(f.condition || ''),
    status:    f.status === 'met' || f.status === 'not_met' ? f.status : 'unclear',
    detail:    String(f.detail || ''),
  };
}
