#!/usr/bin/env node
/**
 * scripts/esign-people-test.mjs — Deploy 237.167
 *
 * Mike: completed e-sign documents "should be able to be linked to the profiles of people
 * (borrowers, brokers, investors) and be able to be seen in their profiles as documents".
 *
 * Two ways this goes wrong, and both are worse than the feature is good:
 *
 *   1. A document appears on the WRONG person's profile. A signature page under someone
 *      else's name is the failure 237.133 and 237.156 were both written to avoid, and a
 *      profile is where a processor would least expect to be misled. So: email is the
 *      identity, and a person with no email on file is matched by NOTHING.
 *
 *   2. A document leaks ACROSS LOs. The e-sign index is org-wide but a client record is
 *      owner-scoped, so "every doc whose signer email matches" would put one LO's
 *      document onto another LO's copy of the same borrower.
 *
 * Run: node scripts/esign-people-test.mjs
 */
import {
  emailsOf, normalizePersonRef, docBelongsTo, visibleTo, docsForPerson, nameKey,
} from '../deploy/netlify/functions/_shared/esign-people.mjs';

let fail = 0;
const check = (name, got, want) => {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + '\n         got  ' + g + '\n         want ' + w);
};
const assert = (name, cond, why) => {
  if (cond === true) { console.log('  ok   ' + name); return; }
  fail++; console.log('  FAIL ' + name + (why ? '\n         ' + String(why).slice(0, 240) : ''));
};

const LO_A = 'lo.a@slacapital.com', LO_B = 'lo.b@slacapital.com';
const borrower = { id: 'c_1', firstName: 'Jeremy', lastName: 'Wilson', email: 'JW@Example.com ' };
const broker   = { id: 'c_2', _isBroker: true, firstName: 'Tanner', lastName: 'Reed', email: 'tanner@brokerage.com' };
const investor = { id: 'inv_1', name: 'King Arthur Fund', pocEmail: 'ops@kaf.com' };
const doc = (over) => Object.assign({
  id: 'd1', status: 'completed', title: 'Assignment Agreement',
  ownerEmail: LO_A, completedAt: '2026-09-18T12:00:00Z',
  signers: [{ id: 's1', name: 'Jeremy Wilson', email: 'jw@example.com', signedAt: '2026-09-18T11:00:00Z' }],
  people: [],
}, over || {});

// ── which addresses a person answers to ───────────────────────────────────
console.log('\nIdentity');
check('a client\'s email is normalized (case and stray spaces)', emailsOf(borrower), ['jw@example.com']);
check('an investor is reached through their point of contact', emailsOf(investor), ['ops@kaf.com']);
check('a client\'s other guarantors count as that record too',
  emailsOf({ email: 'a@x.com', guarantors: [{ email: 'B@x.com' }, { email: '' }] }), ['a@x.com', 'b@x.com']);
check('no email on file means no addresses, not a wildcard', emailsOf({ id: 'c_9' }), []);
check('junk is not an address', emailsOf({ email: 'not-an-email' }), []);

// ── the match ─────────────────────────────────────────────────────────────
console.log('\nWhose document is it');
check('the person who signed it', docBelongsTo(doc(), borrower).via, 'signed');
check('...case never matters', docBelongsTo(doc({ signers: [{ email: 'JW@EXAMPLE.COM' }] }), borrower).via, 'signed');
check('someone who did not sign it gets nothing', docBelongsTo(doc(), broker).linked, false);
check('A PERSON WITH NO EMAIL MATCHES NOTHING — never by name',
  docBelongsTo(doc({ signers: [{ name: 'Jeremy Wilson', email: '' }] }), { id: 'c_9', firstName: 'Jeremy', lastName: 'Wilson' }).linked,
  false);
assert('...even though the names are identical',
  nameKey('Jeremy Wilson') === nameKey('JEREMY  WILSON'), 'the name keys really do match');

const filed = doc({ people: [{ kind: 'investor', id: 'inv_1', name: 'King Arthur Fund', at: '2026-09-18T13:00:00Z' }] });
check('a document filed to an investor by hand shows on them, though nobody there signed',
  [docBelongsTo(filed, investor).via, docBelongsTo(filed, investor).at], ['linked', '2026-09-18T13:00:00Z']);
check('...and a hand-filed link does not spill onto anyone else', docBelongsTo(filed, broker).linked, false);
check('an explicit link wins over a signature, so the reason shown is the deliberate one',
  docBelongsTo(doc({ people: [{ kind: 'client', id: 'c_1', at: 'x' }] }), borrower).via, 'linked');
