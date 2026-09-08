/**
 * scripts/loan-summary-parity-test.mjs — Deploy 236.901
 *
 * The Closed Loans / Pipeline pages fetch loans through a SUMMARY projection,
 * and a field that isn't on the allow-list simply never reaches the browser.
 * The failure is silent and looks like a broken save or a dead feature:
 *
 *   236.616  disposition + servicing scalars — "edits looked like they didn't
 *            save (they reverted on reload)"
 *   236.820  commission payment status — "the sync wrote correctly but the
 *            page never saw it"
 *   236.901  extensionEsign — the extension status chip had nothing to render
 *            no matter how correctly the marker was stamped (Mike: "The status
 *            update for the extension isnt showing correctly")
 *
 * Two lists have to agree: the blob path (clients-list.mjs LOAN_SUMMARY_FIELDS)
 * and the Postgres path (clients-list-pg.mjs LOAN_SUMMARY_EXTRA_KEYS). Their
 * comments say "keep in sync" six times over, which is precisely the kind of
 * instruction that decays. This asserts it instead.
 *
 * Run: node scripts/loan-summary-parity-test.mjs
 */
import { readFileSync } from 'node:fs';

const BLOB = new URL('../deploy/netlify/functions/clients-list.mjs', import.meta.url);
const PG   = new URL('../deploy/netlify/functions/clients-list-pg.mjs', import.meta.url);

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log((ok ? '  ok   ' : '  FAIL ') + name +
    (ok ? '' : '\n         expected ' + JSON.stringify(expected) + '\n         got      ' + JSON.stringify(actual)));
}

/** Pull the quoted entries out of a `const NAME = [ ... ];` array literal. */
function readList(url, name) {
  const src = readFileSync(url, 'utf8');
  const start = src.indexOf('const ' + name);
  if (start < 0) throw new Error(name + ' not found in ' + url.pathname);
  const open = src.indexOf('[', start);
  const close = src.indexOf('];', open);
  if (open < 0 || close < 0) throw new Error(name + ' is not an array literal');
  const body = src.slice(open + 1, close)
    // Drop comments so a field mentioned in prose isn't counted.
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  return (body.match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1));
}

console.log('loan summary parity gate\n');

const blobFields = readList(BLOB, 'LOAN_SUMMARY_FIELDS');
const pgFields   = readList(PG, 'LOAN_SUMMARY_EXTRA_KEYS');

check('blob list is non-trivial', blobFields.length > 40, true);
check('pg list is non-trivial', pgFields.length > 20, true);

// The PG list carries only the EXTRA (non-promoted) keys, so it is a subset of
// the blob list rather than an exact copy. What must never happen is a key
// living in one and not the other.
const blobSet = new Set(blobFields);
const missingFromBlob = pgFields.filter((k) => !blobSet.has(k));
check('every PG summary key is also in the blob summary', missingFromBlob, []);

// Fields the server writes and a page reads through the summary. Each of these
// cost a real bug when it was missing; this is the regression list.
const MUST_CARRY = [
  'disposition',                 // 236.616
  'commissionPaymentStatus',     // 236.820
  'anniversaryFollowUps',        // 236.823
  'extensionEsign',              // 236.901 — the extension status chip
  'extensionServicer',           // 236.901 — servicer hand-off record
  'maturityDate',                // the extension moves this
  'processingStage',             // borrower stage + the processing board
];
for (const k of MUST_CARRY) {
  check("blob summary carries '" + k + "'", blobSet.has(k), true);
}

// No accidental duplicates — a duplicated key is a sign of a bad merge.
for (const [label, list] of [['blob', blobFields], ['pg', pgFields]]) {
  const dupes = list.filter((k, i) => list.indexOf(k) !== i);
  check(label + ' list has no duplicates', [...new Set(dupes)], []);
}

console.log('\n' + (failures ? failures + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(failures ? 1 : 0);
