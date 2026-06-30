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
  if (opts.guidelinesBytes && opts.guidelinesBytes.length) {
    const block = {
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: opts.guidelinesBytes.toString('base64') },
    };
    // Only mark this as the cache breakpoint if there's no loan app
    // to take that role.
    if (!opts.loanAppBytes || !opts.loanAppBytes.length) {
      block.cache_control = { type: 'ephemeral' };
    }
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
  // Deploy 236.78 — system prompt now lists ALL attached docs so the
  // model knows what's available for cross-reference. Also tightened
  // to stop the model from inventing checks (property address on an
  // entity doc, etc.) that aren't in the per-doc rubric.
  const lines = [
    "You are an expert loan-document underwriter at SLA Capital.",
    "Given a specific loan document and the conditions it must meet, you read it carefully and decide whether each condition is met.",
    "You always respond with valid JSON matching the schema the user provides — no commentary, no markdown code fences, just the JSON object.",
    "",
    "Documents attached in the user message (in order):",
  ];
  let idx = 1;
  if (opts.guidelinesBytes && opts.guidelinesBytes.length) {
    lines.push(`  ${idx}. INVESTOR UNDERWRITING GUIDELINES PDF — authoritative reference for what the investor requires. Cross-check the doc being reviewed against the relevant sections (entity / borrower / appraisal / title / insurance / etc.).`);
    idx += 1;
  }
  if (opts.loanAppBytes && opts.loanAppBytes.length) {
    lines.push(`  ${idx}. LOAN APPLICATION PDF (SLA's signed loan application for this loan) — source of truth for borrower name, LLC / entity name, property address, loan amount, and other application-level fields. When the per-doc rubric says "match X to the loan application", you MUST cross-reference the loan application PDF directly rather than guessing or claiming the data is unavailable.`);
    idx += 1;
  }
  lines.push(`  ${idx}. THE DOCUMENT BEING REVIEWED — the focus of your review. The conditions in the user prompt apply to THIS document.`);
  lines.push('');
  lines.push("CRITICAL RULES — these prevent the most common AI verdict mistakes:");
  lines.push("• ONLY evaluate the conditions listed in the per-doc rubric. Do NOT invent additional checks.");
  lines.push("• Many borrower/entity/guarantor documents (Articles of Organization, OFAC reports, ID, credit reports, etc.) do NOT contain the property address or loan amount — that's normal. Do NOT flag missing property address or missing loan amount as an issue UNLESS the per-doc rubric explicitly says to verify it.");
  lines.push("• When the rubric says 'matches loan application' or 'matches the loan' — LOOK in the attached Loan Application PDF. Do not claim the data is unavailable when the PDF is right there.");
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
  if (ctx.entityName)    ctxLines.push('- Borrowing entity / LLC: ' + ctx.entityName);
  if (ctx.address)       ctxLines.push('- Property address: ' + ctx.address);
  const hasLoanApp = !!(opts.loanAppBytes && opts.loanAppBytes.length);

  return [
    'You are reviewing a loan document for SLA Capital.',
    '',
    'DOCUMENT TYPE: ' + (opts.docLabel || '(unspecified)'),
    'INVESTOR: ' + investor,
    '',
    'REQUIRED CONDITIONS for approval (per-doc rubric):',
    opts.docConditions || '(no conditions specified)',
    '',
    hasLoanApp
      ? 'CROSS-REFERENCE: when the rubric says "match X to the loan application" or similar, look it up directly in the attached Loan Application PDF. That PDF is the source of truth for borrower name, entity / LLC name, property address, and loan amount.'
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
    '  }',
    '}',
    '',
    'Verdict rules:',
    '- "approved" only when every applicable rubric condition is fully met.',
    '- If a rubric condition is "not_met" with material concern, verdict MUST be "issues".',
    '- Extracted entities are used downstream to cross-check consistency. Use null if the field is not naturally present on this doc — that is normal and not an issue on its own.',
    '- For documentDate / expirationDate: only fill these in if the date is LITERALLY visible on the doc. Do not infer. Bank statements have a statement period (use the statement end date). Certificates of Good Standing typically have a "printed on" or "as of" date. Insurance / drivers licenses / passports have explicit expirations. If you cannot see a date, return null — that is not a finding by itself.',
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
