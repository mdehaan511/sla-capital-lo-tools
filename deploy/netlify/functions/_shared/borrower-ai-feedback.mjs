/**
 * _shared/borrower-ai-feedback.mjs — Deploy 237.183 (Mike)
 *
 * "On this loan the borrower is trying to upload docs and getting errors about the AI
 * Review in the borrower portal. Any AI errors shouldnt be appearing in the borrower
 * portal."
 *
 * Showing the AI to borrowers was ALREADY switched off — `BORROWER_AI_FEEDBACK = false`
 * has lived in borrower-intake-upload.mjs since that flow shipped, and that endpoint
 * honours it: the upload receipt is the neutral "Received — submitted for review."
 *
 * borrower-intake-status.mjs never got the memo. It builds the card the borrower sees on
 * every page LOAD straight from `aiVerdict` / `aiNotes`, so the neutral receipt was
 * replaced by raw reviewer output the moment the page refreshed. That is how Mike's
 * borrower ended up reading "AI review timed out after 22s. Upload a corrected version"
 * about a document with nothing wrong with it — and, worse, a paragraph analysing a
 * guarantor's citizenship status.
 *
 * So the switch lives HERE, in one place both endpoints import, because a policy about
 * what borrowers may see cannot be a per-file constant that one file forgets.
 *
 * WHILE THIS IS false:
 *   - no AI verdict, note, finding or error reaches a borrower, ever;
 *   - an uploaded document reads "Received — a processor will review it";
 *   - a HUMAN flag still reaches them (verdict 'issues' + flagReason) — that is a person
 *     writing to a borrower, which is the whole point of that field.
 *
 * Turning it on is not just flipping this: an AI summary is written for a processor, and
 * would need a borrower-safe rewrite first (the citizenship paragraph is the argument).
 */
export const BORROWER_AI_FEEDBACK = false;

/** Text a borrower sees for a document that is in but not yet human-reviewed. */
export const BORROWER_RECEIVED_MSG = 'Received — a processor will review it.';

/**
 * Is this tray state an AI FAILURE rather than a finding about the document?
 * A timeout or a fetch failure says nothing about the borrower's file, so it must never
 * read as "needs fix" to anybody — not to the borrower, and not to the processor either.
 */
export function isAiFailure(d) {
  const err = String((d && d.aiError) || '');
  if (err && err !== 'none') return true;
  // Older trays stored the failure only in the summary text.
  return /^(AI review timed out|AI request failed)/i.test(String((d && d.aiNotes) || ''));
}
