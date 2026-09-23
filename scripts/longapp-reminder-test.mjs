/**
 * longapp-reminder-test.mjs — Deploy 237.190
 *
 * Gate for the loan-app resend / reminder button (Chance: "is there anyway we
 * can get a 'resend' or reminder button for the loan app as well?").
 *
 * Static wiring checks only — no network. The thing these buttons quietly
 * depend on is the 236.414 token REUSE in borrower-info-request: if a resend
 * ever went back to rotating the token, every link already in the borrower's
 * inbox would die the moment an LO clicked "Send reminder". Check 1 guards it.
 *
 *   node scripts/longapp-reminder-test.mjs
 */
import { readFileSync } from 'node:fs';

const req = readFileSync('deploy/netlify/functions/borrower-info-request.mjs', 'utf8');
const api = readFileSync('deploy/sla-api.js', 'utf8');
const ld  = readFileSync('deploy/loan-details.js', 'utf8');
const ldh = readFileSync('deploy/loan-details.html', 'utf8');

let fails = 0;
function check(name, ok) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) fails++;
}

console.log('borrower-info-request.mjs');
check('a resend still REUSES a live token (236.414) — reminders must not kill sent links',
  /tokenReusable\s*=\s*!!\(existing\s*&&\s*existing\.token/.test(req) &&
  /const token = tokenReusable \? existing\.token : generateToken\(\)/.test(req));
check('reminder only counts when there is an existing record to nudge about',
  /const isReminder = !!body\.reminder && !!existing;/.test(req));
check('"started" is derived from collected data, for the pick-up-where-you-left-off copy',
  /const hasStarted = !!\(existing && existing\.data && Object\.keys\(existing\.data\)\.length > 0\);/.test(req));
check('the reminder flags reach the email builder',
  /reminder: isReminder,\s*\n\s*started: hasStarted,/.test(req));
check('sendBorrowerEmail takes reminder + started',
  /async function sendBorrowerEmail\(\{[^}]*reminder, started \}\)/.test(req));
check('a reminder gets its own subject line',
  /Reminder: your loan application for \$\{propertyAddress\} is still open/.test(req) &&
  /Reminder: your SLA Capital loan application is still open/.test(req));
check('a started application gets the pick-up CTA',
  /const ctaLabel = \(reminder && started\) \? 'Pick Up Where You Left Off'/.test(req));
check('the banner says reminder, not request',
  /SLA Capital — Loan Application Reminder/.test(req));
check('the audit entry says reminder',
  /isReminder \? 'Sent a reminder about the long-form loan application to '/.test(req));
check('the appended entry comes back on the response',
  /noteEntry = appendNoteEntry\(/.test(req) && /entry: noteEntry,/.test(req));

console.log('sla-api.js');
check('BorrowerInfo.request forwards reminder', /if \(opts\.reminder\)\s+body\.reminder = true;/.test(api));

console.log('loan-details.js');
check('both handlers exist', /function appCopyLongAppLink\(btn\)/.test(ld) && /function appSendReminder\(btn\)/.test(ld));
check('reminder posts reminder:true with the loan + recipient',
  /var opts = \{ loanId: _loanId, sendEmail: true, email: email, reminder: true \};/.test(ld));
check('cross-LO views pass the owner override on both calls',
  (ld.match(/if \(_loEmail && _user && _loEmail !== _user\.email\) opts\._owner = _loEmail;/g) || []).length >= 4);
check('copy uses the EXISTING link from status (never mints one)',
  /function appCopyLongAppLink[\s\S]{0,400}SLA\.BorrowerInfo\.status\(/.test(ld) &&
  !/function appCopyLongAppLink[\s\S]{0,400}BorrowerInfo\.request\(/.test(ld));
check('the recipient is escaped into the button attribute',
  /data-email="' \+ escAttr\(email\)/.test(ld));
check('reminder is hidden once the application is complete',
  /if \(_ldLongAppStatus !== 'complete'\)/.test(ld));
check('status refresh keeps _ldLongAppStatus current and re-renders',
  /_ldLongAppStatus = String\(s \|\| ''\);/.test(ld) && /renderNotesLog\(\);/.test(ld));
check('only the newest App sent entry gets the buttons',
  /e\.kind === 'app_sent' && e\.id && e\.id === _latestAppSentId/.test(ld));
check('the returned entry is appended to the feed', /_loan\.notesLog\.push\(resp\.entry\)/.test(ld));

console.log('loan-details.html');
// Deploy 237.250 — was a literal ?v=237190 on both, which every later deploy that
// touched either file broke (it had been failing since loan-details.js moved on).
// What it actually guards is that the page is served a copy NEW ENOUGH to have the
// reminder buttons, so that is what it checks.
const pinOf = (name) => Number((ldh.match(new RegExp(name.replace('.', '\\.') + '\\?v=(\\d+)')) || [])[1] || 0);
check('loan-details.js + sla-api.js are pinned to 237.190 or newer (they carry the reminder buttons)',
  pinOf('loan-details.js') >= 237190 && pinOf('sla-api.js') >= 237190);

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
