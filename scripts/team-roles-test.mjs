#!/usr/bin/env node
/**
 * scripts/team-roles-test.mjs — Deploy 237.216 (Raissa, via Mike)
 *
 * Raissa: "is it also possible to add an underwriter option in the dropdown here, so Dee
 * can filter loans already assigned to her"
 *
 * Adding a word to a dropdown is the easy half. The half worth a gate is everything that
 * picks a PERSON off a loan's team and used to be able to assume they were processing it:
 *
 *   1. THE PROCESSOR OF RECORD. `loan.assignedProcessor` fell back to "the first person on
 *      the team". An underwriter alone on a loan became its processor — and the admins'
 *      24-hour "nobody assigned" alert went quiet on a loan nobody was processing.
 *   2. A PROCESSING TASK handed to the first team member (borrower-form-submit).
 *   3. THE BORROWER'S "Your SLA Team", which printed any unknown role as "Loan Processor"
 *      with the person's email next to it.
 *
 * And the claim the whole change rests on: Dee needs NO new login role, because the
 * pipeline's filters match on email across every role. That is asserted, not assumed.
 *
 * Run: node scripts/team-roles-test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import {
  TEAM_ROLES, isTeamRole, isReviewOnlyRole, primaryProcessor, borrowerFacingTeam, roleWorkPhrase,
} from '../deploy/netlify/functions/_shared/team-roles.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + why : ''));
};
const read = (p) => readFileSync(new URL('../deploy/' + p, import.meta.url), 'utf8');

const dee    = { email: 'diana@slacapital.com',  name: 'Diana Labasan',    role: 'underwriter' };
const raissa = { email: 'raissa@slacapital.com', name: 'Raissa Dalimocon', role: 'processor' };
const keith  = { email: 'keith@slacapital.com',  name: 'Keith',            role: 'closer' };
const jessy  = { email: 'jessy@slacapital.com',  name: 'Jessy',            role: 'manager' };
const legacy = { email: 'old@slacapital.com',    name: 'Pre-236.662' };     // no role = a processor

console.log('\nThe roles');
check('the three that existed, then Underwriter', TEAM_ROLES.map((t) => t.label), ['Processor', 'Closer', 'Processing Manager', 'Underwriter']);
check('underwriter is a real role; nonsense is not', [isTeamRole('underwriter'), isTeamRole('UNDERWRITER'), isTeamRole('janitor'), isTeamRole('')], [true, true, false, false]);
check('only the underwriter is review-only', TEAM_ROLES.filter((t) => isReviewOnlyRole(t.value)).map((t) => t.value), ['underwriter']);

console.log('\nWho is PROCESSING the loan');
check('the processor, wherever they sit on the list', primaryProcessor([dee, keith, raissa]).email, raissa.email);
check('a closer or manager still stands in when there is no processor (unchanged)', primaryProcessor([keith, jessy]).email, keith.email);
check('AN UNDERWRITER ALONE MEANS NOBODY IS PROCESSING IT', primaryProcessor([dee]), null);
check('...and she is skipped even when she was added first', primaryProcessor([dee, keith]).email, keith.email);
check('an old entry with no role is a processor', primaryProcessor([dee, legacy]).email, legacy.email);
check('empty / junk teams', [primaryProcessor([]), primaryProcessor(null), primaryProcessor([{ role: 'processor' }])], [null, null, null]);

// Run the endpoint's REAL _syncPrimary, not a description of it.
const EP = read('netlify/functions/loan-assign-processor.mjs');
const syncSrc = (EP.match(/function _syncPrimary\(\) \{[\s\S]*?\n  \}/) || [''])[0];
assert('_syncPrimary can be lifted', syncSrc.length > 0);
const syncWith = (team, prior) => {
  const loan = { assignedProcessors: team };
  if (prior) loan.assignedProcessor = prior;
  vm.runInNewContext(syncSrc + '\n_syncPrimary();', { loan, primaryProcessor });
  return loan.assignedProcessor ? loan.assignedProcessor.email : null;
};
check('assign only an underwriter: the loan has NO processor of record', syncWith([dee]), null);
check('...so a stale one is removed, not left behind', syncWith([dee], { email: 'gone@x.com' }), null);
check('underwriter + processor: the processor is the processor', syncWith([dee, raissa]), raissa.email);
check('closer only: unchanged from before', syncWith([keith]), keith.email);
// Code only: the comment above _syncPrimary quotes the old fallback on purpose.
assert('the old "first person on the team" fallback is gone', !/\|\| arr\[0\]/.test(EP.replace(/\/\/[^\n]*/g, '')));
assert('the endpoint accepts exactly the shared role list',
  /const VALID_ROLES = \{\}; TEAM_ROLES\.forEach\(\(t\) => \{ VALID_ROLES\[t\.value\] = 1; \}\);/.test(EP));