check('a link filed as "client" still matches when the page asks as a broker (a broker IS a client)',
  docBelongsTo(doc({ people: [{ kind: 'client', id: 'c_2', at: 'x' }] }), broker, '').via, 'linked');

console.log('\nThe explicit-link shape');
check('a usable link is kept, normalized', normalizePersonRef({ kind: 'investor', id: 'inv_1', name: ' King  Arthur ', email: 'A@B.com' }),
  { kind: 'investor', id: 'inv_1', name: 'King Arthur', email: 'a@b.com', ownerKey: '' });
check('no kind, no link', normalizePersonRef({ id: 'c_1' }), null);
check('no id, no link', normalizePersonRef({ kind: 'client' }), null);
check('an invented kind is refused', normalizePersonRef({ kind: 'lender', id: 'x' }), null);

// ── the cross-LO gate ─────────────────────────────────────────────────────
console.log('\nWho may see it');
check('the LO who owns the document', visibleTo(doc(), { email: LO_A }), true);
check('ANOTHER LO MAY NOT — the same borrower exists in both books', visibleTo(doc(), { email: LO_B }), false);
check('staff see everything (admin / processor)', visibleTo(doc(), { email: LO_B, staff: true }), true);
check('the LO the document was FILED to, even though another LO sent it',
  visibleTo(doc({ assignment: { loanId: 'l1', ownerKey: LO_B } }), { email: LO_B }), true);
check('...and the LO whose loan it was started from',
  visibleTo(doc({ loan: { loanId: 'l1', ownerKey: LO_B } }), { email: LO_B }), true);
check('a viewer with no email sees nothing', visibleTo(doc(), {}), false);

// ── the list a profile actually draws ─────────────────────────────────────
console.log('\nThe profile list');
const summaries = [
  doc({ id: 'd_new', completedAt: '2026-09-18T12:00:00Z' }),
  doc({ id: 'd_old', completedAt: '2026-01-02T12:00:00Z' }),
  doc({ id: 'd_draft', status: 'draft' }),
  doc({ id: 'd_sent', status: 'sent' }),
  doc({ id: 'd_cancelled', status: 'cancelled' }),
  doc({ id: 'd_other', signers: [{ email: 'someone@else.com' }] }),
  doc({ id: 'd_otherLO', ownerEmail: LO_B }),
];
const mine = docsForPerson(summaries, borrower, '', { email: LO_A });
check('only COMPLETED documents — a draft on a profile is a promise, not a record',
  mine.map((d) => d.id), ['d_new', 'd_old']);
check('newest first', mine[0].id, 'd_new');
check('another LO\'s document is not on my copy of this borrower',
  mine.some((d) => d.id === 'd_otherLO'), false);
// d_otherLO shares d_new's completion time, so it sorts alongside it, not after d_old.
check('...but staff see it', docsForPerson(summaries, borrower, '', { email: LO_A, staff: true }).map((d) => d.id),
  ['d_new', 'd_otherLO', 'd_old']);
check('a person who signed nothing has an empty list', docsForPerson(summaries, investor, '', { email: LO_A, staff: true }), []);

const row = mine[0];
check('a row carries what the profile prints', [row.title, row.via, row.signerName], ['Assignment Agreement', 'signed', 'Jeremy Wilson']);
check('...and links through to the loan when it was filed to one',
  docsForPerson([doc({ assignment: { loanId: 'l1', clientId: 'c_1', ownerKey: LO_A, address: '123 Main St', slaNumber: 'SLA-1', slugLabel: 'Assignment' } })],
    borrower, '', { email: LO_A })[0].loan,
  { loanId: 'l1', clientId: 'c_1', ownerKey: LO_A, address: '123 Main St', slaNumber: 'SLA-1', slugLabel: 'Assignment' });
check('no loan filed = no loan link, rather than a broken one',
  docsForPerson([doc()], borrower, '', { email: LO_A })[0].loan, null);

console.log('\nRubbish in');
check('no summaries at all', docsForPerson(null, borrower, '', { email: LO_A }), []);
check('a summary with no signers', docsForPerson([doc({ signers: null })], borrower, '', { email: LO_A }), []);
check('no person', docsForPerson(summaries, null, '', { email: LO_A, staff: true }), []);

console.log('\n' + (fail ? fail + ' CHECK(S) FAILED' : 'all checks pass'));
process.exit(fail ? 1 : 0);
