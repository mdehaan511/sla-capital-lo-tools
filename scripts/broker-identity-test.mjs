/**
 * broker-identity-test.mjs — Deploy 237.215
 *
 * Jeremy quoted three broker deals for Gavin Berg (gavin@kindhomeloans.com)
 * with no borrower yet. They came out with the BROKER named "Chris TBD" — the
 * placeholder he had typed for the missing borrower — and the same record
 * showing again as Guarantor 1 with the broker's email.
 *
 * The mechanism, in two halves:
 *   1. broker-link resolves a broker by EMAIL. An email is a strong key but
 *      it is not a name: when the only client holding gavin@ was a borrower
 *      placeholder, that branch adopted it — flagged it as a broker and
 *      handed its name back.
 *   2. Four save endpoints then stamped that name over the one the LO typed.
 *
 * And the reason a placeholder existed at all: a broker-mode quote carried no
 * borrower name, so the term sheet printed blank and the LO filled the gap by
 * hand — in the client record, which is the one place it does damage.
 *
 *   node scripts/broker-identity-test.mjs
 */
import { readFileSync } from 'node:fs';

let fails = 0;
function check(name, ok) {
  console.log((ok ? '  ok   ' : '  FAIL ') + name);
  if (!ok) fails++;
}

const link = readFileSync('deploy/netlify/functions/_shared/broker-link.mjs', 'utf8');

console.log('broker-link: an email is not a name');
check('a name conflict is detected when the matched client is called something else',
  /const nameConflict = !!incomingName && !!recName\s*\n\s*&& recName\.toLowerCase\(\) !== incomingName\.toLowerCase\(\);/.test(link));
check('the typed broker name wins over the matched record', /if \(nameConflict\) \{\s*\n\s*broker\.name = incomingName;/.test(link));
check('a conflicting record is NOT silently converted into a broker',
  /if \(!nameConflict\) await _ensureFlagged\(/.test(link));
check('the conflict is logged, so the next one is findable', /\[broker-link\] email .* is on client/.test(link));
check('the caller can see it happened', /return \{ id: hit\.client\.id, created: false, broker, nameConflict, matchedName: recName \};/.test(link));
check('a clean match still flags and adopts as before', /_ensureFlagged\(ownerKey, hit\.client, incomingComp, clientsStore\)/.test(link));

console.log('save endpoints: fill, never overwrite');
for (const [file, v] of [
  ['sizer-save-loan.mjs', 'loanRecord'],
  ['loan-update-from-sizer.mjs', 'merged'],
  ['prospects-save.mjs', 'loan'],
  ['clients-save.mjs', 'l'],
]) {
  const src = readFileSync('deploy/netlify/functions/' + file, 'utf8');
  const guarded = new RegExp('if \\(b\\.name && !String\\(' + v + '\\.brokerName \\|\\| \'\'\\)\\.trim\\(\\)\\)').test(src);
  const bare = new RegExp('if \\(b\\.name\\)\\s+' + v + '\\.brokerName').test(src);
  check(file + ' keeps the typed broker name', guarded && !bare);
  const compOk = !new RegExp('if \\(b\\.company\\)\\s+' + v + '\\.brokerCompany').test(src);
  check(file + ' keeps the typed company too', compOk);
}

console.log('the placeholder is the product\'s job, not the LO\'s');
for (const page of ['rtl-sizer.html', 'dscr-sizer.html', 'guc-sizer.html', 'mf-dscr-sizer.html']) {
  const s = readFileSync('deploy/' + page, 'utf8');
  // Deploy 237.251 -- the variable is the page's OWN loan-record name (the DSCR sizers say
  // loanRecord, RTL/GUC say loanRec). This check used to demand `loanRec`, which is how
  // "loanRec is not defined" shipped in the two DSCR sizers and stayed green for a week.
  const declared = (/var (loanRec|loanRecord) = ClientBook\.buildLoanFromSizer\(/.exec(s) || [])[1] || '';
  const stamped = (/if \(_isBrokerPayload && !String\(formData\.borrowerName \|\| ''\)\.trim\(\)\) \{\s*\n\s*(\w+)\.borrowerName = 'TBD';/.exec(s) || [])[1] || '';
  check(page + ' stamps TBD on a broker-mode quote with no borrower, on the variable it actually declares',
    !!declared && stamped === declared);
  // The placeholder must land on the LOAN only — the client is the broker.
  const payload = (/var _payload = \{[\s\S]*?\n      \};/.exec(s) || [''])[0];
  check(page + ' does NOT put the placeholder in the client payload',
    payload.indexOf("'TBD'") < 0);
}

console.log('the broker-as-parent display already handles the clean case');
{
  const ld = readFileSync('deploy/loan-details.js', 'utf8');
  check('a flagged broker parent is not shown as Guarantor 1',
    /_bwPrimaryIsBroker = !!\(c && c\._isBroker\) &&/.test(ld));
  check('...and the pane says the guarantor is still to come',
    /No guarantor is linked to this loan yet/.test(ld));
}

console.log(fails ? `\n${fails} check(s) FAILED` : '\nall checks passed');
process.exit(fails ? 1 : 0);