// The alert that would have gone quiet reads the processor of record.
const ALERTS = read('netlify/functions/processing-alerts.mjs');
assert('the admins\' "nobody assigned" alert reads the processor of record — so it still fires',
  /const assignee = \(ex\.assignedProcessor && ex\.assignedProcessor\.email\)/.test(ALERTS) && /manager && !assignee && inPipeline/.test(ALERTS));

console.log('\nProcessing work never lands on the underwriter');
const FORM = read('netlify/functions/borrower-form-submit.mjs');
assert('the VOM follow-up task goes to the processor of record', /const p0 = primaryProcessor\(procs\);/.test(FORM));
assert('...not to "the first team member with an email"', !/procs\.find\(\(a\) => a && a\.email\) \|\| null/.test(FORM));

console.log('\nThe borrower does not see their underwriter');
check('"Your SLA Team" leaves her out and keeps everyone else', borrowerFacingTeam([dee, raissa, keith, jessy]).map((p) => p.role), ['processor', 'closer', 'manager']);
check('junk in', [borrowerFacingTeam(null), borrowerFacingTeam([{ role: 'processor' }])], [[], []]);
const INTAKE = read('netlify/functions/borrower-intake-status.mjs');
assert('the borrower portal builds its team through that filter',
  /const assigned = borrowerFacingTeam\(loan && loan\.assignedProcessors\);/.test(INTAKE));

console.log('\nThe assignment email says what she was assigned FOR');
check('each role', ['processor', 'manager', 'closer', 'underwriter', ''].map(roleWorkPhrase),
  ['for processing', 'for processing', 'for closing', 'for underwriting', 'for processing']);
assert('the email uses it', /roleWorkPhrase\(assignee && assignee\.role\)/.test(EP));

// ── the claim: no new login role is needed ──────────────────────────────────
console.log('\nDee can filter to her loans with NO new login role');
const PIPE = read('processing-pipeline.html');
const f0 = PIPE.indexOf('    if (procFilter) {');
const f1 = PIPE.indexOf('    if (search) {', f0);
assert('both pipeline filters can be found', f0 > 0 && f1 > f0);
const filters = PIPE.slice(f0, f1).replace(/\/\/[^\n]*/g, '');       // code only, comments dropped
assert('"My Loans" and the team-member filter match on EMAIL', (filters.match(/\.email/g) || []).length >= 4);
assert('...and never look at the ROLE — so an underwriter is found like anyone else', !/\.role\b/.test(filters),
  'a role test here would silently hide her loans from her own filter');
assert('the team-member dropdown is built from every team member, whatever their role',
  /team\.forEach\(function\(p\) \{\s*var em = String\(\(p && p\.email\) \|\| ''\)\.toLowerCase\(\);/.test(PIPE));
assert('her chip on the card reads Underwriter', /role === 'underwriter' \? 'Underwriter'/.test(PIPE));

console.log('\nThe picker in Raissa\'s screenshot');
const LD = read('loan-details.js');
const rolesSrc = (LD.match(/var PROC_ROLES = \[[\s\S]*?\n\];/) || [''])[0];
const PROC_ROLES = vm.runInNewContext(rolesSrc + '\nPROC_ROLES;');
check('Loan Details offers exactly the server\'s roles, same labels, same order',
  PROC_ROLES.map((r) => r.value + '=' + r.label), TEAM_ROLES.map((r) => r.value + '=' + r.label));
const LDH = read('loan-details.html');
assert('the Underwriter badge has its own colour', /\.proc-role-underwriter \{/.test(LDH));
assert('the page is pinned to a loan-details.js that HAS the option',
  Number((LDH.match(/loan-details\.js\?v=(\d+)/) || [])[1]) >= 237216, 'feedback_guard_the_function');

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
