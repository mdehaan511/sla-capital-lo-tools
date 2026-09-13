// Gate for deploy/netlify/functions/_shared/client-save-merge.mjs (Deploy 236.999).
// Run: node scripts/client-save-merge-test.mjs
import assert from 'node:assert/strict';
import { preserveOmittedClientFields } from '../deploy/netlify/functions/_shared/client-save-merge.mjs';

const clone = (o) => JSON.parse(JSON.stringify(o));
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ok   ' + name);
}

const stored = {
  id: 'c1',
  firstName: 'Donato',
  lastName: 'Callahan',
  email: 'donato@example.com',
  homeAddress: { street: '1 Main St', city: 'St. Louis', state: 'MO', zip: '63112' },
  mailingAddress: { street: 'PO Box 9', city: 'St. Louis', state: 'MO', zip: '63112' },
  ssn_enc: 'enc-value',
  _emailChangeRequest: { requested: 'new@example.com' },
  companies: [
    { id: 'co1', name: 'Cates Ave LLC', ein: '12-3456789', address: '5909 Cates Ave' },
    { id: 'co2', name: 'Miami St LLC', ein: '98-7654321' },
  ],
  loans: [
    {
      id: 'l1',
      address: '5909 Cates Ave',
      notes: 'legacy notes',
      submittedAt: '2026-06-16T10:00:00Z',
      notesLog: [
        { id: 'n1', ts: '2026-06-01T00:00:00Z', text: 'first' },
        { id: 'n2', ts: '2026-06-10T00:00:00Z', text: 'second' },
      ],
    },
  ],
};

// What Pipeline used to send: a SUMMARY record with a fresh one-entry notesLog.
const summaryRoundTrip = {
  id: 'c1',
  firstName: 'Donato',
  lastName: 'Callahan',
  email: 'donato@example.com',
  hasSSN: true,
  companies: [{ id: 'co1', name: 'Cates Ave LLC' }, { id: 'co2', name: 'Miami St LLC' }],
  loans: [
    {
      id: 'l1',
      address: '5909 Cates Ave',
      status: 'submitted',
      submittedAt: '2026-09-13T12:00:00Z',
      notesLog: [{ id: 'n3', ts: '2026-09-13T12:00:00Z', text: 'Submitted for UW review' }],
    },
  ],
};

check('summary save keeps home + mailing address', () => {
  const r = preserveOmittedClientFields(clone(stored), clone(summaryRoundTrip));
  assert.equal(r.homeAddress.street, '1 Main St');
  assert.equal(r.mailingAddress.street, 'PO Box 9');
});

check('summary save keeps company EINs + addresses', () => {
  const r = preserveOmittedClientFields(clone(stored), clone(summaryRoundTrip));
  assert.equal(r.companies[0].ein, '12-3456789');
  assert.equal(r.companies[0].address, '5909 Cates Ave');
  assert.equal(r.companies[1].ein, '98-7654321');
});

check('summary save unions the notes log in timestamp order', () => {
  const r = preserveOmittedClientFields(clone(stored), clone(summaryRoundTrip));
  assert.deepEqual(r.loans[0].notesLog.map((n) => n.id), ['n1', 'n2', 'n3']);
});

check('summary save keeps the ORIGINAL submittedAt', () => {
  const r = preserveOmittedClientFields(clone(stored), clone(summaryRoundTrip));
  assert.equal(r.loans[0].submittedAt, '2026-06-16T10:00:00Z');
});

check('incoming loan fields still win (status change lands)', () => {
  const r = preserveOmittedClientFields(clone(stored), clone(summaryRoundTrip));
  assert.equal(r.loans[0].status, 'submitted');
});

check('explicit null clears a client field', () => {
  const payload = clone(stored);
  payload._emailChangeRequest = null;
  const r = preserveOmittedClientFields(clone(stored), payload);
  assert.equal(r._emailChangeRequest, null);
});

check('explicit empty string clears an address field', () => {
  const payload = clone(stored);
  payload.homeAddress = '';
  const r = preserveOmittedClientFields(clone(stored), payload);
  assert.equal(r.homeAddress, '');
});

check('a company left out of a full save stays removed', () => {
  const payload = clone(stored);
  payload.companies = [payload.companies[0]];
  const r = preserveOmittedClientFields(clone(stored), payload);
  assert.equal(r.companies.length, 1);
  assert.equal(r.companies[0].id, 'co1');
});

check('an edited company field wins over the stored one', () => {
  const payload = clone(stored);
  payload.companies[0].ein = '11-1111111';
  const r = preserveOmittedClientFields(clone(stored), payload);
  assert.equal(r.companies[0].ein, '11-1111111');
});

check('a company without an id is matched by name', () => {
  const s = clone(stored);
  delete s.companies[1].id;
  const payload = { id: 'c1', companies: [{ name: 'miami st llc ' }], loans: [] };
  const r = preserveOmittedClientFields(s, payload);
  assert.equal(r.companies[0].ein, '98-7654321');
});

check('an edited note (same id) keeps the incoming text', () => {
  const payload = clone(stored);
  payload.loans[0].notesLog[1].text = 'second (edited)';
  const r = preserveOmittedClientFields(clone(stored), payload);
  assert.deepEqual(r.loans[0].notesLog.map((n) => n.text), ['first', 'second (edited)']);
});

check('a brand-new loan not on the stored record is untouched', () => {
  const payload = clone(stored);
  payload.loans.push({ id: 'l2', address: 'New Loan', notesLog: [{ id: 'x', ts: '2026-09-13' }] });
  const r = preserveOmittedClientFields(clone(stored), payload);
  assert.equal(r.loans.length, 2);
  assert.deepEqual(r.loans[1].notesLog.map((n) => n.id), ['x']);
});

check('a payload with no loans key keeps the stored loans', () => {
  const r = preserveOmittedClientFields(clone(stored), { id: 'c1', firstName: 'D' });
  assert.equal(r.loans.length, 1);
  assert.equal(r.loans[0].notesLog.length, 2);
});

check('no stored record → payload returned unchanged', () => {
  const payload = clone(summaryRoundTrip);
  assert.deepEqual(preserveOmittedClientFields(null, payload), summaryRoundTrip);
});

console.log('\nall ' + passed + ' checks pass');
