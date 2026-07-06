/**
 * loan-review-zip-classify.mjs — POST /api/loan-review-zip-classify
 *
 * Deploy 236.208 — bulk zip upload for Doc Review. Client extracts
 * the zip in-browser, sends us the file names, we return which slug
 * (if any) each maps to. Confident mappings feed the existing
 * per-doc upload flow; unclear ones surface in a modal for the
 * processor to resolve.
 *
 * Body:
 *   {
 *     reviewId: string,          // review we're bulk-uploading into
 *     filenames: string[],       // names extracted from the zip
 *   }
 *
 * Response:
 *   {
 *     ok: true,
 *     assignments: [
 *       { filename, slug, confidence: 'high' | 'low' | 'unknown', reason? }
 *     ]
 *   }
 *
 * confidence:
 *   'high'    — safe to auto-upload without confirming
 *   'low'     — a plausible slug but processor should confirm
 *   'unknown' — no confident match; processor must pick or skip
 *
 * Auth: processor or admin.
 */
import { getStore } from '@netlify/blobs';
import {
  handleOptions, json, requireAuth, isProcessor, readJsonBody, keySafe,
} from './_shared/auth.mjs';
import { getChecklist } from './_shared/loan-review-checklists.mjs';

const MAX_FILES = 60;

export default async (req, context) => {
  try { return await handle(req, context); }
  catch (e) {
    console.error('loan-review-zip-classify error:', e);
    return json(500, { error: 'Server error: ' + ((e && e.message) || 'unknown') });
  }
};

async function handle(req, context) {
  const pre = handleOptions(req); if (pre) return pre;
  if (req.method !== 'POST') return json(405, { error: 'Method not allowed' });

  const user = requireAuth(context, req);
  if (!user) return json(401, { error: 'Not authenticated' });
  if (!isProcessor(user)) return json(403, { error: 'Processor or admin role required' });

  const body = (await readJsonBody(req)) || {};
  if (!body.reviewId) return json(400, { error: 'reviewId required' });
  if (!Array.isArray(body.filenames) || !body.filenames.length) {
    return json(400, { error: 'filenames array required' });
  }
  if (body.filenames.length > MAX_FILES) {
    return json(413, { error: 'Too many files; max is ' + MAX_FILES });
  }

  // Load the review so we know which checklist (DSCR vs RTL) to
  // classify against. Also we already know which slugs already have
  // uploaded docs, so a marginal filename match against a filled tray
  // is a strong signal for the "Replace" path — but that's the UI's
  // problem, not ours; we still map to the slug.
  const reviewStore = getStore({ name: 'loan_reviews', consistency: 'strong' });
  const review = await reviewStore.get(keySafe(body.reviewId), { type: 'json' });
  if (!review) return json(404, { error: 'Review not found' });

  const loanType = String(review.loanType || 'dscr').toLowerCase();
  const checklist = getChecklist(loanType);
  const slugs = checklist.map((d) => ({ slug: d.slug, label: d.label, hint: d.conditions || '' }));

  // Filename-only heuristic pass. Cheap and catches the obvious
  // "articles_of_organization.pdf" / "Appraisal.pdf" / "PSA.pdf"
  // cases before we spend a Claude call. Whatever the heuristic
  // marks 'high' skips the LLM; the rest go to Claude Haiku.
  const heuristicMatches = new Map(); // filename → { slug, confidence }
  for (const raw of body.filenames) {
    const fn = String(raw || '');
    const norm = _normFilename(fn);
    if (!norm) continue;
    const hit = _heuristic(norm, slugs);
    if (hit) heuristicMatches.set(fn, hit);
  }

  const needsClaude = body.filenames.filter((fn) => !heuristicMatches.has(fn));
  let claudeAssignments = new Map();
  if (needsClaude.length) {
    try {
      claudeAssignments = await _classifyWithClaude(needsClaude, slugs);
    } catch (e) {
      console.warn('classify: Claude call failed, falling back to unknown:', e && e.message);
    }
  }

  const assignments = body.filenames.map((fn) => {
    const heur = heuristicMatches.get(fn);
    if (heur) return { filename: fn, slug: heur.slug, confidence: heur.confidence, reason: heur.reason || '' };
    const claude = claudeAssignments.get(fn);
    if (claude) return { filename: fn, slug: claude.slug || null, confidence: claude.confidence || 'unknown', reason: claude.reason || '' };
    return { filename: fn, slug: null, confidence: 'unknown', reason: 'No match' };
  });

  return json(200, { ok: true, loanType, assignments });
}

