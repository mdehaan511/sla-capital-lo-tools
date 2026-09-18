#!/usr/bin/env node
/**
 * scripts/borrower-ai-silence-test.mjs — Deploy 237.182
 *
 * Mike: "the borrower is trying to upload docs and getting errors about the AI Review in
 * the borrower portal. Any AI errors shouldnt be appearing in the borrower portal."
 *
 * The switch was ALREADY off. `BORROWER_AI_FEEDBACK = false` had lived in
 * borrower-intake-upload.mjs the whole time and that endpoint honoured it — the upload
 * receipt was the neutral "Received". borrower-intake-status.mjs, which builds the card
 * on every page LOAD, read `aiVerdict` / `aiNotes` straight from the tray, so the neutral
 * receipt was replaced by the reviewer's own words on the next refresh.
 *
 * That is why this gate exists rather than a code comment: the rule was already written
 * down and still broke, because it lived in the wrong file and nothing checked it. These
 * checks lift the real _itemState out of the status endpoint and put the actual text Mike
 * was sent through it.
 *
 * Run: node scripts/borrower-ai-silence-test.mjs
 */
import fs from 'node:fs';
import vm from 'node:vm';
import {
  BORROWER_AI_FEEDBACK, BORROWER_RECEIVED_MSG, isAiFailure,
} from '../deploy/netlify/functions/_shared/borrower-ai-feedback.mjs';

const src = fs.readFileSync(new URL('../deploy/netlify/functions/borrower-intake-status.mjs', import.meta.url), 'utf8');
const a = src.indexOf('function _itemState(d) {');
const b = src.indexOf('\n}', a);
if (a < 0 || b < 0) throw new Error('marker missing: function _itemState');
const ctx = { Array, String, Number, Boolean, BORROWER_AI_FEEDBACK, BORROWER_RECEIVED_MSG, isAiFailure };
vm.createContext(ctx);
vm.runInContext(src.slice(a, b + 2), ctx);
const state = (d) => vm.runInContext('_itemState(' + JSON.stringify(d) + ')', ctx);

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + String(why).slice(0, 260) : ''));
};

console.log('\nThe switch');
check('borrower-facing AI feedback is OFF', BORROWER_AI_FEEDBACK, false);

// The two cards from Mike's screenshots, verbatim.
const TIMEOUT = { currentDocId: 'd1', aiVerdict: 'issues', aiError: 'timeout',
  aiNotes: 'AI review timed out after 22s' };
const CITIZENSHIP = { currentDocId: 'd1', aiVerdict: 'issues', aiNotes:
  "The ID belongs to Nehemias Jose Lopez Hiciano (Guarantor 1) and is unexpired, but (1) the loan " +
  "application uses the name 'Nehemias Lopez' ... (2) the guarantor answered 'No' to U.S. Citizenship " +
  "on the application, but no green card or visa/passport has been submitted as required for a non-citizen.",
  aiFindings: [{ status: 'not_met', detail: 'No green card or visa submitted' }] };

console.log('\nWhat Mike\'s borrower was actually shown');
const t = state(TIMEOUT);
check('a timed-out review is NOT the borrower\'s problem to fix',
  [t.status, t.message], ['submitted', BORROWER_RECEIVED_MSG]);
assert('...and the words "timed out" never reach them', t.message.indexOf('timed out') < 0, t.message);
assert('...nor are they told to upload a corrected version',
  t.message.indexOf('corrected version') < 0, t.message);

const c = state(CITIZENSHIP);
check('a real AI finding still does not speak to the borrower',
  [c.status, c.message, c.findings], ['submitted', BORROWER_RECEIVED_MSG, []]);
assert('...no citizenship analysis', !/citizen|green card|visa/i.test(c.message), c.message);
assert('...no guarantor name from the reviewer\'s notes', c.message.indexOf('Nehemias') < 0, c.message);

console.log('\nA failure is recognised however it was stored');
check('by the aiError field', [isAiFailure({ aiError: 'timeout' }), isAiFailure({ aiError: 'fetch_failed' })], [true, true]);
check('and on older trays, by the summary text it left behind',
  [isAiFailure({ aiNotes: 'AI review timed out after 22s' }), isAiFailure({ aiNotes: 'AI request failed: socket hang up' })],
  [true, true]);
check('a genuine finding is NOT a failure',
  [isAiFailure({ aiNotes: 'The Articles are an Oklahoma LLC...' }), isAiFailure({}), isAiFailure(null)],
  [false, false, false]);

console.log('\nWhat a borrower SHOULD still see');
check('a human flag reaches them, in the human\'s words',
  state({ currentDocId: 'd1', verdict: 'issues', flagReason: 'The back of the ID is cut off' }),
  { status: 'needs_fix', accepted: false, uploaded: true, uploadedCount: 1,
    message: 'Your loan team flagged an issue: The back of the ID is cut off. Please upload a corrected version.',
    findings: [] });
check('...and a reason that already ends in punctuation is not double-stopped',
  state({ currentDocId: 'd1', verdict: 'issues', flagReason: 'Wrong page?' }).message,
  'Your loan team flagged an issue: Wrong page? Please upload a corrected version.');
check('an accepted document says so', state({ currentDocId: 'd1', verdict: 'approved' }).status, 'accepted');
check('a requested manual review says so', state({ currentDocId: 'd1', manualReviewRequested: true }).status, 'manual_review');
check('nothing uploaded is still just a to-do', state({}).status, 'todo');
check('an AI-approved document reads as plainly submitted, not as an AI verdict',
  state({ currentDocId: 'd1', aiVerdict: 'approved' }).message, 'Submitted for review.');

console.log('\nNo AI text escapes, whatever the tray holds');
const leaky = [
  { currentDocId: 'd1', aiVerdict: 'issues', aiNotes: 'SECRET REVIEWER PROSE' },
  { currentDocId: 'd1', aiVerdict: 'needs_manual_review', aiNotes: 'SECRET REVIEWER PROSE' },
  { currentDocId: 'd1', aiVerdict: 'approved', aiNotes: 'SECRET REVIEWER PROSE' },
  { currentDocId: 'd1', aiError: 'fetch_failed', aiNotes: 'SECRET REVIEWER PROSE' },
  { currentDocId: 'd1', aiVerdict: 'issues', aiError: 'timeout', aiNotes: 'SECRET REVIEWER PROSE',
    aiFindings: [{ status: 'not_met', detail: 'SECRET FINDING' }] },
];
assert('not one of five tray shapes leaks the reviewer\'s text',
  leaky.every((d) => {
    const s = state(d);
    return s.message.indexOf('SECRET') < 0 && JSON.stringify(s.findings || []).indexOf('SECRET') < 0;
  }), JSON.stringify(leaky.map((d) => state(d).message)));

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