// ─── Heuristic classifier ─────────────────────────────────────
// Normalize a filename to a comparable token stream.
function _normFilename(fn) {
  return String(fn || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]{1,5}$/, '')       // strip extension
    .replace(/[^a-z0-9]+/g, ' ')            // any non-alnum → space
    .trim();
}
// Very cheap slug guess: if the filename contains most tokens of a
// slug's label OR its slug identifier, mark 'high' confidence.
function _heuristic(normFilename, slugs) {
  let bestScore = 0;
  let bestSlug = null;
  const fnTokens = new Set(normFilename.split(/\s+/).filter(Boolean));
  for (const s of slugs) {
    const labelTokens = new Set(_normFilename(s.label).split(/\s+/).filter((t) => t.length > 2));
    const slugTokens  = new Set(s.slug.replace(/_/g, ' ').split(/\s+/).filter((t) => t.length > 2));
    const targets = new Set([...labelTokens, ...slugTokens]);
    if (!targets.size) continue;
    let hits = 0;
    for (const t of targets) if (fnTokens.has(t)) hits++;
    const score = hits / targets.size;
    if (score > bestScore) { bestScore = score; bestSlug = s.slug; }
  }
  if (bestScore >= 0.6) return { slug: bestSlug, confidence: 'high', reason: 'filename tokens match label' };
  return null; // let Claude decide
}

// ─── Claude Haiku classifier ──────────────────────────────────
async function _classifyWithClaude(filenames, slugs) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY not configured');

  const checklistLines = slugs.map((s, i) => `${i + 1}. ${s.slug} — "${s.label}"${s.hint ? ' — ' + s.hint : ''}`).join('\n');
  const filenameLines  = filenames.map((f, i) => `${i + 1}. ${f}`).join('\n');

  const system =
    "You classify loan-document filenames into a fixed checklist. " +
    "For each filename, pick the single best slug from the checklist, or return null if unclear. " +
    "Base your decision on the filename ONLY — you cannot see the file contents. " +
    "Return strictly JSON matching the schema: " +
    '{"assignments":[{"filename":"...","slug":"..."|null,"confidence":"high"|"low"|"unknown","reason":"..."}]}. ' +
    "Use 'high' when the filename clearly names the doc (\"appraisal.pdf\", \"psa - 123 main.pdf\"). " +
    "Use 'low' when it's a plausible guess but ambiguous. Use 'unknown' with slug:null when nothing fits.";

  const userMsg =
    'CHECKLIST:\n' + checklistLines + '\n\n' +
    'FILENAMES:\n' + filenameLines + '\n\n' +
    'Return only the JSON object described in the system prompt. No prose.';

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      system,
      messages: [{ role: 'user', content: userMsg }],
    }),
  });
  const raw = await resp.text().catch(() => '');
  if (!resp.ok) throw new Error('Claude ' + resp.status + ': ' + raw.slice(0, 200));
  let body; try { body = JSON.parse(raw); } catch (_) { throw new Error('Claude returned non-JSON'); }
  const text = (body && body.content && body.content[0] && body.content[0].text) || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude output had no JSON object');
  let parsed; try { parsed = JSON.parse(jsonMatch[0]); } catch (_) { throw new Error('Claude JSON was invalid'); }
  const out = new Map();
  const validSlugs = new Set(slugs.map((s) => s.slug));
  for (const a of (parsed.assignments || [])) {
    if (!a || !a.filename) continue;
    const slug = a.slug && validSlugs.has(a.slug) ? a.slug : null;
    out.set(a.filename, {
      slug,
      confidence: ['high', 'low', 'unknown'].indexOf(a.confidence) >= 0 ? a.confidence : (slug ? 'low' : 'unknown'),
      reason: String(a.reason || '').slice(0, 200),
    });
  }
  return out;
}
